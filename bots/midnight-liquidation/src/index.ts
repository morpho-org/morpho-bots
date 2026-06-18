import type { Address, Hex } from 'viem'

import { ensureError } from '@repo/utils'
import { getBlockNumber } from 'viem/actions'

import type { Market, SwapStep } from './execution/encode-call'
import type { SwapConfigEntry } from './execution/swap-step'
import type { LiquidationPlan } from './sizing/plan'
import type { LensOut } from './state/lens.sol'

import { assertContractDeployed, createDeploylessClient } from './client'
import { loadConfig } from './config'
import { createDaemon } from './daemon/daemon'
import { runTick } from './daemon/tick'
import { createPostgresQuery, discoverBorrowers, rindexerSyncedBlock } from './discovery/borrowers'
import { encodeLiquidationExec } from './execution/encode-call'
import { simulateLiquidationExec } from './execution/simulate'
import { buildSwapStep } from './execution/swap-step'
import { createLogger } from './logger'
import { initialFees } from './queue/fee-policy'
import { createPendingQueue } from './queue/pending-queue'
import { createSigner } from './signer'
import { readMidnightLiquidationLens } from './state/lens.sol'

async function main() {
  const config = loadConfig()
  const logger = createLogger(config.logLevel)

  // Signed-send path: a plain wallet client + nonce manager (separate from the deployless read
  // client). The EOA is the liquidator and the recipient of both end-of-exec token sweeps.
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

  // Per-collateral swap routing for this chain, normalized to lowercase token keys for lookup. A
  // collateral with no entry is skipped at tick time (`config.no_swap_path`) — a coverage gap, not fatal.
  const swapByCollateral = new Map<string, SwapConfigEntry>()
  for (const [token, entry] of Object.entries(config.swapConfig[String(config.chainId)] ?? {})) {
    if (entry) swapByCollateral.set(token.toLowerCase(), entry)
  }
  const swapStepFor = (plan: LiquidationPlan, out: LensOut): SwapStep | null => {
    const collateral = out.market.collateralParams[plan.collateralIndex]
    if (!collateral) return null
    const entry = swapByCollateral.get(collateral.token.toLowerCase())
    return entry ? buildSwapStep(entry, plan, out) : null
  }

  // The exec calldata for one liquidation — the same bytes the simulate gate checks and the queue
  // broadcasts, so a sim-ok plan and its broadcast can't drift.
  const encodeExec = (
    market: Market,
    borrower: Address,
    plan: LiquidationPlan,
    swapStep: SwapStep
  ): Hex =>
    encodeLiquidationExec({
      executor: config.executooorAddress,
      midnight: config.midnight,
      market,
      collateralIndex: plan.collateralIndex,
      seizedAssets: plan.seizedAssets,
      repaidUnits: plan.repaidUnits,
      borrower,
      postMaturityMode: plan.postMaturityMode,
      swapStep,
      recipient: eoa
    })

  const query = createPostgresQuery(config.databaseUrl)
  const discover = () => discoverBorrowers(query)
  const queue = createPendingQueue({
    send: signer.send,
    getReceipt: signer.getReceipt,
    getBaseFee: signer.getBaseFee,
    maxFeeWei: config.maxFeeWei,
    logger
  })

  // Phase-4 daemon: an HTTP block-poll watcher drives one tick per new block (coalescing backlog),
  // passing the polled height as both the rindexer-lag reference and the queue's submittedAtBlock.
  // Each liquidatable position resolves its swap step, simulates the real `exec_606BaXt`, and — on a
  // sim-ok result — broadcasts that same exec via the Executor singleton, then drives queue.onBlock.
  const tick = (chainHead: bigint) =>
    runTick({
      discover,
      syncedBlock: () => rindexerSyncedBlock(query),
      chainHead,
      caller: config.executooorAddress,
      readLens: pairs => readMidnightLiquidationLens(client, config.midnight, pairs),
      swapStepFor,
      simulate: ({ market, borrower, plan, swapStep }) =>
        simulateLiquidationExec(client, {
          executooor: config.executooorAddress,
          eoa,
          data: encodeExec(market, borrower, plan, swapStep)
        }),
      submit: async ({ market, borrower, plan, swapStep, blockNumber, label }) => {
        const fees = initialFees(await signer.getBaseFee(), config.maxFeeWei)
        await queue.submit({
          request: {
            to: config.executooorAddress,
            data: encodeExec(market, borrower, plan, swapStep)
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
