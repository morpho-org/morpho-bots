import { describe, expect, it } from 'bun:test'

import { activeBits } from '../../src/sizing/bitmap'

describe('activeBits', () => {
  it('returns the set bit indices ascending', () => {
    expect(activeBits(0b101n)).toEqual([0, 2])
  })

  it('handles a single high bit', () => {
    expect(activeBits(1n << 15n)).toEqual([15])
  })

  it('returns an empty array for an empty bitmap', () => {
    expect(activeBits(0n)).toEqual([])
  })

  it('spans the full uint128 width', () => {
    expect(activeBits(1n | (1n << 127n))).toEqual([0, 127])
  })
})
