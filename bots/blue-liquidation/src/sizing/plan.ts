import { ORACLE_PRICE_SCALE } from '../constants'
import { lifFromLltv } from './lif'
import { min, mulDivDown, toAssetsDown, wMulDown } from './math'

/**
 * The fresh, lens-derived inputs the sizing decision depends on. All fields come from one `eth_call`
 * against a single `block.timestamp`, so accrual, health, and price are mutually consistent.
 * `accruedTotalBorrowAssets` is post-accrual; `totalBorrowShares` is the raw read (accrual never
 * changes it).
 */
export type PlanInput = {
  hasDebt: boolean
  /** `_isHealthy`: `maxBorrow >= borrowed` (so `!healthy` ⟺ liquidatable, given debt). */
  healthy: boolean
  borrowShares: bigint
  collateral: bigint
  accruedTotalBorrowAssets: bigint
  totalBorrowShares: bigint
  /** Oracle price in `ORACLE_PRICE_SCALE` units (both tokens' decimals already baked in). */
  collateralPrice: bigint
  lltv: bigint
}

/** A seize-exact plan: pin `seizedAssets` and pass `repaidShares = 0`, letting Blue ceil-derive it. */
export type LiquidationPlan = { seizedAssets: bigint }

/**
 * Why {@link planWithReason} produced no plan. Reasons discriminate SEVERITY (and hence log level);
 * the numbers on {@link SizingTrace} discriminate cause.
 *
 * `no_debt` and `healthy` are UNREACHABLE from the tick — `isLiquidatable` tests exactly
 * `hasDebt && !healthy` — so observing one means the eligibility gate and the sizing module have
 * diverged, a correctness bug. They are logged at `warn`, as a live assertion.
 */
export type PlanSkipReason =
  | 'no_debt'
  | 'healthy'
  /** Pure residual bad debt: shares outstanding but no collateral left to seize. */
  | 'no_collateral'
  /** A non-reverting zero oracle price — unsizable, and a divide-by-zero if used. */
  | 'zero_price'
  /** Dust, or a price so high the full-debt seize floors to zero collateral. */
  | 'seize_rounds_to_zero'

/**
 * Every value on the causal chain from a lens reading to a refused seize, so an operator can replay
 * the decision from one log line instead of re-deriving it. Absent for the two pre-sizing refusals
 * (`no_debt`, `healthy`), which are decided before any arithmetic runs.
 */
type SizingTrace = {
  lif: bigint
  /** Full debt in loan assets, floored from `borrowShares`. */
  repaidAssetsFull: bigint
  /** Collateral the full-debt repay would seize, before the 100%-of-collateral clamp. */
  seizeForFullDebt: bigint
  /** The final seize; `0n` is what refused the plan. */
  seizedAssets: bigint
}

/** A plan, or the reason there is none plus the numbers that explain it. */
type PlanOutcome =
  | { kind: 'plan'; plan: LiquidationPlan }
  | { kind: 'skip'; reason: PlanSkipReason; trace?: SizingTrace }

/**
 * Turns a fresh lens reading into a seize-exact liquidation plan, or a {@link PlanSkipReason}
 * explaining why there is none.
 *
 * Blue liquidation is permissionless and time-independent, so the only gate is `hasDebt && !healthy`
 * (no maturity, no liquidator gate, no RCF cap). The single sizing rule pins the seize at the amount
 * that fully closes the debt, capped at 100% of collateral:
 *
 *   repaidAssetsFull = borrowShares.toAssetsDown(accruedTotalBorrowAssets, totalBorrowShares)
 *   seizeForFullDebt = mulDivDown(wMulDown(repaidAssetsFull, lif), ORACLE_PRICE_SCALE, collateralPrice)
 *   seizedAssets     = min(collateral, seizeForFullDebt)
 *
 * Pinning `seizedAssets` keeps an aggregator's fixed sell amount correct. Blue ceil-derives
 * `repaidShares`; the double-floor input guarantees `repaidShares <= borrowShares` (proved in
 * `plan.test.ts`). When collateral binds, seizing all collateral socializes the residual as bad debt
 * in the same call. If a later oracle move makes the derived repay too large, simulation catches the
 * revert before broadcast.
 *
 * @param input - Fresh lens-derived position state, all read at one block.
 * @returns `{ kind: 'plan' }` with a submittable plan, or `{ kind: 'skip' }` with the reason and —
 *   for every refusal reached after sizing began — a {@link SizingTrace}.
 */
export const planWithReason = (input: PlanInput): PlanOutcome => {
  if (!input.hasDebt) return { kind: 'skip', reason: 'no_debt' }
  if (input.healthy) return { kind: 'skip', reason: 'healthy' }
  // Degenerate: pure residual bad debt (borrowShares > 0 but collateral == 0). Nothing to seize; a
  // backstop bot does not perform an uncompensated loan-token repay, and Blue rejects a (0, 0)
  // liquidate anyway (`exactlyOneZero`).
  if (input.collateral === 0n) return { kind: 'skip', reason: 'no_collateral' }
  // A zero (non-reverting) oracle price would divide-by-zero below. It also makes maxBorrow 0, so the
  // lens reports the position unhealthy — but we cannot size against it; skip rather than throw and
  // abort the whole tick. (A reverting oracle is already dropped by the lens as valid=false.)
  if (input.collateralPrice === 0n) return { kind: 'skip', reason: 'zero_price' }

  const lif = lifFromLltv(input.lltv)
  const repaidAssetsFull = toAssetsDown(
    input.borrowShares,
    input.accruedTotalBorrowAssets,
    input.totalBorrowShares
  )
  const seizeForFullDebt = mulDivDown(
    wMulDown(repaidAssetsFull, lif),
    ORACLE_PRICE_SCALE,
    input.collateralPrice
  )
  const seizedAssets = min(input.collateral, seizeForFullDebt)
  const trace: SizingTrace = { lif, repaidAssetsFull, seizeForFullDebt, seizedAssets }
  // Rounds to nothing (dust position, or price ≫ debt): can't pass 0 to `liquidate`, so skip it.
  if (seizedAssets === 0n) return { kind: 'skip', reason: 'seize_rounds_to_zero', trace }
  return { kind: 'plan', plan: { seizedAssets } }
}

/**
 * Bare-plan facade over {@link planWithReason} for callers that do not report a reason.
 *
 * @param input - Fresh lens-derived position state.
 * @returns The plan, or `null` when the position is not liquidatable or has nothing to seize.
 */
export const plan = (input: PlanInput): LiquidationPlan | null => {
  const outcome = planWithReason(input)
  return outcome.kind === 'plan' ? outcome.plan : null
}
