import { BPS, ORACLE_PRICE_SCALE, WAD } from '../constants'
import { lifAt } from './lif'
import { min, mulDivDown, mulDivUp } from './math'
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

/**
 * Why {@link planWithReason} produced no plan. Reasons discriminate SEVERITY (and hence log level);
 * the numbers on {@link SizingTrace} discriminate cause. That is why there is no `margin_ate_cap` or
 * `price_too_high` — those are one continuous arithmetic that `cap` vs `capEff` vs `seizedAssets`
 * pin exactly.
 *
 * `no_debt`, `locked` and `healthy_pre_maturity` are UNREACHABLE from the tick: `isLiquidatable`
 * tests the same lens fields `planWithReason` re-tests, and `!postMaturityMode && healthy` is the
 * exact negation of its third clause. A caller that observes one has diverged from the sizing
 * module, which is a correctness bug — hence they are logged at `warn`, as a live assertion.
 */
export type PlanSkipReason =
  | 'no_debt'
  | 'locked'
  | 'healthy_pre_maturity'
  /** Best slot holds nothing, and the position is not a full bad-debt write-off. */
  | 'nothing_to_seize'
  /** The repay cap is zero or negative — see the guard in {@link capBoundOutcome}. */
  | 'cap_not_positive'
  /** The expected dust case: a positive cap whose largest in-cap seize floors to zero collateral. */
  | 'seize_rounds_to_zero'

/**
 * Every value on the causal chain from a lens reading to a refused seize, so an operator can replay
 * the decision from one log line instead of re-deriving it. `maxRepaid`/`rcfExempt`/`rcfDisabled`
 * apply to normal mode only and are `undefined` post-maturity — the logger drops `undefined`, so a
 * post-maturity line self-describes its mode.
 */
type SizingTrace = {
  postMaturityMode: boolean
  lif: bigint
  /** `debt - badDebt`: the post-writeoff debt every cap is taken against. */
  effectiveDebt: bigint
  /** The seize that was refused — `0n`, or negative when the cap went negative. */
  seizedAssets: bigint
  /** The repay bound before `seizeCapMarginBps`. Absent when the cap stage never ran. */
  cap?: bigint
  /** `cap` after the margin — separates "the margin ate the cap" from "the division floored". */
  capEff?: bigint
  maxRepaid?: bigint
  rcfExempt?: boolean
  /** `true` when `lltv >= WAD` waives the RCF cap entirely (so `maxRepaid` is omitted, not huge). */
  rcfDisabled?: boolean
}

/** A plan, or the reason there is none plus the numbers that explain it. */
type PlanOutcome =
  | { kind: 'plan'; plan: LiquidationPlan }
  | { kind: 'skip'; reason: PlanSkipReason; trace?: SizingTrace }

/** Trace fields fixed once the mode is chosen, before the cap stage runs. */
type TraceBase = Omit<SizingTrace, 'cap' | 'capEff' | 'seizedAssets'>

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
 */
export const maxSeizeForCap = (cap: bigint, price: bigint, lif: bigint): bigint => {
  if (cap === 0n || price === 0n) return 0n
  return mulDivDown(mulDivDown(cap, lif, WAD), ORACLE_PRICE_SCALE, price)
}

/**
 * Sizes a cap-binding seize-exact plan: seize the largest amount whose contract-derived repaid stays
 * within `cap`, after shaving `marginBps` off the cap for one-block drift headroom.
 */
const capBoundOutcome = ({
  input,
  cap,
  marginBps,
  base
}: {
  input: PlanInput
  cap: bigint
  marginBps: number
  base: TraceBase
}): PlanOutcome => {
  const capEff = mulDivDown(cap, BPS - BigInt(marginBps), BPS)
  const seizedAssets = maxSeizeForCap(capEff, input.bestCollateralPrice, base.lif)
  const trace: SizingTrace = { ...base, cap, capEff, seizedAssets }
  // Discriminate on the RAW cap, not `capEff`: a legitimate 1-wei cap with any margin > 0 floors to
  // capEff 0, which is ordinary dust, not an impossible state. A non-positive RAW cap means the RCF
  // numerator went negative (`debt - maxDebt < badDebt < debt`), which breaks the module's invariant
  // AND would otherwise produce a NEGATIVE seize that slips past an `=== 0n` guard and reverts
  // opaquely when abi-encoded as uint256.
  if (cap <= 0n) return { kind: 'skip', reason: 'cap_not_positive', trace }
  // Rounds to nothing. Never emit a `(0, 0)` plan, which `isBadDebtRealization` would misclassify as
  // a bad-debt write-off against a solvent position. `<= 0n` rather than `=== 0n` is defense in
  // depth: a positive cap can only floor to a non-negative seize, so the negative case is already
  // caught by the guard above — this simply cannot be the branch that lets one through.
  if (seizedAssets <= 0n) return { kind: 'skip', reason: 'seize_rounds_to_zero', trace }
  return {
    kind: 'plan',
    plan: {
      collateralIndex: input.bestCollateralIndex,
      seizedAssets,
      repaidUnits: 0n,
      postMaturityMode: base.postMaturityMode
    }
  }
}

const seizeWholeSlot = (input: PlanInput, postMaturityMode: boolean): PlanOutcome => ({
  kind: 'plan',
  plan: {
    collateralIndex: input.bestCollateralIndex,
    seizedAssets: input.bestCollateralAmt,
    repaidUnits: 0n,
    postMaturityMode
  }
})

/**
 * Post-maturity mode: the RCF cap does not apply, but the contract still subtracts `repaidUnits`
 * from the (post-writeoff) debt with no clamp, so over-repaying reverts (Panic 0x11 underflow).
 * Seizing the whole slot is correct only while its implied repaid units fit within the debt — the
 * underwater case. When the slot is worth more than the debt (the common case: a solvent borrower
 * who simply missed maturity), seize the largest amount whose contract-derived repaid stays within
 * that debt. `badDebt` is written off before the repay, so the cap is `debt - badDebt`.
 */
const postMaturityOutcome = ({
  input,
  lif,
  marginBps
}: {
  input: PlanInput
  lif: bigint
  marginBps: number
}): PlanOutcome => {
  const effectiveDebt = input.debt - input.badDebt
  const base: TraceBase = { postMaturityMode: true, lif, effectiveDebt }
  const wholeSlotRepaid = impliedRepaidUnits(
    input.bestCollateralAmt,
    input.bestCollateralPrice,
    lif
  )
  if (wholeSlotRepaid <= effectiveDebt) return seizeWholeSlot(input, true)
  return capBoundOutcome({ input, cap: effectiveDebt, marginBps, base })
}

/**
 * Normal mode: like post-maturity, the contract subtracts `repaidUnits` from the post-writeoff debt
 * with no clamp, so an implied repay above it reverts (Panic 0x11). The repay is bounded by the RCF
 * cap (waived when the slot is rcf-exempt) AND never exceeds that debt. Seize the whole slot only
 * when its implied repaid units fit within the bound; otherwise seize the largest amount whose
 * contract-derived repaid stays within that bound.
 */
const normalModeOutcome = ({
  input,
  lif,
  marginBps
}: {
  input: PlanInput
  lif: bigint
  marginBps: number
}): PlanOutcome => {
  const effectiveDebt = input.debt - input.badDebt
  const maxRepaid = maxRepaidPreMaturity({
    debt: input.debt,
    badDebt: input.badDebt,
    maxDebt: input.maxDebt,
    lif,
    lltv: input.bestCollateralLltv
  })
  const exempt = isRcfExempt({
    collateralAmt: input.bestCollateralAmt,
    price: input.bestCollateralPrice,
    lif,
    maxRepaid,
    rcfThreshold: input.rcfThreshold
  })
  // `lltv >= WAD` waives the cap and returns maxUint256; report that as a flag rather than logging a
  // 78-digit number that reads like a real bound.
  const rcfDisabled = input.bestCollateralLltv >= WAD
  const base: TraceBase = {
    postMaturityMode: false,
    lif,
    effectiveDebt,
    rcfExempt: exempt,
    ...(rcfDisabled ? { rcfDisabled } : { maxRepaid })
  }
  const wholeSlotRepaid = impliedRepaidUnits(
    input.bestCollateralAmt,
    input.bestCollateralPrice,
    lif
  )
  const repayCap = exempt ? effectiveDebt : min(maxRepaid, effectiveDebt)
  if (wholeSlotRepaid <= repayCap) return seizeWholeSlot(input, false)
  return capBoundOutcome({ input, cap: repayCap, marginBps, base })
}

/**
 * Turns a fresh lens reading into a liquidation plan, or a {@link PlanSkipReason} explaining why
 * there is none. Mirrors the mode and amount policy of `liquidate(...)`:
 *
 * - past maturity → post-maturity mode: no RCF cap; seize 100% of the best slot if its implied
 *   repaid units fit within the (post-writeoff) debt, else the largest amount that does;
 * - pre-maturity & unhealthy → normal mode: the same, bounded by the RCF cap (waived when
 *   rcf-exempt) clamped to the post-writeoff debt;
 * - otherwise (no debt, locked, or healthy-and-pre-maturity) → skip.
 *
 * Every non-bad-debt plan is **seize-exact**: it pins `seizedAssets` (with `repaidUnits = 0`) and the
 * contract ceil-derives `repaidUnits` (:2369). Pinning the seize means the Executor holds exactly what
 * every venue (Uniswap or aggregator) sells, so there is no sell-side drift. Bad-debt realization is
 * the only `(0, 0)` plan. A cap-binding seize is sized against `cap·(1 - seizeCapMarginBps)` to keep
 * headroom for a one-block oracle move; any residual drift fails closed in `simulate()`, never
 * on-chain.
 *
 * @param input - Fresh lens-derived position state, all read at one `blockTimestamp`.
 * @param options - Non-lens sizing knobs; `seizeCapMarginBps` defaults to `0` (unmargined cap).
 * @returns `{ kind: 'plan' }` with a submittable plan, or `{ kind: 'skip' }` with the reason and —
 *   for every cap-stage refusal — a {@link SizingTrace} sufficient to replay the arithmetic.
 */
export const planWithReason = (input: PlanInput, options: PlanOptions = {}): PlanOutcome => {
  const { seizeCapMarginBps: marginBps = 0 } = options

  if (!input.hasDebt) return { kind: 'skip', reason: 'no_debt' }
  if (input.locked) return { kind: 'skip', reason: 'locked' }

  const postMaturityMode = input.blockTimestamp > input.maturity
  if (!postMaturityMode && input.healthy) return { kind: 'skip', reason: 'healthy_pre_maturity' }

  // Full write-off: the only legitimate `(0, 0)` plan. Must precede the `nothing_to_seize` guard,
  // which would otherwise steal it (a fully-bad-debt position often holds no collateral either).
  if (input.badDebt >= input.debt) {
    return {
      kind: 'plan',
      plan: {
        collateralIndex: input.bestCollateralIndex,
        seizedAssets: 0n,
        repaidUnits: 0n,
        postMaturityMode
      }
    }
  }

  const lif = lifAt({
    now: input.blockTimestamp,
    maturity: input.maturity,
    maxLif: input.bestCollateralMaxLif,
    postMaturityMode
  })

  // An empty best slot would make `wholeSlotRepaid` 0, pass every cap comparison, and return a
  // `(0, 0)` whole-slot plan that `isBadDebtRealization` reads as a write-off against a position we
  // just established is NOT fully bad debt. Refuse it explicitly instead.
  if (input.bestCollateralAmt === 0n) {
    return {
      kind: 'skip',
      reason: 'nothing_to_seize',
      // No cap stage ran — the slot is empty, so `cap`/`capEff` are deliberately absent rather than
      // fabricated (the logger drops `undefined`, so the line self-describes).
      trace: { postMaturityMode, lif, effectiveDebt: input.debt - input.badDebt, seizedAssets: 0n }
    }
  }

  return postMaturityMode
    ? postMaturityOutcome({ input, lif, marginBps })
    : normalModeOutcome({ input, lif, marginBps })
}

/**
 * Bare-plan facade over {@link planWithReason} for callers that do not report a reason.
 *
 * @param input - Fresh lens-derived position state.
 * @param options - Non-lens sizing knobs.
 * @returns The plan, or `null` when the position is not liquidatable or cannot be sized.
 */
export const plan = (input: PlanInput, options: PlanOptions = {}): LiquidationPlan | null => {
  const outcome = planWithReason(input, options)
  return outcome.kind === 'plan' ? outcome.plan : null
}
