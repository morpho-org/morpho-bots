import { describe, expect, it } from 'vitest'

import type { MarketParams } from '../../src/market'
import type { LensOut } from '../../src/state/lens.sol'

import { ORACLE_PRICE_SCALE, WAD } from '../../src/constants'
import { expectedLoanOut } from '../../src/execution/swap-step'

const PARAMS: MarketParams = {
  loanToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  collateralToken: '0x4200000000000000000000000000000000000006',
  oracle: '0x1111111111111111111111111111111111111111',
  irm: '0x46415998764C29aB2a25CbeA6254146D50D22687',
  lltv: 86n * 10n ** 16n
}

function lensOut(collateralPrice: bigint): LensOut {
  return {
    params: PARAMS,
    valid: true,
    hasDebt: true,
    healthy: false,
    blockTimestamp: 1_700_000_000n,
    borrowShares: 0n,
    collateral: 0n,
    accruedTotalBorrowAssets: 0n,
    totalBorrowShares: 0n,
    collateralPrice,
    lltv: PARAMS.lltv
  }
}

describe('expectedLoanOut', () => {
  it('converts seized collateral to loan units at the oracle price (price = 1e36 → 1:1)', () => {
    expect(expectedLoanOut({ seizedAssets: 3n * WAD }, lensOut(ORACLE_PRICE_SCALE))).toBe(3n * WAD)
  })

  it('scales by a below-parity price (0.5e36 → half)', () => {
    const halfPrice = ORACLE_PRICE_SCALE / 2n
    expect(expectedLoanOut({ seizedAssets: 4n * WAD }, lensOut(halfPrice))).toBe(2n * WAD)
  })

  it('floors the conversion (mulDivDown)', () => {
    // 1 wei of collateral at half price → 0.5 loan units → floors to 0.
    expect(expectedLoanOut({ seizedAssets: 1n }, lensOut(ORACLE_PRICE_SCALE / 2n))).toBe(0n)
  })
})
