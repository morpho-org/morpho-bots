import { describe, expect, it } from 'vitest'

import { bumpFees, initialFees } from '../../src/queue/fee-policy'

describe('bumpFees', () => {
  it('bumps both fees by 12.5% and floors maxFee at baseFee*2 + priority', () => {
    expect(
      bumpFees({
        maxFeePerGas: 1000n,
        maxPriorityFeePerGas: 1000n,
        baseFee: 100n,
        maxFeeWei: 10_000n
      })
    ).toEqual({ kind: 'bump', fees: { maxFeePerGas: 1325n, maxPriorityFeePerGas: 1125n } })
  })

  it('applies a +1 wei floor so tiny fees still clear the replacement threshold', () => {
    // 1 * 1125/1000 floors to 1, which is not a valid replacement; the +1 floor lifts it to 2.
    expect(
      bumpFees({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, baseFee: 0n, maxFeeWei: 1000n })
    ).toEqual({ kind: 'bump', fees: { maxFeePerGas: 2n, maxPriorityFeePerGas: 2n } })
  })

  it('drops rather than chasing when the bumped maxFee exceeds the ceiling', () => {
    expect(
      bumpFees({
        maxFeePerGas: 1000n,
        maxPriorityFeePerGas: 1000n,
        baseFee: 100n,
        maxFeeWei: 1000n
      })
    ).toEqual({ kind: 'drop' })
  })
})

describe('initialFees', () => {
  it('uses a 1-gwei tip and 2×-base-fee headroom under a comfortable ceiling', () => {
    expect(initialFees(10n ** 9n, 100n * 10n ** 9n)).toEqual({
      maxPriorityFeePerGas: 10n ** 9n,
      maxFeePerGas: 2n * 10n ** 9n + 10n ** 9n
    })
  })

  it('clamps both fees to the ceiling (an underpriced first send the bump path then recovers)', () => {
    expect(initialFees(50n, 10n)).toEqual({ maxPriorityFeePerGas: 10n, maxFeePerGas: 10n })
  })
})
