import { BPS, ORACLE_PRICE_SCALE, WAD } from '../constants'
import { lifAt } from './lif'
import { min, mulDivDown, mulDivUp } from './math'
import { isRcfExempt, maxRepaidNormalMode } from './rcf'

/**
 * Ceiling on the candidates a caller keeps per position. The tick spends one quote plus one simulation
 * per candidate it tries, so an unbounded list would let a single pathological position exhaust the
 * venue rate budget for every other position in the tick.
 *
 * **This is a real limit, not just a backstop, and the bot does NOT currently support the protocol's
 * full collateral range.** Midnight allows `MAX_COLLATERALS_PER_BORROWER` (16) activated slots per
 * borrower (midnight-contracts.txt:863), each sizeable in up to two modes — so a maximally diversified
 * position has 32 candidates and this keeps 4. Today's listed markets carry at most two collaterals,
 * which at two open modes is exactly 4, so nothing is dropped in practice; **a third listed collateral
 * would start silently truncating.** Raise this (and re-check the rate budget) before such a market
 * ships, or accept that only the top-ranked few are ever attempted.
 *
 * {@link planCandidates} deliberately does NOT apply it: truncating on the gross, oracle-only surplus
 * it ranks by can discard a candidate that wins once route cost is charged, and that decision is
 * irreversible downstream. The caller applies {@link capCandidates} to its own final ordering instead.
 */
export const MAX_PLAN_CANDIDATES_PER_POSITION = 4

/**
 * Ceiling on the candidates per position whose route is resolved and probed, applied to the GROSS
 * ordering before any cost is known.
 *
 * A separate, looser bound than {@link MAX_PLAN_CANDIDATES_PER_POSITION} because it bounds a different
 * cost: probe traffic, not quotes. Resolving a route costs a chain read and registers a pair, and each
 * distinct pair then costs a full indicative sweep (one call per ladder rung per venue) — so an
 * unbounded list would let one 16-slot position issue hundreds of indicative calls on a ~1 rps client.
 *
 * Twice the plan cap, because the point of costing above the cap is that route cost may REORDER
 * candidates: the priced set has to be a strict superset of what the cap keeps, or the reorder has
 * nothing to work with. Candidates past this bound are dropped rather than left uncosted, since an
 * uncosted candidate fails its whole position open to gross ordering (see `scoreNetOfRouteCost`).
 */
export const MAX_PROBED_CANDIDATES_PER_POSITION = 2 * MAX_PLAN_CANDIDATES_PER_POSITION

/**
 * One activated collateral slot, as sizing sees it. `index` is the MARKET-level index into
 * `market.collateralParams` — what `liquidate` takes — not a position in {@link PlanInput.collaterals}.
 *
 * `swapFree` is the one field the lens cannot supply: it compares the slot's token against the
 * market's loan token, which sizing deliberately does not know (it holds no addresses). The mapping
 * happens in `planInputFromLens`.
 */
export type CollateralSlot = {
  index: number
  amt: bigint
  /** Oracle price in ORACLE_PRICE_SCALE units. */
  price: bigint
  maxLif: bigint
  lltv: bigint
  /**
   * This slot's token IS the market's loan token, so seizing it needs no swap: no venue call and no
   * route risk, so no ROUTE cost for the incentive to cover. Gas is untouched by this and remains
   * material — bounding it needs an absolute floor (BOTS-81), not {@link PlanOptions.headroomFloorBps}.
   */
  swapFree: boolean
}

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
  /**
   * Every activated collateral slot, unranked (the lens emits them in descending market index).
   * Sizing plans each one independently; `maxDebt`/`badDebt` above are already summed across all of
   * them, exactly as `liquidate` computes them.
   */
  collaterals: readonly CollateralSlot[]
}

export type LiquidationPlan = {
  collateralIndex: number
  seizedAssets: bigint
  repaidUnits: bigint
  postMaturityMode: boolean
  /**
   * LIF this plan was sized at — {@link lifAt} for `postMaturityMode` at `input.blockTimestamp`.
   * Surfaced rather than recomputed because a matured-and-unhealthy slot yields a plan in BOTH modes
   * at the same instant, so chain time alone does not identify which LIF any one of them used.
   */
  lif: bigint
  /**
   * The repay the contract will ceil-derive for `seizedAssets` at {@link LiquidationPlan.lif} — i.e.
   * the swap's break-even output in loan units. `repaidUnits` stays `0n` (seize-exact); this is what
   * the chain computes from it.
   */
  impliedRepaidUnits: bigint
  /**
   * Oracle price of the seized slot, in ORACLE_PRICE_SCALE units. Carried so consumers valuing this
   * plan's seize need only the plan — with several slots per position, a price read off the lens
   * output would have to be re-matched to `collateralIndex` at every call site.
   */
  oraclePrice: bigint
  /** {@link CollateralSlot.swapFree} for the seized slot. */
  swapFree: boolean
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
 * - `nothing_to_seize`: the slot holds no collateral, so a whole-slot seize would build a `(0, 0)`
 *   plan that {@link isBadDebtRealization} would misclassify as a write-off against a still-solvent
 *   position. Also reported when the position has no activated slots at all.
 * - `seize_rounds_to_zero`: a cap-binding seize rounded down to zero collateral.
 * - `insufficient_headroom`: the plan's incentive headroom is below
 *   {@link PlanOptions.headroomFloorBps}, so no swap route could fund the repay. Clears on its own as
 *   the post-maturity LIF ramps, which is why a skip must not record backoff (see {@link PlanOutcome}).
 *   Never reported for a swap-free plan, which pays no route cost — see {@link gateOnHeadroom}.
 *
 * These are **per candidate**, not per position: one slot can skip while another sizes, and a
 * matured-and-unhealthy slot can have one of its two modes gated while the other proceeds. A reason
 * therefore describes a `(slot, mode)` candidate — see {@link PlanSkip.collateralIndex}.
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
  | { plan: LiquidationPlan; reason?: undefined; headroom?: undefined }
  | { plan: null; reason: PlanSkipReason; headroom?: SkippedHeadroom }

/**
 * The numbers behind an `insufficient_headroom` skip. Carried on the outcome because the gate holds the
 * rejected plan, and a caller cannot reconstruct these afterwards: a matured-and-unhealthy slot is
 * sized in BOTH modes and each is gated separately, so neither `maxLif` nor chain time identifies
 * which LIF this particular rejection applied.
 */
type SkippedHeadroom = { bps: bigint; lif: bigint; postMaturityMode: boolean }

/**
 * One candidate {@link planCandidates} could not size, with the slot it belongs to. `collateralIndex`
 * is what makes a reported skip attributable: a position can emit several, and a reason alone does not
 * say which slot produced it. `0` when the position has no activated slot at all — the same
 * stand-in index a write-off uses, and equally inert.
 */
type PlanSkip = {
  reason: PlanSkipReason
  collateralIndex: number
  headroom?: SkippedHeadroom
}

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
   * a pure time gate, suppressing until `headroom(t) >= floor`. `0` disables the gate. It never
   * applies to a swap-free plan, which has no route to pay for — see {@link gateOnHeadroom}.
   */
  headroomFloorBps?: number
}

const skip = (reason: PlanSkipReason, headroom?: SkippedHeadroom): PlanOutcome => ({
  plan: null,
  reason,
  headroom
})
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

// Assembles a seize-exact plan with the derived fields downstream consumers would otherwise
// recompute: the LIF it was sized at, the repay the chain will derive from it, and the slot's price
// and swap-free flag (so the plan alone identifies what is being sold and at what price).
const buildPlan = (args: {
  slot: CollateralSlot
  seizedAssets: bigint
  lif: bigint
  postMaturityMode: boolean
}): LiquidationPlan => ({
  collateralIndex: args.slot.index,
  seizedAssets: args.seizedAssets,
  repaidUnits: 0n,
  postMaturityMode: args.postMaturityMode,
  lif: args.lif,
  impliedRepaidUnits: impliedRepaidUnits(args.seizedAssets, args.slot.price, args.lif),
  oraclePrice: args.slot.price,
  swapFree: args.slot.swapFree
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
const capBoundPlan = (args: {
  slot: CollateralSlot
  cap: bigint
  lif: bigint
  marginBps: number
  postMaturityMode: boolean
}): PlanOutcome => {
  const { slot, cap, lif, marginBps, postMaturityMode } = args
  const capEff = mulDivDown(cap, BPS - BigInt(marginBps), BPS)
  const seizedAssets = maxSeizeForCap(capEff, slot.price, lif)
  if (seizedAssets === 0n) return skip('seize_rounds_to_zero')
  return sized(buildPlan({ slot, seizedAssets, lif, postMaturityMode }))
}

// The whole-slot seize-exact plan in the given mode (the no-cap-binding case for both modes).
const wholeSlotPlan = (
  slot: CollateralSlot,
  lif: bigint,
  postMaturityMode: boolean
): LiquidationPlan => buildPlan({ slot, seizedAssets: slot.amt, lif, postMaturityMode })

// Normal-mode sizing (gated on-chain by `debt > maxDebt`, before or after maturity alike): LIF is the
// slot's full `maxLif` immediately. The contract subtracts `repaidUnits` from the post-writeoff debt
// with no clamp, so an implied repay above it reverts (Panic 0x11). The repay is bounded by the RCF
// cap (waived when the slot is rcf-exempt) AND never exceeds that debt. Seize the whole slot only when
// its implied repaid units fit within the bound; otherwise seize the largest amount whose
// contract-derived repaid stays within it.
const normalModePlan = (input: PlanInput, slot: CollateralSlot, marginBps: number): PlanOutcome => {
  const lif = lifAt({
    now: input.blockTimestamp,
    maturity: input.maturity,
    maxLif: slot.maxLif,
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
    lltv: slot.lltv
  })
  const wholeSlotRepaid = impliedRepaidUnits(slot.amt, slot.price, lif)
  const exempt = isRcfExempt({
    collateralAmt: slot.amt,
    price: slot.price,
    lif,
    maxRepaid,
    rcfThreshold: input.rcfThreshold
  })
  const repayCap = exempt ? effectiveDebt : min(maxRepaid, effectiveDebt)
  if (repayCap <= 0n) return skip('cap_not_positive')

  if (wholeSlotRepaid <= repayCap) return sized(wholeSlotPlan(slot, lif, false))
  return capBoundPlan({ slot, cap: repayCap, lif, marginBps, postMaturityMode: false })
}

// Post-maturity-mode sizing (gated on-chain by `blockTimestamp > maturity`): LIF ramps WAD → maxLif
// over TIME_TO_MAX_LIF and the RCF cap does not apply, but the contract still subtracts `repaidUnits`
// from the (post-writeoff) debt with no clamp, so over-repaying reverts (Panic 0x11 underflow).
// Seizing the whole slot is correct only while its implied repaid units fit within the debt — the
// underwater case. When the slot is worth more than the debt (the common case: a solvent borrower who
// simply missed maturity), seize the largest amount whose contract-derived repaid stays within that
// debt. `badDebt` is written off before the repay, so the cap is the post-writeoff debt.
const postMaturityPlan = (
  input: PlanInput,
  slot: CollateralSlot,
  marginBps: number
): PlanOutcome => {
  const lif = lifAt({
    now: input.blockTimestamp,
    maturity: input.maturity,
    maxLif: slot.maxLif,
    postMaturityMode: true
  })
  const effectiveDebt = input.debt - input.badDebt
  const wholeSlotRepaid = impliedRepaidUnits(slot.amt, slot.price, lif)
  if (wholeSlotRepaid <= effectiveDebt) return sized(wholeSlotPlan(slot, lif, true))
  return capBoundPlan({ slot, cap: effectiveDebt, lif, marginBps, postMaturityMode: true })
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
export const planSurplus = (chosen: LiquidationPlan): bigint =>
  seizedValueOf(chosen.seizedAssets, chosen.oraclePrice) - chosen.impliedRepaidUnits

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
 * Stand-in slot for a write-off against a position with no activated collateral left. Every field is
 * inert: the plan seizes nothing, so `liquidate` skips the block that would read `price`/`maxLif`, and
 * `index: 0` is the only index guaranteed to exist (a market's `collateralParams` is never empty).
 * `maxLif: WAD` keeps {@link lifAt} at exactly WAD rather than dividing by zero.
 */
const WRITE_OFF_SLOT: CollateralSlot = {
  index: 0,
  amt: 0n,
  price: 0n,
  maxLif: WAD,
  lltv: 0n,
  swapFree: false
}

// Best-first: larger surplus wins; on an exact tie post-maturity wins, because its `now > maturity`
// gate cannot close between read and exec while normal mode's `unhealthy` can. Written out rather than
// leaning on sort stability, which would make the tie-break depend on construction order.
const bySurplusThenPostMaturity = (a: LiquidationPlan, b: LiquidationPlan): number => {
  const surplusA = planSurplus(a)
  const surplusB = planSurplus(b)
  if (surplusA !== surplusB) return surplusA > surplusB ? -1 : 1
  if (a.postMaturityMode === b.postMaturityMode) return 0
  return a.postMaturityMode ? -1 : 1
}

/**
 * Truncates ONE position's ranked candidate list to `limit`, keeping the best swap-free candidate even
 * when the ranking alone would have dropped it — a swap-free candidate is the only kind guaranteed to
 * be fundable, so it is the last one worth discarding.
 *
 * The caller's ranking decides what survives, so this must be applied to the FINAL ordering (net of
 * route cost, not the gross surplus {@link planCandidates} ranks by) and to one position's
 * alternatives, never across a batch spanning several positions.
 *
 * Generic over the candidate so it can cap a plan list or a tick-enriched one; non-mutating.
 */
export const capCandidates = <T>(
  ranked: readonly T[],
  isSwapFree: (candidate: T) => boolean,
  limit: number
): T[] => {
  if (ranked.length <= limit) return [...ranked]
  const kept = ranked.slice(0, limit)
  if (kept.some(isSwapFree)) return kept
  const swapFree = ranked.find(isSwapFree)
  if (swapFree) kept[kept.length - 1] = swapFree
  return kept
}

/**
 * The single best plan for a position, or a {@link PlanSkipReason} when none could be sized — the
 * highest-surplus entry of {@link planCandidates}, which callers that can only act on one plan should
 * use. A caller able to fall through alternatives wants `planCandidates` instead.
 *
 * Mirrors the mode and amount policy of `liquidate(...)`, applied per activated slot:
 *
 * - past maturity & healthy → post-maturity mode (the only open gate): no RCF cap; seize 100% of the
 *   slot if its implied repaid units fit within the (post-writeoff) debt, else seize the largest
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
  const { plans, skips } = planCandidates(input, options)
  const best = plans[0]
  if (best) return sized(best)
  // Report the first candidate's reason. With one activated slot in one open mode — every market the
  // bot saw before multi-collateral, and still the common case — that is the only reason there is.
  const first = skips[0]
  return first ? skip(first.reason, first.headroom) : skip('nothing_to_seize')
}

/**
 * The candidate list behind {@link planWithReason}: every `(slot, mode)` this position could be
 * liquidated through, **ranked best-first by {@link planSurplus}**, plus the per-slot reasons for the
 * ones that could not be sized.
 *
 * **The entries are alternatives, not a batch.** One `liquidate` call seizes from exactly one slot, so
 * a caller works down the list and stops at the first candidate that quotes and simulates — the point
 * being that a slot needing a venue can fail transiently while a swap-free slot on the same position
 * cannot. Submitting two of them would be two liquidations of one position.
 *
 * Ordering is surplus-descending, then post-maturity first on a tie (whose gate cannot close between
 * read and exec, unlike normal mode's). Surplus is oracle-only and gross of execution cost, so it
 * systematically flatters a slot that needs a swap: a cbBTC slot at ~420 bps outranks a loan-token
 * slot at ~60 bps even though only the latter is certain to execute.
 *
 * **The list is UNCAPPED**, because this ordering is not the one to truncate on: route cost is
 * frequently the deciding term rather than a tiebreaker, so a caller that can price it must re-rank
 * before applying {@link MAX_PLAN_CANDIDATES_PER_POSITION} through {@link capCandidates}. The bound on
 * a position's candidate count is the protocol's `MAX_COLLATERALS_PER_BORROWER` times two modes.
 *
 * A matured-and-unhealthy slot contributes **two** entries, one per open on-chain gate — see
 * {@link openModePlans} for why the loser is kept rather than discarded.
 *
 * A single-element list is returned for a full write-off (`badDebt >= debt`), which seizes nothing and
 * therefore has no slot to choose. Side-effect free.
 */
export const planCandidates = (
  input: PlanInput,
  options: PlanOptions = {}
): { plans: LiquidationPlan[]; skips: PlanSkip[] } => {
  const { seizeCapMarginBps = 0, headroomFloorBps = 0 } = options
  // The position-level guards below reject before any slot is examined, so they carry the inert
  // stand-in index rather than a real one.
  const none = (reason: PlanSkipReason) => ({
    plans: [],
    skips: [{ reason, collateralIndex: 0 }]
  })

  if (!input.hasDebt) return none('no_debt')
  if (input.locked) return none('locked')

  const matured = input.blockTimestamp > input.maturity
  if (!matured && input.healthy) return none('healthy_pre_maturity')

  // Bad-debt realization: a pure write-off. No assets move and no swap funds it, so the headroom gate
  // must not see it — hence the early return rather than a `(0, 0)` plan falling through. It seizes
  // from no slot, so `collateralIndex` is inert on-chain: `liquidate` skips its whole sizing block for
  // a `(0, 0)` call (midnight-contracts.txt:1847) and only reads the index to pick a price it then
  // never uses. Slot 0 stands in when the position has no activated collateral left at all.
  if (input.badDebt >= input.debt) {
    const slot = input.collaterals[0] ?? WRITE_OFF_SLOT
    return {
      plans: [
        buildPlan({
          slot,
          seizedAssets: 0n,
          lif: lifAt({
            now: input.blockTimestamp,
            maturity: input.maturity,
            maxLif: slot.maxLif,
            postMaturityMode: matured
          }),
          postMaturityMode: matured
        })
      ],
      skips: []
    }
  }

  const plans: LiquidationPlan[] = []
  const skips: PlanSkip[] = []
  for (const slot of input.collaterals) {
    // Every plan below here seizes collateral, so an empty slot cannot produce one: a whole-slot
    // seize of nothing is the `(0, 0)` shape reserved for bad-debt realization.
    if (slot.amt === 0n) {
      skips.push({ reason: 'nothing_to_seize', collateralIndex: slot.index })
      continue
    }
    for (const mode of openModePlans(input, slot, seizeCapMarginBps)) {
      const outcome = gateOnHeadroom(mode, headroomFloorBps)
      if (outcome.plan === null) {
        skips.push({
          reason: outcome.reason,
          collateralIndex: slot.index,
          headroom: outcome.headroom
        })
      } else plans.push(outcome.plan)
    }
  }
  if (plans.length === 0 && skips.length === 0) {
    skips.push({ reason: 'nothing_to_seize', collateralIndex: 0 })
  }

  return { plans: plans.toSorted(bySurplusThenPostMaturity), skips }
}

/**
 * Every mode whose on-chain gate is open for this slot — the mode policy of `liquidate(...)`, see
 * {@link planWithReason}'s JSDoc. One outcome pre-maturity or post-maturity-and-healthy; **two** when
 * the position is matured AND unhealthy, because the contract opens both gates and the caller picks.
 *
 * Both are returned rather than the higher-surplus one, because they are not interchangeable at exec
 * time: normal mode's gate (`debt > maxDebt`) can close between read and broadcast if the price
 * recovers, and post-maturity's (`now > maturity`) cannot. Keeping both lets the tick fall through to
 * the surviving mode in the same tick instead of forfeiting the position — the same reason it keeps
 * several slots. Ranking still prefers the higher-surplus one; this only stops the other being
 * discarded before it can be a fallback.
 *
 * Each is gated on headroom INDEPENDENTLY by the caller, which is what makes returning both safe: a
 * post-maturity plan still early in its LIF ramp is rejected on its own merits without taking the
 * normal-mode plan — funded at the full `maxLif` from the first block — down with it.
 */
const openModePlans = (
  input: PlanInput,
  slot: CollateralSlot,
  seizeCapMarginBps: number
): PlanOutcome[] => {
  const matured = input.blockTimestamp > input.maturity
  if (!matured) return [normalModePlan(input, slot, seizeCapMarginBps)]

  const post = postMaturityPlan(input, slot, seizeCapMarginBps)
  if (input.healthy) return [post]
  return [normalModePlan(input, slot, seizeCapMarginBps), post]
}

/**
 * Rejects a sized plan whose incentive headroom cannot cover the operator's floor on execution cost.
 * Reads the CHOSEN plan's own `lif`, so it cannot disagree with the mode `selectMode` picked.
 *
 * **A swap-free plan is exempt**, because the floor bounds a cost it does not pay: there is no route,
 * so no route can be too expensive. The exemption is not a rounding concession — it decides whether
 * these positions are liquidated at all in the window that matters. A loan-as-collateral slot's LLTV
 * is 98% precisely so the incentive covers a liquidator's gas, which caps `maxLif` at ~1.006 and the
 * headroom at ~60 bps; against the default 3 bps floor the gate becomes a pure time gate suppressing
 * the first ~3 minutes past maturity. That is exactly the contested window an ascending-price
 * maturity auction is won in (see `rankByUsdSurplus`), so charging a swap-free plan for a swap would
 * forfeit the whole position.
 *
 * This exempts the ROUTE-cost floor only. Break-even still binds — the quoting layer's
 * `minAcceptableAmountOut` and `assessProfitability` both hold a swap-free plan to covering the repay
 * `liquidate` will pull — and an absolute dust floor (BOTS-81) will apply to it like any other plan.
 */
const gateOnHeadroom = (outcome: PlanOutcome, headroomFloorBps: number): PlanOutcome => {
  if (headroomFloorBps <= 0 || outcome.plan === null || outcome.plan.swapFree) return outcome
  const bps = headroomBps(outcome.plan)
  if (bps >= BigInt(headroomFloorBps)) return outcome
  return skip('insufficient_headroom', {
    bps,
    lif: outcome.plan.lif,
    postMaturityMode: outcome.plan.postMaturityMode
  })
}

/**
 * {@link planWithReason} projected to just the plan, for callers that do not report the skip reason.
 */
export const plan = (input: PlanInput, options: PlanOptions = {}): LiquidationPlan | null =>
  planWithReason(input, options).plan
