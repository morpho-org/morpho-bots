import type { SwapPlan, Venue } from '@repo/swaps'
import type { Address, Hex } from 'viem'

import {
  assertContractDeployed,
  createBalanceMonitor,
  createBackoff,
  createBlockSampler,
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
import { ensureError, tryCatch } from '@repo/utils'
import { erc20Abi } from 'viem'
import { getBlockNumber, readContract } from 'viem/actions'

import type { MarketParams } from './market'
import type { LiquidationPlan } from './sizing/plan'

import { loadConfig } from './config'
import { PLAN_SKIP_SAMPLE_EVERY_BLOCKS, SETTLED_COOLDOWN_BLOCKS } from './constants'
import { createGraphqlCandidateSource, discoverCandidates } from './discovery/borrowers'
import { encodeLiquidationExec } from './execution/encode-call'
import { composeQuoting } from './quotes'
import { runTick } from './runner/tick'
import { readBlueLiquidationLens } from './state/lens.sol'
import { createMarketParamsResolver, multicallIdToMarketParams } from './state/market-params'
import { revertReason } from './tx-error'

async function main() {
  const config = loadConfig()
  // Global wide-log context stamped onto every line (replaces the enrichment the retired Vector VRL
  // did): the bot identity + chain, plus whichever RAILWAY_* identity vars this deployment exposes.
  const logger = createLogger(config.logLevel, {
    context: { bot: 'blue-liquidation', chainId: config.chainId, ...railwayContext() }
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
      executor: config.executooorAddress,
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

  // Venue selector: caches a best-first venue ranking per pair from log-scaled indicative probes.
  // Decimals are read once per collateral (memoized in the selector); the collateral set is bounded
  // by the discovered markets, so these are a handful of one-off reads over the process lifetime.
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
  // Bounds the `plan.skipped` diagnostic to one burst per cadence; process-lifetime state, like the
  // two stores above.
  const planSkipSampler = createBlockSampler(PLAN_SKIP_SAMPLE_EVERY_BLOCKS)

  // The exec calldata for one liquidation — the same bytes the simulate gate checks and the queue
  // broadcasts, so a sim-ok plan and its broadcast can't drift.
  const encodeExec = (
    market: MarketParams,
    borrower: Address,
    plan: LiquidationPlan,
    swapPlan: SwapPlan
  ): Hex =>
    encodeLiquidationExec({
      executor: config.executooorAddress,
      morpho: config.morpho,
      market,
      seizedAssets: plan.seizedAssets,
      borrower,
      plan: swapPlan,
      recipient: eoa
    })

  // Borrower discovery: poll the Morpho GraphQL API's `marketPositions` (skip-paginated, listed
  // markets only, over-inclusive by health-factor cutoff). Only (marketId, borrower) is consumed —
  // the market's immutable params are recovered on-chain via idToMarketParams(id) and cached (params
  // never change per id), and the lens re-reads every pair fresh, so the API is a coverage source,
  // never the source of truth.
  const fetchPage = createGraphqlCandidateSource({
    url: config.discovery.apiUrl,
    chainId: config.chainId,
    healthFactorLte: config.discovery.healthFactorLte
  })
  const resolveParams = createMarketParamsResolver(multicallIdToMarketParams(client, config.morpho))
  const discover = () => discoverCandidates(fetchPage, resolveParams, { logger })

  // Startup discovery self-check (non-fatal): run one discovery pass at boot so a bad API URL or a
  // schema drift is diagnosable from Railway logs at boot, rather than as an opaque per-tick
  // `tick.error`. A failure here is logged and the bot proceeds — the per-block tick retries.
  {
    const probe = await tryCatch(discover())
    if (probe.error) {
      logger.warn('discovery.startup_error', { detail: ensureError(probe.error).message })
    } else {
      logger.info('discovery.startup', {
        chainId: config.chainId,
        candidates: probe.data.length,
        // A sample so the join's parsed MarketParams can be eyeballed (non-zero addresses/lltv).
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
    getConsumedNonce: signer.consumedNonce,
    syncNonce: signer.syncNonce,
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

  // An HTTP block-poll watcher drives one tick per new block (coalescing backlog), passing the polled
  // height as the queue's submittedAtBlock. Each liquidatable position resolves its swap, simulates
  // the real `exec_606BaXt`, and — on a sim-ok result — broadcasts that same exec via the Executor
  // singleton. Pending-queue upkeep runs in `maintain`.
  const tick = (chainHead: bigint) =>
    runTick({
      discover,
      chainHead,
      readLens: pairs => readBlueLiquidationLens(client, config.morpho, pairs),
      quoteFor,
      simulate: ({ market, borrower, plan, swapPlan }) =>
        simulateLiquidationExec(client, {
          executooor: config.executooorAddress,
          eoa,
          data: encodeExec(market, borrower, plan, swapPlan)
        }),
      submit: async ({ market, borrower, plan, swapPlan, blockNumber, label }) => {
        const fees = initialFees(await signer.getBaseFee(), config.maxFeeWei)
        // Returned, not awaited-and-discarded: the tick needs to know whether a tx actually went out
        // before it clears this position's backoff.
        return queue.submit({
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
      planSkipSampler,
      inflightLabels: () => queue.inflightLabels(),
      logger
    })

  // Per-block maintenance, run by the runner BEFORE the tick and independently of it: pending-queue
  // upkeep (confirmations / stuck-detection / fee-bumps / nonce reconciliation / latch clearing) plus
  // the periodic EOA-balance metric. Keeping it off the tick means a sustained discovery / lens
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

  // Graceful shutdown: stop the watcher and log the pending set (hashes + nonces) plus the venue
  // state for observability. Sends are fire-and-forget and chain truth wins on restart, so there is
  // nothing to persist or await-drain — a redeploy re-derives from chain.
  const shutdown = (signal: string) => {
    heartbeatMonitor.stop()
    logger.info('shutdown', {
      signal,
      pending: queue.snapshot(),
      venues: venueSelector.snapshot()
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
