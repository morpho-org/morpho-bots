import { ensureError } from '@repo/utils'
import { getBlockNumber } from 'viem/actions'

import { assertContractDeployed, createDeploylessClient } from './chain/client'
import { createSigner } from './chain/signer'
import { loadConfig } from './config'
import { createDaemon } from './daemon/daemon'
import { runTick } from './daemon/tick'
import { createPostgresQuery, discoverBorrowers, rindexerSyncedBlock } from './discovery/borrowers'
import { encodeDummyLiquidate } from './execution/encode-call'
import { simulateLiquidate } from './execution/simulate'
import { readMidnightLiquidationLens } from './lens/lens.sol'
import { createLogger } from './logger'
import { initialFees } from './queue/fee-policy'
import { createPendingQueue } from './queue/pending-queue'

async function main() {
  const config = loadConfig()
  const logger = createLogger(config.logLevel)

  // Signed-send path: a plain wallet client + nonce manager (separate from the deployless read
  // client). The EOA address doubles as the liquidator + the dummy-liquidate receiver.
  const signer = createSigner(config)
  const eoa = signer.account.address

  logger.info('startup', {
    chainId: config.chainId,
    liquidator: eoa,
    callback: config.executooorAddress,
    midnight: config.midnight
  })

  // Read-only client shared by the lens and simulate paths. Validate EXECUTOOOR_ADDRESS holds code
  // before doing any work — fatal on a typo / not-yet-deployed address (liveness, not identity).
  const client = createDeploylessClient(config)
  await assertContractDeployed(client, config.executooorAddress, 'EXECUTOOOR_ADDRESS')

  const query = createPostgresQuery(config.databaseUrl)
  const discover = () => discoverBorrowers(query)
  const queue = createPendingQueue({
    send: signer.send,
    getReceipt: signer.getReceipt,
    getBaseFee: signer.getBaseFee,
    maxFeeWei: config.maxFeeWei,
    logger
  })

  // Phase-3 daemon: an HTTP block-poll watcher drives one tick per new block (coalescing backlog),
  // passing the polled height as both the rindexer-lag reference and the queue's submittedAtBlock.
  // The tick submits structurally-valid plans (Phase 3: a deterministically-reverting dummy that
  // moves no funds — see encodeDummyLiquidate) and drives the queue's onBlock.
  const tick = (chainHead: bigint) =>
    runTick({
      discover,
      syncedBlock: () => rindexerSyncedBlock(query),
      chainHead,
      caller: config.executooorAddress,
      readLens: pairs => readMidnightLiquidationLens(client, config.midnight, pairs),
      simulate: args =>
        simulateLiquidate(client, {
          midnight: config.midnight,
          executooor: config.executooorAddress,
          ...args
        }),
      submit: async ({ market, borrower, plan, blockNumber, label }) => {
        const fees = initialFees(await signer.getBaseFee(), config.maxFeeWei)
        await queue.submit({
          request: {
            to: config.midnight,
            data: encodeDummyLiquidate({ market, borrower, eoa, plan })
          },
          label,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          blockNumber
        })
      },
      pendingOnBlock: blockNumber => queue.onBlock(blockNumber),
      inflightLabels: () => queue.inflightLabels(),
      logger
    })

  const daemon = createDaemon({ getBlockNumber: () => getBlockNumber(client), tick, logger })
  daemon.start()

  // Graceful shutdown: stop the watcher and dump the pending set (hashes + nonces). Sends are
  // fire-and-forget and chain truth wins on restart, so there is nothing to await-drain.
  const shutdown = (signal: string) => {
    logger.info('shutdown', { signal, pending: queue.snapshot() })
    void daemon.stop().finally(() => process.exit(0))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch(error => {
  // Config/client never came up, so we cannot honor LOG_LEVEL — emit the failure directly, exit non-zero.
  console.error(
    JSON.stringify({ level: 'error', event: 'startup.error', error: ensureError(error).message })
  )
  process.exitCode = 1
})
