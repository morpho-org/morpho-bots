import type { LensOut } from '../lens.sol'
import type { LiquidationPlan } from '../sizing/plan'

import { ORACLE_PRICE_SCALE } from '../constants'
import { mulDivDown } from '../sizing/math'

/**
 * The loan-token amount the swap is expected to produce, valued at the lens's fresh oracle price (no
 * DEX slippage).
 *
 * Blue's oracle price converts collateral to loan units directly (`loan = collateral * price /
 * ORACLE_PRICE_SCALE`), with token decimals already baked in. This reference feeds Uniswap min-out
 * construction and aggregator route-quality checks.
 */
export function expectedLoanOut(plan: LiquidationPlan, out: LensOut): bigint {
  return mulDivDown(plan.seizedAssets, out.collateralPrice, ORACLE_PRICE_SCALE)
}
