/** Production conversion callbacks and inclusive bounds for integer-rate tick selection. */
export type FindRepresentableRateTickParameters = {
  targetTick: bigint
  minimumTick: bigint
  maximumTick: bigint
  minimumRateBps: bigint
  maximumRateBps: bigint
  minimumAprWad?: bigint
  maximumAprWad?: bigint
  rateToTick: (rateBps: bigint) => bigint
  tickToAprWad: (tick: bigint) => bigint
}

/**
 * Finds the closest constraint-safe tick that an integer APR quote reconstructs exactly.
 * @param parameters - Inclusive tick, integer-rate, and exact-APR ranges plus production converters;
 * the target tick must already satisfy the supplied tick and APR constraints.
 * @returns The closest representable tick and its persisted integer rate, or `undefined` when the
 * bounded integer-rate domain contains no valid representation.
 * @remarks Rate-to-tick conversion is monotonic: higher APR maps to lower ticks. A binary search
 * locates the two representable ticks surrounding the target, so runtime is logarithmic in the
 * configured integer-rate range and independent of tick-domain size.
 */
export const findRepresentableRateTick = (parameters: FindRepresentableRateTickParameters) => {
  if (
    parameters.minimumRateBps > parameters.maximumRateBps ||
    parameters.minimumTick > parameters.maximumTick
  ) {
    return undefined
  }

  let low = parameters.minimumRateBps
  let high = parameters.maximumRateBps
  while (low < high) {
    const middle = (low + high) / 2n
    if (parameters.rateToTick(middle) <= parameters.targetTick) high = middle
    else low = middle + 1n
  }

  const candidateRates = low > parameters.minimumRateBps ? [low - 1n, low] : [low]
  const candidates = candidateRates
    .map(rateBps => {
      const tick = parameters.rateToTick(rateBps)
      return { rateBps, tick, aprWad: parameters.tickToAprWad(tick) }
    })
    .filter(candidate => {
      const aboveMinimumApr =
        parameters.minimumAprWad === undefined || candidate.aprWad >= parameters.minimumAprWad
      const belowMaximumApr =
        parameters.maximumAprWad === undefined || candidate.aprWad <= parameters.maximumAprWad
      return (
        candidate.tick >= parameters.minimumTick &&
        candidate.tick <= parameters.maximumTick &&
        aboveMinimumApr &&
        belowMaximumApr
      )
    })

  return candidates.reduce<(typeof candidates)[number] | undefined>((closest, candidate) => {
    if (closest === undefined) return candidate
    const candidateDistance =
      candidate.tick > parameters.targetTick
        ? candidate.tick - parameters.targetTick
        : parameters.targetTick - candidate.tick
    const closestDistance =
      closest.tick > parameters.targetTick
        ? closest.tick - parameters.targetTick
        : parameters.targetTick - closest.tick
    return candidateDistance < closestDistance ? candidate : closest
  }, undefined)
}
