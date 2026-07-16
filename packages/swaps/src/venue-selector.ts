import type { Address } from 'viem'

import { ensureError, safeParseUnits, tryCatch } from '@repo/utils'
import { getAddress } from 'viem'

import type { QuoteLogger } from './quoting'
import type { PriceParameters, PriceQuote, Venue } from './types'

/** A collateral→loan swap pair the selector probes and ranks venues for. */
export type VenuePair = { collateral: Address; loan: Address }

/** A venue and its indicative output for a probe size — the unit `select` ranks and returns. */
export type VenueQuoteEstimate = { venue: Venue; expectedOut: bigint }

// One pair's cached probe: the base-unit sizes we priced at, and — per ladder index — the best-first
// venue ranking. `updatedAt` gates staleness.
type PairCache = {
  updatedAt: number
  ladder: bigint[]
  rankedByBucket: VenueQuoteEstimate[][]
}

/** A process-lifetime probe cache + best-first venue lookup, keyed by chain + collateral + loan. */
export type VenueSelector = {
  /** Probe every enabled venue for `pair` at each ladder point, unless the cache is still fresh. */
  refresh: (pair: VenuePair) => Promise<void>
  /** Best-first venues for `pair` at the `amountIn` size bucket; `[]` when the pair is not yet probed. */
  select: (pair: VenuePair, amountIn: bigint) => VenueQuoteEstimate[]
  /** Per-pair cache ages + current winner per bucket, for periodic / shutdown observability. */
  snapshot: () => { pair: string; ageMs: number; winners: (Venue | null)[] }[]
}

// Nearest ladder index to `amountIn` in LOG space (venue rankings shift with size, and the ladder is
// log-scaled). Uses Number ratios — exact precision is unnecessary for choosing a bucket, and the
// ratios stay small even when the amounts exceed 2**53.
function nearestBucket(ladder: bigint[], amountIn: bigint): number {
  let best = 0
  let bestDistance = Infinity
  for (let i = 0; i < ladder.length; i++) {
    const point = ladder[i]
    if (point === undefined || point <= 0n) continue
    const ratio = Number(amountIn) / Number(point)
    const distance = ratio >= 1 ? ratio : 1 / ratio
    if (distance < bestDistance) {
      bestDistance = distance
      best = i
    }
  }
  return best
}

/**
 * Builds the venue selector consumed by {@link composeMultiVenueQuoting}. It caches, per pair, an
 * indicative output curve (each enabled venue priced at each log-scaled ladder size) and exposes a
 * best-first venue ranking per size bucket. `refresh` is staleMs-gated so repeat calls for the same
 * pair within the window make no venue calls — the caller drives it only for pairs with a liquidatable
 * position, so no venue budget is spent on quiet markets. `select` is pure/synchronous (cache lookup).
 * The cache lives in this closure — one selector instance is the process-lifetime "global" cache; do
 * not hoist it to module scope (keeps tests isolated).
 */
export function createVenueSelector(deps: {
  venues: readonly Venue[]
  chainId: number
  /** Log-scaled sell sizes in whole collateral tokens (e.g. `['0.01','0.1','1','10','100']`). */
  ladderWholeTokens: readonly string[]
  getDecimals: (token: Address) => Promise<number>
  indicativeQuote: (venue: Venue, params: PriceParameters) => Promise<PriceQuote>
  staleMs: number
  logger: QuoteLogger
  now?: () => number
}): VenueSelector {
  const now = deps.now ?? (() => Date.now())
  const cache = new Map<string, PairCache>()
  const decimalsCache = new Map<string, number>()

  const keyFor = (pair: VenuePair) =>
    `${deps.chainId}:${getAddress(pair.collateral)}:${getAddress(pair.loan)}`

  async function decimalsFor(token: Address): Promise<number> {
    const key = getAddress(token)
    const cached = decimalsCache.get(key)
    if (cached !== undefined) return cached
    const decimals = await deps.getDecimals(token)
    decimalsCache.set(key, decimals)
    return decimals
  }

  // Log-scaled ladder in the collateral's base units. Fail loud on a malformed/non-positive entry —
  // a bad ladder is operator misconfig, and a silently-dropped point would skew the size buckets.
  function ladderFor(decimals: number): bigint[] {
    return deps.ladderWholeTokens.map(size => {
      const parsed = safeParseUnits(size, decimals)
      if (parsed === null || parsed <= 0n) {
        throw new Error(`invalid probe ladder size: "${size}"`)
      }
      return parsed
    })
  }

  async function refresh(pair: VenuePair): Promise<void> {
    const key = keyFor(pair)
    const existing = cache.get(key)
    if (existing && now() - existing.updatedAt < deps.staleMs) return

    const ladder = ladderFor(await decimalsFor(pair.collateral))
    const rankedByBucket: VenueQuoteEstimate[][] = ladder.map(() => [])
    for (const venue of deps.venues) {
      for (let i = 0; i < ladder.length; i++) {
        const amountIn = ladder[i]
        if (amountIn === undefined) continue
        const { data, error } = await tryCatch(
          deps.indicativeQuote(venue, {
            chainId: deps.chainId,
            tokenIn: pair.collateral,
            tokenOut: pair.loan,
            amountIn
          })
        )
        if (error) {
          deps.logger.warn('probe.venue_error', {
            venue,
            collateral: pair.collateral,
            loan: pair.loan,
            amountIn: amountIn.toString(),
            detail: ensureError(error).message
          })
          continue
        }
        if (!data || data.expectedAmountOut <= 0n) continue
        rankedByBucket[i]?.push({ venue, expectedOut: data.expectedAmountOut })
      }
    }
    for (const estimates of rankedByBucket) {
      estimates.sort((a, b) =>
        a.expectedOut < b.expectedOut ? 1 : a.expectedOut > b.expectedOut ? -1 : 0
      )
    }

    cache.set(key, { updatedAt: now(), ladder, rankedByBucket })
    deps.logger.info('probe.refreshed', {
      collateral: pair.collateral,
      loan: pair.loan,
      points: ladder.length,
      venues: deps.venues.length
    })
  }

  function select(pair: VenuePair, amountIn: bigint): VenueQuoteEstimate[] {
    const entry = cache.get(keyFor(pair))
    if (!entry) return []
    return entry.rankedByBucket[nearestBucket(entry.ladder, amountIn)] ?? []
  }

  function snapshot() {
    return [...cache.entries()].map(([pair, entry]) => ({
      pair,
      ageMs: now() - entry.updatedAt,
      winners: entry.rankedByBucket.map(estimates => estimates[0]?.venue ?? null)
    }))
  }

  return { refresh, select, snapshot }
}
