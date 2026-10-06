import { maxUint128 } from 'viem'
import { describe, expect, test } from 'vitest'

import {
  acceptedLossFactorOf,
  incrementalLossBps,
  lendHalt,
  MAX_LOSS_FACTOR
} from '../../src/domain/loss-factor'

describe('loss factor', () => {
  test('pins the ceiling to type(uint128).max', () => {
    expect(MAX_LOSS_FACTOR).toBe(maxUint128)
  })

  test('halts lending on any inequality and names its direction', () => {
    const observation = (lossFactor: bigint) => ({
      lossFactor,
      acceptedLossFactor: 5n,
      defaulted: false
    })

    expect(lendHalt(observation(5n))).toBeUndefined()
    expect(lendHalt(observation(6n))).toEqual({ ...observation(6n), direction: 'above' })
    expect(lendHalt(observation(4n))).toEqual({ ...observation(4n), direction: 'below' })
  })

  test('defaults an unconfigured market to zero', () => {
    const marketId = `0x${'11'.repeat(32)}` as const

    expect(acceptedLossFactorOf(undefined, marketId)).toEqual({
      acceptedLossFactor: 0n,
      defaulted: true
    })
    expect(acceptedLossFactorOf(new Map([[marketId, 3n]]), marketId)).toEqual({
      acceptedLossFactor: 3n,
      defaulted: false
    })
  })

  test('measures the slashed lender credit only above the accepted value', () => {
    const halt = (lossFactor: bigint, acceptedLossFactor: bigint) =>
      lendHalt({ lossFactor, acceptedLossFactor, defaulted: false })!

    expect(incrementalLossBps(halt(MAX_LOSS_FACTOR / 100n, 0n))).toBe(100n)
    expect(incrementalLossBps(halt(1n, 0n))).toBe(1n)
    expect(incrementalLossBps(halt(MAX_LOSS_FACTOR, MAX_LOSS_FACTOR / 2n))).toBe(10_000n)
    expect(incrementalLossBps(halt(0n, 1n))).toBeUndefined()
  })
})
