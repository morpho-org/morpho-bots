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
  /**
   * LIF this plan was sized at — {@link lifAt} for `postMaturityMode` at `input.blockTimestamp`.
   * Surfaced rather than recomputed because it is NOT derivable from `postMaturityMode` alone: the
   * matured-and-unhealthy branch picks a mode by surplus, so only the chosen plan knows its own LIF.
   */
  lif: bigint
  /**
   * The repay the contract will ceil-derive for `seizedAssets` at {@link LiquidationPlan.lif} — i.e.
   * the swap's break-even output in loan units. `repaidUnits` stays `0n` (seize-exact); this is what
   * the chain computes from it.
   */
  impliedRepaidUnits: bigint
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
 * - `insufficient_headroom`: the chosen plan's incentive headroom is below
 *   {@link PlanOptions.headroomFloorBps}, so no swap route could fund the repay. Clears on its own as
 *   the post-maturity LIF ramps, which is why a skip must not record backoff (see {@link PlanOutcome}).
 */
export type PlanSkipReason =
  | 'no_debt'
  | 'locked'
  | 'healthy_pre_maturity'
  | 'cap_not_positive'
  | 'nothing_to_seize'
  | 'seize_rounds_to_zero'
  | 'insufficient_headroom'
  | 'writeoff_below_max_debt'

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
  /**
   * A **lower bound** on swap execution cost in bps — the cheapest route the operator would ever
   * expect — NOT a typical-cost estimate. A seize-exact plan's entire margin is `(lif - 1)/lif`, so a
   * plan whose headroom is under this floor cannot fund its own repay by any route and is skipped
   * before it costs a quote, a simulation and a gas estimate.
   *
   * Set it too high and the gate blinds the earliest, most contested part of a maturity: the floor is
   * a pure time gate, suppressing until `headroom(t) >= floor`. `0` disables the gate.
   */
  headroomFloorBps?: number
}

const skip = (reason: PlanSkipReason): PlanOutcome => ({ plan: null, reason })
const sized = (plan: LiquidationPlan): PlanOutcome => ({ plan })

/**
 * Whether `plan` is a pure bad-debt write-off: the contract realizes the loss and nothing is traded.
 *
 * A `(0, 0)` plan is the encoding — seizing no collateral for no repay. Callers must branch on this
 * before treating a plan as a swap-funded liquidation, since a write-off needs neither a quote nor
 * loan-token funding. Pure predicate: no failures, no side effects.
 *
 * Takes only the two amounts it reads, not a whole {@link LiquidationPlan}, so a caller holding
 * wire-verified params need not synthesize the plan's derived fields to ask the question.
 */
export const isBadDebtRealization = (
  plan: Pick<LiquidationPlan, 'seizedAssets' | 'repaidUnits'>
): boolean => plan.seizedAssets === 0n && plan.repaidUnits === 0n

/**
 * Repaid units the contract derives when the caller passes `seizedAssets`
 * (midnight-contracts.txt:2369): two chained ceil-divisions, collateral → loan units → repaid units.
 * Both round up, i.e. against the liquidator, so this is the swap's break-even output. Every sized
 * plan already carries its own value as {@link LiquidationPlan.impliedRepaidUnits}, so read that
 * rather than recomputing; export this only alongside a consumer that cannot.
 */
const impliedRepaidUnits = (seizedAssets: bigint, price: bigint, lif: bigint): bigint =>
  mulDivUp(mulDivUp(seizedAssets, price, ORACLE_PRICE_SCALE), WAD, lif)

/**
 * The seized slot's oracle value in loan units — `seizedAssets · price / ORACLE_PRICE_SCALE`. Floors,
 * so a dust position can value to zero; callers dividing by it must guard that.
 */
const seizedValueOf = (seizedAssets: bigint, price: bigint): bigint =>
  mulDivDown(seizedAssets, price, ORACLE_PRICE_SCALE)

// Assembles a seize-exact plan with the two derived fields downstream consumers would otherwise
// recompute: the LIF it was sized at and the repay the chain will derive from it.
const buildPlan = (args: {
  input: PlanInput
  seizedAssets: bigint
  lif: bigint
  postMaturityMode: boolean
}): LiquidationPlan => ({
  collateralIndex: args.input.bestCollateralIndex,
  seizedAssets: args.seizedAssets,
  repaidUnits: 0n,
  postMaturityMode: args.postMaturityMode,
  lif: args.lif,
  impliedRepaidUnits: impliedRepaidUnits(
    args.seizedAssets,
    args.input.bestCollateralPrice,
    args.lif
  )
})

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
  return sized(buildPlan({ input, seizedAssets, lif, postMaturityMode }))
}

// The whole-slot seize-exact plan in the given mode (the no-cap-binding case for both modes).
const wholeSlotPlan = (input: PlanInput, lif: bigint, postMaturityMode: boolean): LiquidationPlan =>
  buildPlan({ input, seizedAssets: input.bestCollateralAmt, lif, postMaturityMode })

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
  // The contract computes the RCF numerator `_position.debt - maxDebt` on the POST-writeoff debt and
  // UNCONDITIONALLY, before the rcfThreshold exemption inside the same `require` can waive the cap
  // (midnight-contracts.txt:1864). Normal mode is gated on the PRE-writeoff `originalDebt > maxDebt`
  // (:1826), so a write-off that pushes effective debt under `maxDebt` reaches that subtraction and
  // reverts with Panic 0x11 — however exempt the slot is. Its own comment ("debt >= maxDebt in this
  // branch") does not hold once a write-off has been applied.
  if (effectiveDebt < input.maxDebt) return skip('writeoff_below_max_debt')
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

  if (wholeSlotRepaid <= repayCap) return sized(wholeSlotPlan(input, lif, false))
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
  if (wholeSlotRepaid <= effectiveDebt) return sized(wholeSlotPlan(input, lif, true))
  return capBoundPlan(input, effectiveDebt, lif, marginBps, true)
}

// Expected surplus of a seize-exact plan, in loan units: the seized slot's oracle value minus the
// repay the contract will ceil-derive. Both terms are already on the plan, so this neither recomputes
// `lifAt` nor can disagree with the LIF the plan was sized at. Used to CHOOSE between two plans whose
// gates are both open; absolute profitability (gas, route quality) stays the quoting layer's job.
/**
 * Expected surplus of a sized plan, in loan units: the seized slot's oracle value minus the repay the
 * contract will ceil-derive for it. Reads the plan's own recorded `impliedRepaidUnits`, so it cannot
 * disagree with the LIF the plan was sized at.
 *
 * **Oracle-only, and a ranking key rather than a profitability measure.** It excludes DEX execution
 * cost and gas, and post-maturity `lif > WAD` makes it structurally positive for every candidate — so
 * a positive surplus does not mean a liquidation is worth attempting. Use it to order work, and leave
 * viability to the headroom floor and the quoting/simulate layer.
 */
export const planSurplus = (input: PlanInput, chosen: LiquidationPlan): bigint =>
  seizedValueOf(chosen.seizedAssets, input.bestCollateralPrice) - chosen.impliedRepaidUnits

/**
 * Incentive headroom of a sized plan, in bps: `(lif - 1) / lif`.
 *
 * Computed from the LIF, NOT from the plan's amounts. The amount-wise ratio
 * `(seizedValue - impliedRepaidUnits) / seizedValue` is the same quantity in exact arithmetic, but the
 * implementation cannot be: `seizedValueOf` floors while `impliedRepaidUnits` double-ceils, so at
 * sub-dollar sizes the two roundings disagree and the ratio is neither exact nor monotone in size —
 * 167 units reported 0 bps where 168 reported 59, at one LIF. Deriving from `lif` makes this
 * **exactly scale-invariant** by construction: no amount enters it, so two candidates at the same LIF
 * cannot disagree.
 *
 * Being a rate, it is blind to position size — it cannot reject dust, whose surplus is real but
 * smaller than the gas to collect it. That needs an absolute floor (BOTS-81), not this.
 */
const headroomBps = (chosen: LiquidationPlan): bigint => ((chosen.lif - WAD) * BPS) / chosen.lif

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
  const { seizeCapMarginBps = 0, headroomFloorBps = 0 } = options

  if (!input.hasDebt) return skip('no_debt')
  if (input.locked) return skip('locked')

  const matured = input.blockTimestamp > input.maturity
  if (!matured && input.healthy) return skip('healthy_pre_maturity')

  // Bad-debt realization: a pure write-off, no assets move and no swap funds it, so the headroom gate
  // below must not see it — hence the early return rather than a `(0, 0)` plan falling through.
  if (input.badDebt >= input.debt) {
    return sized(
      buildPlan({
        input,
        seizedAssets: 0n,
        lif: lifAt({
          now: input.blockTimestamp,
          maturity: input.maturity,
          maxLif: input.bestCollateralMaxLif,
          postMaturityMode: matured
        }),
        postMaturityMode: matured
      })
    )
  }

  // Below here every plan seizes collateral, so an empty best slot cannot produce one: a whole-slot
  // seize of nothing is the `(0, 0)` shape reserved for bad-debt realization.
  if (input.bestCollateralAmt === 0n) return skip('nothing_to_seize')

  return gateOnHeadroom(selectMode(input, seizeCapMarginBps), headroomFloorBps)
}

// The mode policy of `liquidate(...)` — see {@link planWithReason}'s JSDoc. Split out so the headroom
// gate is provably DOWNSTREAM of mode selection: normal mode pays the full `maxLif` with no ramp, so a
// gate reading a ramping post-maturity LIF would reject matured-and-unhealthy positions that normal
// mode funds immediately.
const selectMode = (input: PlanInput, seizeCapMarginBps: number): PlanOutcome => {
  const matured = input.blockTimestamp > input.maturity
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

// Rejects a sized plan whose incentive headroom cannot cover the operator's floor on execution cost.
// Reads the CHOSEN plan's own `lif`, so it cannot disagree with the mode `selectMode` picked.
const gateOnHeadroom = (outcome: PlanOutcome, headroomFloorBps: number): PlanOutcome => {
  if (headroomFloorBps <= 0 || outcome.plan === null) return outcome
  if (headroomBps(outcome.plan) >= BigInt(headroomFloorBps)) return outcome
  return skip('insufficient_headroom')
}

/**
 * {@link planWithReason} projected to just the plan, for callers that do not report the skip reason.
 */
export const plan = (input: PlanInput, options: PlanOptions = {}): LiquidationPlan | null =>
  planWithReason(input, options).plan
