import type { Address } from 'viem'

import { assertNever, ensureError, tryCatch } from '@repo/utils'
import { isAddressEqual } from 'viem'

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
 * The slippage percentage (bps) that puts a venue's min-out at `floor`, given that the venue applies
 * the percentage to `denominator`.
 *
 * Which denominator is correct depends on the venue: Uniswap applies the percentage to the oracle
 * reference we hand it, while the aggregators apply it to their own quoted output. Passing the wrong
 * one silently lands the floor below break-even — see the second pass in `firmQuoteVenue`.
 */
/**
 * Whether a quote's ENCODED min-out is known to sit at or above `floor`. A `'derived'` min-out never
 * qualifies, however large it looks: it is our reconstruction, so checking it against the floor checks
 * our arithmetic against itself (see {@link Swap.minOutSource}).
 */
export const clearsFloor = (swap: Swap, floor: bigint): boolean =>
  swap.minOutSource === 'venue' && swap.amountOutMinimum >= floor

const slippageForFloor = (floor: bigint, denominator: bigint): number =>
  denominator <= 0n || floor >= denominator
    ? 0
    : Number(((denominator - floor) * BPS) / denominator)

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
  /**
   * Break-even output: the loan-token amount the protocol will pull to settle the repay. When set, the
   * min-out floor is derived from it instead of from the operator's `slippageBps`.
   *
   * A liquidation's entire margin is the protocol's liquidation incentive, so break-even — not a
   * percentage — is the economically correct floor. A fixed allowance is wrong in both directions and
   * crosses over as the incentive changes: below break-even it lets a shortfall through to fail at the
   * repay instead (surfacing as a misleading allowance error), and above break-even it makes the
   * router reject fills that would have settled profitably. Deriving the allowance from break-even is
   * right at every point, and cannot be tuned wrong.
   *
   */
  minAcceptableAmountOut: bigint
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
 * The outcome of firm-quoting ONE venue. Returned structured (not logged) so the composer owns its
 * own logging + branching (`quote.failed`/`quote.route_quality_failed` fall through to the next
 * venue; `select.ok` short-circuits).
 */
type FirmQuoteOutcome =
  | { kind: 'swap'; swap: Swap; plan: SwapPlan }
  | { kind: 'quote_failed'; reason: QuoteFailureReason; detail: string }
  | { kind: 'bad_route'; swap: Swap }
  | { kind: 'floor_unmet'; swap: Swap; floor: bigint }

// One firm venue quote shared by both composers: build the venue params, dispatch under `tryCatch`,
// then oracle-sanity the quoted output and fold a success into the plan's final step. `venueEntry` is
// resolved INSIDE the awaited thunk so a synchronous adapter/entry throw (e.g. an unreachable uniswap
// arm in multi-venue mode) becomes a caught rejection, never an escape that aborts the run.
async function firmQuoteVenue(args: {
  httpClient: RateLimitedClient
  chainId: number
  executor: Address
  venueEntry: () => SwapConfigEntry
  tokenIn: Address
  amountIn: bigint
  steps: SwapStep[]
  request: QuoteRequest
  maxRouteImpactBps: number
}): Promise<FirmQuoteOutcome> {
  const { httpClient, chainId, executor, venueEntry } = args
  const { tokenIn, amountIn, steps, request, maxRouteImpactBps } = args
  const { loanToken, referenceAmountOut, minAcceptableAmountOut } = request

  // The clamp exists only because a percentage cannot express a floor above its own denominator: at
  // `lif == WAD` the double-ceil in break-even can land a unit over the floored oracle reference. It is
  // an ARITHMETIC bound on what we can ask a venue for — never a relaxation of what we accept, which is
  // always the requested `minAcceptableAmountOut` (see the postcondition below).
  const askableFloor =
    minAcceptableAmountOut > referenceAmountOut ? referenceAmountOut : minAcceptableAmountOut

  const paramsFor = (denominator: bigint): QuoteParameters => ({
    chainId,
    tokenIn,
    tokenOut: loanToken,
    // Seize-exact when no unwraps ran: the contract transfers exactly `amountIn` to the Executor
    // before the callback. After unwraps it is the chain's worst-case output — a fixed-amount
    // venue can only leave skimmable surplus, never revert on shortfall.
    amountIn,
    slippageBps: slippageForFloor(askableFloor, denominator),
    minAcceptableAmountOut,
    executor,
    referenceAmountOut,
    // The request's decimals describe the RAW collateral; after an unwrap they would mislabel
    // the underlying, so they are only forwarded on the direct (no-unwrap) path.
    tokenInDecimals: steps.length === 0 ? request.tokenInDecimals : undefined
  })

  const quote = async (params: QuoteParameters) =>
    tryCatch((async () => quoteByVenue(httpClient, venueEntry(), params))())

  const first = await quote(paramsFor(referenceAmountOut))
  if (first.error || !first.data) {
    const reason = first.error instanceof QuoteError ? first.error.reason : 'api_error'
    return { kind: 'quote_failed', reason, detail: ensureError(first.error).message }
  }

  // The aggregators apply the slippage percentage to THEIR OWN quote, which sits under the oracle
  // reference by the execution cost, so a percentage derived against the reference lands their min-out
  // at `quote · floor / reference` — strictly BELOW break-even. Re-deriving against the venue's own
  // quoted output puts it back. Uniswap applies the percentage to the reference itself and is already
  // at or above the floor, so it never takes this branch.
  let swap = first.data
  // A `derived` minimum can never clear the floor however it is asked for, so a retry there is a second
  // API call that is guaranteed not to help.
  if (
    swap.minOutSource === 'venue' &&
    !clearsFloor(swap, minAcceptableAmountOut) &&
    swap.expectedAmountOut > 0n
  ) {
    const second = await quote(paramsFor(swap.expectedAmountOut))
    if (second.data) swap = second.data
  }

  // POSTCONDITION, and the actual guarantee — the retry above is only an attempt to satisfy it. The
  // second quote's own output can come back lower than the first's, which puts its min-out back under
  // the floor; the retry can fail outright; and a venue that only lets us RECONSTRUCT its min-out
  // cannot be checked at all. In every one of those cases the encoded bound does not protect the
  // repay, so the venue is refused and the caller falls through to the next one. Keeping a
  // known-underfloor quote here is what the earlier revision got wrong.
  if (!clearsFloor(swap, minAcceptableAmountOut)) {
    return { kind: 'floor_unmet', swap, floor: minAcceptableAmountOut }
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
  // The same economic floor the venue path enforces. `resolution.amountIn` is the chain's threaded
  // WORST-CASE output, and every hop encodes its own min-out, so it is an on-chain bound rather than an
  // estimate — but route quality alone does not check it against break-even, and the two thresholds are
  // unrelated: a chain can clear `maxRouteImpactBps` and still land under the repay.
  if (resolution.amountIn < request.minAcceptableAmountOut) {
    logger.warn('quote.floor_unmet', {
      venue: 'unwrap-only',
      id: request.id,
      collateral: request.collateralToken,
      expected: resolution.amountIn,
      amountOutMinimum: resolution.amountIn,
      minOutSource: 'venue',
      floor: request.minAcceptableAmountOut
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
 * projects its lens output into a {@link QuoteRequest}), for bots that discover collateral at
 * runtime and rank venues by a cached probe (see {@link createVenueSelector}). For each
 * liquidatable position it first runs the pre-swap unwrap chain, then refreshes + takes the
 * selector's best-first venue order for the POST-unwrap pair (falling back to the deterministic
 * enabled order for venues the probe couldn't rank), fetches ONE firm quote from the top venue,
 * sanity-checks it against the oracle reference, and — coverage-first — falls through to the next
 * venue on failure (bounded by the enabled set) before giving up. No enabled venues → `no_config`
 * (no API call, no probe, no unwrap), preserving the caller's no-swap posture. A firm quote is
 * requested only AFTER the venue is chosen, never fanned out across venues at once. Quotes are made
 * ONLY for liquidatable positions, so API + probe usage is bounded by the (small) liquidatable set,
 * never the full candidate universe.
 */
export function composeMultiVenueQuoting(deps: {
  httpClient: RateLimitedClient
  chainId: number
  executor: Address
  /** Enabled venues, in deterministic default order (used when a pair has no cached probe yet). */
  venues: readonly Venue[]
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
        return { venue: '0x', baseUrl: baseUrls['0x'] }
      case '1inch':
        return { venue: '1inch', baseUrl: baseUrls['1inch'] }
      case 'lifi':
        return { venue: 'lifi', baseUrl: baseUrls.lifi }
      case 'liquidswap':
        return { venue: 'liquidswap', baseUrl: baseUrls.liquidswap }
      case 'uniswap-v3':
        throw new QuoteError('api_error', 'uniswap-v3 is not a multi-venue candidate')
      default:
        return assertNever(venue)
    }
  }

  // Probe the POST-unwrap pair (indicative, isolated rate budget) so the selector ranks venues for
  // the token actually being sold, then take its best-first order. Enabled venues the cache could
  // NOT rank (a cold pair, or a venue whose probe transiently failed) are appended in deterministic
  // configured order rather than dropped — a probe hiccup must not hide a healthy venue from the
  // firm-quote fall-through for a full staleMs window. A probe failure is likewise non-fatal.
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

    const ranked = select(pair, amountIn).map(estimate => estimate.venue)
    const order = [...ranked, ...venues.filter(venue => !ranked.includes(venue))]
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
        if (outcome.kind === 'floor_unmet') {
          lastReason = 'bad_route'
          logger.warn('quote.floor_unmet', {
            venue,
            id,
            collateral: collateralToken,
            expected: outcome.swap.expectedAmountOut,
            amountOutMinimum: outcome.swap.amountOutMinimum,
            minOutSource: outcome.swap.minOutSource,
            floor: outcome.floor
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
