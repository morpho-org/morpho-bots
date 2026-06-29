import { describe, expect, it } from 'bun:test'
import { getAddress, zeroAddress } from 'viem'

import type { LiquidationPlan } from '../../src/sizing/plan'
import type { LensOut } from '../../src/state/lens.sol'

import { ORACLE_PRICE_SCALE, WAD } from '../../src/constants'
import {
  buildSwapStep,
  coversRepay,
  expectedLoanOut,
  repaidAssets
} from '../../src/execution/swap-step'

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
    // 1098 × 9950 / 10000 = 1092 (floor).
    expect(
      buildSwapStep(entry, plan, { ...out, bestCollateralPrice: ORACLE_PRICE_SCALE * 3n })
        .amountOutMinimum
    ).toBe(1092n)
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

  it('floors amountOutMinimum at the repay when slippage would dip below it', () => {
    // No LIF margin (maxLif = WAD): the seize equals the repay in value, so expected = repaidUnits and
    // the slippage-bounded minimum (995) falls below the repay (1000) Midnight pulls — the floor wins.
    const plan: LiquidationPlan = {
      collateralIndex: 0,
      seizedAssets: 0n,
      repaidUnits: 1000n,
      postMaturityMode: false
    }
    const noBonus = { ...out, bestCollateralMaxLif: WAD }
    expect(buildSwapStep(entry, plan, noBonus).amountOutMinimum).toBe(1000n)
  })
})

describe('repaidAssets', () => {
  it('returns repaidUnits directly for a cap-binding plan', () => {
    const plan: LiquidationPlan = {
      collateralIndex: 0,
      seizedAssets: 0n,
      repaidUnits: 1234n,
      postMaturityMode: false
    }
    expect(repaidAssets(plan, out)).toBe(1234n)
  })

  it('derives the contract repay with double-ceil for a whole-slot plan', () => {
    const plan: LiquidationPlan = {
      collateralIndex: 0,
      seizedAssets: 1000n,
      repaidUnits: 0n,
      postMaturityMode: false
    }
    // lif = maxLif = 1.1, price = 2: ceil(ceil(1000*2) * WAD / 1.1·WAD) = ceil(2000/1.1) = 1819.
    expect(repaidAssets(plan, out)).toBe(1819n)
  })
})

describe('coversRepay', () => {
  it('is true when the LIF-bonused seize value exceeds the repay (cap-binding)', () => {
    const plan: LiquidationPlan = {
      collateralIndex: 0,
      seizedAssets: 0n,
      repaidUnits: 1000n,
      postMaturityMode: false
    }
    // expected = 1000 × 1.1 = 1100 > 1000.
    expect(coversRepay(plan, out)).toBe(true)
  })

  it('is false when there is no LIF margin to cover the repay (maxLif = WAD)', () => {
    const plan: LiquidationPlan = {
      collateralIndex: 0,
      seizedAssets: 0n,
      repaidUnits: 1000n,
      postMaturityMode: false
    }
    // expected = 1000 × 1.0 = 1000, not strictly greater than the 1000 repay → cannot self-fund.
    expect(coversRepay(plan, { ...out, bestCollateralMaxLif: WAD })).toBe(false)
  })
})
