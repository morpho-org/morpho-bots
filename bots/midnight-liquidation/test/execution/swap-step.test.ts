import { describe, expect, it } from 'bun:test'
import { getAddress, zeroAddress } from 'viem'

import type { LiquidationPlan } from '../../src/sizing/plan'
import type { LensOut } from '../../src/state/lens.sol'

import { ORACLE_PRICE_SCALE, WAD } from '../../src/constants'
import { buildSwapStep, expectedLoanOut } from '../../src/execution/swap-step'

const ROUTER = getAddress('0x5555555555555555555555555555555555555555')
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

const entry = { router: ROUTER, fee: 3000, slippageBps: 50 } // 0.5%

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

  it('values a cap-binding plan (seizedAssets = 0) from repaidUnits × lif', () => {
    const plan: LiquidationPlan = {
      collateralIndex: 0,
      seizedAssets: 0n,
      repaidUnits: 1000n,
      postMaturityMode: false // normal mode → lif = maxLif (1.1×)
    }
    // repaidUnits(1000) × maxLif(1.1) / WAD = 1100 loan.
    expect(expectedLoanOut(plan, out)).toBe(1100n)
  })
})

describe('buildSwapStep', () => {
  it('passes router + fee through and bounds amountOutMinimum by slippageBps (100%-slot)', () => {
    const plan: LiquidationPlan = {
      collateralIndex: 0,
      seizedAssets: 1000n,
      repaidUnits: 0n,
      postMaturityMode: false
    }
    const step = buildSwapStep(entry, plan, out)
    expect(step.router).toBe(ROUTER)
    expect(step.fee).toBe(3000)
    // 2000 × (10000 - 50) / 10000 = 1990.
    expect(step.amountOutMinimum).toBe(1990n)
  })

  it('bounds amountOutMinimum for a cap-binding plan', () => {
    const plan: LiquidationPlan = {
      collateralIndex: 0,
      seizedAssets: 0n,
      repaidUnits: 1000n,
      postMaturityMode: false
    }
    // 1100 × 9950 / 10000 = 1094 (floor).
    expect(buildSwapStep(entry, plan, out).amountOutMinimum).toBe(1094n)
  })

  it('applies no reduction when slippageBps is 0', () => {
    const plan: LiquidationPlan = {
      collateralIndex: 0,
      seizedAssets: 1000n,
      repaidUnits: 0n,
      postMaturityMode: false
    }
    expect(buildSwapStep({ ...entry, slippageBps: 0 }, plan, out).amountOutMinimum).toBe(2000n)
  })
})
