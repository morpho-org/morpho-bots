import type { Address } from 'viem'

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
import { ensureError, tryCatch } from '@repo/utils'
import { getAbiItem, toFunctionSelector } from 'viem'
import { getBlockNumber, readContract } from 'viem/actions'

import { loadConfig } from './config'
import { encodeReallocation } from './encode'
import { InvalidVaultError } from './invalid-vault.error'
import { runTick } from './runner/tick'
import { createStrategy } from './strategies'
import { revertReason } from './tx-error'
import { fetchVaultV2Data } from './vault-data'

// Blocks a vault stays in the queue's backpressure set AFTER its tx settles, suppressing an
// immediate re-plan from a read RPC that lags the send RPC's confirmation.
const SETTLED_COOLDOWN_BLOCKS = 20n

async function main() {
  const config = loadConfig()
  // Global wide-log context stamped onto every line: the bot identity + chain, plus whichever
  // RAILWAY_* identity vars this deployment exposes.
  const logger = createLogger(config.logLevel, {
    context: { bot: 'vault-v2-reallocation', chainId: config.chainId, ...railwayContext() }
  })

  const client = createDeploylessClient(config)

  // Startup vault validation, which also gathers the adapter set the signing policy binds to:
  // fetchVaultV2Data proves each whitelisted address is a factory-made VaultV2 with exactly one
  // MorphoMarketV1 adapter (typed InvalidVaultError otherwise — fatal, since the policy authorizes
  // the address as a tx target). isAdapter is a cheap cross-check that the vault recognizes it.
  const startupBlock = await getBlockNumber(client)
  const adapterByVault: Record<Address, readonly Address[]> = {}
  for (const vault of config.vaultWhitelist) {
    await assertContractDeployed(client, vault, 'VAULT_WHITELIST entry')
    const vaultData = await fetchVaultV2Data(client, vault, {
      chainId: config.chainId,
      blockNumber: startupBlock
    })
    const recognized = await readContract(client, {
      address: vault,
      abi: vaultV2Abi,
      functionName: 'isAdapter',
      args: [vaultData.adapterAddress]
    })
    if (!recognized) {
      throw new InvalidVaultError(
        `vault ${vault} does not recognize adapter ${vaultData.adapterAddress}`
      )
    }
    adapterByVault[vault] = [vaultData.adapterAddress]
  }

  // Signed-send path: a plain wallet client + local nonce cursor (separate from the read client).
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
      executor: config.vaultWhitelist,
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
  const eoa = signer.account.address

  logger.info('startup', {
    chainId: config.chainId,
    reallocator: eoa,
    vaults: config.vaultWhitelist,
    adapters: adapterByVault,
    strategy: config.strategy,
    intervalMs: config.reallocationIntervalMs,
    dryRun: config.dryRun
  })

  // The allocator role is probed non-fatally: a pending grant must not crash-loop the bot; the tick
  // re-checks and resumes on its own. Unlike MetaMorpho V1's onlyAllocatorRole, VaultV2.allocate
  // requires isAllocator[msg.sender] strictly — curator/owner do NOT implicitly qualify, so the
  // check is deliberately narrower than the V1 bot's.
  const isAllocator = (vault: Address) =>
    readContract(client, {
      address: vault,
      abi: vaultV2Abi,
      functionName: 'isAllocator',
      args: [eoa]
    })
  for (const vault of config.vaultWhitelist) {
    const role = await tryCatch(isAllocator(vault))
    if (role.error || !role.data) {
      logger.warn('allocator.missing_role', {
        vault,
        detail: 'grant the allocator role to the EOA'
      })
    }
  }

  // Transaction-queue state is in-memory only — chain truth wins on restart. A redeploy re-derives
  // the nonce cursor from `getTransactionCount('pending')`, and any tx that was in flight settles
  // on-chain regardless of the bot; settlement audit ships via the structured `tx.*` log events.
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
  let lastRunMs = 0
  const tick = async (chainHead: bigint) => {
    if (Date.now() - lastRunMs < config.reallocationIntervalMs) return
    lastRunMs = Date.now()
    await runTick({
      vaults: config.vaultWhitelist,
      chainHead,
      isAllocator,
      expectedAdapter: vault => adapterByVault[vault]?.[0],
      fetchVault: (vault, blockNumber) =>
        fetchVaultV2Data(client, vault, { chainId: config.chainId, blockNumber }),
      strategy,
      encodeReallocation: (vaultData, reallocation) =>
        encodeReallocation(vaultData.adapterAddress, reallocation),
      // Byte-for-byte what gets broadcast. A revert here — role revoked, cap exceeded, insufficient
      // idle, market no longer enabled — means do not send; the tick gates on `ok` only.
      simulate: (vault, data) => simulateCall(client, { eoa, to: vault, data }),
      submit: async ({ vault, data, blockNumber }) => {
        const fees = initialFees(await signer.getBaseFee(), config.maxFeeWei)
        await queue.submit({
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
