import type { Address } from 'viem'

import type { LiquidationPlan } from '../sizing/plan'
import type { LensOut } from '../state/lens.sol'
import type { SwapStep } from './encode-call'

import { ORACLE_PRICE_SCALE, WAD } from '../constants'
import { lifAt } from '../sizing/lif'
import { mulDivDown } from '../sizing/math'
import { impliedRepaidUnits } from '../sizing/plan'

const BPS = 10_000n

/** The operator's per-collateral swap config entry (`SWAP_CONFIG_PATH` → `[chainId][collateral]`). */
export type SwapConfigEntry = { router: Address; fee: number; slippageBps: number }

/**
 * The loan-token amount the swap is expected to produce, valued at the lens's fresh oracle price (no
 * DEX slippage). The Midnight oracle price converts collateral → loan units directly (`loan =
 * collateral * price / ORACLE_PRICE_SCALE`), so no USD/decimals round-trip is needed — the result is
 * already in the loan token's native units, which is what Uniswap's `amountOutMinimum` expects.
 *
 * The seized collateral differs by plan branch: the 100%-slot branches pass `seizedAssets` (known
 * up front), while the cap-binding branch passes `seizedAssets = 0` and the contract derives
 * `seizedAssets` from `repaidUnits` on-chain with two floor divisions. We mirror that derivation
 * before valuing the collateral so the swap minimum cannot exceed the rounded on-chain seize.
 */
export function expectedLoanOut(plan: LiquidationPlan, out: LensOut): bigint {
  if (plan.seizedAssets > 0n) {
    return mulDivDown(plan.seizedAssets, out.bestCollateralPrice, ORACLE_PRICE_SCALE)
  }
  if (out.bestCollateralPrice === 0n) return 0n
  const lif = lifAt({
    now: out.blockTimestamp,
    maturity: out.market.maturity,
    maxLif: out.bestCollateralMaxLif,
    postMaturityMode: plan.postMaturityMode
  })
  const seizedAssets = mulDivDown(
    mulDivDown(plan.repaidUnits, lif, WAD),
    ORACLE_PRICE_SCALE,
    out.bestCollateralPrice
  )
  return mulDivDown(seizedAssets, out.bestCollateralPrice, ORACLE_PRICE_SCALE)
}

/**
 * The exact loan-token amount Midnight pulls from the Executor at the end of `liquidate`
 * (midnight-contracts.txt:2436) — the repay the swap output must cover, in loan-token native units.
 * Cap-binding plans (`seizedAssets == 0`) pass the repay directly as `repaidUnits`; whole-slot plans
 * have it derived on-chain from the seize at the LIF bonus with two ceil-divisions (:2369), mirrored
 * here by `impliedRepaidUnits` so the floor matches the contract to the wei.
 */
export function repaidAssets(plan: LiquidationPlan, out: LensOut): bigint {
  if (plan.seizedAssets === 0n) return plan.repaidUnits
  const lif = lifAt({
    now: out.blockTimestamp,
    maturity: out.market.maturity,
    maxLif: out.bestCollateralMaxLif,
    postMaturityMode: plan.postMaturityMode
  })
  return impliedRepaidUnits(plan.seizedAssets, out.bestCollateralPrice, lif)
}

/**
 * Whether the seized collateral, valued at the fresh oracle price (no DEX fee), can cover the repay
 * Midnight pulls. The necessary condition for a swap-funded liquidation to self-fund: when it fails,
 * the post-maturity LIF bonus is below the repay (e.g. just past maturity, LIF ≈ WAD, where the
 * seize ≈ the repay before any swap cost), so the swap can NEVER produce enough loan token however it
 * fills and the repay `transferFrom` reverts (`ERC20: transfer amount exceeds allowance`). Gated out
 * before simulating so doomed plans aren't re-tried every block; they recover on their own as the LIF
 * ramps past the swap cost. `<=` (not `<`): at equality there is zero headroom for any fee/slippage.
 */
export function coversRepay(plan: LiquidationPlan, out: LensOut): boolean {
  return expectedLoanOut(plan, out) > repaidAssets(plan, out)
}

/**
 * Builds the single-hop {@link SwapStep} for a plan: the operator's per-collateral router + fee tier,
 * plus an `amountOutMinimum` that is the tighter of (a) the slippage-bounded oracle expectation and
 * (b) the loan-token repay Midnight will pull. Flooring at the repay is essential: Midnight pulls
 * exactly `repaidAssets` at the end of `liquidate` (:2436), so a slippage bound below it would let the
 * swap fill short and revert the repay with "transfer amount exceeds allowance". The bound fails
 * closed — if the pool can't fill it the swap reverts mid-`liquidate` and the whole tx rolls back (a
 * missed liquidation, never a loss).
 */
export function buildSwapStep(
  entry: SwapConfigEntry,
  plan: LiquidationPlan,
  out: LensOut
): SwapStep {
  const expected = expectedLoanOut(plan, out)
  const slippageBounded = (expected * (BPS - BigInt(entry.slippageBps))) / BPS
  const floor = repaidAssets(plan, out)
  const amountOutMinimum = slippageBounded > floor ? slippageBounded : floor
  return { router: entry.router, fee: entry.fee, amountOutMinimum }
}
