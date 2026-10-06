/** Inclusive rate bounds, in integer basis points, that every published offer rate must sit inside. */
export type RateRange = {
  minimumRateBps: bigint
  maximumRateBps: bigint
}

/**
 * Names the bound a derived rate falls outside of.
 * @param rateBps - Derived rate in integer basis points.
 * @param range - Inclusive bounds; callers validate `minimumRateBps <= maximumRateBps`.
 * @returns `undefined` when `minimumRateBps <= rateBps <= maximumRateBps`, so a rate equal to a bound
 * is admissible; otherwise the violated bound.
 * @remarks The single admissibility predicate for ladder rungs and bootstrap offers on both sides. An
 * inadmissible rate is omitted, never clamped onto the bound, so a reference outside the range can
 * never pile liquidity onto a boundary rate.
 */
export const violatedRateBound = (
  rateBps: bigint,
  range: RateRange
): 'minimum' | 'maximum' | undefined => {
  if (rateBps < range.minimumRateBps) return 'minimum'
  if (rateBps > range.maximumRateBps) return 'maximum'
  return undefined
}
