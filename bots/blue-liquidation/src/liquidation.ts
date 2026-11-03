import type { Address, Hex } from 'viem'

import { task } from '@repo/controller'
import { zeroFloorSub } from '@repo/utils'

import type { LiquidationPlan, PlanSkipReason } from './sizing/plan'
import type { LensOut } from './state/lens.sol'

import { ORACLE_PRICE_SCALE, WAD } from './constants'
import { planInputFromLens } from './runner/eligibility'
import { mulDivDown, toAssetsUp, wMulDown } from './sizing/math'
import { planWithReason } from './sizing/plan'

/** One liquidatable position as the world read it, at one block of the kernel's chain. */
export type PositionReading = Readonly<{
  marketId: Hex
  borrower: Address
  out: LensOut
  block: number
}>

/** A position's seize-exact plan, or why it has none. */
export type Sizing =
  | Readonly<{ plan: LiquidationPlan; reason?: undefined }>
  | Readonly<{ plan: null; reason: PlanSkipReason }>

export const sizePosition = (out: LensOut): Sizing => planWithReason(planInputFromLens(out))

/**
 * A position's rank among liquidation candidates, bigger first: how far its health factor, WAD-scaled,
 * sits below one. Debt and borrowing power are both in loan-token units, so the rank does not depend
 * on the loan token's decimals.
 */
export const unhealthiness = (out: LensOut) => {
  const borrowed = toAssetsUp(out.borrowShares, out.accruedTotalBorrowAssets, out.totalBorrowShares)
  const collateralValue = mulDivDown(out.collateral, out.collateralPrice, ORACLE_PRICE_SCALE)
  const healthFactor = mulDivDown(wMulDown(collateralValue, out.lltv), WAD, borrowed)
  return zeroFloorSub(WAD, healthFactor)
}

/**
 * A position with a plan wants its liquidation, ranked by {@link unhealthiness}; two liquidations of one
 * position never run beside each other.
 */
export const liquidationTask = ({ bid }: Readonly<{ bid: bigint }>, key: string) =>
  task('liquidate', { priority: bid, conflicts: { writes: [`position:${key}`] } })
