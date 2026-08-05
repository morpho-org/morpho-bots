import { describe, expect, it } from 'vitest'

import { createBlockSampler } from '../../src/runner/block-cadence'

describe('createBlockSampler', () => {
  it('grants the first claim', () => {
    expect(createBlockSampler(150n).claim(100n)).toBe(true)
  })

  it('refuses a claim inside the window', () => {
    const sampler = createBlockSampler(150n)
    sampler.claim(100n)
    expect(sampler.claim(101n)).toBe(false)
    expect(sampler.claim(249n)).toBe(false)
  })

  it('grants again at exactly everyBlocks past the last grant', () => {
    // The boundary `createBalanceMonitor` depends on: a delta of exactly `everyBlocks` logs.
    const sampler = createBlockSampler(150n)
    sampler.claim(100n)
    expect(sampler.claim(250n)).toBe(true)
  })

  it('measures the window from the last GRANT, not the last call', () => {
    const sampler = createBlockSampler(10n)
    expect(sampler.claim(100n)).toBe(true)
    expect(sampler.claim(105n)).toBe(false) // refused, so it must not re-stamp
    expect(sampler.claim(110n)).toBe(true)
  })

  it('does not consume the window when it is never asked', () => {
    // The edge-trigger guarantee: a caller that asks only when it has something to say gets an
    // immediate grant after any quiet stretch, with no per-caller state.
    const sampler = createBlockSampler(150n)
    expect(sampler.claim(100n)).toBe(true)
    // ...400 quiet blocks during which the caller never asks...
    expect(sampler.claim(500n)).toBe(true)
  })

  it('grants every claim at a zero cadence', () => {
    const sampler = createBlockSampler(0n)
    expect(sampler.claim(1n)).toBe(true)
    expect(sampler.claim(1n)).toBe(true)
  })
})
