import { describe, expect, it } from 'bun:test'

import { aprBpsToTick } from '../src/rates'

describe('aprBpsToTick', () => {
  it('returns the closest aligned tick', () => {
    const tick = aprBpsToTick({ aprBps: 450, timeToMaturity: 31_536_000n, tickSpacing: 4 })

    expect(tick % 4n).toBe(0n)
  })

  it('rejects non-positive time to maturity', () => {
    expect(() => aprBpsToTick({ aprBps: 450, timeToMaturity: 0n, tickSpacing: 10 })).toThrow(
      'Market has matured'
    )
  })
})
