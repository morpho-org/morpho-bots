import type { Address } from 'viem'

import { ensureError, safeParseUnits, tryCatch } from '@repo/utils'
import { getAddress } from 'viem'

import type { QuoteLogger } from './quoting'
import type { PriceParameters, PriceQuote, Venue } from './types'

import { routeCostBps } from './cost-bps.utils'
import { InvalidProbeLadderError } from './invalid-probe-ladder.error'

/** A collateral→loan swap pair the selector probes and ranks venues for. */
export type VenuePair = { collateral: Address; loan: Address }

/**
 * The canonical dedup key for a {@link VenuePair} — checksummed, so two spellings of one pair collapse.
 * Exported so a caller deduplicating pairs before driving {@link VenueSelector.refresh} keys them
 * exactly as the cache does; a caller keying them itself can drift from the cache it is filling.
 * Chain-agnostic: the cache prefixes its own `chainId`, which a single-chain caller does not have to.
 */
export const venuePairKey = (pair: VenuePair): string =>
  `${getAddress(pair.collateral)}:${getAddress(pair.loan)}`

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
  /**
   * Age of the cached curve this was read off, in ms.
   *
   * Bound it before consuming {@link VenueCostEstimate.estimatedOut} as an absolute level — that is
   * the only term staleness decays (see {@link createVenueSelector} for the asymmetry). Venue
   * ORDERING needs no bound at any age.
   */
  ageMs: number
}

/**
 * How old a cached curve may be before its absolute LEVEL stops being usable.
 *
 * Bounds every consumer of {@link VenueCostEstimate.estimatedOut} as a level — a first-pass min-out
 * denominator and a cross-candidate route-cost ranking alike — because that is the single term
 * staleness decays (see {@link createVenueSelector} for the asymmetry). Venue ORDERING is deliberately
 * unbounded, which is why this is not a second `PROBE_STALE_MS`: a bot whose probe cadence is long
 * because it only consumes ordering (blue's is 10 minutes) must not thereby inherit a 10-minute-old
 * denominator.
 */
export const MAX_COST_LEVEL_AGE_MS = 60_000

/**
 * Whether a pair's curve may be consumed as an absolute cost level: every enabled venue ranked, none
 * clamped off the probed ladder, none past {@link MAX_COST_LEVEL_AGE_MS}, and every level positive.
 *
 * One predicate for both consumers — the firm-quote fall-through bound here, and a bot's
 * cross-candidate ranking — because a curve either supports level comparisons or it does not. Two
 * hand-rolled subsets of these clauses is how a candidate cutoff comes to trust a curve that quoting
 * itself refuses. `false` is always the fail-open answer: score gross, walk every venue.
 */
export const curveIsTrusted = (
  estimates: readonly VenueCostEstimate[],
  venues: readonly Venue[]
): boolean =>
  estimates.length > 0 &&
  venues.every(venue => estimates.some(estimate => estimate.venue === venue)) &&
  estimates.every(
    estimate =>
      !estimate.clamped && estimate.estimatedOut > 0n && estimate.ageMs <= MAX_COST_LEVEL_AGE_MS
  )

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
  /**
   * Probe every enabled venue for `pair` at each ladder point, unless the cache is still fresh.
   *
   * Venues run concurrently and their rungs serially, so the sweep costs about one rung's rate-limit
   * wait times the rung count (~8 s for 8 rungs at 1 rps) rather than that times the venue count.
   * Resolves as soon as a sweep for the same pair is ALREADY in flight — it never joins one — so a
   * caller cannot be made to wait behind another's sweep, and two callers cannot double-probe a pair.
   * The corollary is that resolution does not mean the cache is now warm; `select` fails open until it
   * is.
   */
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

// Precision a CONFIGURED ladder size is validated at, so "is this a positive decimal?" is answered
// independently of the collateral's decimals — otherwise a valid rung would be operator misconfig on
// a low-decimal token and fine on the next one.
const LADDER_SIZE_PRECISION = 18

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

// Where `amountIn` sits between two rungs in LOG space, as a `RATE_SCALE` weight in [0, 1], or `null`
// when the bracket is degenerate (a zero/equal rung, a non-finite ratio). `null` rather than a weight
// of zero: zero is a legitimate answer meaning "at the low rung", and reporting it for an unusable
// bracket would present a clamp as a confident interpolation. The only float in the interpolation
// path: the rates it blends stay exact bigints, and a `Number` ratio of two same-pair sizes stays well
// inside double precision even when the amounts exceed 2**53.
const logWeight = (lo: bigint, hi: bigint, amountIn: bigint): bigint | null => {
  const span = Math.log(Number(hi) / Number(lo))
  const offset = Math.log(Number(amountIn) / Number(lo))
  if (!Number.isFinite(span) || span <= 0 || !Number.isFinite(offset)) return null
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
  const weight = lo && hi ? logWeight(lo.amountIn, hi.amountIn, amountIn) : null
  if (lo && hi && weight !== null) {
    const loRate = rateOf(lo)
    return { rate: loRate + ((rateOf(hi) - loRate) * weight) / RATE_SCALE, clamped: false }
  }
  const nearest = nearestProbed(rungs, amountIn)
  return nearest ? { rate: rateOf(nearest), clamped: true } : null
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
 * rate behind. {@link VenueCostEstimate.ageMs} is what a consumer of the level bounds itself by.
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
  const inflight = new Set<string>()

  const keyFor = (pair: VenuePair) => `${deps.chainId}:${venuePairKey(pair)}`

  const decimalsFor = async (token: Address): Promise<number> => {
    const key = getAddress(token)
    const cached = decimalsCache.get(key)
    if (cached !== undefined) return cached
    const decimals = await deps.getDecimals(token)
    decimalsCache.set(key, decimals)
    return decimals
  }

  // Ladder in the collateral's base units, sorted and deduped so the bracket search stays monotonic
  // even when the operator lists the sizes out of order or two rungs collapse onto one base-unit
  // amount. A CONFIGURED size that is malformed or non-positive fails loud — operator misconfig,
  // judged at a fixed precision so the verdict does not depend on which collateral it is being
  // converted for. A rung whose value merely converts to less than one base unit is dropped, in both
  // the USD and the whole-token reading: that is a property of the collateral, not of the config.
  //
  // A throwing `usdPriceOf` degrades to the whole-token ladder rather than leaving the pair cold —
  // the fallback its own doc promises.
  const ladderFor = async (collateral: Address, decimals: number): Promise<bigint[]> => {
    const { data: price } = await tryCatch(
      (async () => (await deps.usdPriceOf?.(collateral)) ?? null)()
    )
    const usdPrice = price !== undefined && price !== null && price > 0n ? price : null
    const sizes = deps.ladderSizes.map(size => {
      if ((safeParseUnits(size, LADDER_SIZE_PRECISION) ?? 0n) <= 0n) {
        throw new InvalidProbeLadderError(size)
      }
      const parsed = safeParseUnits(size, usdPrice === null ? decimals : USD_LADDER_PRICE_DECIMALS)
      return usdPrice === null
        ? (parsed ?? 0n)
        : ((parsed ?? 0n) * 10n ** BigInt(decimals)) / usdPrice
    })
    return [...new Set(sizes.filter(size => size > 0n))].toSorted(ascending)
  }

  // One venue's whole ladder. Rungs stay SERIAL so a venue's own token bucket paces them; the caller
  // runs venues concurrently, which their separate buckets already isolate.
  const probeVenue = async (
    venue: Venue,
    pair: VenuePair,
    ladder: bigint[],
    collateralDecimals: number
  ): Promise<(RungQuote | null)[]> => {
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
    return rungs
  }

  const refresh = async (pair: VenuePair): Promise<void> => {
    const key = keyFor(pair)
    const existing = cache.get(key)
    if (existing && now() - existing.updatedAt < deps.staleMs) return
    // A refresh for this pair is already running: RETURN rather than join it. `updatedAt` is written
    // only once the sweep completes, so without this a second caller would start a duplicate sweep;
    // and joining would put a full ladder sweep back on the critical path of whoever asked second.
    // The caller then reads whatever the cache holds and fails open (see {@link VenueSelector.select}).
    if (inflight.has(key)) return
    inflight.add(key)
    try {
      // Collateral decimals: for the ladder, and passed to the probe so decimal-denominated venues
      // (LiquidSwap) can convert base units → a human-readable amountIn.
      const collateralDecimals = await decimalsFor(pair.collateral)
      const ladder = await ladderFor(pair.collateral, collateralDecimals)
      // Venues run CONCURRENTLY: they hold separate token buckets, so serializing them multiplied the
      // sweep's wall-clock by the venue count for no rate-limit benefit — and that sweep is what a
      // liquidatable pair waits behind.
      const probed = await Promise.all(
        deps.venues.map(venue => probeVenue(venue, pair, ladder, collateralDecimals))
      )
      // Inserted in configured order, not completion order, so `select`'s tie-break stays deterministic.
      const curves = new Map<Venue, (RungQuote | null)[]>()
      deps.venues.forEach((venue, index) => {
        const rungs = probed[index]
        if (rungs?.some(rung => rung !== null)) curves.set(venue, rungs)
      })

      cache.set(key, { updatedAt: now(), ladder, curves })
      deps.logger.info('probe.refreshed', {
        collateral: pair.collateral,
        loan: pair.loan,
        points: ladder.length,
        venues: deps.venues.length,
        curved: curves.size
      })
    } finally {
      inflight.delete(key)
    }
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
    const ageMs = now() - entry.updatedAt
    const ranked: { rate: bigint; estimate: VenueCostEstimate }[] = []
    for (const [venue, rungs] of entry.curves) {
      const interpolated = rateAt(entry.ladder, rungs, amountIn)
      if (!interpolated) continue
      const estimatedOut = (interpolated.rate * amountIn) / RATE_SCALE
      const raw = routeCostBps({ reference: referenceAmountOut, amountOut: estimatedOut })
      ranked.push({
        rate: interpolated.rate,
        estimate: {
          venue,
          estimatedOut,
          costBps: raw === null ? null : Math.max(raw, 0),
          costBpsRaw: raw,
          clamped: interpolated.clamped,
          ageMs
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
