import { TickLib } from '@morpho-org/midnight-sdk'
import { MathLib, Time } from '@morpho-org/morpho-ts'

import type { RateRange } from './rate-range'

import { violatedRateBound } from './rate-range'

const YEAR_SECONDS = Time.s.from.y(1n)
const BPS_WAD = MathLib.WAD / 10_000n

/**
 * Inclusive aligned-tick range whose encoded rates stay inside the configured hard rate bounds.
 * @remarks Midnight prices are inverse to rates, so `lowestTick` carries the maximum rate and
 * `highestTick` the minimum rate. An absent side leaves that direction unbounded.
 */
export type TickWindow = {
  lowestTick?: bigint
  highestTick?: bigint
}

/** Lowest tick the protocol encodes; `TickLib.priceToTick` never returns a negative tick. */
export const LOWEST_TICK = 0n

/**
 * Rounds a tick up onto the market's tick spacing.
 * @param tick - Candidate protocol tick.
 * @param spacing - Market tick spacing; must be positive.
 * @returns The lowest aligned tick at or above `tick`.
 */
export const alignTickUp = (tick: bigint, spacing: bigint) =>
  ((tick + spacing - 1n) / spacing) * spacing

/**
 * Rounds a tick down onto the market's tick spacing.
 * @param tick - Candidate protocol tick.
 * @param spacing - Market tick spacing; must be positive.
 * @returns The highest aligned tick at or below `tick`.
 */
export const alignTickDown = (tick: bigint, spacing: bigint) => (tick / spacing) * spacing

/**
 * Converts an annual rate into the lowest spacing-aligned tick whose price covers the rate.
 * @param rateBps - Simple annual rate in integer basis points.
 * @param timeToMaturity - Seconds until the market matures; must be positive.
 * @param tickSpacing - Market tick spacing used for alignment.
 * @returns The aligned protocol tick; its exact encoded rate never exceeds `rateBps`.
 * @throws SDK validation errors for a negative rate, an exhausted maturity, or invalid spacing.
 */
export const alignedRateTick = (rateBps: bigint, timeToMaturity: bigint, tickSpacing: bigint) => {
  const periodRateWad = (rateBps * BPS_WAD * timeToMaturity) / YEAR_SECONDS
  return TickLib.priceToTick(TickLib.rateToPrice(periodRateWad), tickSpacing)
}

type RateTickParameters = {
  minimumRateBps?: bigint
  maximumRateBps?: bigint
  timeToMaturity: bigint
  tickSpacing: bigint
}

const encodesRateAbove = (tick: bigint, rateBps: bigint, timeToMaturity: bigint) =>
  TickLib.tickToPrice(tick) === 0n || TickLib.tickToApr(tick, timeToMaturity) > rateBps * BPS_WAD

/**
 * Derives the aligned-tick window equivalent to a configured inclusive hard rate range.
 * @param parameters - Optional minimum/maximum annual rates in integer basis points, seconds to
 * maturity, and the market tick spacing.
 * @returns Window ticks for every supplied bound; an empty window (`lowestTick` above
 * `highestTick`) means no aligned tick encodes a rate inside the range.
 * @throws SDK validation errors for negative bounds, an exhausted maturity, or invalid spacing.
 * @remarks Pure and side-effect free. Both ends are rounded inward against `TickLib.tickToApr`, so
 * every tick inside the window encodes an APR within the bounds exactly, however coarse the spacing.
 */
export const rateTickWindow = (parameters: RateTickParameters): TickWindow => {
  const { minimumRateBps, maximumRateBps, timeToMaturity, tickSpacing } = parameters
  let lowestTick: bigint | undefined
  if (maximumRateBps !== undefined) {
    const aligned = alignedRateTick(maximumRateBps, timeToMaturity, tickSpacing)
    lowestTick = encodesRateAbove(aligned, maximumRateBps, timeToMaturity)
      ? aligned + tickSpacing
      : aligned
  }
  let highestTick: bigint | undefined
  if (minimumRateBps !== undefined) {
    const aligned = alignedRateTick(minimumRateBps, timeToMaturity, tickSpacing)
    highestTick =
      TickLib.tickToApr(aligned, timeToMaturity) >= minimumRateBps * BPS_WAD
        ? aligned
        : aligned - tickSpacing
  }
  return {
    ...(lowestTick === undefined ? {} : { lowestTick }),
    ...(highestTick === undefined ? {} : { highestTick })
  }
}

/**
 * Reports whether a bounded window contains no aligned tick.
 * @param window - Window derived by {@link rateTickWindow}.
 * @returns `true` only when both bounds exist and exclude every aligned tick.
 */
export const isEmptyTickWindow = (window: TickWindow) =>
  window.lowestTick !== undefined &&
  window.highestTick !== undefined &&
  window.lowestTick > window.highestTick

/**
 * Applies {@link violatedRateBound} to an exact encoded APR at full precision.
 * @param aprWad - WAD simple APR, as `TickLib.tickToApr` returns for a published tick.
 * @param range - Inclusive bounds in integer basis points.
 * @returns Whether the APR lies inside the range; unlike a basis-point truncation, 600.26 BPS fails a
 * 600 BPS maximum.
 */
export const isAprWadInRange = (aprWad: bigint, range: RateRange) =>
  violatedRateBound(aprWad, {
    minimumRateBps: range.minimumRateBps * BPS_WAD,
    maximumRateBps: range.maximumRateBps * BPS_WAD
  }) === undefined

/**
 * Encodes an admissible rate at an aligned tick whose APR stays inside the same bounds.
 * @param rateBps - Nominal annual rate in integer basis points.
 * @param parameters - The bounds, seconds to maturity, and tick spacing `window` was derived from.
 * @param window - {@link rateTickWindow} of `parameters`; must not be empty.
 * @returns The aligned tick, moved inward by at most one spacing when rounding would carry its
 * encoded APR past a bound; `undefined` when `rateBps` itself fails {@link violatedRateBound}, which
 * a caller must refuse rather than saturate.
 */
export const admissibleRateTick = (
  rateBps: bigint,
  parameters: RateTickParameters,
  window: TickWindow
) => {
  const bound = violatedRateBound(rateBps, {
    minimumRateBps: parameters.minimumRateBps ?? rateBps,
    maximumRateBps: parameters.maximumRateBps ?? rateBps
  })
  if (bound !== undefined) return undefined
  const tick = alignedRateTick(rateBps, parameters.timeToMaturity, parameters.tickSpacing)
  if (window.lowestTick !== undefined && tick < window.lowestTick) return window.lowestTick
  if (window.highestTick !== undefined && tick > window.highestTick) return window.highestTick
  return tick
}
