import type { SwapConfigEntry, Swap, Venue } from '@repo/swaps'
import type { Address, Hex } from 'viem'

import {
  assertContractDeployed,
  createBackoff,
  createDeploylessClient,
  createLogger,
  createPendingQueue,
  createRunner,
  createSigner,
  initialFees,
  simulateLiquidationExec
} from '@repo/bot-kit'
import { createRateLimitedClient } from '@repo/swaps'
import { ensureError } from '@repo/utils'
import { getAddress } from 'viem'
import { getBlockNumber } from 'viem/actions'

import type { Market } from './execution/encode-call'
import type { LiquidationPlan } from './sizing/plan'

import { loadConfig } from './config'
import { SETTLED_COOLDOWN_BLOCKS } from './constants'
import { createPostgresQuery, discoverBorrowers, rindexerSyncedBlock } from './discovery/borrowers'
import { encodeLiquidationExec } from './execution/encode-call'
import { composeQuoting } from './quotes'
import { runTick } from './runner/tick'
import { readMidnightLiquidationLens } from './state/lens.sol'
import { revertReason } from './tx-error'

async function main() {
  const config = loadConfig()
  const logger = createLogger(config.logLevel)

  // Signed-send path: a plain wallet client + local nonce cursor (separate from the deployless read
  // client). The EOA is the liquidator and the recipient of both end-of-exec token sweeps.
  const signer = createSigner({
    chain: config.chain,
    rpcUrl: config.rpcUrl,
    rpcUrlFallback: config.rpcUrlFallback,
    sendRpcUrl: config.sendRpcUrl,
    privateKey: config.liquidatorPrivateKey
  })
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
  await assertContractDeployed(
    client,
    config.executooorAddress,
    'EXECUTOOOR_ADDRESS',
    'deploy it with `bun run --filter @repo/contracts deploy:executor`'
  )

  // Per-collateral swap routing for this chain, keyed by EIP-55-checksummed collateral address (the
  // config schema and the lens both return checksummed addresses). A collateral with no entry is
  // skipped at tick time (`config.no_swap_path`) — a coverage gap, not fatal.
  const swapByCollateral = new Map<string, SwapConfigEntry>()
  for (const [token, entry] of Object.entries(config.swapConfig[String(config.chainId)] ?? {})) {
    if (entry) swapByCollateral.set(getAddress(token), entry)
  }
  // No routes configured for this chain (unset/absent swap config): the bot still runs — it
  // identifies liquidatable borrowers and realizes pure bad debt — but skips every routed
  // liquidation (`config.no_swap_path`). Warn loudly so this isn't mistaken for a healthy, fully
  // armed deployment. Otherwise log the chosen venue per collateral.
  if (swapByCollateral.size === 0) {
    logger.warn('swap_config.no_routes', {
      chainId: config.chainId,
      detail:
        'no swap routes configured — routed liquidations will be skipped (bad-debt realization still runs)'
    })
  } else {
    logger.info('quoting.startup', {
      chainId: config.chainId,
      venues: Object.fromEntries(
        [...swapByCollateral].map(([token, entry]) => [token, entry.venue])
      )
    })
  }

  // Rate-limited HTTP client for aggregator quotes. API keys are read from env HERE, at the point of
  // use, and live only in this closure — never on the (logged) Config object.
  const apiKeys: Partial<Record<Venue, string>> = {}
  if (Bun.env.ZEROX_API_KEY) apiKeys['0x'] = Bun.env.ZEROX_API_KEY
  if (Bun.env.ONEINCH_API_KEY) apiKeys['1inch'] = Bun.env.ONEINCH_API_KEY
  const httpClient = createRateLimitedClient({
    apiKeys,
    rps: config.quoting.httpRps,
    burst: config.quoting.httpBurst,
    maxRetries: config.quoting.httpMaxRetries,
    timeoutMs: config.quoting.quoteTimeoutMs
  })
  const { quoteFor } = composeQuoting({
    httpClient,
    chainId: config.chainId,
    executor: config.executooorAddress,
    swapByCollateral,
    maxRouteImpactBps: config.quoting.maxRouteImpactBps,
    logger
  })
  const backoff = createBackoff({
    baseBlocks: config.quoting.backoffBaseBlocks,
    maxBlocks: config.quoting.backoffMaxBlocks
  })

  // The exec calldata for one liquidation — the same bytes the simulate gate checks and the queue
  // broadcasts, so a sim-ok plan and its broadcast can't drift.
  const encodeExec = (
    market: Market,
    borrower: Address,
    plan: LiquidationPlan,
    swap: Swap | null
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
      swap,
      recipient: eoa
    })

  const query = createPostgresQuery(config.databaseUrl)
  const discover = () => discoverBorrowers(query)
  const queue = createPendingQueue({
    send: signer.send,
    getReceipt: signer.getReceipt,
    getBaseFee: signer.getBaseFee,
    syncNonce: signer.syncNonce,
    maxFeeWei: config.maxFeeWei,
    logger,
    settledCooldownBlocks: SETTLED_COOLDOWN_BLOCKS,
    revertReason
  })

  // Phase-4 runner: an HTTP block-poll watcher drives one tick per new block (coalescing backlog),
  // passing the polled height as both the rindexer-lag reference and the queue's submittedAtBlock.
  // Each liquidatable position resolves its swap step, simulates the real `exec_606BaXt`, and — on a
  // sim-ok result — broadcasts that same exec via the Executor singleton, then drives queue.onBlock.
  const tick = (chainHead: bigint) =>
    runTick({
      discover,
      syncedBlock: () => rindexerSyncedBlock(query),
      chainHead,
      caller: config.executooorAddress,
      seizeCapMarginBps: config.quoting.seizeCapMarginBps,
      readLens: pairs => readMidnightLiquidationLens(client, config.midnight, pairs),
      quoteFor,
      simulate: ({ market, borrower, plan, swap }) =>
        simulateLiquidationExec(client, {
          executooor: config.executooorAddress,
          eoa,
          data: encodeExec(market, borrower, plan, swap)
        }),
      submit: async ({ market, borrower, plan, swap, blockNumber, label }) => {
        const fees = initialFees(await signer.getBaseFee(), config.maxFeeWei)
        await queue.submit({
          request: {
            to: config.executooorAddress,
            data: encodeExec(market, borrower, plan, swap)
          },
          label,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          blockNumber
        })
      },
      backoff,
      pendingOnBlock: blockNumber => queue.onBlock(blockNumber),
      inflightLabels: () => queue.inflightLabels(),
      logger
    })

  const runner = createRunner({
    getBlockNumber: () => getBlockNumber(client),
    tick,
    logger,
    revertReason
  })
  runner.start()

  // Graceful shutdown: stop the watcher and dump the pending set (hashes + nonces). Sends are
  // fire-and-forget and chain truth wins on restart, so there is nothing to await-drain.
  const shutdown = (signal: string) => {
    logger.info('shutdown', { signal, pending: queue.snapshot() })
    void runner.stop().finally(() => process.exit(0))
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
