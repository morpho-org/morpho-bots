import type { Address } from 'viem'

import { assertNever, ensureError, tryCatch } from '@repo/utils'
import { getAddress } from 'viem'

import type { SwapConfigEntry } from './config'
import type { RateLimitedClient } from './http-client'
import type {
  PriceParameters,
  PriceQuote,
  QuoteFailureReason,
  QuoteOutcome,
  QuoteParameters,
  Swap,
  Venue
} from './types'

import { BPS } from './constants'
import { QuoteError } from './types'
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
 * projects its lens output into a {@link QuoteRequest}). For each liquidatable position it resolves
 * the operator's per-collateral venue, fetches ONE executable quote (Uniswap is local; aggregators
 * make a single API call), and sanity-checks an aggregator's quoted output against the free oracle
 * reference — rejecting a route worse than `maxRouteImpactBps` below it. Quote/route failures return
 * `failed` (the caller backs the position off); an unconfigured collateral returns `no_config` (no API
 * call, no backoff). Quotes are made ONLY for liquidatable positions, so API usage is bounded by the
 * (small) liquidatable set, never the full candidate universe.
 */
export function composeQuoting(deps: {
  httpClient: RateLimitedClient
  chainId: number
  executor: Address
  /** Per-collateral venue config for this chain, keyed by EIP-55-checksummed collateral address. */
  swapByCollateral: Map<string, SwapConfigEntry>
  maxRouteImpactBps: number
  logger: QuoteLogger
}): { quoteFor: (request: QuoteRequest) => Promise<QuoteOutcome> } {
  const { httpClient, chainId, executor, swapByCollateral, maxRouteImpactBps, logger } = deps

  return {
    async quoteFor(request) {
      const { collateralToken, loanToken, amountIn, referenceAmountOut } = request
      const entry = swapByCollateral.get(getAddress(collateralToken))
      if (!entry) return { kind: 'no_config' }

      const params: QuoteParameters = {
        chainId,
        tokenIn: collateralToken,
        tokenOut: loanToken,
        // Seize-exact: the contract transfers exactly `amountIn` to the Executor before the
        // callback, so this is exactly the collateral the swap will sell — no prediction needed.
        amountIn,
        slippageBps: entry.slippageBps,
        executor,
        referenceAmountOut,
        tokenInDecimals: request.tokenInDecimals
      }

      const { data: swap, error } = await tryCatch(quoteByVenue(httpClient, entry, params))
      if (error || !swap) {
        const reason = error instanceof QuoteError ? error.reason : 'api_error'
        logger.warn('quote.failed', {
          venue: entry.venue,
          collateral: collateralToken,
          reason,
          detail: ensureError(error).message
        })
        return { kind: 'failed', reason }
      }

      if (
        !passesRouteQuality({
          expected: swap.expectedAmountOut,
          reference: referenceAmountOut,
          maxBps: maxRouteImpactBps
        })
      ) {
        logger.warn('quote.bad_route', {
          venue: entry.venue,
          collateral: collateralToken,
          expected: swap.expectedAmountOut,
          oracle: referenceAmountOut
        })
        return { kind: 'failed', reason: 'bad_route' }
      }

      logger.info('quote.ok', {
        venue: entry.venue,
        collateral: collateralToken,
        expected: swap.expectedAmountOut,
        oracle: referenceAmountOut,
        amountOutMinimum: swap.amountOutMinimum
      })
      return { kind: 'swap', swap }
    }
  }
}

/**
 * Multi-venue variant of {@link composeQuoting} for bots that discover collateral at runtime and rank
 * venues by a cached probe (see {@link createVenueSelector}) instead of a per-collateral config file.
 * For each liquidatable position it takes the selector's best-first venue order (or a deterministic
 * default when the pair is not yet probed), fetches ONE firm quote from the top venue, sanity-checks
 * it against the oracle reference, and — coverage-first — falls through to the next ranked venue on
 * failure (bounded by the enabled set) before giving up. No enabled venues → `no_config` (no API call),
 * preserving the caller's bad-debt path. A firm quote is requested only AFTER the venue is chosen,
 * never fanned out across venues at once.
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
  /** Best-first venues (with indicative outputs) for a pair+size, from the probe cache; `[]` if cold. */
  select: (
    pair: { collateral: Address; loan: Address },
    amountIn: bigint
  ) => readonly { venue: Venue; expectedOut: bigint }[]
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

  return {
    async quoteFor(request) {
      const { collateralToken, loanToken, amountIn, referenceAmountOut } = request
      if (venues.length === 0) return { kind: 'no_config' }

      const ranked = select({ collateral: collateralToken, loan: loanToken }, amountIn)
      const order = ranked.length > 0 ? ranked.map(estimate => estimate.venue) : [...venues]
      if (ranked.length === 0) {
        logger.info('select.cold_default', { collateral: collateralToken, loan: loanToken, order })
      }

      const params: QuoteParameters = {
        chainId,
        tokenIn: collateralToken,
        tokenOut: loanToken,
        // Seize-exact: the contract transfers exactly `amountIn` to the Executor before the callback.
        amountIn,
        slippageBps,
        executor,
        referenceAmountOut,
        tokenInDecimals: request.tokenInDecimals
      }

      // Try the ranked venues in order; a quote or route-quality failure falls through to the next
      // (coverage-first). Only the CHOSEN venue is firm-quoted per step — never all venues at once.
      let lastReason: QuoteFailureReason = 'no_route'
      for (const venue of order) {
        // The `entryFor` call is inside the awaited thunk so a synchronous throw (an unreachable
        // uniswap arm) becomes a caught rejection, never an escape that aborts the op run.
        const { data: swap, error } = await tryCatch(
          (async () => quoteByVenue(httpClient, entryFor(venue), params))()
        )
        if (error || !swap) {
          lastReason = error instanceof QuoteError ? error.reason : 'api_error'
          logger.warn('quote.failed', {
            venue,
            collateral: collateralToken,
            reason: lastReason,
            detail: ensureError(error).message
          })
          continue
        }
        if (
          !passesRouteQuality({
            expected: swap.expectedAmountOut,
            reference: referenceAmountOut,
            maxBps: maxRouteImpactBps
          })
        ) {
          lastReason = 'bad_route'
          logger.warn('quote.route_quality_failed', {
            venue,
            collateral: collateralToken,
            expected: swap.expectedAmountOut,
            oracle: referenceAmountOut
          })
          continue
        }
        logger.info('select.ok', {
          venue,
          collateral: collateralToken,
          expected: swap.expectedAmountOut,
          oracle: referenceAmountOut,
          amountOutMinimum: swap.amountOutMinimum,
          order
        })
        return { kind: 'swap', swap }
      }
      return { kind: 'failed', reason: lastReason }
    }
  }
}
