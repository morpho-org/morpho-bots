import { ORACLE_PRICE_SCALE, WAD } from '../constants'
import { lifAt } from './lif'
import { min, mulDivUp } from './math'
import { isRcfExempt, maxRepaidPreMaturity } from './rcf'

/**
 * The fresh, lens-derived inputs the sizing decision depends on. Field names mirror the lens
 * output; `blockTimestamp` is chain time (not host clock), so LIF and the `now > maturity` test
 * are evaluated against the same block the rest of the reading came from.
 */
export type PlanInput = {
  blockTimestamp: bigint
  maturity: bigint
  hasDebt: boolean
  locked: boolean
  /** `isHealthy`: `maxDebt >= debt` (so `!healthy` ⟺ `debt > maxDebt`). */
  healthy: boolean
  debt: bigint
  badDebt: bigint
  maxDebt: bigint
  /** Market-level `rcfThreshold`. */
  rcfThreshold: bigint
  /** Best (highest USD value) activated collateral slot, chosen by the lens. */
  bestCollateralIndex: number
  bestCollateralAmt: bigint
  /** Oracle price of the best slot, in ORACLE_PRICE_SCALE units. */
  bestCollateralPrice: bigint
  /** Per-collateral `maxLif` and `lltv` of the best slot. */
  bestCollateralMaxLif: bigint
  bestCollateralLltv: bigint
}

export type LiquidationPlan = {
  collateralIndex: number
  seizedAssets: bigint
  repaidUnits: bigint
  postMaturityMode: boolean
}

export function isBadDebtRealization(plan: LiquidationPlan): boolean {
  return plan.seizedAssets === 0n && plan.repaidUnits === 0n
}

// Repaid units the contract derives when the caller passes `seizedAssets` (midnight-contracts.txt:2369):
// two chained ceil-divisions, collateral → loan units → repaid units.
function impliedRepaidUnits(seizedAssets: bigint, price: bigint, lif: bigint): bigint {
  return mulDivUp(mulDivUp(seizedAssets, price, ORACLE_PRICE_SCALE), WAD, lif)
}

/**
 * Turns a fresh lens reading into a liquidation plan, or `null` when the position is not
 * liquidatable. Mirrors the mode and amount policy of `liquidate(...)`:
 *
 * - past maturity → post-maturity mode: no RCF cap; seize 100% of the best slot if its implied
 *   repaid units fit within the (post-writeoff) debt, else repay the full debt and let the contract
 *   derive the smaller seize (avoids over-repaying, which the contract reverts on);
 * - pre-maturity & unhealthy → normal mode: seize 100% of the slot when its implied repaid units
 *   fit within the repay bound — the RCF cap (waived when rcf-exempt) clamped to the post-writeoff
 *   debt — otherwise repay that bound and let the contract derive the smaller seize;
 * - otherwise (no debt, locked, or healthy-and-pre-maturity) → skip.
 *
 * The plan emits exactly one nonzero amount (`atMostOneNonZero`, :2314); the contract derives the
 * other side. An over-large `repaidUnits` fails closed in `simulate()`, never on-chain.
 */
export function plan(input: PlanInput): LiquidationPlan | null {
  if (!input.hasDebt || input.locked) return null

  const postMaturityMode = input.blockTimestamp > input.maturity
  if (!postMaturityMode && input.healthy) return null

  if (input.badDebt >= input.debt) {
    return {
      collateralIndex: input.bestCollateralIndex,
      seizedAssets: 0n,
      repaidUnits: 0n,
      postMaturityMode
    }
  }

  const lif = lifAt({
    now: input.blockTimestamp,
    maturity: input.maturity,
    maxLif: input.bestCollateralMaxLif,
    postMaturityMode
  })

  const seizeWholeSlot: LiquidationPlan = {
    collateralIndex: input.bestCollateralIndex,
    seizedAssets: input.bestCollateralAmt,
    repaidUnits: 0n,
    postMaturityMode
  }

  // Post-maturity mode: the RCF cap does not apply, but the contract still subtracts `repaidUnits`
  // from the (post-writeoff) debt with no clamp, so over-repaying reverts (Panic 0x11 underflow).
  // Seizing the whole slot is correct only while its implied repaid units fit within the debt — the
  // underwater case. When the slot is worth more than the debt (the common case: a solvent borrower
  // who simply missed maturity), repay the full debt instead and let the contract derive the smaller
  // seize at the LIF bonus. `badDebt` is written off before the repay, so the cap is the post-writeoff
  // debt (`debt - badDebt`).
  if (postMaturityMode) {
    const effectiveDebt = input.debt - input.badDebt
    const wholeSlotRepaid = impliedRepaidUnits(
      input.bestCollateralAmt,
      input.bestCollateralPrice,
      lif
    )
    if (wholeSlotRepaid <= effectiveDebt) return seizeWholeSlot
    return {
      collateralIndex: input.bestCollateralIndex,
      seizedAssets: 0n,
      repaidUnits: effectiveDebt,
      postMaturityMode
    }
  }

  // Normal mode: like post-maturity above, the contract subtracts `repaidUnits` from the
  // post-writeoff debt with no clamp, so an implied repay above it reverts (Panic 0x11). The repay is
  // bounded by the RCF cap (waived when the slot is rcf-exempt) AND never exceeds that debt. Seize
  // the whole slot only when its implied repaid units fit within the bound; otherwise repay the bound
  // exactly and let the contract derive the smaller seize.
  const effectiveDebt = input.debt - input.badDebt
  const maxRepaid = maxRepaidPreMaturity({
    debt: input.debt,
    badDebt: input.badDebt,
    maxDebt: input.maxDebt,
    lif,
    lltv: input.bestCollateralLltv
  })
  const wholeSlotRepaid = impliedRepaidUnits(
    input.bestCollateralAmt,
    input.bestCollateralPrice,
    lif
  )
  const exempt = isRcfExempt({
    collateralAmt: input.bestCollateralAmt,
    price: input.bestCollateralPrice,
    lif,
    maxRepaid,
    rcfThreshold: input.rcfThreshold
  })
  const repayCap = exempt ? effectiveDebt : min(maxRepaid, effectiveDebt)

  if (wholeSlotRepaid <= repayCap) return seizeWholeSlot
  return {
    collateralIndex: input.bestCollateralIndex,
    seizedAssets: 0n,
    repaidUnits: repayCap,
    postMaturityMode
  }
}
