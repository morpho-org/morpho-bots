import type { Address } from 'viem'

import { assertNever, ensureError, tryCatch } from '@repo/utils'
import { getAddress, isAddressEqual } from 'viem'

import type { SwapConfigEntry } from './config'
import type { RateLimitedClient } from './http-client'
import type {
  PriceParameters,
  PriceQuote,
  QuoteFailureReason,
  QuoteOutcome,
  QuoteParameters,
  Swap,
  SwapPlan,
  SwapStep,
  Venue
} from './types'
import type { Unwrapper, UnwrapResolution } from './unwrappers/resolve'
import type { VenuePair, VenueQuoteEstimate } from './venue-selector'

import { BPS } from './constants'
import { QuoteError } from './types'
import { resolveUnwraps } from './unwrappers/resolve'
import { priceLifi, quoteLifi } from './venues/lifi'
import { priceLiquidSwap, quoteLiquidSwap } from './venues/liquidswap'
import { priceOneInch, quoteOneInch } from './venues/oneinch'
import { quoteUniswapV3 } from './venues/uniswap-v3'
import { priceZerox, quoteZerox } from './venues/zerox'

// Dispatches one firm quote to the configured venue's adapter. Uniswap is local; aggregators hit the
// API. `async` so a SYNCHRONOUS throw from the local Uniswap arm (e.g. calldata encoding) becomes a
// rejection caught by the caller's tryCatch — not an escape that aborts the whole tick.
export async function quoteByVenue(
  client: RateLimitedClient,
  entry: SwapConfigEntry,
  params: QuoteParameters
): Promise<Swap> {
  switch (entry.venue) {
    case 'uniswap-v3':
      return quoteUniswapV3(entry, params)
    case '0x':
      return quoteZerox(client, entry, params)
    case '1inch':
      return quoteOneInch(client, entry, params)
    case 'lifi':
      return quoteLifi(client, entry, params)
    case 'liquidswap':
      return quoteLiquidSwap(client, entry, params)
    default:
      return assertNever(entry)
  }
}

// Dispatches one indicative price probe to a venue. Only the aggregators support it; Uniswap has no
// off-chain quote (its adapter merely echoes the oracle), so it is never a probe/multi-venue candidate.
export async function priceByVenue(
  client: RateLimitedClient,
  args: { venue: Venue; baseUrls: Partial<Record<Venue, string>>; params: PriceParameters }
): Promise<PriceQuote> {
  const { venue, baseUrls, params } = args
  switch (venue) {
    case '0x':
      return priceZerox(client, { baseUrl: baseUrls['0x'] }, params)
    case '1inch':
      return priceOneInch(client, { baseUrl: baseUrls['1inch'] }, params)
    case 'lifi':
      return priceLifi(client, { baseUrl: baseUrls.lifi }, params)
    case 'liquidswap':
      return priceLiquidSwap(client, { baseUrl: baseUrls.liquidswap }, params)
    case 'uniswap-v3':
      throw new QuoteError('api_error', 'uniswap-v3 does not support indicative probing')
    default:
      return assertNever(venue)
  }
}

/**
 * Free, oracle-based route-quality check (no extra API call): a venue's quoted output must be within
 * `maxBps` of the oracle's no-slippage reference. The venue's own min-out is still the on-chain bound;
 * this is a pre-broadcast guard against a bad route.
 */
export function passesRouteQuality(args: {
  expected: bigint
  reference: bigint
  maxBps: number
}): boolean {
  const floor = (args.reference * (BPS - BigInt(args.maxBps))) / BPS
  return args.expected >= floor
}

/**
 * One liquidatable position's swap request, already projected out of the protocol's lens shape by
 * the calling bot (which knows how its markets address collateral).
 */
export type QuoteRequest = {
  /** The seized collateral token to sell. */
  collateralToken: Address
  /** The loan token to buy (for the repay). */
  loanToken: Address
  /** Exactly the collateral the Executor will hold (seize-exact) — the amount the swap sells. */
  amountIn: bigint
  /** Oracle-priced expected output (no DEX slippage) — the route-quality reference. */
  referenceAmountOut: bigint
  /** `collateralToken` decimals — required only for decimal-denominated venues (LiquidSwap). */
  tokenInDecimals?: number
  /** The position's correlation id — threaded into log events only, never parsed. */
  id?: string
}

// Normalizes a venue adapter's Swap into the plan's final step: the spender becomes the step's
// approval target and the venue-agnostic call fields carry over verbatim.
function toStep(swap: Swap, tokenIn: Address, tokenOut: Address): SwapStep {
  return {
    tokenIn,
    tokenOut,
    target: swap.target,
    value: swap.value,
    callData: swap.callData,
    amountIn: swap.amountIn,
    approvalSpender: swap.spender
  }
}

/**
 * The outcome of firm-quoting ONE venue. Returned structured (not logged) because the two composers
 * emit DIFFERENT event names for the same outcome (`quote.bad_route` vs `quote.route_quality_failed`,
 * `quote.ok` vs `select.ok`) and diverge on control flow (short-circuit vs fall through to the next
 * venue), so each caller owns its own logging + branching.
 */
type FirmQuoteOutcome =
  | { kind: 'swap'; swap: Swap; plan: SwapPlan }
  | { kind: 'quote_failed'; reason: QuoteFailureReason; detail: string }
  | { kind: 'bad_route'; swap: Swap }

// One firm venue quote shared by both composers: build the venue params, dispatch under `tryCatch`,
// then oracle-sanity the quoted output and fold a success into the plan's final step. `venueEntry` is
// resolved INSIDE the awaited thunk so a synchronous adapter/entry throw (e.g. an unreachable uniswap
// arm in multi-venue mode) becomes a caught rejection, never an escape that aborts the run.
async function firmQuoteVenue(args: {
  httpClient: RateLimitedClient
  chainId: number
  executor: Address
  venueEntry: () => SwapConfigEntry
  slippageBps: number
  tokenIn: Address
  amountIn: bigint
  steps: SwapStep[]
  request: QuoteRequest
  maxRouteImpactBps: number
}): Promise<FirmQuoteOutcome> {
  const { httpClient, chainId, executor, venueEntry, slippageBps } = args
  const { tokenIn, amountIn, steps, request, maxRouteImpactBps } = args
  const { loanToken, referenceAmountOut } = request

  const params: QuoteParameters = {
    chainId,
    tokenIn,
    tokenOut: loanToken,
    // Seize-exact when no unwraps ran: the contract transfers exactly `amountIn` to the Executor
    // before the callback. After unwraps it is the chain's worst-case output — a fixed-amount
    // venue can only leave skimmable surplus, never revert on shortfall.
    amountIn,
    slippageBps,
    executor,
    referenceAmountOut,
    // The request's decimals describe the RAW collateral; after an unwrap they would mislabel
    // the underlying, so they are only forwarded on the direct (no-unwrap) path.
    tokenInDecimals: steps.length === 0 ? request.tokenInDecimals : undefined
  }

  const { data: swap, error } = await tryCatch(
    (async () => quoteByVenue(httpClient, venueEntry(), params))()
  )
  if (error || !swap) {
    const reason = error instanceof QuoteError ? error.reason : 'api_error'
    return { kind: 'quote_failed', reason, detail: ensureError(error).message }
  }

  // The reference stays the FULL-PATH oracle value (collateral → loan): the unwrap chain threads its
  // worst-case amounts into `amountIn`, so the venue's quoted output is directly comparable.
  if (
    !passesRouteQuality({
      expected: swap.expectedAmountOut,
      reference: referenceAmountOut,
      maxBps: maxRouteImpactBps
    })
  ) {
    return { kind: 'bad_route', swap }
  }

  return {
    kind: 'swap',
    swap,
    plan: {
      steps: [...steps, toStep(swap, tokenIn, loanToken)],
      expectedAmountOut: swap.expectedAmountOut,
      amountOutMinimum: swap.amountOutMinimum
    }
  }
}

/**
 * Runs the pre-swap unwrap chain for a request, mapping an unwrapper error onto the shared
 * `failed` outcome. Returns the resolution (possibly empty — plain collateral) or the outcome to
 * short-circuit with.
 */
async function tryResolveUnwraps(
  unwrappers: readonly Unwrapper[],
  request: QuoteRequest,
  executor: Address,
  logger: QuoteLogger
): Promise<{ resolution: UnwrapResolution } | { outcome: QuoteOutcome }> {
  const { data: resolution, error } = await tryCatch(
    resolveUnwraps(unwrappers, {
      token: request.collateralToken,
      amountIn: request.amountIn,
      executor,
      stopToken: request.loanToken
    })
  )
  if (error || !resolution) {
    const reason = error instanceof QuoteError ? error.reason : 'api_error'
    logger.warn('unwrap.failed', {
      id: request.id,
      collateral: request.collateralToken,
      reason,
      detail: ensureError(error).message
    })
    return { outcome: { kind: 'failed', reason } }
  }
  if (resolution.steps.length > 0) {
    logger.info('unwrap.resolved', {
      id: request.id,
      collateral: request.collateralToken,
      path: [...resolution.steps.map(step => step.tokenIn), resolution.token],
      amountIn: resolution.amountIn
    })
  }
  return { resolution }
}

/**
 * The unwrap chain already ends in the loan token — nothing left to sell. The plan is the unwrap
 * steps alone, still oracle-sanity-checked: the threaded worst-case output stands in for a venue's
 * quoted output (conservative — it floors, never predicts).
 */
function unwrapOnlyPlan(args: {
  resolution: UnwrapResolution
  request: QuoteRequest
  maxRouteImpactBps: number
  logger: QuoteLogger
}): QuoteOutcome {
  const { resolution, request, maxRouteImpactBps, logger } = args
  if (
    !passesRouteQuality({
      expected: resolution.amountIn,
      reference: request.referenceAmountOut,
      maxBps: maxRouteImpactBps
    })
  ) {
    logger.warn('unwrap.bad_route', {
      id: request.id,
      collateral: request.collateralToken,
      expected: resolution.amountIn,
      oracle: request.referenceAmountOut
    })
    return { kind: 'failed', reason: 'bad_route' }
  }
  logger.info('quote.ok', {
    venue: 'unwrap-only',
    id: request.id,
    collateral: request.collateralToken,
    expected: resolution.amountIn,
    oracle: request.referenceAmountOut,
    amountOutMinimum: resolution.amountIn
  })
  return {
    kind: 'swap',
    plan: {
      steps: resolution.steps,
      expectedAmountOut: resolution.amountIn,
      amountOutMinimum: resolution.amountIn
    }
  }
}

/**
 * Minimal structural logger the quoting layer needs (`info`/`warn` only). Any richer logger — e.g. a
 * bot's JSON-line `Logger` — satisfies it; kept structural so this package depends on no runtime.
 */
export type QuoteLogger = {
  info: (event: string, fields?: Record<string, unknown>) => void
  warn: (event: string, fields?: Record<string, unknown>) => void
}

/**
 * Builds the `quoteFor` a liquidation bot's tick consumes (behind a thin per-protocol adapter that
 * projects its lens output into a {@link QuoteRequest}). For each liquidatable position it first
 * runs the pre-swap unwrap chain (ERC4626 shares etc. → a tradable underlying — unless the
 * collateral has its own config entry, which wins verbatim as the operator's escape hatch), then
 * resolves the operator's per-collateral venue for the token the chain ends on, fetches ONE
 * executable quote (Uniswap is local; aggregators make a single API call), and sanity-checks an
 * aggregator's quoted output against the free oracle reference — rejecting a route worse than
 * `maxRouteImpactBps` below it. Quote/route/unwrap failures return `failed` (the caller backs the
 * position off); an unconfigured (post-unwrap) collateral returns `no_config` (no API call).
 * Quotes are made ONLY for liquidatable positions, so API + probe usage is bounded by the (small)
 * liquidatable set, never the full candidate universe.
 */
export function composeQuoting(deps: {
  httpClient: RateLimitedClient
  chainId: number
  executor: Address
  /** Per-collateral venue config for this chain, keyed by EIP-55-checksummed collateral address. */
  swapByCollateral: Map<string, SwapConfigEntry>
  maxRouteImpactBps: number
  /** Pre-swap converters, tried in order each hop. Pass `[]` for venue-only quoting. */
  unwrappers: readonly Unwrapper[]
  logger: QuoteLogger
}): { quoteFor: (request: QuoteRequest) => Promise<QuoteOutcome> } {
  const { httpClient, chainId, executor, swapByCollateral, maxRouteImpactBps, unwrappers, logger } =
    deps

  // One venue quote for `tokenIn`, appended to the (possibly empty) unwrap steps as the plan's
  // final step.
  async function quoteVenue(args: {
    entry: SwapConfigEntry
    tokenIn: Address
    amountIn: bigint
    steps: SwapStep[]
    request: QuoteRequest
  }): Promise<QuoteOutcome> {
    const { entry, tokenIn, amountIn, steps, request } = args
    const { id } = request

    const outcome = await firmQuoteVenue({
      httpClient,
      chainId,
      executor,
      venueEntry: () => entry,
      slippageBps: entry.slippageBps,
      tokenIn,
      amountIn,
      steps,
      request,
      maxRouteImpactBps
    })

    if (outcome.kind === 'quote_failed') {
      logger.warn('quote.failed', {
        venue: entry.venue,
        id,
        collateral: request.collateralToken,
        reason: outcome.reason,
        detail: outcome.detail
      })
      return { kind: 'failed', reason: outcome.reason }
    }

    if (outcome.kind === 'bad_route') {
      logger.warn('quote.bad_route', {
        venue: entry.venue,
        id,
        collateral: request.collateralToken,
        expected: outcome.swap.expectedAmountOut,
        oracle: request.referenceAmountOut
      })
      return { kind: 'failed', reason: 'bad_route' }
    }

    logger.info('quote.ok', {
      venue: entry.venue,
      id,
      collateral: request.collateralToken,
      expected: outcome.swap.expectedAmountOut,
      oracle: request.referenceAmountOut,
      amountOutMinimum: outcome.swap.amountOutMinimum
    })
    return { kind: 'swap', plan: outcome.plan }
  }

  return {
    async quoteFor(request) {
      const { collateralToken, loanToken, amountIn } = request

      // A direct entry for the raw collateral wins verbatim (no unwrap probing): backward
      // compatible, and the operator's escape hatch for share tokens with direct DEX liquidity or
      // gated redeems (sUSDe-style vaults that preview fine but revert on redeem).
      const direct = swapByCollateral.get(getAddress(collateralToken))
      if (direct) {
        return quoteVenue({ entry: direct, tokenIn: collateralToken, amountIn, steps: [], request })
      }

      const unwrapped = await tryResolveUnwraps(unwrappers, request, executor, logger)
      if ('outcome' in unwrapped) return unwrapped.outcome
      const { resolution } = unwrapped

      if (resolution.steps.length > 0 && isAddressEqual(resolution.token, loanToken)) {
        return unwrapOnlyPlan({ resolution, request, maxRouteImpactBps, logger })
      }

      const entry = swapByCollateral.get(getAddress(resolution.token))
      if (!entry) return { kind: 'no_config' }
      return quoteVenue({
        entry,
        tokenIn: resolution.token,
        amountIn: resolution.amountIn,
        steps: resolution.steps,
        request
      })
    }
  }
}

/**
 * Multi-venue variant of {@link composeQuoting} for bots that discover collateral at runtime and rank
 * venues by a cached probe (see {@link createVenueSelector}) instead of a per-collateral config file.
 * For each liquidatable position it first runs the pre-swap unwrap chain, then refreshes + takes the
 * selector's best-first venue order for the POST-unwrap pair (or a deterministic default when the
 * pair is not yet probed), fetches ONE firm quote from the top venue, sanity-checks it against the
 * oracle reference, and — coverage-first — falls through to the next ranked venue on failure
 * (bounded by the enabled set) before giving up. No enabled venues → `no_config` (no API call, no
 * probe, no unwrap), preserving the caller's bad-debt path. A firm quote is requested only AFTER
 * the venue is chosen, never fanned out across venues at once.
 */
export function composeMultiVenueQuoting(deps: {
  httpClient: RateLimitedClient
  chainId: number
  executor: Address
  /** Enabled venues, in deterministic default order (used when a pair has no cached probe yet). */
  venues: readonly Venue[]
  /** Global slippage (bps) applied to every venue — no per-collateral routing anymore. */
  slippageBps: number
  /** Optional per-venue API host overrides. */
  baseUrls: Partial<Record<Venue, string>>
  maxRouteImpactBps: number
  /** Pre-swap converters, tried in order each hop. Pass `[]` for venue-only quoting. */
  unwrappers: readonly Unwrapper[]
  /**
   * Probe-cache refresh for the (post-unwrap) pair — runs here, after unwrap resolution, so the
   * probes price the tradable underlying. Failures are non-fatal (cold-default venue order).
   */
  refresh: (pair: VenuePair) => Promise<void>
  /** Best-first venues (with indicative outputs) for a pair+size, from the probe cache; `[]` if cold. */
  select: (pair: VenuePair, amountIn: bigint) => readonly VenueQuoteEstimate[]
  logger: QuoteLogger
}): { quoteFor: (request: QuoteRequest) => Promise<QuoteOutcome> } {
  const {
    httpClient,
    chainId,
    executor,
    venues,
    slippageBps,
    baseUrls,
    maxRouteImpactBps,
    unwrappers,
    refresh,
    select,
    logger
  } = deps

  // Synthesize the venue's firm-quote entry from the global slippage + optional host override — the
  // per-collateral config file (and its Uniswap arm) is gone in this mode.
  function entryFor(venue: Venue): SwapConfigEntry {
    switch (venue) {
      case '0x':
        return { venue: '0x', baseUrl: baseUrls['0x'], slippageBps }
      case '1inch':
        return { venue: '1inch', baseUrl: baseUrls['1inch'], slippageBps }
      case 'lifi':
        return { venue: 'lifi', baseUrl: baseUrls.lifi, slippageBps }
      case 'liquidswap':
        return { venue: 'liquidswap', baseUrl: baseUrls.liquidswap, slippageBps }
      case 'uniswap-v3':
        throw new QuoteError('api_error', 'uniswap-v3 is not a multi-venue candidate')
      default:
        return assertNever(venue)
    }
  }

  // Probe the POST-unwrap pair (indicative, isolated rate budget) so the selector ranks venues for
  // the token actually being sold, then take its best-first order — or the deterministic default when
  // the pair is cold. A probe failure is non-fatal: the default order still drives the firm-quote loop.
  async function venueOrderFor(pair: VenuePair, amountIn: bigint, id?: string): Promise<Venue[]> {
    const { error: probeError } = await tryCatch(refresh(pair))
    if (probeError) {
      logger.warn('probe.error', {
        id,
        collateral: pair.collateral,
        loan: pair.loan,
        detail: probeError.message
      })
    }

    const ranked = select(pair, amountIn)
    const order = ranked.length > 0 ? ranked.map(estimate => estimate.venue) : [...venues]
    if (ranked.length === 0) {
      logger.info('select.cold_default', { collateral: pair.collateral, loan: pair.loan, order })
    }
    return order
  }

  return {
    async quoteFor(request) {
      const { collateralToken, loanToken, referenceAmountOut, id } = request
      if (venues.length === 0) return { kind: 'no_config' }

      const unwrapped = await tryResolveUnwraps(unwrappers, request, executor, logger)
      if ('outcome' in unwrapped) return unwrapped.outcome
      const { resolution } = unwrapped

      if (resolution.steps.length > 0 && isAddressEqual(resolution.token, loanToken)) {
        return unwrapOnlyPlan({ resolution, request, maxRouteImpactBps, logger })
      }

      const pair: VenuePair = { collateral: resolution.token, loan: loanToken }
      const order = await venueOrderFor(pair, resolution.amountIn, id)

      // Try the ranked venues in order; a quote or route-quality failure falls through to the next
      // (coverage-first). Only the CHOSEN venue is firm-quoted per step — never all venues at once.
      let lastReason: QuoteFailureReason = 'no_route'
      for (const venue of order) {
        const outcome = await firmQuoteVenue({
          httpClient,
          chainId,
          executor,
          venueEntry: () => entryFor(venue),
          slippageBps,
          tokenIn: resolution.token,
          amountIn: resolution.amountIn,
          steps: resolution.steps,
          request,
          maxRouteImpactBps
        })
        if (outcome.kind === 'quote_failed') {
          lastReason = outcome.reason
          logger.warn('quote.failed', {
            venue,
            id,
            collateral: collateralToken,
            reason: lastReason,
            detail: outcome.detail
          })
          continue
        }
        if (outcome.kind === 'bad_route') {
          lastReason = 'bad_route'
          logger.warn('quote.route_quality_failed', {
            venue,
            id,
            collateral: collateralToken,
            expected: outcome.swap.expectedAmountOut,
            oracle: referenceAmountOut
          })
          continue
        }
        logger.info('select.ok', {
          venue,
          id,
          collateral: collateralToken,
          expected: outcome.swap.expectedAmountOut,
          oracle: referenceAmountOut,
          amountOutMinimum: outcome.swap.amountOutMinimum,
          order
        })
        return { kind: 'swap', plan: outcome.plan }
      }
      return { kind: 'failed', reason: lastReason }
    }
  }
}
