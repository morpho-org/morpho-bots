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
 * Turns a fresh lens reading into a seize-exact liquidation plan, or `null` when the position is not
 * liquidatable or has nothing to seize.
 *
 * Blue liquidation is permissionless and time-independent, so the only gate is `hasDebt && !healthy`
 * (no maturity, no liquidator gate, no RCF cap). The single sizing rule pins the seize at the amount
 * that fully closes the debt, capped at 100% of collateral:
 *
 *   repaidAssetsFull = borrowShares.toAssetsDown(accruedTotalBorrowAssets, totalBorrowShares)
 *   seizeForFullDebt = mulDivDown(wMulDown(repaidAssetsFull, lif), ORACLE_PRICE_SCALE, collateralPrice)
 *   seizedAssets     = min(collateral, seizeForFullDebt)
 *
 * Pinning `seizedAssets` (with `repaidShares = 0`) is what keeps an aggregator's fixed sell amount
 * correct — the Executor holds exactly the seize when the callback runs. Blue then ceil-derives
 * `repaidShares` from the pinned seize; the inbound double-floor guarantees `repaidShares ≤
 * borrowShares` (proved in `plan.test.ts`), so the on-chain `borrowShares -= repaidShares` cannot
 * underflow. When collateral binds (underwater), seizing 100% drives `position.collateral` to 0 and
 * Blue socializes the residual as bad debt in the same call — no separate call needed. A one-block
 * oracle move that lifts the exec-time derived repaid above the debt simply reverts, caught by
 * `simulate()` (fail closed, never a loss).
 */
export function plan(input: PlanInput): LiquidationPlan | null {
  if (!input.hasDebt || input.healthy) return null
  // Degenerate: pure residual bad debt (borrowShares > 0 but collateral == 0). Nothing to seize; a
  // backstop bot does not perform an uncompensated loan-token repay, and Blue rejects a (0, 0)
  // liquidate anyway (`exactlyOneZero`).
  if (input.collateral === 0n) return null
  // A zero (non-reverting) oracle price would divide-by-zero below. It also makes maxBorrow 0, so the
  // lens reports the position unhealthy — but we cannot size against it; skip rather than throw and
  // abort the whole tick. (A reverting oracle is already dropped by the lens as valid=false.)
  if (input.collateralPrice === 0n) return null

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
  if (seizedAssets === 0n) return null
  return { seizedAssets }
}
