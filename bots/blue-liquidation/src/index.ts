import type { Address, Hex } from 'viem'

import { ensureError, tryCatch } from '@repo/utils'
import { getAddress } from 'viem'
import { getBlockNumber } from 'viem/actions'

import type { SwapConfigEntry } from './config'
import type { MarketParams } from './market'
import type { Swap, Venue } from './quotes/types'
import type { LiquidationPlan } from './sizing/plan'

import { assertContractDeployed, createDeploylessClient } from './client'
import { loadConfig } from './config'
import {
  createPostgresQuery,
  discoverCandidates,
  discoveryDiagnostics,
  rindexerSyncedBlock
} from './discovery/borrowers'
import { encodeLiquidationExec } from './execution/encode-call'
import { simulateLiquidationExec } from './execution/simulate'
import { createLogger } from './logger'
import { createBackoff } from './queue/backoff'
import { initialFees } from './queue/fee-policy'
import { createPendingQueue } from './queue/pending-queue'
import { composeQuoting } from './quotes'
import { createRateLimitedClient } from './quotes/http-client'
import { createRunner } from './runner/runner'
import { runTick } from './runner/tick'
import { createSigner } from './signer'
import { readBlueLiquidationLens } from './state/lens.sol'
import { createMarketParamsResolver, multicallIdToMarketParams } from './state/market-params'

async function main() {
  const config = loadConfig()
  const logger = createLogger(config.logLevel)

  // Signed-send path: a plain wallet client + local nonce cursor (separate from the deployless read
  // client). The EOA is the liquidator and the recipient of both end-of-exec token sweeps.
  const signer = createSigner(config)
  const eoa = signer.account.address

  logger.info('startup', {
    chainId: config.chainId,
    liquidator: eoa,
    callback: config.executooorAddress,
    morpho: config.morpho
  })

  // Read-only client shared by the lens and simulate paths. Validate both the Executor and the Morpho
  // singleton hold code before doing any work — fatal on a typo / not-yet-deployed address (liveness,
  // not identity).
  const client = createDeploylessClient(config)
  await assertContractDeployed(
    client,
    config.executooorAddress,
    'EXECUTOOOR_ADDRESS',
    'deploy it with `bun run --filter @repo/contracts deploy:executor`'
  )
  await assertContractDeployed(client, config.morpho, 'Morpho singleton')

  // Per-collateral swap routing for this chain, keyed by EIP-55-checksummed collateral address (the
  // config schema and the lens both return checksummed addresses). A collateral with no entry is
  // skipped at tick time (`config.no_swap_path`) — a coverage gap, not fatal.
  const swapByCollateral = new Map<string, SwapConfigEntry>()
  for (const [token, entry] of Object.entries(config.swapConfig[String(config.chainId)] ?? {})) {
    if (entry) swapByCollateral.set(getAddress(token), entry)
  }
  // No routes configured for this chain (unset/absent swap config): the bot still runs — it
  // identifies liquidatable borrowers — but skips every routed liquidation (`config.no_swap_path`).
  // Warn loudly so this isn't mistaken for a healthy, fully armed deployment. Otherwise log the
  // chosen venue per collateral.
  if (swapByCollateral.size === 0) {
    logger.warn('swap_config.no_routes', {
      chainId: config.chainId,
      detail: 'no swap routes configured — every liquidation will be skipped (config.no_swap_path)'
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
    market: MarketParams,
    borrower: Address,
    plan: LiquidationPlan,
    swap: Swap
  ): Hex =>
    encodeLiquidationExec({
      executor: config.executooorAddress,
      morpho: config.morpho,
      market,
      seizedAssets: plan.seizedAssets,
      borrower,
      swap,
      recipient: eoa
    })

  const query = createPostgresQuery(config.databaseUrl)
  // Discovery is (id, borrower) from the indexed Borrow events; the market's immutable params are
  // recovered on-chain via idToMarketParams(id) and cached (params never change per id), so
  // steady-state ticks make no extra RPC calls once every market has been seen once.
  const resolveParams = createMarketParamsResolver(multicallIdToMarketParams(client, config.morpho))
  const discover = () => discoverCandidates(query, resolveParams)

  // Startup discovery self-check (non-fatal): surface the rindexer schema + first discovery result so
  // a column-name mismatch or a not-yet-migrated table is diagnosable from Railway logs at boot,
  // rather than as an opaque per-tick `tick.error`. rindexer may still be starting/migrating on first
  // deploy, so a failure here is logged and the bot proceeds — the per-block tick retries discovery.
  {
    const diag = await tryCatch(discoveryDiagnostics(query))
    if (diag.error) {
      logger.warn('discovery.startup_error', { detail: ensureError(diag.error).message })
    } else {
      logger.info('discovery.schema', {
        // The ACTUAL rindexer `borrow` column names — compare against what BORROWER_IDS_SQL selects
        // if discovery yields zero candidates while rindexer is synced.
        borrow: diag.data.borrow
      })
      const probe = await tryCatch(Promise.all([discover(), rindexerSyncedBlock(query)]))
      if (probe.error) {
        logger.warn('discovery.startup_error', { detail: ensureError(probe.error).message })
      } else {
        const [candidates, syncedBlock] = probe.data
        logger.info('discovery.startup', {
          candidates: candidates.length,
          syncedBlock,
          // A sample so the join's parsed MarketParams can be eyeballed (non-zero addresses/lltv).
          sample: candidates[0] ?? null
        })
      }
    }
  }

  const queue = createPendingQueue({
    send: signer.send,
    getReceipt: signer.getReceipt,
    getBaseFee: signer.getBaseFee,
    maxFeeWei: config.maxFeeWei,
    logger
  })

  // An HTTP block-poll watcher drives one tick per new block (coalescing backlog), passing the polled
  // height as both the rindexer-lag reference and the queue's submittedAtBlock. Each liquidatable
  // position resolves its swap, simulates the real `exec_606BaXt`, and — on a sim-ok result —
  // broadcasts that same exec via the Executor singleton, then drives queue.onBlock.
  const tick = (chainHead: bigint) =>
    runTick({
      discover,
      syncedBlock: () => rindexerSyncedBlock(query),
      chainHead,
      readLens: pairs => readBlueLiquidationLens(client, config.morpho, pairs),
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

  const runner = createRunner({ getBlockNumber: () => getBlockNumber(client), tick, logger })
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
