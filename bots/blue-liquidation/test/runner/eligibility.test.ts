import { describe, expect, it } from 'vitest'

import type { MarketParams } from '../../src/market'
import type { LensOut } from '../../src/state/lens.sol'

import { ORACLE_PRICE_SCALE, WAD } from '../../src/constants'
import { isLiquidatable, planInputFromLens } from '../../src/runner/eligibility'

const PARAMS: MarketParams = {
  loanToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  collateralToken: '0x4200000000000000000000000000000000000006',
  oracle: '0x1111111111111111111111111111111111111111',
  irm: '0x46415998764C29aB2a25CbeA6254146D50D22687',
  lltv: 86n * 10n ** 16n
}

function lensOut(overrides: Partial<LensOut> = {}): LensOut {
  return {
    params: PARAMS,
    valid: true,
    hasDebt: true,
    healthy: false,
    blockTimestamp: 1_700_000_000n,
    borrowShares: 1000n * WAD * 10n ** 6n,
    collateral: 100n * WAD,
    accruedTotalBorrowAssets: 5000n * WAD,
    totalBorrowShares: 5000n * WAD * 10n ** 6n,
    collateralPrice: ORACLE_PRICE_SCALE,
    lltv: PARAMS.lltv,
    ...overrides
  }
}

describe('isLiquidatable', () => {
  it('is true only for a valid, indebted, unhealthy position', () => {
    expect(isLiquidatable(lensOut())).toBe(true)
  })

  it('is false when the market is invalid (forged params / no market)', () => {
    expect(isLiquidatable(lensOut({ valid: false }))).toBe(false)
  })

  it('is false with no debt', () => {
    expect(isLiquidatable(lensOut({ hasDebt: false }))).toBe(false)
  })

  it('is false when healthy', () => {
    expect(isLiquidatable(lensOut({ healthy: true }))).toBe(false)
  })
})

describe('planInputFromLens', () => {
  it('projects the flat per-position + accrued-market fields onto PlanInput', () => {
    const out = lensOut()
    expect(planInputFromLens(out)).toEqual({
      hasDebt: out.hasDebt,
      healthy: out.healthy,
      borrowShares: out.borrowShares,
      collateral: out.collateral,
      accruedTotalBorrowAssets: out.accruedTotalBorrowAssets,
      totalBorrowShares: out.totalBorrowShares,
      collateralPrice: out.collateralPrice,
      lltv: out.lltv
    })
  })
})
