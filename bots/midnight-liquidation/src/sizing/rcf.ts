import { maxUint256 } from 'viem'

import { ORACLE_PRICE_SCALE, WAD } from '../constants'
import { mulDivDown, mulDivUp, zeroFloorSub } from './math'

/**
 * Maximum repaid units permitted by the pre-maturity Repayment Cap Factor.
 * Mirrors midnight-contracts.txt:2378-2380.
 *
 * `badDebt` is the writeoff the contract subtracts from debt before sizing (:2347), so the cap is
 * taken against the post-writeoff (`debt - badDebt`) amount. `lltv >= WAD` disables the cap
 * entirely (the position can be fully liquidated). The denominator `WAD² - lif·lltv` is strictly
 * positive for every allowed `lltv < WAD` because `maxLif` is derived so that `maxLif·lltv < WAD²`
 * (:997, :2487), and `lif <= maxLif`.
 */
export function maxRepaidPreMaturity({
  debt,
  badDebt,
  maxDebt,
  lif,
  lltv
}: {
  debt: bigint
  badDebt: bigint
  maxDebt: bigint
  lif: bigint
  lltv: bigint
}): bigint {
  if (lltv >= WAD) return maxUint256
  const effectiveDebt = debt - badDebt
  return mulDivUp(effectiveDebt - maxDebt, WAD * WAD, WAD * WAD - lif * lltv)
}

/**
 * Whether the RCF cap is waived for the liquidated slot: its full pre-seizure value, converted to
 * repaid units and net of `maxRepaid`, is below the market's `rcfThreshold`. Normal mode only.
 * Mirrors midnight-contracts.txt:2381-2385 (collateral → loan units via `/ORACLE_PRICE_SCALE`,
 * loan → repaid units via `·WAD/lif`, both floored, then `zeroFloorSub(maxRepaid) < rcfThreshold`).
 */
export function isRcfExempt({
  collateralAmt,
  price,
  lif,
  maxRepaid,
  rcfThreshold
}: {
  collateralAmt: bigint
  price: bigint
  lif: bigint
  maxRepaid: bigint
  rcfThreshold: bigint
}): boolean {
  const slotInLoanUnits = mulDivDown(collateralAmt, price, ORACLE_PRICE_SCALE)
  const slotInRepaidUnits = mulDivDown(slotInLoanUnits, WAD, lif)
  return zeroFloorSub(slotInRepaidUnits, maxRepaid) < rcfThreshold
}
