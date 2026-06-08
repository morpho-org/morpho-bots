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

  it('seizes the whole slot when the binding cap is waived by the rcf exemption', () => {
    expect(plan(baseInput({ bestCollateralAmt: 2000n * WAD, rcfThreshold: 2000n * WAD }))).toEqual({
      collateralIndex: 3,
      seizedAssets: 2000n * WAD,
      repaidUnits: 0n,
      postMaturityMode: false
    })
  })

  it('seizes the whole slot past maturity with no cap, regardless of health', () => {
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
      seizedAssets: 2000n * WAD,
      repaidUnits: 0n,
      postMaturityMode: true
    })
  })
})
