import type { Hex } from 'viem'

/**
 * Midnight's loss-factor ceiling, `type(uint128).max`; a market at it rejects every take.
 * @remarks A literal rather than viem's `maxUint128`: this module is in the browser playground
 * graph, where any viem value import pulls `viem/accounts` in.
 */
export const MAX_LOSS_FACTOR = 0xff_ff_ff_ff_ff_ff_ff_ff_ff_ff_ff_ff_ff_ff_ff_ffn

const BPS = 10_000n

/** Which side of the accepted value an observed loss factor sits on. */
export type LossFactorDirection = 'above' | 'below'

/**
 * A market's loss factor at one block beside the value the operator accepted for it.
 * @remarks `defaulted` marks a market absent from `markets.acceptedLossFactor`, whose accepted
 * value is therefore `0`.
 */
export type LossFactorObservation = {
  lossFactor: bigint
  acceptedLossFactor: bigint
  defaulted: boolean
}

/** A loss-factor observation that differs from the accepted value, so lending must stop. */
export type LendHalt = LossFactorObservation & { direction: LossFactorDirection }

/**
 * Resolves the operator-accepted loss factor for one market.
 * @param accepted - Validated per-market accepted values; omitted markets accept `0`.
 * @param marketId - Canonical market identifier.
 * @returns The accepted value and whether it was defaulted.
 */
export const acceptedLossFactorOf = (
  accepted: ReadonlyMap<Hex, bigint> | undefined,
  marketId: Hex
) => {
  const value = accepted?.get(marketId)
  return value === undefined
    ? { acceptedLossFactor: 0n, defaulted: true }
    : { acceptedLossFactor: value, defaulted: false }
}

/**
 * Decides whether one observation halts lending.
 * @param observation - Observed and accepted loss factor for one market.
 * @returns The halt with its direction, or `undefined` only on exact equality.
 * @remarks The protocol only ever raises the loss factor, so `above` is a newly realized loss and
 * `below` is configuration ahead of the chain; both fail closed.
 */
export const lendHalt = (observation: LossFactorObservation): LendHalt | undefined => {
  if (observation.lossFactor === observation.acceptedLossFactor) return undefined
  return {
    ...observation,
    direction: observation.lossFactor > observation.acceptedLossFactor ? 'above' : 'below'
  }
}

/**
 * Measures the lender credit slashed since the accepted loss factor, rounded up.
 * @param halt - A halt whose observed loss factor is above the accepted value.
 * @returns `1 − (MAX − lossFactor) / (MAX − accepted)` in basis points, or `undefined` for `below`,
 * where the ratio is negative.
 * @remarks Mirrors the credit slash in `Midnight.updatePositionView`.
 */
export const incrementalLossBps = (halt: LendHalt): bigint | undefined => {
  if (halt.direction !== 'above') return undefined
  const numerator = (halt.lossFactor - halt.acceptedLossFactor) * BPS
  const denominator = MAX_LOSS_FACTOR - halt.acceptedLossFactor
  return (numerator + denominator - 1n) / denominator
}
