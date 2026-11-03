import type { KernelHead, ReportCommand } from '@repo/kernel'
import type { Logger } from '@repo/kit'
import type { SwapPlan, Venue } from '@repo/swaps'
import type { Address, Hex } from 'viem'

import { runIdAt } from '@repo/controller'
import { GraphFailedError } from '@repo/engine'
import {
  assertContractDeployed,
  buildIdentityFromEnv,
  createBalanceMonitor,
  createDeploylessClient,
  createHeartbeatMonitor,
  createJournalFileSink,
  createLogger,
  simulateLiquidationExec,
  withLogging
} from '@repo/kit'
import {
  createErc4626Unwrapper,
  createPendlePtUnwrapper,
  createRateLimitedClient,
  createVenueSelector,
  PENDLE_CHAIN_IDS,
  priceByVenue
} from '@repo/swaps'
import { ensureError, tryCatch } from '@repo/utils'
import { join } from 'node:path'
import { erc20Abi } from 'viem'
import { getBalance, readContract } from 'viem/actions'

import type { MarketParams } from './market'

import { loadConfig } from './config'
import { createApiCandidateSource, discoverCandidates } from './discovery/borrowers'
import { CandidatesApiRefusedError } from './errors'
import { encodeLiquidationExec } from './execution/encode-call'
import { liquidatorAccount, liquidatorKernel } from './kernel'
import { composeQuoting } from './quotes'
import { startLiquidator } from './run'
import { readBlueLiquidationLens } from './state/lens.sol'
import { createMarketParamsResolver, multicallIdToMarketParams } from './state/market-params'
import { createTickStats } from './stats'

/** How long a route authorizes liquidations before its position is quoted again. */
const QUOTE_VALID_MS = 30_000
/** How long a position whose quote failed, or found no path, waits to be quoted again. */
const QUOTE_RETRY_MS = 10_000
/** How many positions are worked at once, preparing or in flight; swap venues are rate limited. */
const POSITIONS_AT_ONCE = 3
const JOURNAL_CAPACITY_BYTES = 16 * 1024 * 1024
const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const

async function superviseKernelBot(
  running: Readonly<{ stop: () => void; stopped: Promise<ReportCommand> }>,
  logger: Logger,
  shutdownFields: () => Record<string, unknown>
): Promise<0 | 1> {
  const shutdown = (signal: NodeJS.Signals) => {
    logger.info('shutdown', { signal, ...shutdownFields() })
    running.stop()
  }
  for (const signal of STOP_SIGNALS) process.on(signal, shutdown)
  const stopped = await tryCatch(running.stopped)
  for (const signal of STOP_SIGNALS) process.off(signal, shutdown)
  if (stopped.error) {
    const failed = stopped.error instanceof GraphFailedError ? stopped.error : undefined
    const report = failed?.stop as ReportCommand | undefined
    logger.error('runner.failed', {
      error: ensureError(failed ? failed.cause : stopped.error).message,
      ...(failed && { origin: failed.origin }),
      ...(report && { outcome: report.outcome, reason: report.reason, open: report.open })
    })
    return 1
  }
  const { outcome, reason, open } = stopped.data
  logger.info('kernel.stopped', { outcome, reason, open })
  return outcome === 'clean' ? 0 : 1
}

async function main() {
  const config = loadConfig()
  const logger = createLogger(config.logLevel, {
    context: { bot: 'blue-liquidation', chainId: config.chainId }
  })

  const account = liquidatorAccount(config)
  const eoa = account.address

  logger.info('startup', {
    chainId: config.chainId,
    liquidator: eoa,
    callback: config.executooorAddress,
    morpho: config.morpho
  })

  const client = createDeploylessClient(config)
  await assertContractDeployed(
    client,
    config.executooorAddress,
    'EXECUTOOOR_ADDRESS',
    'deploy it with `pnpm --filter @repo/contracts run deploy:executor`'
  )
  await assertContractDeployed(client, config.morpho, 'Morpho singleton')

  // Enabled venues are inferred from which venue API keys are present (loadConfig already enforced
  // the no-key → detection-only opt-in). Keys are read HERE, at the point of use, and live only in
  // this closure — never on the (logged) Config object.
  const apiKeys: Partial<Record<Venue, string>> = {}
  if (process.env.ZEROX_API_KEY) apiKeys['0x'] = process.env.ZEROX_API_KEY
  if (process.env.ONEINCH_API_KEY) apiKeys['1inch'] = process.env.ONEINCH_API_KEY
  if (process.env.LIFI_API_KEY) apiKeys.lifi = process.env.LIFI_API_KEY
  const venues = config.venues.enabled
  if (venues.length === 0) {
    logger.warn('quoting.no_routes', {
      chainId: config.chainId,
      detail:
        'no venue API keys set — running detection-only (every liquidation is skipped, config.no_swap_path)'
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

  // Venue selector: caches each venue's rate curve per pair from log-scaled indicative probes.
  // Decimals are read once per collateral (memoized in the selector); the collateral set is bounded
  // by the discovered markets, so these are a handful of one-off reads over the process lifetime. No
  // `usdPriceOf` is wired here, so the ladder stays denominated in whole collateral tokens.
  const venueSelector = createVenueSelector({
    venues,
    chainId: config.chainId,
    ladderSizes: config.probe.ladderSizes,
    getDecimals: token =>
      readContract(client, { address: token, abi: erc20Abi, functionName: 'decimals' }),
    indicativeQuote: (venue, params) => priceByVenue(probeClient, { venue, baseUrls, params }),
    staleMs: config.probe.staleMs,
    logger
  })

  // Pre-swap converters for exotic collateral (ERC-4626 shares, Pendle PTs → underlying).
  // Auto-detecting with per-process memoization. `erc4626` first: a memoized eth_call beats consulting
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
    baseUrls,
    maxRouteImpactBps: config.quoting.maxRouteImpactBps,
    unwrappers,
    excludeCollaterals: config.venues.excludeCollaterals,
    logger
  })

  // The exec calldata for one liquidation — the same bytes the preparation simulates and the kernel
  // validates, simulates again at its head, and signs.
  const encodeExec = (
    market: MarketParams,
    borrower: Address,
    seizedAssets: bigint,
    swapPlan: SwapPlan
  ): Hex =>
    encodeLiquidationExec({
      executor: config.executooorAddress,
      morpho: config.morpho,
      market,
      seizedAssets,
      borrower,
      plan: swapPlan,
      recipient: eoa
    })

  // Borrower discovery: poll the Morpho API's liquidation candidates (cursor-paginated, listed
  // markets only, over-inclusive by health-factor cutoff). Only (marketId, borrower) is consumed —
  // the market's immutable params are recovered onchain via idToMarketParams(id) and cached (params
  // never change per id), and the lens re-reads every pair fresh, so the API is a coverage source,
  // never the source of truth.
  const fetchPage = createApiCandidateSource({
    url: config.discovery.apiUrl,
    apiKey: config.discovery.apiKey,
    chainId: config.chainId,
    healthFactorLte: config.discovery.healthFactorLte
  })
  const resolveParams = createMarketParamsResolver(multicallIdToMarketParams(client, config.morpho))
  const discover = () => discoverCandidates(fetchPage, resolveParams, { logger })

  // Startup discovery self-check: a refused request (bad key or URL) is fatal, since no retry fixes it
  // and the bot would otherwise run healthy while discovering nothing. Other failures retry per reading.
  {
    const probe = await tryCatch(discover())
    if (probe.error instanceof CandidatesApiRefusedError) throw probe.error
    if (probe.error) {
      logger.warn('discovery.startup_error', { detail: ensureError(probe.error).message })
    } else {
      logger.info('discovery.startup', {
        chainId: config.chainId,
        candidates: probe.data.candidates.length,
        // A sample so the join's parsed MarketParams can be eyeballed (non-zero addresses/lltv).
        sample: probe.data.candidates[0] ?? null
      })
    }
  }

  const balanceMonitor = createBalanceMonitor({
    address: eoa,
    read: () => getBalance(client, { address: eoa }),
    logger
  })
  using heartbeatMonitor = createHeartbeatMonitor({
    url: process.env.BETTERSTACK_HEARTBEAT_URL,
    logger
  })
  void heartbeatMonitor.start()

  // Scoped to the lens read: viem-dlc emits per outermost request inside the scope.
  const readLens = (pairs: Parameters<typeof readBlueLiquidationLens>[2], at: KernelHead) =>
    withLogging(() => readBlueLiquidationLens(client, config.morpho, pairs, at.hash as Hex), {
      logger: logger.layer,
      lens: 'blue-liquidation'
    })
  const kernel = liquidatorKernel({ config, account, logger })
  const journal = await createJournalFileSink({
    directory: join(config.kernel.stateDirectory, 'journal'),
    graph: 'blue-liquidation',
    build: buildIdentityFromEnv(process.env),
    capacityBytes: JOURNAL_CAPACITY_BYTES
  })
  const running = await startLiquidator({
    journal: journal.journal,
    kernel: kernel.live,
    world: {
      discover,
      readLens,
      onHead: head => void balanceMonitor.maybeLog(BigInt(head.number))
    },
    worldValidMs: config.worldValidMs,
    quotes: { quoteFor, validForMs: QUOTE_VALID_MS, retryMs: QUOTE_RETRY_MS },
    prepare: {
      executor: config.executooorAddress,
      encode: encodeExec,
      simulate: data =>
        simulateLiquidationExec(client, { executooor: config.executooorAddress, eoa, data })
    },
    venue: {
      concurrency: POSITIONS_AT_ONCE,
      budget: { calls: config.quoting.httpRps, perMs: 1_000 }
    },
    simulations: POSITIONS_AT_ONCE,
    backoff: {
      baseBlocks: Number(config.quoting.backoffBaseBlocks),
      maxBlocks: Number(config.quoting.backoffMaxBlocks)
    },
    runId: runIdAt(Date.now()),
    maxReservations: POSITIONS_AT_ONCE,
    stats: createTickStats(),
    logger
  })

  process.exitCode = await superviseKernelBot(running, logger, () => ({
    venues: venueSelector.snapshot()
  }))
}

main().catch(error => {
  // Config/client never came up, so we cannot honor LOG_LEVEL — emit the failure directly, exit non-zero.
  console.error(
    JSON.stringify({ level: 'error', event: 'startup.error', error: ensureError(error).message })
  )
  process.exitCode = 1
})
