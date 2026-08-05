import { describe, expect, it } from 'vitest'

import { wadToWholePercent, wholePercentToWAD } from '../../src/helpers/wad'

describe('wholePercentToWAD', () => {
  it('should convert whole percentage values to WAD', () => {
    expect(wholePercentToWAD(1)).toBe(10000000000000000n)
    expect(wholePercentToWAD(10)).toBe(100000000000000000n)
    expect(wholePercentToWAD(100)).toBe(1000000000000000000n)
  })

  it('should handle decimal percentage values', () => {
    expect(wholePercentToWAD(0.5)).toBe(5000000000000000n)
    expect(wholePercentToWAD(1.5)).toBe(15000000000000000n)
    expect(wholePercentToWAD(99.99)).toBe(999900000000000000n)
  })

  it('should handle zero', () => {
    expect(wholePercentToWAD(0)).toBe(0n)
  })

  it('should handle very small values', () => {
    expect(wholePercentToWAD(0.01)).toBe(100000000000000n)
    expect(wholePercentToWAD(0.001)).toBe(10000000000000n)
  })

  it('should handle large values', () => {
    expect(wholePercentToWAD(1000)).toBe(10000000000000000000n)
    expect(wholePercentToWAD(10000)).toBe(100000000000000000000n)
  })

  it('should handle negative values', () => {
    expect(wholePercentToWAD(-1)).toBe(-10000000000000000n)
    expect(wholePercentToWAD(-10)).toBe(-100000000000000000n)
  })
})

describe('wadToWholePercent', () => {
  it('should convert WAD values to whole percentages', () => {
    expect(wadToWholePercent(10000000000000000n)).toBe(1)
    expect(wadToWholePercent(100000000000000000n)).toBe(10)
    expect(wadToWholePercent(1000000000000000000n)).toBe(100)
  })

  it('should handle fractional percentages', () => {
    expect(wadToWholePercent(5000000000000000n)).toBe(0.5)
    expect(wadToWholePercent(15000000000000000n)).toBe(1.5)
    expect(wadToWholePercent(999900000000000000n)).toBe(99.99)
  })

  it('should handle zero', () => {
    expect(wadToWholePercent(0n)).toBe(0)
  })

  it('should handle very small WAD values', () => {
    expect(wadToWholePercent(100000000000000n)).toBe(0.01)
    expect(wadToWholePercent(10000000000000n)).toBe(0.001)
  })

  it('should handle large WAD values', () => {
    expect(wadToWholePercent(10000000000000000000n)).toBe(1000)
    expect(wadToWholePercent(100000000000000000000n)).toBe(10000)
  })

  it('should handle negative WAD values', () => {
    expect(wadToWholePercent(-10000000000000000n)).toBe(-1)
    expect(wadToWholePercent(-100000000000000000n)).toBe(-10)
  })
})

describe('wholePercentToWAD and wadToWholePercent round-trip', () => {
  it('should maintain value consistency in round-trip conversions', () => {
    const values = [0, 0.01, 0.5, 1, 5, 10, 50, 100, 1000]

    for (const value of values) {
      const wad = wholePercentToWAD(value)
      const result = wadToWholePercent(wad)
      expect(result).toBe(value)
    }
  })

  it('should maintain value consistency for negative values', () => {
    const values = [-0.01, -1, -10, -100]

    for (const value of values) {
      const wad = wholePercentToWAD(value)
      const result = wadToWholePercent(wad)
      expect(result).toBe(value)
    }
  })

  it('should handle precision limits appropriately', () => {
    // Test with a value that has more precision than WAD_TWO_DECIMALS can represent
    const highPrecisionValue = 1.123456789
    const wad = wholePercentToWAD(highPrecisionValue)
    const result = wadToWholePercent(wad)
    // Result should be close but may not be exact due to precision limits
    expect(Math.abs(result - highPrecisionValue)).toBeLessThan(0.0001)
  })
})
