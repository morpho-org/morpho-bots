import { describe, expect, it } from 'vitest'

import { bigintAbs, bigintMin, mulDivDown, mulDivUp, zeroFloorSub } from '../../src/helpers/bigint'

describe('bigintAbs', () => {
  it('should return absolute value of positive bigint', () => {
    expect(bigintAbs(5n)).toBe(5n)
    expect(bigintAbs(100n)).toBe(100n)
  })

  it('should return absolute value of negative bigint', () => {
    expect(bigintAbs(-5n)).toBe(5n)
    expect(bigintAbs(-100n)).toBe(100n)
  })

  it('should return zero for zero', () => {
    expect(bigintAbs(0n)).toBe(0n)
  })
})

describe('mulDiv', () => {
  it('floors and ceils around a fractional result', () => {
    expect(mulDivDown(7n, 3n, 2n)).toBe(10n) // 21/2 = 10.5 -> 10
    expect(mulDivUp(7n, 3n, 2n)).toBe(11n) // 21/2 = 10.5 -> 11
  })

  it('agrees on an exact division', () => {
    expect(mulDivDown(6n, 2n, 3n)).toBe(4n)
    expect(mulDivUp(6n, 2n, 3n)).toBe(4n)
  })

  it('throws on a zero denominator (matches the EVM revert)', () => {
    expect(() => mulDivDown(1n, 1n, 0n)).toThrow()
    expect(() => mulDivUp(1n, 1n, 0n)).toThrow()
  })
})

describe('zeroFloorSub', () => {
  it('subtracts when positive and floors at zero otherwise', () => {
    expect(zeroFloorSub(5n, 3n)).toBe(2n)
    expect(zeroFloorSub(3n, 5n)).toBe(0n)
    expect(zeroFloorSub(4n, 4n)).toBe(0n)
  })
})

describe('bigintMin', () => {
  it('returns the lesser', () => {
    expect(bigintMin(3n, 5n)).toBe(3n)
    expect(bigintMin(5n, 3n)).toBe(3n)
    expect(bigintMin(4n, 4n)).toBe(4n)
  })
})
