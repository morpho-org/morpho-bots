/**
 * Computes the absolute value of a bigint.
 *
 * @param value - The bigint value to compute the absolute value for.
 * @returns The absolute value of the input bigint.
 */
export function bigintAbs(value: bigint) {
  return value < 0n ? -value : value
}
