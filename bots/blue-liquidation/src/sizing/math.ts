// Fixed-point integer primitives mirroring morpho-blue's MathLib + SharesMathLib exactly, including
// rounding direction and the virtual-share/asset offsets — all load-bearing for bit-faithful sizing.
// Division by zero throws (native bigint), matching the EVM's divide-by-zero revert. This is the full
// library the lens and planner reason about; it also reads as documentation of Blue's share math.

import { VIRTUAL_ASSETS, VIRTUAL_SHARES, WAD } from '../constants'

/** Floor of `x * y / d` (MathLib.mulDivDown). */
export function mulDivDown(x: bigint, y: bigint, d: bigint): bigint {
  return (x * y) / d
}

/** Ceil of `x * y / d` (MathLib.mulDivUp). */
export function mulDivUp(x: bigint, y: bigint, d: bigint): bigint {
  return (x * y + (d - 1n)) / d
}

/** Floor of `x * y / WAD` (MathLib.wMulDown). */
export function wMulDown(x: bigint, y: bigint): bigint {
  return mulDivDown(x, y, WAD)
}

/** Floor of `x * WAD / y` (MathLib.wDivDown). */
export function wDivDown(x: bigint, y: bigint): bigint {
  return mulDivDown(x, WAD, y)
}

/** Ceil of `x * WAD / y` (MathLib.wDivUp). */
export function wDivUp(x: bigint, y: bigint): bigint {
  return mulDivUp(x, WAD, y)
}

/**
 * First three non-zero terms of `e^(nx) - 1` (MathLib.wTaylorCompounded); `x` is a per-second WAD
 * rate, `n` the elapsed seconds. Each term floors independently and in this exact order — a fused
 * formula diverges by a few wei.
 */
export function wTaylorCompounded(x: bigint, n: bigint): bigint {
  const firstTerm = x * n
  const secondTerm = mulDivDown(firstTerm, firstTerm, 2n * WAD)
  const thirdTerm = mulDivDown(secondTerm, firstTerm, 3n * WAD)
  return firstTerm + secondTerm + thirdTerm
}

/** assets → shares, rounding down (SharesMathLib.toSharesDown). */
export function toSharesDown(assets: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivDown(assets, totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS)
}

/** assets → shares, rounding up (SharesMathLib.toSharesUp). */
export function toSharesUp(assets: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivUp(assets, totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS)
}

/** shares → assets, rounding down (SharesMathLib.toAssetsDown). */
export function toAssetsDown(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivDown(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES)
}

/** shares → assets, rounding up (SharesMathLib.toAssetsUp). */
export function toAssetsUp(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivUp(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES)
}

/** Lesser of two bigints (UtilsLib.min). */
export function min(x: bigint, y: bigint): bigint {
  return y < x ? y : x
}
