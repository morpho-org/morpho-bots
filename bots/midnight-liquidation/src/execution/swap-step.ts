import { ORACLE_PRICE_SCALE } from '../constants';
import { mulDivDown } from '../sizing/math';
import type { LiquidationPlan } from '../sizing/plan';
import type { LensOut } from '../state/lens.sol';

/**
 * The loan-token amount the swap is expected to produce, valued at the lens's fresh oracle price (no
 * DEX slippage).
 *
 * Every non-bad-debt plan is seize-exact (`plan.seizedAssets` is pinned, `repaidUnits = 0`), and the
 * contract transfers exactly `seizedAssets` to the Executor before the callback — so the seized
 * collateral the swap acts on is exactly `plan.seizedAssets`, with no sell-side drift on any venue.
 * The Midnight oracle price converts collateral → loan units directly (`loan = collateral * price /
 * ORACLE_PRICE_SCALE`), so no USD/decimals round-trip is needed — the result is already in the loan
 * token's native units. This is the venue-agnostic reference output: a Uniswap min-out is derived
 * from it, and an aggregator's quoted output is sanity-checked against it.
 */
export function expectedLoanOut(plan: LiquidationPlan, out: LensOut): bigint {
  return mulDivDown(plan.seizedAssets, out.bestCollateralPrice, ORACLE_PRICE_SCALE);
}
