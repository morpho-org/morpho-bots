import { describe, expect, it } from 'bun:test'

import type { LiquidationPlan, PlanInput } from '../../src/sizing/plan'

import { ORACLE_PRICE_SCALE, WAD } from '../../src/constants'
import { plan } from '../../src/sizing/plan'

const MAX_LIF = 1036269430051813471n
const LLTV = 860000000000000000n

// Pre-maturity (now < maturity), unhealthy borrower with one activated slot — the normal-mode base.
function baseInput(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    blockTimestamp: 1000n,
    maturity: 2000n,
    hasDebt: true,
    locked: false,
    healthy: false,
    debt: 1000n * WAD,
    badDebt: 0n,
    maxDebt: 900n * WAD,
    rcfThreshold: WAD,
    bestCollateralIndex: 3,
    bestCollateralAmt: 100n * WAD,
    bestCollateralPrice: ORACLE_PRICE_SCALE,
    bestCollateralMaxLif: MAX_LIF,
    bestCollateralLltv: LLTV,
    ...overrides
  }
}

describe('plan', () => {
  it('skips a position with no debt', () => {
    expect(plan(baseInput({ hasDebt: false }))).toBeNull()
  })

  it('skips a liquidation-locked position', () => {
    expect(plan(baseInput({ locked: true }))).toBeNull()
  })

  it('skips a healthy position before maturity', () => {
    expect(plan(baseInput({ healthy: true }))).toBeNull()
  })

  it('seizes the whole slot in normal mode when the RCF cap does not bind', () => {
    expect(plan(baseInput({ bestCollateralAmt: 100n * WAD }))).toEqual({
      collateralIndex: 3,
      seizedAssets: 100n * WAD,
      repaidUnits: 0n,
      postMaturityMode: false
    })
  })

  it('repays exactly maxRepaid in normal mode when the cap binds and the slot is not exempt', () => {
    const expected: LiquidationPlan = {
      collateralIndex: 3,
      seizedAssets: 0n,
      repaidUnits: 919047619047619043969n,
      postMaturityMode: false
    }
    expect(plan(baseInput({ bestCollateralAmt: 2000n * WAD, rcfThreshold: WAD }))).toEqual(expected)
  })

  it('seizes the whole slot when rcf-exempt and the slot fits within the debt', () => {
    // Exemption waives the RCF cap, so a slot whose implied repaid units (~965 WAD) still fit within
    // the 1000-WAD debt is seized whole — the cap would otherwise have bound it at ~919 WAD.
    expect(plan(baseInput({ bestCollateralAmt: 1000n * WAD, rcfThreshold: 2000n * WAD }))).toEqual({
      collateralIndex: 3,
      seizedAssets: 1000n * WAD,
      repaidUnits: 0n,
      postMaturityMode: false
    })
  })

  it('caps an rcf-exempt over-collateralized slot at the debt instead of over-repaying', () => {
    // Regression: an exempt 2000-WAD slot against 1000-WAD debt implies ~1930 WAD repaid. Seizing it
    // whole makes the contract derive repaidUnits > debt and revert (Panic 0x11 underflow) — a real
    // bot run hit exactly this. The plan must instead repay the post-writeoff debt and derive the seize.
    expect(plan(baseInput({ bestCollateralAmt: 2000n * WAD, rcfThreshold: 2000n * WAD }))).toEqual({
      collateralIndex: 3,
      seizedAssets: 0n,
      repaidUnits: 1000n * WAD,
      postMaturityMode: false
    })
  })

  it('repays the full debt past maturity when the slot is worth more than the debt', () => {
    // Over-collateralized (the common post-maturity case): a 2000-WAD slot against 1000-WAD debt would
    // imply ~1930 WAD repaid — more than the debt — so seizing it whole would over-repay and revert.
    // The plan caps at the (post-writeoff) debt and lets the contract derive the smaller seize.
    expect(
      plan(
        baseInput({
          blockTimestamp: 3000n,
          maturity: 2000n,
          healthy: true,
          bestCollateralAmt: 2000n * WAD
        })
      )
    ).toEqual({
      collateralIndex: 3,
      seizedAssets: 0n,
      repaidUnits: 1000n * WAD, // debt - badDebt
      postMaturityMode: true
    })
  })

  it('realizes fully bad debt with zero seized assets and zero repaid units', () => {
    expect(
      plan(
        baseInput({
          blockTimestamp: 3000n,
          maturity: 2000n,
          healthy: true,
          debt: 1000n * WAD,
          badDebt: 1000n * WAD
        })
      )
    ).toEqual({
      collateralIndex: 3,
      seizedAssets: 0n,
      repaidUnits: 0n,
      postMaturityMode: true
    })
  })

  it('seizes the whole slot past maturity when the slot cannot cover the debt', () => {
    // Underwater: a 500-WAD slot implies ~482 WAD repaid, within the 1000-WAD debt, so seizing it whole
    // does not over-repay — take all of it (partial repay).
    expect(
      plan(
        baseInput({
          blockTimestamp: 3000n,
          maturity: 2000n,
          healthy: true,
          bestCollateralAmt: 500n * WAD
        })
      )
    ).toEqual({
      collateralIndex: 3,
      seizedAssets: 500n * WAD,
      repaidUnits: 0n,
      postMaturityMode: true
    })
  })
})
