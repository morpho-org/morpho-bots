import { describe, expect, it } from 'bun:test'

import { bigintAbs } from '../../src/helpers/bigint'

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
