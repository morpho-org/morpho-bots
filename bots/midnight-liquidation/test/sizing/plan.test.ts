import { describe, expect, it } from 'vitest'

import type { LiquidationPlan, PlanInput } from '../../src/sizing/plan'

import { ORACLE_PRICE_SCALE, WAD } from '../../src/constants'
import { maxSeizeForCap, plan, planWithReason } from '../../src/sizing/plan'

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

  it('seizes the cap-bound amount in normal mode when the cap binds and the slot is not exempt', () => {
    // The RCF cap is ~919 WAD of repaid units; seize-exact pins the largest seize whose contract-derived
    // repaid stays within it (`maxSeizeForCap`), and lets the contract ceil-derive `repaidUnits`.
    const maxRepaid = 919047619047619043969n
    const expected: LiquidationPlan = {
      collateralIndex: 3,
      seizedAssets: maxSeizeForCap(maxRepaid, ORACLE_PRICE_SCALE, MAX_LIF),
      repaidUnits: 0n,
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
    // bot run hit exactly this. Seize-exact instead pins the largest seize whose derived repaid stays
    // within the post-writeoff debt.
    expect(plan(baseInput({ bestCollateralAmt: 2000n * WAD, rcfThreshold: 2000n * WAD }))).toEqual({
      collateralIndex: 3,
      seizedAssets: maxSeizeForCap(1000n * WAD, ORACLE_PRICE_SCALE, MAX_LIF),
      repaidUnits: 0n,
      postMaturityMode: false
    })
  })

  it('seizes the cap-bound amount past maturity when the slot is worth more than the debt', () => {
    // Over-collateralized (the common post-maturity case): a 2000-WAD slot against 1000-WAD debt would
    // imply ~1930 WAD repaid — more than the debt — so seizing it whole would over-repay and revert.
    // Seize-exact pins the largest seize whose derived repaid stays within the (post-writeoff) debt.
    // dt = 4000s > TIME_TO_MAX_LIF (3600s), so the post-maturity LIF is clamped to maxLif.
    expect(
      plan(
        baseInput({
          blockTimestamp: 6000n,
          maturity: 2000n,
          healthy: true,
          bestCollateralAmt: 2000n * WAD
        })
      )
    ).toEqual({
      collateralIndex: 3,
      seizedAssets: maxSeizeForCap(1000n * WAD, ORACLE_PRICE_SCALE, MAX_LIF), // cap = debt - badDebt
      repaidUnits: 0n,
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

  it('shrinks a cap-binding seize by the safety margin, leaving repaidUnits at 0', () => {
    // 100 bps margin: size the seize against cap·(1 - 100/10000) instead of the raw RCF cap.
    const maxRepaid = 919047619047619043969n
    const capEff = (maxRepaid * (10_000n - 100n)) / 10_000n
    expect(
      plan(baseInput({ bestCollateralAmt: 2000n * WAD, rcfThreshold: WAD }), {
        seizeCapMarginBps: 100
      })
    ).toEqual({
      collateralIndex: 3,
      seizedAssets: maxSeizeForCap(capEff, ORACLE_PRICE_SCALE, MAX_LIF),
      repaidUnits: 0n,
      postMaturityMode: false
    })
  })

  it('treats an explicit zero margin identically to the default (no margin)', () => {
    const input = baseInput({ bestCollateralAmt: 2000n * WAD, rcfThreshold: WAD })
    expect(plan(input, { seizeCapMarginBps: 0 })).toEqual(plan(input))
  })

  it('skips (returns null) when a cap-binding seize rounds to zero — never a (0,0) bad-debt plan', () => {
    // Post-maturity dust: 1 wei of debt against a high-priced slot. The cap binds, but the largest
    // seize whose derived repaid fits in 1 wei rounds to 0 collateral. The plan must return null, NOT a
    // { seized: 0, repaid: 0 } plan, which tick.ts would mis-route as a bad-debt write-off.
    const result = plan(
      baseInput({
        blockTimestamp: 3000n,
        maturity: 2000n,
        healthy: true,
        debt: 1n,
        badDebt: 0n,
        bestCollateralAmt: 1n * WAD,
        bestCollateralPrice: ORACLE_PRICE_SCALE * 10n
      })
    )
    expect(result).toBeNull()
  })
})

describe('maxSeizeForCap', () => {
  // Local re-derivation of the contract's repaid←seize ceil-ceil (midnight-contracts.txt:2369),
  // independent of the module's private `impliedRepaidUnits`, to check the inverse round-trip.
  const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b
  const impliedRepaid = (s: bigint, price: bigint, lif: bigint): bigint =>
    ceilDiv(ceilDiv(s * price, ORACLE_PRICE_SCALE) * WAD, lif)

  it('returns 0 for a zero cap or zero price (no divide-by-zero)', () => {
    expect(maxSeizeForCap(0n, ORACLE_PRICE_SCALE, WAD)).toBe(0n)
    expect(maxSeizeForCap(1000n, 0n, WAD)).toBe(0n)
  })

  it('matches the hand-computed contract derivation (repaid 1000, lif 1.1x, price 3x)', () => {
    // floor(floor(1000 * 1.1) / 3) = floor(1100 / 3) = 366.
    expect(maxSeizeForCap(1000n, ORACLE_PRICE_SCALE * 3n, (WAD * 11n) / 10n)).toBe(366n)
  })

  it('is the identity in collateral units at a 1:1 price and unit LIF', () => {
    expect(maxSeizeForCap(500n, ORACLE_PRICE_SCALE, WAD)).toBe(500n)
  })

  it('is exact and maximal across a deterministic grid (derived repaid <= cap < repaid(S+1))', () => {
    const caps = [1n, 2n, 3n, 7n, 999n, 1000n, 1001n, WAD, 919047619047619043969n, 1000n * WAD]
    const prices = [
      1n,
      ORACLE_PRICE_SCALE / 3n,
      ORACLE_PRICE_SCALE / 2n,
      ORACLE_PRICE_SCALE - 1n,
      ORACLE_PRICE_SCALE,
      ORACLE_PRICE_SCALE + 1n,
      ORACLE_PRICE_SCALE * 2n,
      ORACLE_PRICE_SCALE * 7n
    ]
    const lifs = [WAD, WAD + 1n, WAD + 2n, (WAD * 11n) / 10n, MAX_LIF, WAD * 2n]
    for (const cap of caps) {
      for (const price of prices) {
        for (const lif of lifs) {
          const s = maxSeizeForCap(cap, price, lif)
          expect(impliedRepaid(s, price, lif) <= cap).toBe(true)
          expect(impliedRepaid(s + 1n, price, lif) > cap).toBe(true)
        }
      }
    }
  })
})

describe('planWithReason', () => {
  // The reachable-from-the-tick skips. `no_debt`/`locked`/`healthy_pre_maturity` are excluded by
  // `isLiquidatable` upstream, so they are asserted only for their reason, not their trace.
  it.each([
    ['no_debt', { hasDebt: false }],
    ['locked', { locked: true }],
    ['healthy_pre_maturity', { healthy: true }]
  ] as const)('reports %s without a trace (decided before any arithmetic)', (reason, overrides) => {
    const outcome = planWithReason(baseInput(overrides))
    expect(outcome).toEqual({ kind: 'skip', reason })
  })

  it('reports seize_rounds_to_zero with the full cap-stage trace', () => {
    // Post-maturity dust: a 1-wei cap against a 10x-priced slot floors the seize to zero.
    const outcome = planWithReason(
      baseInput({
        blockTimestamp: 3000n,
        healthy: true,
        debt: 1n,
        badDebt: 0n,
        bestCollateralAmt: 1n * WAD,
        bestCollateralPrice: ORACLE_PRICE_SCALE * 10n
      })
    )
    expect(outcome).toEqual({
      kind: 'skip',
      reason: 'seize_rounds_to_zero',
      trace: {
        postMaturityMode: true,
        lif: 1010074841681059297n,
        effectiveDebt: 1n,
        cap: 1n,
        capEff: 1n,
        seizedAssets: 0n
      }
    })
  })

  it('reports capEff 0 when the margin alone eats a 1-wei cap', () => {
    const outcome = planWithReason(
      baseInput({
        blockTimestamp: 3000n,
        healthy: true,
        debt: 1n,
        badDebt: 0n,
        bestCollateralAmt: 1n * WAD,
        bestCollateralPrice: ORACLE_PRICE_SCALE * 10n
      }),
      { seizeCapMarginBps: 30 }
    )
    expect(outcome.kind).toBe('skip')
    expect(outcome).toMatchObject({
      reason: 'seize_rounds_to_zero',
      trace: { cap: 1n, capEff: 0n, seizedAssets: 0n }
    })
  })

  it('caps a post-maturity seize at the post-writeoff debt, not the gross debt', () => {
    // `badDebt` is written off before the repay, so the cap is `debt - badDebt`. Sizing against the
    // gross debt would over-repay and revert on-chain (Panic 0x11). Asserted by equivalence rather
    // than a literal, so the test does not re-derive the sizing arithmetic it is checking.
    const post = {
      blockTimestamp: 3000n,
      maturity: 2000n,
      healthy: true,
      bestCollateralAmt: 1000n * WAD
    }
    const withWriteoff = plan(baseInput({ ...post, debt: 1000n * WAD, badDebt: 400n * WAD }))
    const equivalent = plan(baseInput({ ...post, debt: 600n * WAD, badDebt: 0n }))
    const grossDebt = plan(baseInput({ ...post, debt: 1000n * WAD, badDebt: 0n }))
    expect(withWriteoff).toEqual(equivalent)
    expect(withWriteoff).not.toEqual(grossDebt)
  })

  it('reports nothing_to_seize for an empty best slot, omitting the cap stage', () => {
    const outcome = planWithReason(baseInput({ bestCollateralAmt: 0n }))
    expect(outcome).toEqual({
      kind: 'skip',
      reason: 'nothing_to_seize',
      trace: {
        postMaturityMode: false,
        lif: MAX_LIF,
        effectiveDebt: 1000n * WAD,
        seizedAssets: 0n
      }
    })
  })

  it('reports cap_not_positive — and no longer returns a NEGATIVE-seize plan', () => {
    // `debt - maxDebt < badDebt < debt` makes the RCF numerator negative, so maxRepaid, the cap and
    // the derived seize all go negative. Before the `<= 0n` guard this returned a plan whose
    // `seizedAssets` was negative, which reverts opaquely once abi-encoded as uint256.
    const input = baseInput({
      debt: 1000n,
      badDebt: 500n,
      maxDebt: 900n,
      rcfThreshold: 0n, // not rcf-exempt, so the negative cap actually binds
      bestCollateralAmt: 5000n,
      bestCollateralPrice: ORACLE_PRICE_SCALE,
      bestCollateralMaxLif: 1100000000000000000n
    })
    const outcome = planWithReason(input)
    expect(outcome).toMatchObject({ kind: 'skip', reason: 'cap_not_positive' })
    expect(outcome.kind === 'skip' && outcome.trace?.cap).toBe(-7406n)
    expect(outcome.kind === 'skip' && outcome.trace?.seizedAssets).toBe(-8146n)
    expect(plan(input)).toBeNull()
  })

  it('omits maxRepaid and flags rcfDisabled when lltv waives the cap', () => {
    const outcome = planWithReason(
      baseInput({ bestCollateralLltv: WAD, bestCollateralAmt: 0n, bestCollateralMaxLif: WAD })
    )
    // Reached via nothing_to_seize, so only the mode fields are present — the point is that a
    // maxUint256 maxRepaid is never logged as if it were a real bound.
    expect(outcome.kind === 'skip' && outcome.trace).not.toHaveProperty('maxRepaid')
  })

  describe('plan() facade', () => {
    // Pins the facade to the implementation so a later edit to planWithReason cannot silently change
    // plan()'s contract (which the whole suite above still asserts through plan()).
    const cases: PlanInput[] = [
      baseInput(), // plans
      baseInput({ hasDebt: false }),
      baseInput({ locked: true }),
      baseInput({ healthy: true }),
      baseInput({ bestCollateralAmt: 0n }),
      baseInput({
        blockTimestamp: 3000n,
        healthy: true,
        debt: 1n,
        bestCollateralAmt: 1n * WAD,
        bestCollateralPrice: ORACLE_PRICE_SCALE * 10n
      })
    ]

    it.each(cases.map((input, i) => [i, input] as const))(
      'case %i returns the outcome plan, or null for a skip',
      (_i, input) => {
        const outcome = planWithReason(input)
        expect(plan(input)).toEqual(outcome.kind === 'plan' ? outcome.plan : null)
      }
    )
  })
})
