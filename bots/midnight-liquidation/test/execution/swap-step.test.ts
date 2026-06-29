import { describe, expect, it } from 'bun:test'
import { getAddress, zeroAddress } from 'viem'

import type { LiquidationPlan } from '../../src/sizing/plan'
import type { LensOut } from '../../src/state/lens.sol'

import { ORACLE_PRICE_SCALE, WAD } from '../../src/constants'
import { expectedLoanOut, predictSeizedAssets } from '../../src/execution/swap-step'

const LOAN = getAddress('0x6666666666666666666666666666666666666666')
const COLLATERAL = getAddress('0x7777777777777777777777777777777777777777')
const ORACLE = getAddress('0x8888888888888888888888888888888888888888')

// price = 2 loan per collateral (1000 collateral → 2000 loan); maxLif = 1.1×.
const PRICE = ORACLE_PRICE_SCALE * 2n
const MAX_LIF = (WAD * 11n) / 10n

const out: LensOut = {
  valid: true,
  hasDebt: true,
  healthy: false,
  locked: false,
  gateAllows: true,
  blockTimestamp: 1500n,
  debt: 5000n,
  maxDebt: 1000n,
  badDebt: 0n,
  activatedBitmap: 1n,
  bestCollateralIdx: 0,
  bestCollateralAmt: 1000n,
  bestCollateralPrice: PRICE,
  bestCollateralMaxLif: MAX_LIF,
  bestCollateralLltv: (WAD * 86n) / 100n,
  market: {
    loanToken: LOAN,
    collateralParams: [
      { token: COLLATERAL, lltv: (WAD * 86n) / 100n, maxLif: MAX_LIF, oracle: ORACLE }
    ],
    maturity: 2000n, // pre-maturity at blockTimestamp 1500 → normal mode
    rcfThreshold: WAD,
    enterGate: zeroAddress,
    liquidatorGate: zeroAddress
  }
}

describe('predictSeizedAssets', () => {
  it('returns the exact seizedAssets for a 100%-slot plan', () => {
    const plan: LiquidationPlan = {
      collateralIndex: 0,
      seizedAssets: 1000n,
      repaidUnits: 0n,
      postMaturityMode: false
    }
    expect(predictSeizedAssets(plan, out)).toBe(1000n)
  })

  it('mirrors the contract seize derivation for a cap-binding plan (seizedAssets = 0)', () => {
    const plan: LiquidationPlan = {
      collateralIndex: 0,
      seizedAssets: 0n,
      repaidUnits: 1000n,
      postMaturityMode: false // normal mode → lif = maxLif (1.1×)
    }
    // floor(floor(1000 * 1.1) / 3) = floor(1100 / 3) = 366 collateral at price 3.
    expect(
      predictSeizedAssets(plan, { ...out, bestCollateralPrice: ORACLE_PRICE_SCALE * 3n })
    ).toBe(366n)
  })

  it('returns 0 when the oracle price is 0 (avoids a divide-by-zero)', () => {
    const plan: LiquidationPlan = {
      collateralIndex: 0,
      seizedAssets: 0n,
      repaidUnits: 1000n,
      postMaturityMode: false
    }
    expect(predictSeizedAssets(plan, { ...out, bestCollateralPrice: 0n })).toBe(0n)
  })
})

describe('expectedLoanOut', () => {
  it('values a 100%-slot plan (seizedAssets > 0) at the oracle price', () => {
    const plan: LiquidationPlan = {
      collateralIndex: 0,
      seizedAssets: 1000n,
      repaidUnits: 0n,
      postMaturityMode: false
    }
    // 1000 collateral × price(2) = 2000 loan.
    expect(expectedLoanOut(plan, out)).toBe(2000n)
  })

  it('values a cap-binding plan (seizedAssets = 0) after contract seize rounding', () => {
    const plan: LiquidationPlan = {
      collateralIndex: 0,
      seizedAssets: 0n,
      repaidUnits: 1000n,
      postMaturityMode: false // normal mode → lif = maxLif (1.1×)
    }
    // Contract seize rounding at price 3: floor(floor(1000 * 1.1) / 3) = 366 collateral,
    // then the swap minimum is based on floor(366 * 3) = 1098 loan.
    expect(expectedLoanOut(plan, { ...out, bestCollateralPrice: ORACLE_PRICE_SCALE * 3n })).toBe(
      1098n
    )
  })
})
