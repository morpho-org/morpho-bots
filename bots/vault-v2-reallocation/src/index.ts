import { vaultV2Abi } from '@morpho-org/blue-sdk-viem'
import {
  assertContractDeployed,
  createBalanceMonitor,
  createDeploylessClient,
  createHeartbeatMonitor,
  createLogger,
  createPendingQueue,
  createRunner,
  createSigner,
  DEFAULT_MAX_DATA_BYTES,
  DEFAULT_MAX_GAS_LIMIT,
  initialFees,
  railwayContext,
  simulateCall
} from '@repo/bot-kit'
import { ensureError } from '@repo/utils'
import { getAbiItem, toFunctionSelector } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { getBlockNumber, readContract } from 'viem/actions'

import { loadConfig } from './config'
import { encodeReallocation } from './encode'
import { createIntervalGate } from './interval-gate'
import { runTick } from './runner/tick'
import { createStrategy } from './strategies'
import { revertReason } from './tx-error'
import { checkVaults } from './vault-checks'
import { fetchVaultV2Data } from './vault-data'

// Blocks a vault stays in the queue's backpressure set AFTER its tx settles, suppressing an
// immediate re-plan from a read RPC that lags the send RPC's confirmation.
const SETTLED_COOLDOWN_BLOCKS = 20n

async function main() {
  const config = loadConfig()
  const logger = createLogger(config.logLevel, {
    context: { bot: 'vault-v2-reallocation', chainId: config.chainId, ...railwayContext() }
  })

  // Every per-pass read goes through the deployless lens (one eth_call per vault), so the HTTP
  // transport has nothing to batch.
  const client = createDeploylessClient({
    chain: config.chain,
    rpcUrl: config.rpcUrl,
    rpcUrlFallback: config.rpcUrlFallback
  })

  // The signer's policy needs the vault → adapter map the startup checks resolve, so the EOA is
  // derived from the key directly here.
  const eoa = privateKeyToAccount(config.reallocatorPrivateKey).address
  const startupBlock = await getBlockNumber(client)

  const adapterByVault = await checkVaults(
    config.vaultWhitelist,
    {
      assertDeployed: vault => assertContractDeployed(client, vault, 'VAULT_WHITELIST entry'),
      fetchVault: vault =>
        fetchVaultV2Data(client, vault, {
          chainId: config.chainId,
          blockNumber: startupBlock,
          eoa
        }),
      isAdapter: (vault, adapter) =>
        readContract(client, {
          address: vault,
          abi: vaultV2Abi,
          functionName: 'isAdapter',
          args: [adapter]
        })
    },
    logger
  )

  // Default-deny pre-broadcast guard: only value-0 multicall(bytes[]) calls to whitelisted vaults
  // whose every inner leg is allocate/deallocate to that vault's own adapter, under the
  // fee/gas/size ceilings, are ever signed (see @repo/bot-kit `evaluatePolicy`).
  const signer = createSigner({
    chain: config.chain,
    rpcUrl: config.rpcUrl,
    rpcUrlFallback: config.rpcUrlFallback,
    privateKey: config.reallocatorPrivateKey,
    policy: {
      chainId: config.chainId,
      targets: config.vaultWhitelist,
      maxFeePerGasWei: config.maxFeeWei,
      maxGasLimit: DEFAULT_MAX_GAS_LIMIT,
      maxDataBytes: DEFAULT_MAX_DATA_BYTES,
      selector: toFunctionSelector(getAbiItem({ abi: vaultV2Abi, name: 'multicall' })),
      multicall: {
        innerSelectors: [
          toFunctionSelector(getAbiItem({ abi: vaultV2Abi, name: 'allocate' })),
          toFunctionSelector(getAbiItem({ abi: vaultV2Abi, name: 'deallocate' }))
        ],
        innerTargetsByOuter: adapterByVault
      }
    },
    logger
  })

  logger.info('startup', {
    chainId: config.chainId,
    reallocator: eoa,
    vaults: config.vaultWhitelist,
    adapters: adapterByVault,
    strategy: config.strategy,
    intervalMs: config.reallocationIntervalMs,
    dryRun: config.dryRun
  })

  const queue = createPendingQueue({
    send: signer.send,
    getReceipt: signer.getReceipt,
    getBaseFee: signer.getBaseFee,
    getConsumedNonce: signer.consumedNonce,
    syncNonce: signer.syncNonce,
    maxFeeWei: config.maxFeeWei,
    logger,
    settledCooldownBlocks: SETTLED_COOLDOWN_BLOCKS,
    revertReason
  })

  const balanceMonitor = createBalanceMonitor({ address: eoa, read: signer.balance, logger })
  const heartbeatMonitor = createHeartbeatMonitor({
    url: process.env.BETTERSTACK_HEARTBEAT_URL,
    logger
  })
  void heartbeatMonitor.start()

  const strategy = createStrategy(config)

  // The block watcher drives one tick per new block; the time gate throttles actual reallocation
  // passes to the configured cadence (queue maintenance still runs every block via `maintain`). A
  // plan is built, simulated, and submitted within a single tick — no unsent plan survives it.
  const intervalGate = createIntervalGate(config.reallocationIntervalMs)
  const tick = async (chainHead: bigint) => {
    if (!intervalGate()) return
    await runTick({
      vaults: config.vaultWhitelist,
      chainHead,
      expectedAdapter: vault => adapterByVault[vault]?.[0],
      fetchVault: (vault, blockNumber) =>
        fetchVaultV2Data(client, vault, { chainId: config.chainId, blockNumber, eoa }),
      strategy,
      encodeReallocation: (vaultData, reallocation) =>
        encodeReallocation(vaultData.adapterAddress, reallocation),
      // Byte-for-byte what gets broadcast. A revert here — role revoked, cap exceeded, insufficient
      // idle, market no longer enabled — means do not send; the tick gates on `ok` only.
      simulate: (vault, data) => simulateCall(client, { eoa, to: vault, data }),
      submit: async ({ vault, data, blockNumber }) => {
        const fees = initialFees(await signer.getBaseFee(), config.maxFeeWei)
        return queue.submit({
          request: { to: vault, data },
          label: vault,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          blockNumber
        })
      },
      dryRun: config.dryRun,
      inflightLabels: () => queue.inflightLabels(),
      revertReason,
      logger
    })
  }

  // Per-block maintenance, run by the runner BEFORE the tick and independently of it: pending-queue
  // upkeep (confirmations / stuck-detection / fee-bumps / nonce reconciliation) plus the periodic
  // EOA-balance metric — a sustained read outage can't starve broadcast txs of receipt checks.
  const maintain = async (blockNumber: bigint) => {
    await queue.onBlock(blockNumber)
    await balanceMonitor.maybeLog(blockNumber)
  }

  const runner = createRunner({
    getBlockNumber: () => getBlockNumber(client),
    tick,
    maintain,
    logger,
    revertReason
  })
  runner.start()

  // Graceful shutdown: stop the watcher and log the pending set. Sends are fire-and-forget and
  // chain truth wins on restart, so there is nothing to persist or await-drain.
  const shutdown = (signal: string) => {
    heartbeatMonitor.stop()
    logger.info('shutdown', { signal, pending: queue.snapshot() })
    void runner.stop().finally(() => process.exit(0))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch(error => {
  // Config/client never came up, so we cannot honor LOG_LEVEL — emit the failure directly.
  console.error(
    JSON.stringify({ level: 'error', event: 'startup.error', error: ensureError(error).message })
  )
  process.exitCode = 1
})
