import type { Address } from 'viem'

import { ensureError, safeParseUnits, tryCatch } from '@repo/utils'
import { getAddress } from 'viem'

import type { QuoteLogger } from './quoting'
import type { PriceParameters, PriceQuote, Venue } from './types'

import { InvalidProbeLadderError } from './invalid-probe-ladder.error'

/** A collateral→loan swap pair the selector probes and ranks venues for. */
export type VenuePair = { collateral: Address; loan: Address }

/**
 * Fixed-point decimals of the `usdPriceOf` feed and of the USD probe ladder — `1e8`, matching the
 * scale the Markets-API token prices are normalized to at their boundary.
 */
export const USD_LADDER_PRICE_DECIMALS = 8

/**
 * A venue's estimated execution at one size, interpolated from the cached probe curve.
 *
 * The cache holds venue rates only — no oracle — so `costBps` is derived per call from the caller's
 * own `referenceAmountOut`. Two markets sharing a pair therefore read one cached curve and each get
 * a cost against their own oracle. `clamped` marks an estimate taken from a ladder end rather than
 * between two rungs; callers must fail open on it (see {@link VenueSelector.select}).
 */
export type VenueCostEstimate = {
  venue: Venue
  /** Interpolated output for the requested `amountIn`, in loan-token base units. */
  estimatedOut: bigint
  /**
   * Route cost against the caller's oracle: `(reference - estimatedOut) / reference * 1e4`. `null`
   * when no reference was supplied — venue ORDERING needs none, because every venue at a rung is
   * probed in the same refresh, so their ratio is immune to the price drift `estimatedOut` carries.
   * Floored at `0`: a venue beating the oracle is a stale oracle, never a bonus to score. See
   * {@link VenueCostEstimate.costBpsRaw} when the sign itself is the signal.
   */
  costBps: number | null
  /**
   * The same figure unfloored, so a venue quoting ABOVE the oracle stays visible as the negative it
   * is. Observability only — never score on it. A persistently negative value is the signature of a
   * stale or optimistic oracle rather than a free lunch, which is how the 2026-08-28 maturity's
   * first-minute readings were misread.
   */
  costBpsRaw: number | null
  /** `amountIn` fell outside the probed ladder, or a bracketing rung was missing for this venue. */
  clamped: boolean
}

/** One venue's indicative execution at one ladder rung — pure market data, no oracle. */
type RungQuote = { amountIn: bigint; expectedOut: bigint }

/**
 * One pair's cached probe: the base-unit sizes we priced at, and — per venue — one entry per ladder
 * index (`null` where that rung failed to probe). `updatedAt` gates staleness.
 */
type PairCache = {
  updatedAt: number
  ladder: bigint[]
  curves: Map<Venue, (RungQuote | null)[]>
}

/** A process-lifetime probe cache + best-first venue lookup, keyed by chain + collateral + loan. */
export type VenueSelector = {
  /** Probe every enabled venue for `pair` at each ladder point, unless the cache is still fresh. */
  refresh: (pair: VenuePair) => Promise<void>
  /**
   * Best-first venues for `pair` at `amountIn`, interpolated across the probed ladder; `[]` when the
   * pair is not yet probed. Pass `referenceAmountOut` to populate {@link VenueCostEstimate.costBps}.
   *
   * Pure and synchronous — a cache lookup plus arithmetic — because phase A sizing calls it and must
   * not await. A `[]` result, or any entry with `clamped: true`, means the curve cannot be trusted
   * for selection and the caller must fall back to its pre-curve behaviour.
   */
  select: (pair: VenuePair, amountIn: bigint, referenceAmountOut?: bigint) => VenueCostEstimate[]
  /** Per-pair cache ages + current winner per bucket, for periodic / shutdown observability. */
  snapshot: () => { pair: string; ageMs: number; winners: (Venue | null)[] }[]
}

// Fixed-point scale for a venue rate (`expectedOut / amountIn`). Wide enough to keep the probed
// ratio's significant digits even on a high-decimal-in / low-decimal-out pair.
const RATE_SCALE = 10n ** 18n

// Basis points times 100, so `costBps` carries two decimal places without a float divide.
const CENTI_BPS = 1_000_000n

const rateOf = (rung: RungQuote): bigint => (rung.expectedOut * RATE_SCALE) / rung.amountIn

const ascending = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0)

// The two adjacent ladder indices enclosing `amountIn`, or `null` when it sits outside the ladder.
const bracketOf = (ladder: bigint[], amountIn: bigint): [number, number] | null => {
  for (let i = 0; i + 1 < ladder.length; i++) {
    const lo = ladder[i]
    const hi = ladder[i + 1]
    if (lo !== undefined && hi !== undefined && amountIn >= lo && amountIn <= hi) return [i, i + 1]
  }
  return null
}

// Where `amountIn` sits between two rungs in LOG space, as a `RATE_SCALE` weight in [0, 1]. The only
// float in the interpolation path: the rates it blends stay exact bigints, and a `Number` ratio of
// two same-pair sizes stays well inside double precision even when the amounts exceed 2**53.
const logWeight = (lo: bigint, hi: bigint, amountIn: bigint): bigint => {
  const span = Math.log(Number(hi) / Number(lo))
  const offset = Math.log(Number(amountIn) / Number(lo))
  if (!Number.isFinite(span) || span <= 0 || !Number.isFinite(offset)) return 0n
  return BigInt(Math.round(Math.min(1, Math.max(0, offset / span)) * Number(RATE_SCALE)))
}

// Probed rung closest to `amountIn` in log space — the clamp target when the bracket is unusable.
const nearestProbed = (rungs: (RungQuote | null)[], amountIn: bigint): RungQuote | null => {
  let best: RungQuote | null = null
  let bestDistance = Infinity
  for (const rung of rungs) {
    if (!rung) continue
    const ratio = Number(amountIn) / Number(rung.amountIn)
    const distance = ratio >= 1 ? ratio : 1 / ratio
    if (distance < bestDistance) {
      bestDistance = distance
      best = rung
    }
  }
  return best
}

// Log-linear interpolation of a venue's rate at `amountIn`, or a clamp to its nearest probed rung
// when `amountIn` falls off the ladder or a bracketing rung never returned. Never extrapolates.
const rateAt = (
  ladder: bigint[],
  rungs: (RungQuote | null)[],
  amountIn: bigint
): { rate: bigint; clamped: boolean } | null => {
  const bracket = bracketOf(ladder, amountIn)
  const lo = bracket ? rungs[bracket[0]] : undefined
  const hi = bracket ? rungs[bracket[1]] : undefined
  if (lo && hi) {
    const loRate = rateOf(lo)
    const weight = logWeight(lo.amountIn, hi.amountIn, amountIn)
    return { rate: loRate + ((rateOf(hi) - loRate) * weight) / RATE_SCALE, clamped: false }
  }
  const nearest = nearestProbed(rungs, amountIn)
  return nearest ? { rate: rateOf(nearest), clamped: true } : null
}

const costBpsOf = (referenceAmountOut: bigint | undefined, estimatedOut: bigint): number | null => {
  if (referenceAmountOut === undefined || referenceAmountOut <= 0n) return null
  const shortfall = referenceAmountOut - estimatedOut
  return Number((shortfall * CENTI_BPS) / referenceAmountOut) / 100
}

/**
 * Builds the venue selector consumed by {@link composeMultiVenueQuoting}. It caches, per pair, each
 * enabled venue's indicative RATE at each log-scaled ladder size and interpolates that curve on
 * `select`. `refresh` is staleMs-gated so repeat calls for the same pair within the window make no
 * venue calls — the caller drives it only for pairs with a liquidatable position, so no venue budget
 * is spent on quiet markets. `select` is pure/synchronous (cache lookup plus arithmetic). The cache
 * lives in this closure — one selector instance is the process-lifetime "global" cache; do not hoist
 * it to module scope (keeps tests isolated).
 *
 * The cache key is `(chainId, collateral, loan)` and is deliberately SHARED by every market on that
 * pair. That is sound only because nothing oracle-derived is stored: a rung holds `amountIn` and
 * `expectedOut`, so two markets on one pair with different oracles read the same curve and each
 * derive their own {@link VenueCostEstimate.costBps} from their own `referenceAmountOut`.
 *
 * Staleness is asymmetric, so tune `staleMs` against the absolute term alone. Every venue at a rung
 * is probed inside one refresh, so their rates drift together and the venue ORDERING holds at any
 * cache age; it is the cross-candidate cost LEVEL that decays as the pair's price leaves the cached
 * rate behind.
 */
export function createVenueSelector(deps: {
  venues: readonly Venue[]
  chainId: number
  /**
   * Log-scaled probe sizes, read as USD decades (e.g. `['0.01', …, '100000']`) when `usdPriceOf`
   * prices the collateral, and as whole collateral tokens when it does not.
   */
  ladderSizes: readonly string[]
  getDecimals: (token: Address) => Promise<number>
  /**
   * USD price of one whole `token`, scaled by `10 ** USD_LADDER_PRICE_DECIMALS`. Absent, or `null`
   * for this token, falls the ladder back to the whole-collateral-token reading of `ladderSizes`.
   */
  usdPriceOf?: (token: Address) => Promise<bigint | null>
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

  const decimalsFor = async (token: Address): Promise<number> => {
    const key = getAddress(token)
    const cached = decimalsCache.get(key)
    if (cached !== undefined) return cached
    const decimals = await deps.getDecimals(token)
    decimalsCache.set(key, decimals)
    return decimals
  }

  // Ladder in the collateral's base units, sorted and deduped so the bracket search stays monotonic
  // even when the operator lists the sizes out of order or two USD rungs collapse onto one base-unit
  // amount. Fail loud on a malformed/non-positive CONFIGURED size — operator misconfig — but merely
  // drop a rung whose USD value converts to less than one base unit.
  const ladderFor = async (collateral: Address, decimals: number): Promise<bigint[]> => {
    const price = (await deps.usdPriceOf?.(collateral)) ?? null
    const usdPrice = price !== null && price > 0n ? price : null
    const sizes = deps.ladderSizes.map(size => {
      const parsed = safeParseUnits(size, usdPrice === null ? decimals : USD_LADDER_PRICE_DECIMALS)
      if (parsed === null || parsed <= 0n) throw new InvalidProbeLadderError(size)
      return usdPrice === null ? parsed : (parsed * 10n ** BigInt(decimals)) / usdPrice
    })
    return [...new Set(sizes.filter(size => size > 0n))].toSorted(ascending)
  }

  const refresh = async (pair: VenuePair): Promise<void> => {
    const key = keyFor(pair)
    const existing = cache.get(key)
    if (existing && now() - existing.updatedAt < deps.staleMs) return

    // Collateral decimals: for the ladder, and passed to the probe so decimal-denominated venues
    // (LiquidSwap) can convert base units → a human-readable amountIn.
    const collateralDecimals = await decimalsFor(pair.collateral)
    const ladder = await ladderFor(pair.collateral, collateralDecimals)
    const curves = new Map<Venue, (RungQuote | null)[]>()
    for (const venue of deps.venues) {
      const rungs: (RungQuote | null)[] = []
      for (const amountIn of ladder) {
        const { data, error } = await tryCatch(
          deps.indicativeQuote(venue, {
            chainId: deps.chainId,
            tokenIn: pair.collateral,
            tokenOut: pair.loan,
            amountIn,
            tokenInDecimals: collateralDecimals
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
          rungs.push(null)
          continue
        }
        rungs.push(
          data && data.expectedAmountOut > 0n
            ? { amountIn, expectedOut: data.expectedAmountOut }
            : null
        )
      }
      if (rungs.some(rung => rung !== null)) curves.set(venue, rungs)
    }

    cache.set(key, { updatedAt: now(), ladder, curves })
    deps.logger.info('probe.refreshed', {
      collateral: pair.collateral,
      loan: pair.loan,
      points: ladder.length,
      venues: deps.venues.length,
      curved: curves.size
    })
  }

  // Ranked on the interpolated RATE rather than on `estimatedOut`, so the ordering survives a size
  // small enough that every venue's output floors to the same base-unit figure.
  const select = (
    pair: VenuePair,
    amountIn: bigint,
    referenceAmountOut?: bigint
  ): VenueCostEstimate[] => {
    const entry = cache.get(keyFor(pair))
    if (!entry) return []
    const ranked: { rate: bigint; estimate: VenueCostEstimate }[] = []
    for (const [venue, rungs] of entry.curves) {
      const interpolated = rateAt(entry.ladder, rungs, amountIn)
      if (!interpolated) continue
      const estimatedOut = (interpolated.rate * amountIn) / RATE_SCALE
      const raw = costBpsOf(referenceAmountOut, estimatedOut)
      ranked.push({
        rate: interpolated.rate,
        estimate: {
          venue,
          estimatedOut,
          costBps: raw === null ? null : Math.max(raw, 0),
          costBpsRaw: raw,
          clamped: interpolated.clamped
        }
      })
    }
    return ranked.toSorted((a, b) => ascending(b.rate, a.rate)).map(candidate => candidate.estimate)
  }

  const winnerAt = (curves: Map<Venue, (RungQuote | null)[]>, index: number): Venue | null => {
    let winner: Venue | null = null
    let bestRate = 0n
    for (const [venue, rungs] of curves) {
      const rung = rungs[index]
      if (!rung) continue
      const rate = rateOf(rung)
      if (winner === null || rate > bestRate) {
        winner = venue
        bestRate = rate
      }
    }
    return winner
  }

  const snapshot = () =>
    [...cache.entries()].map(([pair, entry]) => ({
      pair,
      ageMs: now() - entry.updatedAt,
      winners: entry.ladder.map((_, index) => winnerAt(entry.curves, index))
    }))

  return { refresh, select, snapshot }
}
