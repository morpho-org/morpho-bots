import { describe, expect, it } from 'vitest'

import { parseMaxFeeGwei } from '../src/fee'

describe('parseMaxFeeGwei', () => {
  it('reads a gwei amount as wei', () => {
    expect(parseMaxFeeGwei(' 300 ')).toBe(300_000_000_000n)
    expect(parseMaxFeeGwei('0.000000001')).toBe(1n)
  })

  it.each(['0', '0.0', '0.0000000001', '-1', '1e3', '0x10', '1.', ''])('refuses %j', raw => {
    expect(parseMaxFeeGwei(raw)).toBeUndefined()
  })
})
