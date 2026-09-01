import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import type { LensOut } from '../../src/state/lens.sol'

import { isLiquidatable, planInputFromLens } from '../../src/runner/eligibility'

const TOKEN = getAddress('0x3333333333333333333333333333333333333333')
const COLLATERAL = getAddress('0x5555555555555555555555555555555555555555')
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
    collaterals: [
      {
        index: 0,
        amt: 5000n,
        price: 10n ** 36n,
        maxLif: 1100000000000000000n,
        lltv: 860000000000000000n
      }
    ],
    market: {
      chainId: 8453n,
      midnight: ZERO,
      loanToken: TOKEN,
      collateralParams: [
        {
          token: COLLATERAL,
          lltv: 860000000000000000n,
          liquidationCursor: 250000000000000000n,
          oracle: ORACLE
        }
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
    const out = lensOut({ debt: 1234n, badDebt: 7n, maxDebt: 1000n })
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
      collaterals: [
        {
          index: 0,
          amt: 5000n,
          price: 10n ** 36n,
          maxLif: 1100000000000000000n,
          lltv: 860000000000000000n,
          swapFree: false
        }
      ]
    })
  })

  it('flags a slot whose token IS the loan token as swap-free', () => {
    // Midnight's loan-as-collateral markets. This is the ONLY place the flag can be derived: the lens
    // returns no such field and the sizing layer holds no addresses.
    const out = lensOut({
      market: {
        ...lensOut().market,
        collateralParams: [{ ...lensOut().market.collateralParams[0]!, token: TOKEN }]
      }
    })
    expect(planInputFromLens(out).collaterals[0]?.swapFree).toBe(true)
  })

  it('leaves every slot of a conventional market not swap-free', () => {
    expect(planInputFromLens(lensOut()).collaterals.map(slot => slot.swapFree)).toEqual([false])
  })
})
