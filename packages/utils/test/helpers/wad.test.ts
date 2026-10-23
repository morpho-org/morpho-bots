import { describe, expect, it } from 'vitest'

import { wholePercentToWAD } from '../../src/helpers/wad'

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
