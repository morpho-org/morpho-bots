import { describe, expect, it } from 'vitest'

import { createBlockSampler } from '../../src/runner/block-cadence'

describe('createBlockSampler', () => {
  it('refuses a claim inside the window', () => {
    const claim = createBlockSampler(150n)
    expect(claim(100n)).toBe(true)
    expect(claim(101n)).toBe(false)
    expect(claim(249n)).toBe(false)
  })

  it('grants again at exactly everyBlocks past the last grant', () => {
    // The boundary `createBalanceMonitor` depends on: a delta of exactly `everyBlocks` logs.
    const claim = createBlockSampler(150n)
    claim(100n)
    expect(claim(250n)).toBe(true)
  })

  it('measures the window from the last GRANT, not the last call', () => {
    const claim = createBlockSampler(10n)
    expect(claim(100n)).toBe(true)
    expect(claim(105n)).toBe(false) // refused, so it must not re-stamp
    expect(claim(110n)).toBe(true)
  })

  it('grants every claim at a zero cadence', () => {
    const claim = createBlockSampler(0n)
    expect(claim(1n)).toBe(true)
    expect(claim(1n)).toBe(true)
  })
})
