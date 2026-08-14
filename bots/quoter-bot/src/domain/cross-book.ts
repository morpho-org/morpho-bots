/**
 * Rate clearance, in integer basis points, kept between own offers that would otherwise cross.
 * @remarks A bootstrap buy crossing the book reprices this far above the highest-rate sell, and a
 * ladder sell that would cross the own bootstrap buy quotes this far below the bootstrap rate.
 */
export const CROSS_BOOK_CLEARANCE_BPS = 10n

/**
 * Clamps a derived quote rate into the configured inclusive hard range.
 * @param rateBps - Derived rate in integer basis points, possibly outside the hard range.
 * @param minimumRateBps - Inclusive configured lower bound.
 * @param maximumRateBps - Inclusive configured upper bound.
 * @returns The nearest rate inside `[minimumRateBps, maximumRateBps]`.
 * @remarks Pure saturation with no validation: callers validate `minimumRateBps <= maximumRateBps`.
 */
export const clampRateBps = (rateBps: bigint, minimumRateBps: bigint, maximumRateBps: bigint) => {
  if (rateBps < minimumRateBps) return minimumRateBps
  if (rateBps > maximumRateBps) return maximumRateBps
  return rateBps
}
