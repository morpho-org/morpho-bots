import { describe, expect, it } from 'bun:test'
import { getAddress, zeroAddress } from 'viem'

import type { LensOut } from '../../src/lens.sol'
import type { LiquidationPlan } from '../../src/sizing/plan'

import { ORACLE_PRICE_SCALE, WAD } from '../../src/constants'
import { expectedLoanOut } from '../../src/execution/swap-step'

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
    chainId: 8453n,
    midnight: zeroAddress,
    loanToken: LOAN,
    collateralParams: [
      {
        token: COLLATERAL,
        lltv: (WAD * 86n) / 100n,
        liquidationCursor: (WAD * 25n) / 100n,
        oracle: ORACLE
      }
    ],
    maturity: 2000n, // pre-maturity at blockTimestamp 1500 → normal mode
    rcfThreshold: WAD,
    enterGate: zeroAddress,
    liquidatorGate: zeroAddress
  }
}

describe('expectedLoanOut', () => {
  it('values a whole-slot plan at the oracle price', () => {
    const plan: LiquidationPlan = {
      collateralIndex: 0,
      seizedAssets: 1000n,
      repaidUnits: 0n,
      postMaturityMode: false
    }
    // 1000 collateral × price(2) = 2000 loan.
    expect(expectedLoanOut(plan, out)).toBe(2000n)
  })

  it('values a cap-binding seize-exact plan at the oracle price (pinned seizedAssets)', () => {
    // Seize-exact: a cap-binding plan pins `seizedAssets` directly (here 366, the contract-derived
    // seize for a ~1000-unit repay cap at price 3), so the reference output is just 366 × 3 = 1098.
    const plan: LiquidationPlan = {
      collateralIndex: 0,
      seizedAssets: 366n,
      repaidUnits: 0n,
      postMaturityMode: false
    }
    expect(expectedLoanOut(plan, { ...out, bestCollateralPrice: ORACLE_PRICE_SCALE * 3n })).toBe(
      1098n
    )
  })

  it('returns 0 when the oracle price is 0 (avoids a divide-by-zero)', () => {
    const plan: LiquidationPlan = {
      collateralIndex: 0,
      seizedAssets: 1000n,
      repaidUnits: 0n,
      postMaturityMode: false
    }
    expect(expectedLoanOut(plan, { ...out, bestCollateralPrice: 0n })).toBe(0n)
  })
})
