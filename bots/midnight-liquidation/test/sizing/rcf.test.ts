import { maxUint256 } from 'viem'
import { describe, expect, it } from 'vitest'

import { ORACLE_PRICE_SCALE, WAD } from '../../src/constants'
import { isRcfExempt, maxRepaidPreMaturity } from '../../src/sizing/rcf'

const MAX_LIF = 1036269430051813471n
const LLTV = 860000000000000000n // 0.86e18

describe('maxRepaidPreMaturity', () => {
  it('returns maxUint256 when lltv >= WAD (cap disabled)', () => {
    expect(
      maxRepaidPreMaturity({
        debt: 1000n * WAD,
        badDebt: 0n,
        maxDebt: 900n * WAD,
        lif: MAX_LIF,
        lltv: WAD
      })
    ).toBe(maxUint256)
  })

  it('caps repaid units against (debt - maxDebt) when there is no bad debt', () => {
    expect(
      maxRepaidPreMaturity({
        debt: 1000n * WAD,
        badDebt: 0n,
        maxDebt: 900n * WAD,
        lif: MAX_LIF,
        lltv: LLTV
      })
    ).toBe(919047619047619043969n)
  })

  it('subtracts the bad-debt writeoff from debt before capping', () => {
    // effectiveDebt - maxDebt = (1000 - 50 - 900)e18 = 50e18, half the no-bad-debt numerator.
    expect(
      maxRepaidPreMaturity({
        debt: 1000n * WAD,
        badDebt: 50n * WAD,
        maxDebt: 900n * WAD,
        lif: MAX_LIF,
        lltv: LLTV
      })
    ).toBe(459523809523809521985n)
  })
})

describe('isRcfExempt', () => {
  // With price = ORACLE_PRICE_SCALE and lif = WAD, slotInRepaidUnits == collateralAmt.
  it('is not exempt when the slot dwarfs the threshold', () => {
    expect(
      isRcfExempt({
        collateralAmt: 500n * WAD,
        price: ORACLE_PRICE_SCALE,
        lif: WAD,
        maxRepaid: 100n * WAD,
        rcfThreshold: WAD
      })
    ).toBe(false) // residual 400e18, not < 1e18
  })

  it('is exempt for a dust slot below the threshold', () => {
    expect(
      isRcfExempt({
        collateralAmt: 100n,
        price: ORACLE_PRICE_SCALE,
        lif: WAD,
        maxRepaid: 0n,
        rcfThreshold: 1_000_000n
      })
    ).toBe(true) // residual 100 < 1e6
  })

  it('is exempt when maxRepaid already covers the slot (zero residual)', () => {
    expect(
      isRcfExempt({
        collateralAmt: 50n * WAD,
        price: ORACLE_PRICE_SCALE,
        lif: WAD,
        maxRepaid: 100n * WAD,
        rcfThreshold: 1n
      })
    ).toBe(true) // residual 0 < 1
  })
})
