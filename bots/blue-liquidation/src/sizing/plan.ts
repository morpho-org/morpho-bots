import { ORACLE_PRICE_SCALE } from '../constants'
import { lifFromLltv } from './lif'
import {
  min,
  mulDivDown,
  mulDivUp,
  toAssetsDown,
  toAssetsUp,
  toSharesUp,
  wDivUp,
  wMulDown
} from './math'

/**
 * The loan assets `liquidate` pulls from the liquidator for a given seize — the swap's break-even
 * output. Mirrors Morpho Blue's own chain, every step of which rounds UP against the liquidator:
 *
 * ```text
 * quoted  = seizedAssets.mulDivUp(collateralPrice, ORACLE_PRICE_SCALE)
 * shares  = quoted.wDivUp(lif).toSharesUp(totalBorrowAssets, totalBorrowShares)
 * assets  = shares.toAssetsUp(totalBorrowAssets, totalBorrowShares)
 * ```
 *
 * The shares round-trip is not decorative: Blue settles the repay in shares, so an assets-only
 * estimate is short by the two rounding steps and understates what the callback must produce.
 *
 * Module-private: every sized plan carries its own value as
 * {@link LiquidationPlan.impliedRepaidAssets}, which is the surface callers want.
 */
const impliedRepaidAssets = (args: {
  seizedAssets: bigint
  collateralPrice: bigint
  lltv: bigint
  accruedTotalBorrowAssets: bigint
  totalBorrowShares: bigint
}): bigint => {
  const quoted = mulDivUp(args.seizedAssets, args.collateralPrice, ORACLE_PRICE_SCALE)
  const shares = toSharesUp(
    wDivUp(quoted, lifFromLltv(args.lltv)),
    args.accruedTotalBorrowAssets,
    args.totalBorrowShares
  )
  return toAssetsUp(shares, args.accruedTotalBorrowAssets, args.totalBorrowShares)
}

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
export type LiquidationPlan = {
  seizedAssets: bigint
  /**
   * The loan assets Blue will pull for `seizedAssets` — the swap's break-even output. Mirrors
   * `liquidate`'s own derivation, including the shares round-trip: Blue converts the quoted seize to
   * shares and back, and BOTH conversions round up, so an assets-only estimate understates what is
   * actually transferred.
   */
  impliedRepaidAssets: bigint
}

/**
 * Why sizing produced no plan, one per guard in {@link planWithReason}. `no_debt` / `healthy` negate
 * `isLiquidatable`, so a caller that gates on it never sees them.
 */
export type PlanSkipReason =
  | 'no_debt'
  | 'healthy'
  | 'no_collateral'
  | 'zero_price'
  | 'seize_rounds_to_zero'

/**
 * Sizing result: exactly one of `plan` / `reason` is set. A skip carries its reason so the caller can
 * report it (`plan.skipped`) instead of dropping the position silently.
 *
 * A skip is NOT a failure signal: callers must not record backoff or mark a cooldown on one. Every
 * reason here is a fact about the position's current state, and the next lens reading re-derives it
 * for free, so suppressing a skipped position would only delay noticing when it becomes sizeable.
 */
type PlanOutcome =
  | { plan: LiquidationPlan; reason?: undefined }
  | { plan: null; reason: PlanSkipReason }

const skip = (reason: PlanSkipReason): PlanOutcome => ({ plan: null, reason })

/**
 * Turns a fresh lens reading into a seize-exact liquidation plan, or the reason there is none.
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
 * Side-effect free.
 */
export const planWithReason = (input: PlanInput): PlanOutcome => {
  if (!input.hasDebt) return skip('no_debt')
  if (input.healthy) return skip('healthy')
  // Degenerate: pure residual bad debt (borrowShares > 0 but collateral == 0). Nothing to seize; a
  // backstop bot does not perform an uncompensated loan-token repay, and Blue rejects a (0, 0)
  // liquidate anyway (`exactlyOneZero`).
  if (input.collateral === 0n) return skip('no_collateral')
  // A zero (non-reverting) oracle price would divide-by-zero below. It also makes maxBorrow 0, so the
  // lens reports the position unhealthy — but we cannot size against it; skip rather than throw and
  // abort the whole tick. (A reverting oracle is already dropped by the lens as valid=false.)
  if (input.collateralPrice === 0n) return skip('zero_price')

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
  // Rounds to nothing (dust position, or price ≫ debt): can't pass 0 to `liquidate`, so skip it.
  if (seizedAssets === 0n) return skip('seize_rounds_to_zero')
  return {
    plan: {
      seizedAssets,
      impliedRepaidAssets: impliedRepaidAssets({
        seizedAssets,
        collateralPrice: input.collateralPrice,
        lltv: input.lltv,
        accruedTotalBorrowAssets: input.accruedTotalBorrowAssets,
        totalBorrowShares: input.totalBorrowShares
      })
    }
  }
}

/**
 * {@link planWithReason} projected to just the plan, for callers that do not report the skip reason.
 */
export const plan = (input: PlanInput): LiquidationPlan | null => planWithReason(input).plan
