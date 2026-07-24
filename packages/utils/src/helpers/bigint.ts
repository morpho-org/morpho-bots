/**
 * Floor of `x * y / d`. Division by zero throws (native bigint), matching the EVM's
 * divide-by-zero revert — consumers porting Solidity fixed-point math rely on this.
 */
export function mulDivDown(x: bigint, y: bigint, d: bigint): bigint {
  return (x * y) / d
}

/**
 * Ceiling of `x * y / d`. Division by zero throws (native bigint), matching the EVM's
 * divide-by-zero revert.
 */
export function mulDivUp(x: bigint, y: bigint, d: bigint): bigint {
  return (x * y + (d - 1n)) / d
}

/** Subtraction floored at zero: `max(0, x - y)`. */
export function zeroFloorSub(x: bigint, y: bigint): bigint {
  return x > y ? x - y : 0n
}

export function bigintMin(x: bigint, y: bigint): bigint {
  return y < x ? y : x
}
