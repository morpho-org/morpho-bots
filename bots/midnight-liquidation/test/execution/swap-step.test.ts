import { describe, expect, it } from 'vitest'

import type { LiquidationPlan } from '../../src/sizing/plan'

import { ORACLE_PRICE_SCALE, WAD } from '../../src/constants'
import { expectedLoanOut } from '../../src/execution/swap-step'

// price = 2 loan per collateral (1000 collateral → 2000 loan). The oracle price now rides on the plan
// itself, so these cases need no lens output at all — a position can activate several slots at
// different prices, and only the plan knows which one it chose.
const PRICE = ORACLE_PRICE_SCALE * 2n

describe('expectedLoanOut', () => {
  it('values a whole-slot plan at the oracle price', () => {
    const plan: LiquidationPlan = {
      collateralIndex: 0,
      seizedAssets: 1000n,
      repaidUnits: 0n,
      postMaturityMode: false,
      lif: WAD,
      impliedRepaidUnits: 1000n,
      oraclePrice: PRICE,
      swapFree: false
    }
    // 1000 collateral × price(2) = 2000 loan.
    expect(expectedLoanOut(plan)).toBe(2000n)
  })

  it('values a cap-binding seize-exact plan at the oracle price (pinned seizedAssets)', () => {
    // Seize-exact: a cap-binding plan pins `seizedAssets` directly (here 366, the contract-derived
    // seize for a ~1000-unit repay cap at price 3), so the reference output is just 366 × 3 = 1098.
    const plan: LiquidationPlan = {
      collateralIndex: 0,
      seizedAssets: 366n,
      repaidUnits: 0n,
      postMaturityMode: false,
      lif: WAD,
      impliedRepaidUnits: 1098n,
      oraclePrice: ORACLE_PRICE_SCALE * 3n,
      swapFree: false
    }
    expect(expectedLoanOut(plan)).toBe(1098n)
  })

  it('returns 0 when the oracle price is 0 (avoids a divide-by-zero)', () => {
    const plan: LiquidationPlan = {
      collateralIndex: 0,
      seizedAssets: 1000n,
      repaidUnits: 0n,
      postMaturityMode: false,
      lif: WAD,
      impliedRepaidUnits: 1000n,
      oraclePrice: 0n,
      swapFree: false
    }
    expect(expectedLoanOut(plan)).toBe(0n)
  })
})
