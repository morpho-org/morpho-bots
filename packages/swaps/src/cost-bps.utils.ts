// Basis points times 100, so a cost carries two decimal places without a float divide.
const CENTI_BPS = 1_000_000n

/**
 * A route's cost against an oracle reference, in bps to two decimals: positive when the route pays
 * less than the oracle, NEGATIVE when it pays more. `null` when there is no usable reference.
 *
 * Deliberately shared by the probe curve and the firm-quote path: the two figures are read against
 * each other to judge probe fidelity, so they must not be two roundings of the same idea. Callers
 * that SCORE on the value floor it at zero — a venue beating the oracle is a stale oracle, never a
 * bonus; callers that only report it keep the sign.
 */
export const routeCostBps = (args: {
  reference: bigint | undefined
  amountOut: bigint
}): number | null => {
  const { reference, amountOut } = args
  if (reference === undefined || reference <= 0n) return null
  return Number(((reference - amountOut) * CENTI_BPS) / reference) / 100
}
