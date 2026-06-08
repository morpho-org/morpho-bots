/**
 * Indices of the set bits in a position's `collateralBitmap`, ascending. Each index `i` maps
 * directly to `market.collateralParams[i]` and `position.collateral[i]`
 * (midnight-contracts.txt:2326-2337). The contract iterates MSB-first, but `maxDebt`/`badDebt`
 * are order-independent folds, so ascending order is equivalent and more readable.
 */
export function activeBits(bitmap: bigint): number[] {
  const bits: number[] = []
  let remaining = bitmap
  let index = 0
  while (remaining > 0n) {
    if ((remaining & 1n) === 1n) bits.push(index)
    remaining >>= 1n
    index++
  }
  return bits
}
