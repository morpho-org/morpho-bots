// Fixed-point integer primitives mirroring Midnight's UtilsLib (midnight-contracts.txt:188-214)
// exactly, including rounding direction — which is load-bearing for bit-faithful sizing.

/** Floor division of `x * y / d` (UtilsLib.mulDivDown, :208-209). */
export function mulDivDown(x: bigint, y: bigint, d: bigint): bigint {
  return (x * y) / d
}

/** Ceiling division of `x * y / d` (UtilsLib.mulDivUp, :213-214). */
export function mulDivUp(x: bigint, y: bigint, d: bigint): bigint {
  return (x * y + (d - 1n)) / d
}

/** `max(0, x - y)` (UtilsLib.zeroFloorSub, :201-205). */
export function zeroFloorSub(x: bigint, y: bigint): bigint {
  return x > y ? x - y : 0n
}

/** Lesser of two bigints (UtilsLib.min, :195-199). */
export function min(x: bigint, y: bigint): bigint {
  return y < x ? y : x
}
