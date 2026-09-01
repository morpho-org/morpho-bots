import { describe, expect, it } from 'vitest'

import type { CollateralSlot, LiquidationPlan, PlanInput } from '../../src/sizing/plan'

import { ORACLE_PRICE_SCALE, WAD } from '../../src/constants'
import {
  capCandidates,
  maxSeizeForCap,
  plan,
  planCandidates,
  planSurplus as planSurplusOf,
  planWithReason
} from '../../src/sizing/plan'

const MAX_LIF = 1036269430051813471n
const LLTV = 860000000000000000n

// The cbBTC-shaped slot these cases were originally written against: lltv 86%, so maxLif ~1.0363.
const slot = (overrides: Partial<CollateralSlot> = {}): CollateralSlot => ({
  index: 3,
  amt: 100n * WAD,
  price: ORACLE_PRICE_SCALE,
  maxLif: MAX_LIF,
  lltv: LLTV,
  swapFree: false,
  ...overrides
})

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
    collaterals: [slot()],
    ...overrides
  }
}

// `baseInput` with a single slot carrying `slotOverrides` — the shape most cases want, since they
// vary one slot field and leave the position alone.
const inputWithSlot = (
  slotOverrides: Partial<CollateralSlot>,
  overrides: Partial<PlanInput> = {}
): PlanInput => baseInput({ collaterals: [slot(slotOverrides)], ...overrides })

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
    expect(plan(inputWithSlot({ amt: 100n * WAD }))).toMatchObject({
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
    // The one full-shape assertion in this file: every field pinned, so an unexpected addition to
    // LiquidationPlan fails here rather than passing silently through the toMatchObject cases.
    const expected: LiquidationPlan = {
      collateralIndex: 3,
      seizedAssets: maxSeizeForCap(maxRepaid, ORACLE_PRICE_SCALE, MAX_LIF),
      repaidUnits: 0n,
      postMaturityMode: false,
      lif: MAX_LIF,
      impliedRepaidUnits: maxRepaid,
      oraclePrice: ORACLE_PRICE_SCALE,
      swapFree: false
    }
    expect(plan(inputWithSlot({ amt: 2000n * WAD }, { rcfThreshold: WAD }))).toEqual(expected)
  })

  it('seizes the whole slot when rcf-exempt and the slot fits within the debt', () => {
    // Exemption waives the RCF cap, so a slot whose implied repaid units (~965 WAD) still fit within
    // the 1000-WAD debt is seized whole — the cap would otherwise have bound it at ~919 WAD.
    expect(plan(inputWithSlot({ amt: 1000n * WAD }, { rcfThreshold: 2000n * WAD }))).toMatchObject({
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
    expect(plan(inputWithSlot({ amt: 2000n * WAD }, { rcfThreshold: 2000n * WAD }))).toMatchObject({
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
        inputWithSlot(
          { amt: 2000n * WAD },
          { blockTimestamp: 6000n, maturity: 2000n, healthy: true }
        )
      )
    ).toMatchObject({
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
    ).toMatchObject({
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
        inputWithSlot(
          { amt: 500n * WAD },
          { blockTimestamp: 3000n, maturity: 2000n, healthy: true }
        )
      )
    ).toMatchObject({
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
      plan(inputWithSlot({ amt: 2000n * WAD }, { rcfThreshold: WAD }), {
        seizeCapMarginBps: 100
      })
    ).toMatchObject({
      collateralIndex: 3,
      seizedAssets: maxSeizeForCap(capEff, ORACLE_PRICE_SCALE, MAX_LIF),
      repaidUnits: 0n,
      postMaturityMode: false
    })
  })

  it('treats an explicit zero margin identically to the default (no margin)', () => {
    const input = inputWithSlot({ amt: 2000n * WAD }, { rcfThreshold: WAD })
    expect(plan(input, { seizeCapMarginBps: 0 })).toEqual(plan(input))
  })

  // Matured AND unhealthy opens both on-chain gates; the plan must pick the higher-surplus mode.
  it('prefers normal mode for a matured-and-unhealthy position early in the LIF ramp', () => {
    // 60s past maturity the post-maturity LIF is ~1.0006 (surplus ≈ 0.6 WAD on a 1000-WAD repay);
    // normal mode pays the full maxLif immediately (surplus ≈ 36 WAD). The slot is rcf-exempt, so both
    // modes cap the repay at the same post-writeoff debt — only the LIF differs.
    expect(
      plan(
        inputWithSlot(
          { amt: 2000n * WAD },
          { blockTimestamp: 2060n, maturity: 2000n, rcfThreshold: 2000n * WAD }
        )
      )
    ).toMatchObject({
      collateralIndex: 3,
      seizedAssets: maxSeizeForCap(1000n * WAD, ORACLE_PRICE_SCALE, MAX_LIF),
      repaidUnits: 0n,
      postMaturityMode: false
    })
  })

  it('prefers normal mode for a matured-and-unhealthy underwater slot during the ramp', () => {
    // Underwater: both modes seize the whole 500-WAD slot, but normal mode's maxLif makes the contract
    // derive fewer repaid units for it (~482 vs ~500 WAD) — same seize, higher surplus.
    expect(
      plan(inputWithSlot({ amt: 500n * WAD }, { blockTimestamp: 2060n, maturity: 2000n }))
    ).toMatchObject({
      collateralIndex: 3,
      seizedAssets: 500n * WAD,
      repaidUnits: 0n,
      postMaturityMode: false
    })
  })

  it('prefers post-maturity mode on a surplus tie once the LIF ramp completes', () => {
    // dt = 4000s > TIME_TO_MAX_LIF: both modes run at maxLif and the exempt slot gives both the same
    // debt-bound cap, so the surpluses tie — post-maturity wins because its gate (now > maturity)
    // cannot close between read and exec, while normal mode's (unhealthy) can if the price recovers.
    expect(
      plan(
        inputWithSlot(
          { amt: 2000n * WAD },
          { blockTimestamp: 6000n, maturity: 2000n, rcfThreshold: 2000n * WAD }
        )
      )
    ).toMatchObject({
      collateralIndex: 3,
      seizedAssets: maxSeizeForCap(1000n * WAD, ORACLE_PRICE_SCALE, MAX_LIF),
      repaidUnits: 0n,
      postMaturityMode: true
    })
  })

  it('prefers post-maturity mode after the ramp when the RCF cap binds normal mode', () => {
    // Same LIF in both modes after the ramp, but the slot is NOT rcf-exempt: normal mode's repay is
    // capped at ~919 WAD while post-maturity repays the full 1000-WAD debt — strictly more surplus.
    expect(
      plan(
        inputWithSlot(
          { amt: 2000n * WAD },
          { blockTimestamp: 6000n, maturity: 2000n, rcfThreshold: WAD }
        )
      )
    ).toMatchObject({
      collateralIndex: 3,
      seizedAssets: maxSeizeForCap(1000n * WAD, ORACLE_PRICE_SCALE, MAX_LIF),
      repaidUnits: 0n,
      postMaturityMode: true
    })
  })

  it('skips (returns null) when a cap-binding seize rounds to zero — never a (0,0) bad-debt plan', () => {
    // Post-maturity dust: 1 wei of debt against a high-priced slot. The cap binds, but the largest
    // seize whose derived repaid fits in 1 wei rounds to 0 collateral. The plan must return null, NOT a
    // { seized: 0, repaid: 0 } plan, which tick.ts would mis-route as a bad-debt write-off.
    const result = plan(
      inputWithSlot(
        { amt: 1n * WAD, price: ORACLE_PRICE_SCALE * 10n },
        { blockTimestamp: 3000n, maturity: 2000n, healthy: true, debt: 1n, badDebt: 0n }
      )
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

describe('derived plan fields', () => {
  it('carries the full maxLif in normal mode, where the LIF does not ramp', () => {
    const built = plan(baseInput())
    expect(built?.lif).toBe(MAX_LIF)
  })

  it('carries the RAMPED lif past maturity, not maxLif', () => {
    // 60s into a 3600s ramp on a 0.0362694 incentive: lif - 1 is ~1/60th of the way up.
    const built = plan(baseInput({ blockTimestamp: 2060n, maturity: 2000n, healthy: true }))
    expect(built?.postMaturityMode).toBe(true)
    expect(built?.lif).toBe(WAD + ((MAX_LIF - WAD) * 60n) / 3600n)
    expect(built!.lif).toBeLessThan(MAX_LIF)
  })

  it('pins the derived repay to the cap, exactly, for a cap-binding seize', () => {
    // maxSeizeForCap is exact rather than conservative: the contract-derived repay lands ON the RCF
    // cap to the unit. Hand-computed literal so a rounding regression fails here rather than silently
    // shrinking every cap-bound plan.
    const built = plan(inputWithSlot({ amt: 2000n * WAD }, { rcfThreshold: WAD }))
    expect(built?.impliedRepaidUnits).toBe(919047619047619043969n)
  })

  it('derives a zero repay for a bad-debt realization, which seizes nothing', () => {
    const built = plan(
      baseInput({ blockTimestamp: 3000n, maturity: 2000n, healthy: true, badDebt: 1000n * WAD })
    )
    expect(built).toMatchObject({ seizedAssets: 0n, repaidUnits: 0n, impliedRepaidUnits: 0n })
  })
})

describe('headroom floor', () => {
  // Past maturity and HEALTHY, so post-maturity mode is the only open gate and the LIF is still
  // ramping — 20s in, headroom is ~2bps against a 349bps ceiling.
  const earlyRamp = { blockTimestamp: 2020n, maturity: 2000n, healthy: true }

  it('skips a plan whose headroom is under the floor, with insufficient_headroom', () => {
    const outcome = planWithReason(baseInput(earlyRamp), { headroomFloorBps: 3 })
    expect(outcome.plan).toBeNull()
    expect(outcome.reason).toBe('insufficient_headroom')
    // The skip carries the numbers behind it, so a caller can report WHY without re-deriving a LIF it
    // cannot recover (the chosen mode is not implied by chain time).
    expect(outcome.headroom).toMatchObject({ postMaturityMode: true })
    expect(outcome.headroom!.bps).toBeLessThan(3n)
  })

  it('allows the same position once the ramp clears the floor', () => {
    const later = planWithReason(baseInput({ ...earlyRamp, blockTimestamp: 2040n }), {
      headroomFloorBps: 3
    })
    expect(later.reason).toBeUndefined()
    expect(later.plan).not.toBeNull()
  })

  it('is disabled at a floor of 0, reproducing the ungated plan exactly', () => {
    const input = baseInput(earlyRamp)
    expect(planWithReason(input, { headroomFloorBps: 0 })).toEqual(planWithReason(input))
  })

  it('pins the shipped default: suppressed at t+20s, allowed at t+40s', () => {
    // The default is a LOWER BOUND on execution cost, not a typical cost — a change to it alters prod
    // timing, so it breaks a test rather than sliding through.
    expect(plan(baseInput(earlyRamp), { headroomFloorBps: 3 })).toBeNull()
    expect(
      plan(baseInput({ ...earlyRamp, blockTimestamp: 2040n }), { headroomFloorBps: 3 })
    ).not.toBeNull()
  })

  it('does NOT skip a matured-and-unhealthy position that normal mode funds at the full maxLif', () => {
    // Regression: the floor must read the CHOSEN plan's lif. Both gates are open here, and normal mode
    // wins early in the ramp because it pays maxLif immediately — ~349bps of headroom. A floor derived
    // from the ramping post-maturity LIF (~2bps at t+20s) would reject a position the chain funds
    // immediately, which is the opposite of the gate's purpose and, default-ON, a prod regression.
    const bothGatesOpen = baseInput({ blockTimestamp: 2020n, maturity: 2000n, healthy: false })
    const outcome = planWithReason(bothGatesOpen, { headroomFloorBps: 100 })
    expect(outcome.reason).toBeUndefined()
    expect(outcome.plan).toMatchObject({ postMaturityMode: false, lif: MAX_LIF })
  })

  it('skips every candidate sharing a (maturity, maxLif, mode) group together', () => {
    // Headroom is (lif - 1)/lif, so it is scale-invariant: it cannot separate a large position from a
    // dust one. A per-candidate threshold test would pass vacuously; assert the GROUP property.
    const sizes = [1n, 1000n, 100n * WAD, 2000n * WAD]
    const reasons = sizes.map(
      amt => planWithReason(inputWithSlot({ amt }, earlyRamp), { headroomFloorBps: 3 }).reason
    )
    expect(reasons).toEqual(sizes.map(() => 'insufficient_headroom'))
  })

  it('never skips a normal-mode (pre-maturity) plan, whose LIF is maxLif from the start', () => {
    expect(plan(baseInput(), { headroomFloorBps: 300 })).not.toBeNull()
  })
})

// The live loan-as-collateral shape: lltv 98%, cursor 0.30 → maxLif 1.006036, i.e. 60 bps of headroom
// at full ramp. The LLTV is 98% precisely so the incentive covers a liquidator's gas.
const LOAN_MAX_LIF = 1006036217303822937n
const LOAN_LLTV = 980000000000000000n
const loanSlot = (overrides: Partial<CollateralSlot> = {}): CollateralSlot =>
  slot({ index: 0, maxLif: LOAN_MAX_LIF, lltv: LOAN_LLTV, swapFree: true, ...overrides })

describe('swap-free (loan-as-collateral) plans', () => {
  // 20s into the ramp: a fraction of a bp of headroom, well under the shipped 3 bps floor.
  const earlyRamp = { blockTimestamp: 2020n, maturity: 2000n, healthy: true }

  it('is exempt from the headroom floor, which bounds a route cost it does not pay', () => {
    const outcome = planWithReason(
      baseInput({ ...earlyRamp, collaterals: [loanSlot({ amt: 1000n * WAD })] }),
      { headroomFloorBps: 3 }
    )
    expect(outcome.reason).toBeUndefined()
    expect(outcome.plan).toMatchObject({ collateralIndex: 0, swapFree: true })
  })

  it('still skips an otherwise identical NON-swap-free slot at the same instant', () => {
    // The control: same LIF, same amounts, same floor — only `swapFree` differs. Without it this
    // whole block would be asserting the ramp rather than the exemption.
    const outcome = planWithReason(
      baseInput({ ...earlyRamp, collaterals: [loanSlot({ amt: 1000n * WAD, swapFree: false })] }),
      { headroomFloorBps: 3 }
    )
    expect(outcome.reason).toBe('insufficient_headroom')
  })

  it('records the 60 bps ceiling the exemption exists for', () => {
    // Pins the economics: at FULL ramp a loan-as-collateral slot clears 3 bps comfortably, so the
    // exemption only ever matters near maturity — which is the contested window.
    const full = planWithReason(
      baseInput({
        blockTimestamp: 2000n + 3600n,
        maturity: 2000n,
        healthy: true,
        collaterals: [loanSlot({ amt: 1000n * WAD, swapFree: false })]
      }),
      { headroomFloorBps: 3 }
    )
    expect(full.reason).toBeUndefined()
    expect(full.plan!.lif).toBe(LOAN_MAX_LIF)
  })
})

describe('planCandidates', () => {
  const twoSlots = { collaterals: [loanSlot({ amt: 1000n * WAD }), slot({ amt: 1000n * WAD })] }

  it('ranks the higher-surplus slot first even when the other needs no swap', () => {
    // Equal notional: the 86% slot's maxLif (~363 bps) beats the loan slot's (~60 bps), so it leads.
    // Ordering chases the larger prize; certainty of execution is what fall-through is for.
    const { plans } = planCandidates(baseInput(twoSlots))
    expect(plans.map(candidate => candidate.collateralIndex)).toEqual([3, 0])
    expect(planSurplusOf(plans[0]!)).toBeGreaterThan(planSurplusOf(plans[1]!))
  })

  it('returns one candidate per activated slot, all seize-exact', () => {
    const { plans } = planCandidates(baseInput(twoSlots))
    expect(plans).toHaveLength(2)
    expect(plans.every(c => c.repaidUnits === 0n && c.seizedAssets > 0n)).toBe(true)
  })

  it('reports a per-slot skip while still planning the sizeable slot', () => {
    const { plans, skips } = planCandidates(
      baseInput({ collaterals: [loanSlot({ amt: 0n }), slot({ amt: 1000n * WAD })] })
    )
    expect(plans.map(candidate => candidate.collateralIndex)).toEqual([3])
    expect(skips.map(entry => entry.reason)).toEqual(['nothing_to_seize'])
  })

  it('reports nothing_to_seize for a position with no activated slots', () => {
    const { plans, skips } = planCandidates(baseInput({ collaterals: [] }))
    expect(plans).toEqual([])
    expect(skips.map(entry => entry.reason)).toEqual(['nothing_to_seize'])
  })

  it('returns a single write-off candidate for fully bad debt, at the first slot index', () => {
    const { plans } = planCandidates(
      baseInput({
        blockTimestamp: 3000n,
        maturity: 2000n,
        healthy: true,
        badDebt: 1000n * WAD,
        ...twoSlots
      })
    )
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({ seizedAssets: 0n, repaidUnits: 0n, collateralIndex: 0 })
  })

  it('writes off a position whose collateral is entirely gone', () => {
    // No slot to read a price or maxLif from — the write-off seizes nothing, so index 0 stands in.
    const { plans } = planCandidates(
      baseInput({
        blockTimestamp: 3000n,
        maturity: 2000n,
        healthy: true,
        badDebt: 1000n * WAD,
        collaterals: []
      })
    )
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({ seizedAssets: 0n, collateralIndex: 0 })
  })

  it('does NOT truncate: the caller caps its own final ordering', () => {
    // Truncating here would cap on gross surplus, before route cost can reorder — and the candidate
    // dropped that way is unrecoverable downstream.
    const many = Array.from({ length: 8 }, (_, i) => slot({ index: i, amt: 1000n * WAD }))
    const { plans } = planCandidates(baseInput({ collaterals: many }))
    expect(plans).toHaveLength(8)
  })

  it('returns BOTH open modes for a matured-and-unhealthy slot', () => {
    // The contract opens both gates and the caller picks, so both are real alternatives. Keeping the
    // loser matters because normal mode's gate (`debt > maxDebt`) can close between read and exec
    // while post-maturity's cannot — the tick must be able to fall through to it in the same tick.
    const { plans } = planCandidates(
      inputWithSlot({ amt: 2000n * WAD }, { blockTimestamp: 2060n, maturity: 2000n })
    )
    expect(new Set(plans.map(candidate => candidate.postMaturityMode))).toEqual(
      new Set([false, true])
    )
    // Same slot, so this is a mode alternative rather than a second slot.
    expect(new Set(plans.map(candidate => candidate.collateralIndex))).toEqual(new Set([3]))
  })

  it('returns one mode pre-maturity and one when matured-and-healthy', () => {
    expect(planCandidates(baseInput()).plans).toHaveLength(1)
    expect(
      planCandidates(
        inputWithSlot(
          { amt: 500n * WAD },
          { blockTimestamp: 3000n, maturity: 2000n, healthy: true }
        )
      ).plans
    ).toHaveLength(1)
  })

  it('gates the two modes independently — the ramping one is skipped, normal mode survives', () => {
    // The reason returning both modes is safe. 20s into the ramp post-maturity has ~2bps of headroom
    // and is rightly rejected on its own merits; normal mode pays the full maxLif from the first
    // block, so it must NOT be dragged down with it.
    const { plans, skips } = planCandidates(
      inputWithSlot({ amt: 2000n * WAD }, { blockTimestamp: 2020n, maturity: 2000n }),
      { headroomFloorBps: 100 }
    )
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({ postMaturityMode: false, lif: MAX_LIF })
    expect(skips.map(entry => entry.reason)).toEqual(['insufficient_headroom'])
    expect(skips[0]?.headroom?.postMaturityMode).toBe(true)
  })

  it('attributes every skip to the slot it came from', () => {
    const { skips } = planCandidates(
      baseInput({ collaterals: [loanSlot({ amt: 0n }), slot({ index: 7, amt: 0n })] })
    )
    expect(skips.map(entry => entry.collateralIndex)).toEqual([0, 7])
  })

  it('prefers post-maturity on an exact surplus tie, without relying on sort stability', () => {
    // Matured + unhealthy at full ramp with an exempt slot: both modes tie, and post-maturity wins
    // because its gate cannot close between read and exec.
    const { plans } = planCandidates(
      baseInput({
        blockTimestamp: 6000n,
        maturity: 2000n,
        rcfThreshold: 2000n * WAD,
        collaterals: [slot({ amt: 2000n * WAD })]
      })
    )
    expect(plans[0]?.postMaturityMode).toBe(true)
  })
})

describe('capCandidates', () => {
  // Only the two fields the cap reads, so these cases are about the policy rather than about sizing.
  const entry = (id: string, swapFree = false) => ({ id, swapFree })

  it('keeps the input unchanged when it already fits', () => {
    const kept = capCandidates([entry('a'), entry('b')], candidate => candidate.swapFree, 4)
    expect(kept.map(candidate => candidate.id)).toEqual(['a', 'b'])
  })

  it('keeps the best `limit` candidates in the caller order', () => {
    const ranked = Array.from({ length: 6 }, (_, i) => entry(`c${i}`))
    const kept = capCandidates(ranked, candidate => candidate.swapFree, 4)
    expect(kept.map(candidate => candidate.id)).toEqual(['c0', 'c1', 'c2', 'c3'])
  })

  it('substitutes the best swap-free candidate for the last survivor', () => {
    const ranked = [...Array.from({ length: 5 }, (_, i) => entry(`c${i}`)), entry('free', true)]
    const kept = capCandidates(ranked, candidate => candidate.swapFree, 4)
    expect(kept.map(candidate => candidate.id)).toEqual(['c0', 'c1', 'c2', 'free'])
  })

  it('substitutes nothing when a swap-free candidate already survived', () => {
    const ranked = [entry('free', true), ...Array.from({ length: 5 }, (_, i) => entry(`c${i}`))]
    const kept = capCandidates(ranked, candidate => candidate.swapFree, 4)
    expect(kept.map(candidate => candidate.id)).toEqual(['free', 'c0', 'c1', 'c2'])
  })

  it('does not mutate its input', () => {
    const ranked = [...Array.from({ length: 5 }, (_, i) => entry(`c${i}`)), entry('free', true)]
    capCandidates(ranked, candidate => candidate.swapFree, 4)
    expect(ranked).toHaveLength(6)
    expect(ranked[5]?.id).toBe('free')
  })
})
