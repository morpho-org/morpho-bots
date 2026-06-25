import { describe, expect, it } from 'bun:test'
import { getAddress } from 'viem'

import type { LensOut } from '../../src/state/lens.sol'

import { isLiquidatable, planInputFromLens } from '../../src/runner/eligibility'

const TOKEN = getAddress('0x3333333333333333333333333333333333333333')
const ORACLE = getAddress('0x4444444444444444444444444444444444444444')
const ZERO = '0x0000000000000000000000000000000000000000' as const

// Base reading is liquidatable: valid, gate open, has debt, unlocked, unhealthy, pre-maturity.
function lensOut(overrides: Partial<LensOut> = {}): LensOut {
  return {
    valid: true,
    hasDebt: true,
    healthy: false,
    locked: false,
    gateAllows: true,
    blockTimestamp: 1000n,
    debt: 1000n,
    maxDebt: 900n,
    badDebt: 0n,
    activatedBitmap: 1n,
    bestCollateralIdx: 0,
    bestCollateralAmt: 5000n,
    bestCollateralPrice: 10n ** 36n,
    bestCollateralMaxLif: 1100000000000000000n,
    bestCollateralLltv: 860000000000000000n,
    market: {
      loanToken: TOKEN,
      collateralParams: [
        { token: TOKEN, lltv: 860000000000000000n, maxLif: 1100000000000000000n, oracle: ORACLE }
      ],
      maturity: 2000n,
      rcfThreshold: 10n ** 30n,
      enterGate: ZERO,
      liquidatorGate: ZERO
    },
    ...overrides
  }
}

describe('isLiquidatable', () => {
  it('is true for an unhealthy, pre-maturity position', () => {
    expect(isLiquidatable(lensOut())).toBe(true)
  })

  it('is true past maturity even when healthy', () => {
    expect(isLiquidatable(lensOut({ healthy: true, blockTimestamp: 3000n }))).toBe(true)
  })

  it('is false when healthy and pre-maturity', () => {
    expect(isLiquidatable(lensOut({ healthy: true }))).toBe(false)
  })

  it('is false when the obligation is invalid, gate-blocked, debt-free, or locked', () => {
    expect(isLiquidatable(lensOut({ valid: false }))).toBe(false)
    expect(isLiquidatable(lensOut({ gateAllows: false }))).toBe(false)
    expect(isLiquidatable(lensOut({ hasDebt: false }))).toBe(false)
    expect(isLiquidatable(lensOut({ locked: true }))).toBe(false)
  })
})

describe('planInputFromLens', () => {
  it('maps obligation config and flat position state into PlanInput', () => {
    const out = lensOut({ debt: 1234n, badDebt: 7n, maxDebt: 1000n, bestCollateralIdx: 3 })
    expect(planInputFromLens(out)).toEqual({
      blockTimestamp: 1000n,
      maturity: 2000n,
      hasDebt: true,
      locked: false,
      healthy: false,
      debt: 1234n,
      badDebt: 7n,
      maxDebt: 1000n,
      rcfThreshold: 10n ** 30n,
      bestCollateralIndex: 3,
      bestCollateralAmt: 5000n,
      bestCollateralPrice: 10n ** 36n,
      bestCollateralMaxLif: 1100000000000000000n,
      bestCollateralLltv: 860000000000000000n
    })
  })
})
