import { describe, expect, it } from 'bun:test'

import { safeParseUnits } from '../../src/helpers/safeParseUnits'

describe('safeParseUnits', () => {
  it('scales by the given decimals', () => {
    expect(safeParseUnits('1', 18)).toBe(1_000000000000000000n)
    expect(safeParseUnits('1.5', 6)).toBe(1_500000n)
    expect(safeParseUnits('1', 0)).toBe(1n)
  })

  it('treats empty and bare-dot input as zero', () => {
    expect(safeParseUnits('', 18)).toBe(0n)
    expect(safeParseUnits('.', 18)).toBe(0n)
  })

  it('trims surrounding whitespace', () => {
    expect(safeParseUnits('  2.5  ', 6)).toBe(2_500000n)
  })

  it('rounds digits beyond the given decimals half-away-from-zero, never truncating', () => {
    expect(safeParseUnits('1.9999999', 6)).toBe(2_000000n)
    expect(safeParseUnits('1.4', 0)).toBe(1n)
    expect(safeParseUnits('1.5', 0)).toBe(2n)
    expect(safeParseUnits('2.5', 0)).toBe(3n)
  })

  it('parses negative amounts, rounding away from zero', () => {
    expect(safeParseUnits('-1.5', 6)).toBe(-1_500000n)
    expect(safeParseUnits('-1.5', 0)).toBe(-2n)
  })

  it('returns null for non-numeric input', () => {
    expect(safeParseUnits('abc', 18)).toBeNull()
    expect(safeParseUnits('1.2.3', 18)).toBeNull()
  })
})
