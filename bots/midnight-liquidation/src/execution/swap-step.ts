import type { LiquidationPlan } from '../sizing/plan'
import type { LensOut } from '../state/lens.sol'

import { ORACLE_PRICE_SCALE, WAD } from '../constants'
import { lifAt } from '../sizing/lif'
import { mulDivDown } from '../sizing/math'

/**
 * The collateral the Executor is expected to hold for the swap, in raw collateral units.
 *
 * The 100%-slot branches pass `seizedAssets` (known up front), so this is exact and the swap has no
 * sell-side drift. The cap-binding branch passes `seizedAssets = 0` and the contract derives the
 * seize from `repaidUnits` on-chain with two floor divisions; we mirror that derivation so an
 * aggregator quote can commit to a fixed sell amount and a Uniswap min-out cannot exceed the rounded
 * on-chain seize. Any drift between this prediction and the on-chain seize (oracle price moving
 * between the read block and the execution block, the post-maturity LIF ramp, or a rounding step)
 * fails closed in `simulate()` — a missed liquidation, never a loss.
 */
export function predictSeizedAssets(plan: LiquidationPlan, out: LensOut): bigint {
  if (plan.seizedAssets > 0n) return plan.seizedAssets
  if (out.bestCollateralPrice === 0n) return 0n
  const lif = lifAt({
    now: out.blockTimestamp,
    maturity: out.market.maturity,
    maxLif: out.bestCollateralMaxLif,
    postMaturityMode: plan.postMaturityMode
  })
  return mulDivDown(
    mulDivDown(plan.repaidUnits, lif, WAD),
    ORACLE_PRICE_SCALE,
    out.bestCollateralPrice
  )
}

/**
 * The loan-token amount the swap is expected to produce, valued at the lens's fresh oracle price (no
 * DEX slippage). The Midnight oracle price converts collateral → loan units directly (`loan =
 * collateral * price / ORACLE_PRICE_SCALE`), so no USD/decimals round-trip is needed — the result is
 * already in the loan token's native units. This is the venue-agnostic reference output: a Uniswap
 * min-out is derived from it, and an aggregator's quoted output is sanity-checked against it.
 */
export function expectedLoanOut(plan: LiquidationPlan, out: LensOut): bigint {
  return mulDivDown(predictSeizedAssets(plan, out), out.bestCollateralPrice, ORACLE_PRICE_SCALE)
}
