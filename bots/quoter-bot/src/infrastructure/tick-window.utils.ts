import { TickLib } from '@morpho-org/midnight-sdk'
import { MathLib, Time } from '@morpho-org/morpho-ts'

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

/**
 * Derives the aligned-tick window equivalent to a configured inclusive hard rate range.
 * @param parameters - Optional minimum/maximum annual rates in integer basis points, seconds to
 * maturity, and the market tick spacing.
 * @returns Window ticks for every supplied bound; an empty window (`lowestTick` above
 * `highestTick`) means no aligned tick encodes a rate inside the range.
 * @throws SDK validation errors for negative bounds, an exhausted maturity, or invalid spacing.
 * @remarks Pure and side-effect free. The window is exact in tick space: every tick inside it
 * encodes an annual rate within the bounds up to sub-basis-point display rounding.
 */
export const rateTickWindow = (parameters: {
  minimumRateBps?: bigint
  maximumRateBps?: bigint
  timeToMaturity: bigint
  tickSpacing: bigint
}): TickWindow => {
  const { minimumRateBps, maximumRateBps, timeToMaturity, tickSpacing } = parameters
  const lowestTick =
    maximumRateBps === undefined
      ? undefined
      : alignedRateTick(maximumRateBps, timeToMaturity, tickSpacing)
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
 * Saturates an aligned tick into the window equivalent of the configured hard rate range.
 * @param tick - Aligned candidate tick derived from a nominal rate.
 * @param window - Window derived by {@link rateTickWindow}; must not be empty.
 * @returns The nearest window tick, keeping the encoded rate inside the hard bounds.
 */
export const clampTickToWindow = (tick: bigint, window: TickWindow) => {
  if (window.lowestTick !== undefined && tick < window.lowestTick) return window.lowestTick
  if (window.highestTick !== undefined && tick > window.highestTick) return window.highestTick
  return tick
}
