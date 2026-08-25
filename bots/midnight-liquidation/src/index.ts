import type { SwapPlan, Venue } from '@repo/swaps'
import type { Address, Hex } from 'viem'

import {
  assertContractDeployed,
  createBalanceMonitor,
  createBackoff,
  createCooldownStore,
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
  simulateLiquidationExec
} from '@repo/bot-kit'
import {
  createErc4626Unwrapper,
  createPendlePtUnwrapper,
  createRateLimitedClient,
  createVenueSelector,
  PENDLE_CHAIN_IDS,
  priceByVenue
} from '@repo/swaps'
import { delay, ensureError, tryCatch } from '@repo/utils'
import { erc20Abi } from 'viem'
import { getBlockNumber, readContract } from 'viem/actions'

import type { Market } from './execution/encode-call'
import type { LiquidationPlan } from './sizing/plan'

import { loadConfig } from './config'
import { LISTED_MARKETS_MAX_AGE_MS, SETTLED_COOLDOWN_BLOCKS } from './constants'
import {
  createApiCandidateSource,
  discoverBorrowers,
  MAX_DISCOVERY_PAGES
} from './discovery/borrowers'
import { createListedMarketFilter, createUnionListedMarketFilter } from './discovery/markets'
import { encodeLiquidationExec } from './execution/encode-call'
import { composeQuoting } from './quotes'
import { runTick } from './runner/tick'
import { readMidnightLiquidationLens } from './state/lens.sol'
import { revertReason } from './tx-error'

async function main() {
  const config = loadConfig()
  // Global wide-log context stamped onto every line (replaces the enrichment the retired Vector VRL
  // did): the bot identity + chain, plus whichever RAILWAY_* identity vars this deployment exposes.
  const logger = createLogger(config.logLevel, {
    context: { bot: 'midnight-liquidation', chainId: config.chainId, ...railwayContext() }
  })

  // Signed-send path: a plain wallet client + local nonce cursor (separate from the deployless read
  // client). The EOA is the liquidator and the recipient of both end-of-exec token sweeps.
  const signer = createSigner({
    chain: config.chain,
    rpcUrl: config.rpcUrl,
    rpcUrlFallback: config.rpcUrlFallback,
    privateKey: config.liquidatorPrivateKey,
    // Default-deny pre-broadcast guard: only value-0 exec_606BaXt calls to this bot's Executor,
    // under the fee/gas/size ceilings, are ever signed (see @repo/bot-kit `evaluatePolicy`).
    policy: {
      chainId: config.chainId,
      targets: [config.executooorAddress],
      maxFeePerGasWei: config.maxFeeWei,
      maxGasLimit: DEFAULT_MAX_GAS_LIMIT,
      maxDataBytes: DEFAULT_MAX_DATA_BYTES
    },
    logger
  })
  const eoa = signer.account.address

  logger.info('startup', {
    chainId: config.chainId,
    liquidator: eoa,
    callback: config.executooorAddress,
    midnight: config.midnight
  })

  // Read-only client shared by the lens and simulate paths. Validate both the Executor and the
  // Midnight singleton hold code before doing any work — fatal on a typo / not-yet-deployed address
  // (liveness, not identity).
  const client = createDeploylessClient(config)
  await assertContractDeployed(
    client,
    config.executooorAddress,
    'EXECUTOOOR_ADDRESS',
    'deploy it with `pnpm --filter @repo/contracts run deploy:executor`'
  )
  await assertContractDeployed(client, config.midnight, 'Midnight singleton')

  // Enabled venues are inferred from which venue API keys are present (loadConfig already enforced the
  // no-key → bad-debt-only opt-in). Keys are read HERE, at the point of use, and live only in this
  // closure — never on the (logged) Config object.
  const apiKeys: Partial<Record<Venue, string>> = {}
  if (process.env.ZEROX_API_KEY) apiKeys['0x'] = process.env.ZEROX_API_KEY
  if (process.env.ONEINCH_API_KEY) apiKeys['1inch'] = process.env.ONEINCH_API_KEY
  if (process.env.LIFI_API_KEY) apiKeys.lifi = process.env.LIFI_API_KEY
  const venues = config.venues.enabled
  if (venues.length === 0) {
    logger.warn('quoting.no_routes', {
      chainId: config.chainId,
      detail:
        'no venue API keys set — running bad-debt-only (positions discovered, bad debt realized, no swap-liquidations)'
    })
  } else {
    logger.info('quoting.startup', { chainId: config.chainId, venues })
  }
  const baseUrls: Partial<Record<Venue, string>> = {}
  if (config.venues.zeroxBaseUrl) baseUrls['0x'] = config.venues.zeroxBaseUrl
  if (config.venues.oneinchBaseUrl) baseUrls['1inch'] = config.venues.oneinchBaseUrl
  if (config.venues.lifiBaseUrl) baseUrls.lifi = config.venues.lifiBaseUrl

  // Two rate-limited HTTP clients, each with its own per-venue token buckets: one for time-sensitive
  // FIRM quotes, and a separate, slower one for BACKGROUND probes — so a probe burst can never queue
  // ahead of a live liquidation's firm quote on the same venue's bucket.
  const httpClient = createRateLimitedClient({
    apiKeys,
    rps: config.quoting.httpRps,
    burst: config.quoting.httpBurst,
    maxRetries: config.quoting.httpMaxRetries,
    timeoutMs: config.quoting.quoteTimeoutMs
  })
  const probeClient = createRateLimitedClient({
    apiKeys,
    rps: config.probe.httpRps,
    burst: config.probe.httpRps,
    maxRetries: config.quoting.httpMaxRetries,
    timeoutMs: config.quoting.quoteTimeoutMs
  })

  // Venue selector: caches a best-first venue ranking per pair from log-scaled indicative probes.
  // Decimals are read once per collateral (memoized in the selector); the collateral set is bounded by
  // the listed markets, so these are a handful of one-off reads over the process lifetime.
  const venueSelector = createVenueSelector({
    venues,
    chainId: config.chainId,
    ladderWholeTokens: config.probe.ladderWholeTokens,
    getDecimals: token =>
      readContract(client, { address: token, abi: erc20Abi, functionName: 'decimals' }),
    indicativeQuote: (venue, params) => priceByVenue(probeClient, { venue, baseUrls, params }),
    staleMs: config.probe.staleMs,
    logger
  })

  // Market whitelist: only listed markets are discovered / probed / liquidated. One filter per
  // configured markets source, unioned — the union applies the max-age rule PER SOURCE, so a source
  // that goes down or goes stale drops out of the whitelist instead of emptying it. Refresh once at
  // startup (non-fatal — a failed first fetch leaves the set empty = fail-closed, and the timer below
  // retries), then poll on an interval.
  const listedMarkets = createUnionListedMarketFilter({
    filters: config.markets.apiUrls.map(apiUrl =>
      createListedMarketFilter({ apiUrl, chainId: config.chainId, logger })
    ),
    chainId: config.chainId,
    maxAgeMs: LISTED_MARKETS_MAX_AGE_MS,
    logger
  })
  await tryCatch(listedMarkets.refresh())

  // Pre-swap converters for exotic collateral (ERC4626 shares, Pendle PTs → underlying).
  // Auto-detecting with per-process memoization. erc4626 first: a memoized eth_call beats consulting
  // the markets list. Pendle is only constructed on chains it is deployed to — elsewhere a
  // cold-cache markets outage would fail plain-collateral quotes too. The Pendle markets list is
  // cached in-process for the bot's lifetime (a 6h TTL inside the unwrapper handles staleness), so
  // it is built once here.
  const pendle = PENDLE_CHAIN_IDS.has(config.chainId)
    ? createPendlePtUnwrapper({
        client: httpClient,
        chainId: config.chainId,
        slippageBps: config.quoting.pendleSlippageBps,
        logger
      })
    : null
  const unwrappers = [createErc4626Unwrapper({ client, logger }), ...(pendle ? [pendle] : [])]

  const { quoteFor } = composeQuoting({
    httpClient,
    selector: venueSelector,
    chainId: config.chainId,
    executor: config.executooorAddress,
    venues,
    slippageBps: config.venues.slippageBps,
    baseUrls,
    maxRouteImpactBps: config.quoting.maxRouteImpactBps,
    unwrappers,
    excludeCollaterals: config.venues.excludeCollaterals,
    logger
  })
  const backoff = createBackoff({
    baseBlocks: config.quoting.backoffBaseBlocks,
    maxBlocks: config.quoting.backoffMaxBlocks
  })
  // Opt-in per-position cooldown (default disabled): one in-memory store for the process lifetime,
  // complementary to `backoff` (see POSITION_LIQUIDATION_COOLDOWN_MS).
  const cooldown = createCooldownStore({ cooldownMs: config.positionCooldownMs })

  // The exec calldata for one liquidation — the same bytes the simulate gate checks and the queue
  // broadcasts, so a sim-ok plan and its broadcast can't drift.
  const encodeExec = (
    market: Market,
    borrower: Address,
    plan: LiquidationPlan,
    swapPlan: SwapPlan | null
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
      plan: swapPlan,
      recipient: eoa
    })

  // Borrower discovery: poll the markets liquidation-candidates endpoint (cursor-paginated,
  // over-inclusive). The lens re-reads every returned pair fresh on-chain, so this is a coverage
  // source, never the source of truth.
  const fetchPage = createApiCandidateSource({
    url: config.discovery.apiUrl,
    chainId: config.chainId,
    healthFactorLte: config.discovery.healthFactorLte
  })
  // Filter candidates to the market whitelist BEFORE the lens read — a non-listed market is never
  // touched (fail-closed), and this also shrinks the lens batch. `current()` freezes the fresh-source
  // set for the whole pass, excluding any source past the fail-closed max-age (a sustained markets-API
  // outage the refresh loop could not recover from), so a since-delisted market can never linger in
  // scope on the back of a stale set.
  //
  // The all-sources-expired case is reported HERE, every tick, rather than from the refresh loop: the
  // whitelist expires on `LISTED_MARKETS_MAX_AGE_MS` but is only re-checked on `MARKETS_REFRESH_MS`, so
  // a longer refresh interval (or a wedged refresh loop) would otherwise leave a total liquidation halt
  // unreported for most of each interval — visible only as `discover.filtered` reading `listed: 0`,
  // which is indistinguishable from "nothing to do".
  const discover = async () => {
    const candidates = await discoverBorrowers(fetchPage, { logger, maxPages: MAX_DISCOVERY_PAGES })
    const whitelist = listedMarkets.current()
    if (whitelist.fresh === 0) {
      logger.warn('markets.whitelist_expired', {
        maxAgeMs: LISTED_MARKETS_MAX_AGE_MS,
        sources: listedMarkets.snapshot().sources,
        detail:
          'every markets source is older than max age — whitelist is empty (fail-closed) until a refresh lands'
      })
    }
    const listed = candidates.filter(candidate => whitelist.isListed(candidate.marketId))
    if (listed.length < candidates.length) {
      // Name the filtered-out markets, not just the counts — "was market X whitelisted at tick T"
      // must be answerable from this line alone (the whitelist is small, so the id list is cheap).
      const skippedMarkets = [
        ...new Set(
          candidates
            .filter(candidate => !whitelist.isListed(candidate.marketId))
            .map(candidate => candidate.marketId)
        )
      ]
      logger.info('discover.filtered', {
        total: candidates.length,
        listed: listed.length,
        skippedMarkets
      })
    }
    return listed
  }

  // Startup discovery self-check (non-fatal): run one discovery pass at boot so a bad candidates-API
  // URL, an auth failure, or a stale/empty whitelist is diagnosable from Railway logs at boot, rather
  // than as an opaque per-tick `tick.error`. The candidates API may still be warming on first deploy,
  // so a failure here is logged and the bot proceeds — the per-block tick retries discovery.
  {
    const probe = await tryCatch(discover())
    if (probe.error) {
      logger.warn('discovery.startup_error', { detail: ensureError(probe.error).message })
    } else {
      logger.info('discovery.startup', {
        chainId: config.chainId,
        candidates: probe.data.length,
        // A sample so the parsed candidate (marketId / borrower) can be eyeballed at boot.
        sample: probe.data[0] ?? null
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
    syncNonce: signer.syncNonce,
    getConsumedNonce: signer.consumedNonce,
    maxFeeWei: config.maxFeeWei,
    logger,
    settledCooldownBlocks: SETTLED_COOLDOWN_BLOCKS,
    revertReason
  })

  // Periodic EOA-balance metric so operators can watch gas drain (see `signer.balance`).
  const balanceMonitor = createBalanceMonitor({
    address: eoa,
    read: signer.balance,
    logger
  })
  const heartbeatMonitor = createHeartbeatMonitor({
    url: process.env.BETTERSTACK_HEARTBEAT_URL,
    logger
  })
  void heartbeatMonitor.start()

  // Phase-4 runner: an HTTP block-poll watcher drives one tick per new block (coalescing backlog),
  // passing the polled height as the queue's submittedAtBlock. Each liquidatable position resolves its
  // swap step, simulates the real `exec_606BaXt`, and — on a sim-ok result — broadcasts that same exec
  // via the Executor singleton. Pending-queue upkeep runs in `maintain`.
  const tick = (chainHead: bigint) =>
    runTick({
      discover,
      chainHead,
      caller: config.executooorAddress,
      seizeCapMarginBps: config.quoting.seizeCapMarginBps,
      readLens: pairs => readMidnightLiquidationLens(client, config.midnight, pairs),
      quoteFor,
      simulate: ({ market, borrower, plan, swapPlan }) =>
        simulateLiquidationExec(client, {
          executooor: config.executooorAddress,
          eoa,
          data: encodeExec(market, borrower, plan, swapPlan)
        }),
      submit: async ({ market, borrower, plan, swapPlan, blockNumber, label }) => {
        const fees = initialFees(await signer.getBaseFee(), config.maxFeeWei, config.priorityFeeWei)
        await queue.submit({
          request: {
            to: config.executooorAddress,
            data: encodeExec(market, borrower, plan, swapPlan)
          },
          label,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          blockNumber
        })
      },
      backoff,
      cooldown,
      inflightLabels: () => queue.inflightLabels(),
      logger
    })

  // Per-block maintenance, run by the runner BEFORE the tick and independently of it: pending-queue
  // upkeep (confirmations / stuck-detection / fee-bumps / nonce reconciliation / latch clearing) plus
  // the periodic EOA-balance metric. Keeping it off the tick means a sustained discovery / lens / API
  // outage can't starve already-broadcast transactions of receipt checks and fee replacement.
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

  // Refresh the market whitelist on an interval, independent of the block loop, via a delay-spaced
  // self-reschedule (no busy loop). The union refreshes every source concurrently and reports each
  // source's failure itself (`markets.refresh_failed`), keeping that source's last-known-good rather
  // than emptying the whitelist; the tryCatch here is belt-and-braces so nothing can kill the schedule.
  // Also re-emits the bad-debt-only health signal while no venue is keyed.
  let stopped = false
  const refreshMarketsLoop = async () => {
    await delay(config.markets.refreshMs)
    if (stopped) return
    const { error } = await tryCatch(listedMarkets.refresh())
    // `refresh` is contractually non-throwing (it reports each source's failure itself), so reaching
    // this is a bug in the union, not an API blip — hence `error`, not `warn`.
    if (error) logger.error('markets.refresh_error', { detail: error.message })
    if (venues.length === 0) {
      logger.warn('quoting.no_routes', { detail: 'still no venue API keys — bad-debt-only' })
    }
    void refreshMarketsLoop()
  }
  void refreshMarketsLoop()

  // Graceful shutdown: stop the loops and log the pending set (hashes + nonces) plus the venue /
  // whitelist state for observability. Sends are fire-and-forget and chain truth wins on restart, so
  // there is nothing to persist or await-drain — a redeploy re-derives from chain.
  const shutdown = (signal: string) => {
    stopped = true
    heartbeatMonitor.stop()
    logger.info('shutdown', {
      signal,
      pending: queue.snapshot(),
      venues: venueSelector.snapshot(),
      listedMarkets: listedMarkets.snapshot()
    })
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
