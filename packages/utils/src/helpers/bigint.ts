/**
 * Floor of `x * y / d`. Division by zero throws (native bigint), matching the EVM's
 * divide-by-zero revert — consumers porting Solidity fixed-point math rely on this.
 *
 * @param x - Multiplicand.
 * @param y - Multiplier.
 * @param d - Divisor.
 * @returns `⌊x * y / d⌋`.
 */
export function mulDivDown(x: bigint, y: bigint, d: bigint): bigint {
  return (x * y) / d
}

/**
 * Ceiling of `x * y / d`. Division by zero throws (native bigint), matching the EVM's
 * divide-by-zero revert.
 *
 * @param x - Multiplicand.
 * @param y - Multiplier.
 * @param d - Divisor.
 * @returns `⌈x * y / d⌉`.
 */
export function mulDivUp(x: bigint, y: bigint, d: bigint): bigint {
  return (x * y + (d - 1n)) / d
}

/**
 * Subtraction floored at zero: `max(0, x - y)`.
 *
 * @param x - Minuend.
 * @param y - Subtrahend.
 * @returns `x - y` when positive, otherwise `0n`.
 */
export function zeroFloorSub(x: bigint, y: bigint): bigint {
  return x > y ? x - y : 0n
}

/**
 * Lesser of two bigints.
 *
 * @param x - First value.
 * @param y - Second value.
 * @returns The smaller of `x` and `y`.
 */
export function bigintMin(x: bigint, y: bigint): bigint {
  return y < x ? y : x
}
