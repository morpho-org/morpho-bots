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
import type { VenueCostEstimate, VenuePair } from './venue-selector'

import { BPS } from './constants'
import { routeCostBps } from './cost-bps.utils'
import { QuoteError } from './types'
import { resolveUnwraps } from './unwrappers/resolve'
import { curveIsTrusted, MAX_COST_LEVEL_AGE_MS } from './venue-selector'
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
  /**
   * Which of the position's candidates this request is for, when a protocol yields several from one
   * {@link QuoteRequest.id} (Midnight's `(collateral slot, mode)` alternatives). Spread verbatim onto
   * this package's log events, under the same never-parsed contract as `id`: without it two candidates
   * of one position emit rows a query cannot tell apart. Fields must be named exactly as the calling
   * bot names them on its own events, since a join spanning both must not normalize — and must avoid
   * the names those events already use (`venue`, `collateral`, `loan`, `reason`, `expected`, `oracle`,
   * `floor`, `order`, `detail`, `path`, `amountIn`, `amountOutMinimum`, `minOutSource`), each of which
   * wins the spread and would drop the discriminator from the row.
   */
  candidate?: Readonly<Record<string, boolean | number | string>>
}

/**
 * The correlation fields every event {@link composeMultiVenueQuoting} emits carries — and every hop it
 * drives through {@link Unwrapper.resolve} — being the position's join key plus whatever discriminates
 * the candidate within it. `id` is spread LAST of the two so a stray `candidate.id` cannot shadow the
 * join key, and each event's own fields are spread after this so neither can shadow them.
 */
const correlationOf = (request: QuoteRequest) => ({ ...request.candidate, id: request.id })

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

/**
 * How far below its interpolated estimate the curve's prediction of a venue's own output is taken,
 * in bps. Absorbs the probe-versus-firm-quote gap (a probe has no taker and asks for no slippage)
 * plus the price drift a cached rate carries.
 *
 * **This governs the SIZE of the margin.** Its direction is
 * {@link predictedVenueOut}'s subject and is not in question here. The two ways the size can be wrong
 * are not symmetric, and that asymmetry is what sets the value:
 *
 * - **A margin too SMALL** leaves the prediction at or above the venue's real quote, so the encoded
 *   floor lands BELOW break-even, {@link clearsFloor} refuses it and the second pass runs. Cost: one
 *   extra HTTP call, and the floor still ends up exactly on break-even.
 * - **A margin too LARGE** pushes the prediction well under the real quote, so the encoded floor
 *   lands ABOVE break-even and a fill the repay would have covered reverts at send instead. On the
 *   2026-08-28 maturity a min-out shortfall already rejected 153 of 167 simulated sends, and the whole
 *   post-maturity incentive is only ~20 bps.
 *
 * So the value is deliberately biased toward the cheap failure, and
 * {@link MAX_FLOOR_OVERSHOOT_BPS} bounds the expensive one independently — the margin's size only
 * decides how often the second pass is spent, never how far above break-even a floor may be encoded.
 * Provisional at this value: `curveCostBps` beside `firmQuoteCostBps` on `select.ok` measures the real
 * probe-versus-firm gap, and that is what should set it.
 */
const CURVE_PREDICTION_MARGIN_BPS = 10n

/**
 * How far above break-even a first-pass encoded min-out may sit before the second pass is spent to
 * put it back, in bps of {@link QuoteRequest.minAcceptableAmountOut}.
 *
 * The bound exists because the overshoot an accurate curve produces and the overshoot a PESSIMISTIC
 * one produces are different quantities. An aggregator encodes `quote · floor / denominator`, so the
 * overshoot factor is `realQuote / prediction` — bounded by {@link CURVE_PREDICTION_MARGIN_BPS} only
 * when the curve is right, and otherwise unbounded in how pessimistic the curve is. A curve just 0.5%
 * low already encodes a floor ~62 bps above break-even, three times the entire post-maturity
 * incentive: every fill in that band reverts at send even though the repay would have covered it,
 * which is the failure this whole path exists to reduce. {@link clearsFloor} cannot catch it — it is a
 * one-sided check.
 *
 * Set at twice `CURVE_PREDICTION_MARGIN_BPS`: an accurate curve's overshoot IS the margin, so this
 * leaves it room for rounding and mild pessimism while capping the give-away at the same order as the
 * margin deliberately spent, rather than at a multiple of the whole prize. Exceeding it costs one
 * extra HTTP call and lands the floor on break-even — the same trade the too-small direction makes.
 */
const MAX_FLOOR_OVERSHOOT_BPS = 2n * CURVE_PREDICTION_MARGIN_BPS

/**
 * A curve estimate turned into a first-pass min-out denominator, or `undefined` when the curve has
 * nothing trustworthy to say (an unranked venue, an estimate clamped off the probed ladder, or one
 * older than {@link MAX_COST_LEVEL_AGE_MS}).
 *
 * **This block's subject is the DIRECTION of the bias relative to the venue's real quote**, which is
 * what makes the prediction safe to encode against; how far down it is taken is
 * {@link CURVE_PREDICTION_MARGIN_BPS}'s subject. An aggregator encodes `quote · floor / denominator`,
 * so a denominator UNDER the venue's real quote lands the encoded floor at or above break-even —
 * safe, and it clears {@link clearsFloor} on the first call — while a denominator OVER the real quote
 * lands the floor below break-even, where the postcondition refuses the quote and the second pass
 * re-derives against the real output. Being under is therefore the direction to be wrong in; how far
 * under is bounded on the other side by {@link MAX_FLOOR_OVERSHOOT_BPS}. Capped at the oracle
 * reference for the reason a scored cost is floored at zero: a venue quoting above the oracle is a
 * stale oracle, not a better route.
 */
const predictedVenueOut = (
  estimate: VenueCostEstimate | undefined,
  referenceAmountOut: bigint
): bigint | undefined => {
  if (!estimate || estimate.clamped || estimate.estimatedOut <= 0n) return undefined
  if (estimate.ageMs > MAX_COST_LEVEL_AGE_MS) return undefined
  const capped =
    estimate.estimatedOut < referenceAmountOut ? estimate.estimatedOut : referenceAmountOut
  return (capped * (BPS - CURVE_PREDICTION_MARGIN_BPS)) / BPS
}

// Counts the firm venue HTTP requests one quoted candidate spends, for
// {@link QuoteOutcome.firmCalls}. It counts requests that reach a venue rather than quote attempts,
// so an adapter failing before its first request (a missing `tokenInDecimals`, an unreachable venue
// arm) truthfully costs nothing.
//
// Read as a delta on the client's own {@link RateLimitedClient.requests} counter when it has one, so a
// transport retry inside a single `getJson` is counted as the extra request it really was. A client
// without one (a test fake) degrades to one per `getJson`, which under-reports a retried request. The
// delta is exact only while nothing else is quoting on the same client — both liquidators work
// candidates serially, and the unwrap chain has already run by the time this is taken.
const countingClient = (client: RateLimitedClient) => {
  const requests = client.requests
  const start = requests?.() ?? 0
  let calls = 0
  const counted: RateLimitedClient = {
    ...client,
    getJson: <T>(args: Parameters<RateLimitedClient['getJson']>[0]) => {
      calls += 1
      return client.getJson<T>(args)
    }
  }
  return { counted, calls: () => (requests ? requests() - start : calls) }
}

// How far a venue-encoded min-out sits ABOVE the break-even floor, in bps of that floor; `0n` when it
// is at or below it, or when there is no floor to measure against.
const floorOvershootBps = (amountOutMinimum: bigint, floor: bigint): bigint =>
  floor <= 0n || amountOutMinimum <= floor ? 0n : ((amountOutMinimum - floor) * BPS) / floor

/**
 * Whether to spend a second firm quote, re-derived against the venue's own quoted output.
 *
 * Both directions of a missed denominator are worth one call, and they are not the same failure. Too
 * high and the encoded floor sits UNDER break-even, where {@link clearsFloor} refuses the quote
 * outright — the venue is unusable without the second pass. Too low and the floor sits above
 * break-even: usable, but every fill in the overshoot band reverts at send although the repay would
 * have covered it, so past {@link MAX_FLOOR_OVERSHOOT_BPS} the call buys back real fills rather than
 * merely a usable quote.
 *
 * A `derived` minimum is exempt in both directions: it is our own reconstruction, so it can neither be
 * checked against the floor nor improved by re-asking (see {@link Swap.minOutSource}).
 */
const needsSecondPass = (swap: Swap, floor: bigint): boolean => {
  if (swap.minOutSource !== 'venue' || swap.expectedAmountOut <= 0n) return false
  if (!clearsFloor(swap, floor)) return true
  return floorOvershootBps(swap.amountOutMinimum, floor) > MAX_FLOOR_OVERSHOOT_BPS
}

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
  /**
   * Predicted venue output for the first pass's min-out denominator (see {@link predictedVenueOut}).
   * Absent falls back to the oracle reference, which a real route always undershoots — so the second
   * pass then runs for every aggregator.
   */
  predictedAmountOut?: bigint
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

  const first = await quote(paramsFor(args.predictedAmountOut ?? referenceAmountOut))
  if (first.error || !first.data) {
    const reason = first.error instanceof QuoteError ? first.error.reason : 'api_error'
    return { kind: 'quote_failed', reason, detail: ensureError(first.error).message }
  }

  // The aggregators apply the slippage percentage to THEIR OWN quote, so the first pass can only ever
  // PREDICT that denominator: it lands their min-out at `quote · floor / prediction`, which misses
  // break-even by however far the prediction missed the real quote — in EITHER direction. Re-deriving
  // against the venue's own quoted output puts it back exactly, which is why the same second pass
  // answers both (see {@link needsSecondPass}). Uniswap applies the percentage to the reference itself
  // and is already at or above the floor, so it never takes this branch.
  let swap = first.data
  if (needsSecondPass(swap, minAcceptableAmountOut)) {
    // An overshooting first quote is already USABLE, so the second pass is an improvement it may
    // decline: a re-quote that drifted down, or never answered, leaves the expensive floor standing
    // rather than losing a fundable liquidation. When the first quote was under the floor there is
    // nothing to fall back to, and a re-quote that never answered is a TRANSPORT failure — reporting
    // it as `floor_unmet` would hand the caller an economic verdict it is entitled to stop its venue
    // walk on.
    const usable = clearsFloor(swap, minAcceptableAmountOut)
    const second = await quote(paramsFor(swap.expectedAmountOut))
    if (second.data && (!usable || clearsFloor(second.data, minAcceptableAmountOut))) {
      swap = second.data
    } else if (!usable) {
      const reason = second.error instanceof QuoteError ? second.error.reason : 'api_error'
      return { kind: 'quote_failed', reason, detail: ensureError(second.error).message }
    }
  }

  // POSTCONDITION, and the actual guarantee — the second pass above is only an attempt to satisfy it.
  // The second quote's own output can come back lower than the first's, which puts its min-out back
  // under the floor; and a venue that only lets us RECONSTRUCT its min-out cannot be checked at all. In
  // both cases the encoded bound does not protect the repay, so the venue is refused and the caller
  // falls through to the next one. Keeping a known-underfloor quote here is what an earlier revision
  // got wrong. A second pass that never answered is NOT one of these cases — it returns above, as the
  // transport failure it is.
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
      stopToken: request.loanToken,
      correlation: correlationOf(request)
    })
  )
  if (error || !resolution) {
    const reason = error instanceof QuoteError ? error.reason : 'api_error'
    logger.warn('unwrap.failed', {
      ...correlationOf(request),
      collateral: request.collateralToken,
      reason,
      detail: ensureError(error).message
    })
    return { outcome: { kind: 'failed', reason } }
  }
  if (resolution.steps.length > 0) {
    logger.info('unwrap.resolved', {
      ...correlationOf(request),
      collateral: request.collateralToken,
      path: [...resolution.steps.map(step => step.tokenIn), resolution.token],
      amountIn: resolution.amountIn
    })
  }
  return { resolution }
}

/**
 * Which swap-free shape a resolution is, for the `venue` field of {@link swapFreePlan}'s log events.
 * Reported so an operator can tell a Midnight loan-as-collateral liquidation (`'no-swap'`, no steps,
 * no venue was ever needed) from a PT-USDC-style unwrap chain that happened to land on the loan token
 * (`'unwrap-only'`, steps that each encode their own min-out). They fail for different reasons and
 * `'unwrap-only'` is load-bearing in existing dashboard queries, so neither name may absorb the other.
 */
const swapFreePath = (resolution: UnwrapResolution): 'no-swap' | 'unwrap-only' =>
  resolution.steps.length === 0 ? 'no-swap' : 'unwrap-only'

/**
 * The sell path already ends in the loan token — nothing left to sell, so the plan needs no venue.
 * Two shapes reach here, distinguished only by {@link swapFreePath}: an unwrap chain that landed on
 * the loan token (PT-USDC collateral in a USDC market), and a collateral token that IS the loan token
 * (Midnight's loan-as-collateral slots), whose plan has no steps at all.
 *
 * Still oracle-sanity-checked and floor-checked: `resolution.amountIn` is the chain's threaded
 * worst-case output — an on-chain bound, not an estimate — and stands in for a venue's quoted output.
 * With zero steps it is exactly `request.amountIn`, so both checks reduce to statements about the
 * oracle: route quality passes unless the oracle prices the collateral more than `maxRouteImpactBps`
 * ABOVE 1:1 — {@link passesRouteQuality} is a floor, not a band, so an underpricing oracle passes at
 * any margin — and the floor passes iff the seize covers its own break-even repay (it does, by
 * construction, for `lif >= WAD`).
 */
const swapFreePlan = (args: {
  resolution: UnwrapResolution
  request: QuoteRequest
  maxRouteImpactBps: number
  logger: QuoteLogger
}): QuoteOutcome => {
  const { resolution, request, maxRouteImpactBps, logger } = args
  const path = swapFreePath(resolution)
  if (
    !passesRouteQuality({
      expected: resolution.amountIn,
      reference: request.referenceAmountOut,
      maxBps: maxRouteImpactBps
    })
  ) {
    logger.warn('unwrap.bad_route', {
      ...correlationOf(request),
      venue: path,
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
    logger.info('quote.floor_unmet', {
      ...correlationOf(request),
      venue: path,
      collateral: request.collateralToken,
      expected: resolution.amountIn,
      amountOutMinimum: resolution.amountIn,
      minOutSource: 'venue',
      floor: request.minAcceptableAmountOut
    })
    return { kind: 'failed', reason: 'floor_unmet' }
  }
  logger.info('quote.ok', {
    ...correlationOf(request),
    venue: path,
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
 * enabled order for venues the probe couldn't rank), fetches ONE firm quote from the top venue, and
 * sanity-checks it against the oracle reference. A curve that ranked every enabled venue on unclamped
 * rungs already names the winner, so the walk stops there; every other curve state (cold, incomplete,
 * clamped) fails open to the coverage-first fall-through through the whole enabled set. A firm quote
 * is requested only AFTER the venue is chosen, never fanned out across venues at once, and its real
 * cost is reported as {@link QuoteOutcome.firmCalls}. Quotes are made ONLY for liquidatable positions,
 * so API + probe usage is bounded by the (small) liquidatable set, never the full candidate universe.
 *
 * No enabled venues → `no_config`, preserving the caller's no-swap posture; `swapFreeWithoutVenues`
 * carves out the one exception, a resolution needing neither a venue nor a call.
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
   * Whether a venue-less deployment may still act on a plan needing no venue AND NO CALLS — the
   * unwrap chain is resolved first, since it is what decides whether a venue is needed at all, but
   * only a zero-step resolution is then acted on. Only for callers whose protocol has such a mode
   * (Midnight's loan-as-collateral slots under `ALLOW_BAD_DEBT_ONLY`).
   *
   * Defaults to `false`, which is what keeps a deliberately unarmed deployment unarmed: it refuses
   * before any unwrap RPC, so it can neither broadcast nor arm backoff off a transient read failure.
   */
  swapFreeWithoutVenues?: boolean
  /**
   * Probe-cache refresh for the (post-unwrap) pair — runs here, after unwrap resolution, so the
   * probes price the tradable underlying. Failures are non-fatal (cold-default venue order).
   */
  refresh: (pair: VenuePair) => Promise<void>
  /**
   * Best-first venues (with interpolated outputs and per-venue costs against `referenceAmountOut`)
   * for a pair+size, from the probe cache; `[]` if cold. Satisfied by `VenueSelector.select`.
   */
  select: (
    pair: VenuePair,
    amountIn: bigint,
    referenceAmountOut?: bigint
  ) => readonly VenueCostEstimate[]
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
    swapFreeWithoutVenues = false,
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
  //
  // `trusted` is true only when the curve ranked EVERY enabled venue on unclamped rungs, which is the
  // one case where the winner is genuinely known; anything less and the caller must keep its full
  // fall-through, because a probe that ranked less than everything could be hiding the healthy venue.
  const venuePlanFor = async (args: {
    pair: VenuePair
    amountIn: bigint
    referenceAmountOut: bigint
    /** {@link correlationOf}'s output for the request being quoted. */
    correlation: ReturnType<typeof correlationOf>
  }): Promise<{ order: Venue[]; estimates: Map<Venue, VenueCostEstimate>; trusted: boolean }> => {
    const { pair, amountIn, referenceAmountOut, correlation } = args
    const { error: probeError } = await tryCatch(refresh(pair))
    if (probeError) {
      logger.warn('probe.error', {
        ...correlation,
        collateral: pair.collateral,
        loan: pair.loan,
        detail: probeError.message
      })
    }

    const ranked = select(pair, amountIn, referenceAmountOut)
    const estimates = new Map(ranked.map(estimate => [estimate.venue, estimate]))
    const order = [...estimates.keys(), ...venues.filter(venue => !estimates.has(venue))]
    if (ranked.length === 0) {
      logger.info('select.cold_default', {
        ...correlation,
        collateral: pair.collateral,
        loan: pair.loan,
        order
      })
    }
    return { order, estimates, trusted: curveIsTrusted(ranked, venues) }
  }

  return {
    async quoteFor(request) {
      const { collateralToken, loanToken, referenceAmountOut } = request
      const correlation = correlationOf(request)

      if (venues.length === 0 && !swapFreeWithoutVenues) return { kind: 'no_config', firmCalls: 0 }

      const unwrapped = await tryResolveUnwraps(unwrappers, request, executor, logger)
      if ('outcome' in unwrapped) return { ...unwrapped.outcome, firmCalls: 0 }
      const { resolution } = unwrapped

      // Nothing left to sell, so this resolves WITHOUT a venue — deliberately ahead of the
      // no-venues gate below. A sell path already ending in the loan token needs no route at all, so
      // a caller that opted into `swapFreeWithoutVenues` must still be able to liquidate it; gating
      // on `venues` first would refuse the one case that provably does not need one.
      if (isAddressEqual(resolution.token, loanToken)) {
        // ...but only the `'no-swap'` shape (see {@link swapFreePath}). An unwrap chain that merely
        // LANDS on the loan token still moves assets and carries per-hop execution risk, which is
        // more than a venue-less posture promises — `ALLOW_BAD_DEBT_ONLY` names loan-as-collateral
        // slots, not PT-USDC. Venue-enabled callers keep both shapes, exactly as before.
        if (venues.length === 0 && resolution.steps.length > 0) {
          return { kind: 'no_config', firmCalls: 0 }
        }
        return { ...swapFreePlan({ resolution, request, maxRouteImpactBps, logger }), firmCalls: 0 }
      }

      if (venues.length === 0) return { kind: 'no_config', firmCalls: 0 }

      const pair: VenuePair = { collateral: resolution.token, loan: loanToken }
      const { order, estimates, trusted } = await venuePlanFor({
        pair,
        amountIn: resolution.amountIn,
        referenceAmountOut,
        correlation
      })
      // A trusted curve ranked every enabled venue on exactly the axis `bad_route` and `floor_unmet`
      // measure, so once the winner has been quoted those two say nothing a runner-up would change and
      // the walk stops there — one candidate costs one venue's worth of calls. `quote_failed` is NOT
      // on that axis: the curve ranked output, not reachability, so a timeout or a rate limit — on the
      // first pass or on the min-out re-derivation — still falls through. Anything the curve cannot
      // vouch for fails OPEN to the full pre-curve walk, because the guarantee it replaces is that a
      // mis-ranked probe costs a fall-through, never a lost route.
      const stopAfterWinner = trusted

      // Try the candidate venues in order; a quote or route-quality failure falls through to the next
      // (coverage-first). Only the CHOSEN venue is firm-quoted per step — never all venues at once.
      // `lastReason` is last-venue-wins, so a transport failure after a floor miss reports the failure
      // and the caller still backs off — the conservative direction of the two.
      const { counted, calls } = countingClient(httpClient)
      let lastReason: QuoteFailureReason = 'no_route'
      for (const venue of order) {
        const outcome = await firmQuoteVenue({
          httpClient: counted,
          chainId,
          executor,
          venueEntry: () => entryFor(venue),
          tokenIn: resolution.token,
          amountIn: resolution.amountIn,
          steps: resolution.steps,
          request,
          maxRouteImpactBps,
          predictedAmountOut: predictedVenueOut(estimates.get(venue), referenceAmountOut)
        })
        if (outcome.kind === 'quote_failed') {
          lastReason = outcome.reason
          logger.warn('quote.failed', {
            ...correlation,
            venue,
            collateral: collateralToken,
            reason: lastReason,
            detail: outcome.detail
          })
          continue
        }
        if (outcome.kind === 'floor_unmet') {
          lastReason = 'floor_unmet'
          // `info`, not `warn`: the floor IS the break-even repay, so during the post-maturity ramp
          // every venue misses it for every candidate on every block until the incentive catches up.
          // That is the ordinary early-ramp shape, not an anomaly to page on.
          logger.info('quote.floor_unmet', {
            ...correlation,
            venue,
            collateral: collateralToken,
            expected: outcome.swap.expectedAmountOut,
            amountOutMinimum: outcome.swap.amountOutMinimum,
            minOutSource: outcome.swap.minOutSource,
            floor: outcome.floor
          })
          if (stopAfterWinner) break
          continue
        }
        if (outcome.kind === 'bad_route') {
          lastReason = 'bad_route'
          logger.warn('quote.route_quality_failed', {
            ...correlation,
            venue,
            collateral: collateralToken,
            expected: outcome.swap.expectedAmountOut,
            oracle: referenceAmountOut
          })
          if (stopAfterWinner) break
          continue
        }
        logger.info('select.ok', {
          ...correlation,
          venue,
          collateral: collateralToken,
          expected: outcome.swap.expectedAmountOut,
          oracle: referenceAmountOut,
          amountOutMinimum: outcome.swap.amountOutMinimum,
          // The probe-fidelity pair: what the curve interpolated this route would cost against the
          // oracle, beside the same figure off the quote the venue actually returned. Both are QUOTED
          // costs — neither is realized on-chain execution, and reading them as such is the error the
          // pair exists to make visible.
          curveCostBps: estimates.get(venue)?.costBpsRaw ?? null,
          // Cache age of the curve those bps came off, so a fidelity reading can be attributed to
          // staleness rather than to the interpolation, and a fail-open is visible as `null`.
          curveAgeMs: estimates.get(venue)?.ageMs ?? null,
          firmQuoteCostBps: routeCostBps({
            reference: referenceAmountOut,
            amountOut: outcome.swap.expectedAmountOut
          }),
          firmCalls: calls(),
          order
        })
        return { kind: 'swap', plan: outcome.plan, firmCalls: calls() }
      }
      return { kind: 'failed', reason: lastReason, firmCalls: calls() }
    }
  }
}
