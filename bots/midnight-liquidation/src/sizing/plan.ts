import { BPS, ORACLE_PRICE_SCALE, WAD } from '../constants'
import { lifAt } from './lif'
import { min, mulDivDown, mulDivUp } from './math'
import { isRcfExempt, maxRepaidNormalMode } from './rcf'

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

/**
 * Why sizing produced no plan. The first three negate {@link isLiquidatable}, so reaching them means
 * the caller planned a position the chain does not consider liquidatable — they read as live
 * assertions, not as ordinary outcomes. The last three are ordinary: a liquidatable position can
 * still be unsizeable.
 *
 * - `cap_not_positive`: the normal-mode repay cap came out at or below zero. Reachable whenever
 *   `debt - badDebt <= maxDebt` while `debt > maxDebt` still holds (e.g. debt 1000, maxDebt 900,
 *   badDebt 200), because {@link maxRepaidNormalMode} takes `effectiveDebt - maxDebt` as its
 *   numerator. Guarded rather than sized, since a negative cap propagates through
 *   {@link maxSeizeForCap} into a negative `seizedAssets`.
 * - `nothing_to_seize`: the best slot holds no collateral, so a whole-slot seize would build a
 *   `(0, 0)` plan that {@link isBadDebtRealization} would misclassify as a write-off against a
 *   still-solvent position.
 * - `seize_rounds_to_zero`: a cap-binding seize rounded down to zero collateral.
 */
export type PlanSkipReason =
  | 'no_debt'
  | 'locked'
  | 'healthy_pre_maturity'
  | 'cap_not_positive'
  | 'nothing_to_seize'
  | 'seize_rounds_to_zero'

/**
 * Sizing result: exactly one of `plan` / `reason` is set. A skip carries its reason so the caller can
 * report it (`plan.skipped`) instead of dropping the position silently.
 *
 * A skip is NOT a failure signal: callers must not record backoff or mark a cooldown on one. Several
 * reasons clear on their own as chain time advances (the post-maturity LIF ramp lifts the repay cap),
 * so suppressing a skipped position would delay re-evaluating it precisely when it becomes viable.
 */
type PlanOutcome =
  | { plan: LiquidationPlan; reason?: undefined }
  | { plan: null; reason: PlanSkipReason }

/**
 * Operator sizing knobs that are NOT lens-derived (so they live here, not on `PlanInput`). Sourced
 * from `config.quoting`.
 */
type PlanOptions = {
  /**
   * Headroom (in bps) shaved off the on-chain repay cap when sizing a cap-binding seize-exact plan.
   * A seize-exact plan pins `seizedAssets`, so the contract re-derives `repaidUnits` at exec-block
   * price/LIF; an oracle price increase between read and exec can lift that derived repaid above the
   * cap and revert (RCF check, normal mode; debt underflow, post-maturity). Sizing against
   * `cap·(1 - margin)` keeps headroom for ordinary one-block moves. `0` reproduces the unmargined cap.
   */
  seizeCapMarginBps?: number
}

const skip = (reason: PlanSkipReason): PlanOutcome => ({ plan: null, reason })
const sized = (plan: LiquidationPlan): PlanOutcome => ({ plan })

export const isBadDebtRealization = (plan: LiquidationPlan): boolean =>
  plan.seizedAssets === 0n && plan.repaidUnits === 0n

// Repaid units the contract derives when the caller passes `seizedAssets` (midnight-contracts.txt:2369):
// two chained ceil-divisions, collateral → loan units → repaid units.
const impliedRepaidUnits = (seizedAssets: bigint, price: bigint, lif: bigint): bigint =>
  mulDivUp(mulDivUp(seizedAssets, price, ORACLE_PRICE_SCALE), WAD, lif)

/**
 * The largest seize `S` whose contract-derived repaid (`impliedRepaidUnits(S, price, lif)`) stays
 * within `cap`. This is exactly the contract's own `repaidUnits → seizedAssets` derivation
 * (midnight-contracts.txt:2371): two chained floor-divisions, repaid units → loan units → collateral.
 *
 * It is provably the exact answer — no search or correction needed. Because both inner divisions
 * round down while `impliedRepaidUnits` rounds up against integer thresholds, the round-trip never
 * overshoots: `impliedRepaidUnits(maxSeizeForCap(cap, …)) <= cap` always holds, and the result is the
 * largest such seize (`impliedRepaidUnits(result + 1) > cap`).
 *
 * Callers must reject a non-positive `cap` before calling: a negative cap yields a negative seize
 * (see `cap_not_positive` in {@link PlanSkipReason}).
 */
export const maxSeizeForCap = (cap: bigint, price: bigint, lif: bigint): bigint => {
  if (cap === 0n || price === 0n) return 0n
  return mulDivDown(mulDivDown(cap, lif, WAD), ORACLE_PRICE_SCALE, price)
}

// Builds a cap-binding seize-exact plan: seize the largest amount whose contract-derived repaid stays
// within `cap`, after shaving `marginBps` off the cap for one-block drift headroom. Skips when that
// rounds to zero — never a `(0, 0)` plan, which `isBadDebtRealization` would misclassify as a
// bad-debt write-off against a solvent position.
const capBoundPlan = (
  input: PlanInput,
  cap: bigint,
  lif: bigint,
  marginBps: number,
  postMaturityMode: boolean
): PlanOutcome => {
  const capEff = mulDivDown(cap, BPS - BigInt(marginBps), BPS)
  const seizedAssets = maxSeizeForCap(capEff, input.bestCollateralPrice, lif)
  if (seizedAssets === 0n) return skip('seize_rounds_to_zero')
  return sized({
    collateralIndex: input.bestCollateralIndex,
    seizedAssets,
    repaidUnits: 0n,
    postMaturityMode
  })
}

// The whole-slot seize-exact plan in the given mode (the no-cap-binding case for both modes).
const wholeSlotPlan = (input: PlanInput, postMaturityMode: boolean): LiquidationPlan => ({
  collateralIndex: input.bestCollateralIndex,
  seizedAssets: input.bestCollateralAmt,
  repaidUnits: 0n,
  postMaturityMode
})

// Normal-mode sizing (gated on-chain by `debt > maxDebt`, before or after maturity alike): LIF is the
// slot's full `maxLif` immediately. The contract subtracts `repaidUnits` from the post-writeoff debt
// with no clamp, so an implied repay above it reverts (Panic 0x11). The repay is bounded by the RCF
// cap (waived when the slot is rcf-exempt) AND never exceeds that debt. Seize the whole slot only when
// its implied repaid units fit within the bound; otherwise seize the largest amount whose
// contract-derived repaid stays within it.
const normalModePlan = (input: PlanInput, marginBps: number): PlanOutcome => {
  const lif = lifAt({
    now: input.blockTimestamp,
    maturity: input.maturity,
    maxLif: input.bestCollateralMaxLif,
    postMaturityMode: false
  })
  const effectiveDebt = input.debt - input.badDebt
  const maxRepaid = maxRepaidNormalMode({
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
  if (repayCap <= 0n) return skip('cap_not_positive')

  if (wholeSlotRepaid <= repayCap) return sized(wholeSlotPlan(input, false))
  return capBoundPlan(input, repayCap, lif, marginBps, false)
}

// Post-maturity-mode sizing (gated on-chain by `blockTimestamp > maturity`): LIF ramps WAD → maxLif
// over TIME_TO_MAX_LIF and the RCF cap does not apply, but the contract still subtracts `repaidUnits`
// from the (post-writeoff) debt with no clamp, so over-repaying reverts (Panic 0x11 underflow).
// Seizing the whole slot is correct only while its implied repaid units fit within the debt — the
// underwater case. When the slot is worth more than the debt (the common case: a solvent borrower who
// simply missed maturity), seize the largest amount whose contract-derived repaid stays within that
// debt. `badDebt` is written off before the repay, so the cap is the post-writeoff debt.
const postMaturityPlan = (input: PlanInput, marginBps: number): PlanOutcome => {
  const lif = lifAt({
    now: input.blockTimestamp,
    maturity: input.maturity,
    maxLif: input.bestCollateralMaxLif,
    postMaturityMode: true
  })
  const effectiveDebt = input.debt - input.badDebt
  const wholeSlotRepaid = impliedRepaidUnits(
    input.bestCollateralAmt,
    input.bestCollateralPrice,
    lif
  )
  if (wholeSlotRepaid <= effectiveDebt) return sized(wholeSlotPlan(input, true))
  return capBoundPlan(input, effectiveDebt, lif, marginBps, true)
}

// Expected surplus of a seize-exact plan, in loan units: the seized slot's oracle value minus the
// repaid units the contract will ceil-derive under that plan's mode/LIF. Used only to CHOOSE between
// two plans whose gates are both open — absolute profitability (gas, slippage, route quality) stays
// the quoting/simulate layer's job.
const planSurplus = (input: PlanInput, chosen: LiquidationPlan): bigint => {
  const lif = lifAt({
    now: input.blockTimestamp,
    maturity: input.maturity,
    maxLif: input.bestCollateralMaxLif,
    postMaturityMode: chosen.postMaturityMode
  })
  const seizedValue = mulDivDown(chosen.seizedAssets, input.bestCollateralPrice, ORACLE_PRICE_SCALE)
  return seizedValue - impliedRepaidUnits(chosen.seizedAssets, input.bestCollateralPrice, lif)
}

/**
 * Turns a fresh lens reading into a liquidation plan, or a {@link PlanSkipReason} when the position
 * cannot be sized. Mirrors the mode and amount policy of `liquidate(...)`:
 *
 * - past maturity & healthy → post-maturity mode (the only open gate): no RCF cap; seize 100% of the
 *   best slot if its implied repaid units fit within the (post-writeoff) debt, else seize the largest
 *   amount whose contract-derived repaid stays within that debt;
 * - past maturity & unhealthy → BOTH gates are open ("After maturity, an unhealthy borrower's
 *   liquidator can choose between both modes" — midnight-contracts.txt, `liquidate`): build both
 *   plans and keep the higher-surplus one. Normal mode pays the full `maxLif` while the post-maturity
 *   LIF is still ramping WAD → maxLif, so it wins early in the ramp; once the ramp completes,
 *   post-maturity is at least as good (same LIF, no RCF cap) and wins the tie — its gate
 *   (`now > maturity`) cannot close between read and exec, while normal mode's (`unhealthy`) can if
 *   the price recovers;
 * - pre-maturity & unhealthy → normal mode: seize 100% of the slot when its implied repaid units
 *   fit within the repay bound — the RCF cap (waived when rcf-exempt) clamped to the post-writeoff
 *   debt — otherwise seize the largest amount whose contract-derived repaid stays within that bound;
 * - otherwise (no debt, locked, or healthy-and-pre-maturity) → skip.
 *
 * Every non-bad-debt plan is **seize-exact**: it pins `seizedAssets` (with `repaidUnits = 0`) and the
 * contract ceil-derives `repaidUnits` (:2369). Pinning the seize means the Executor holds exactly what
 * every venue (Uniswap or aggregator) sells, so there is no sell-side drift. Bad-debt realization is
 * the only `(0, 0)` plan. A cap-binding seize is sized against `cap·(1 - seizeCapMarginBps)` to keep
 * headroom for a one-block oracle move; any residual drift fails closed in `simulate()`, never on-chain.
 *
 * Side-effect free. Callers must not treat a skip as a failure — see {@link PlanOutcome}.
 */
export const planWithReason = (input: PlanInput, options: PlanOptions = {}): PlanOutcome => {
  const { seizeCapMarginBps = 0 } = options

  if (!input.hasDebt) return skip('no_debt')
  if (input.locked) return skip('locked')

  const matured = input.blockTimestamp > input.maturity
  if (!matured && input.healthy) return skip('healthy_pre_maturity')

  if (input.badDebt >= input.debt) {
    return sized({
      collateralIndex: input.bestCollateralIndex,
      seizedAssets: 0n,
      repaidUnits: 0n,
      postMaturityMode: matured
    })
  }

  // Below here every plan seizes collateral, so an empty best slot cannot produce one: a whole-slot
  // seize of nothing is the `(0, 0)` shape reserved for bad-debt realization.
  if (input.bestCollateralAmt === 0n) return skip('nothing_to_seize')

  if (!matured) return normalModePlan(input, seizeCapMarginBps)

  const post = postMaturityPlan(input, seizeCapMarginBps)
  if (input.healthy) return post

  // Matured AND unhealthy: both gates are open, so pick the higher-surplus mode; a tie resolves
  // toward post-maturity and a one-sided skip takes the plan that exists (see the JSDoc mode policy).
  const normal = normalModePlan(input, seizeCapMarginBps)
  if (post.plan === null) return normal.plan === null ? post : normal
  if (normal.plan === null) return post
  return planSurplus(input, normal.plan) > planSurplus(input, post.plan) ? normal : post
}

/**
 * {@link planWithReason} projected to just the plan, for callers that do not report the skip reason.
 */
export const plan = (input: PlanInput, options: PlanOptions = {}): LiquidationPlan | null =>
  planWithReason(input, options).plan
