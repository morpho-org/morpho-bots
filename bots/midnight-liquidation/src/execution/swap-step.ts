import type { Address } from 'viem'

import type { LiquidationPlan } from '../sizing/plan'
import type { LensOut } from '../state/lens.sol'
import type { SwapStep } from './encode-call'

import { ORACLE_PRICE_SCALE, WAD } from '../constants'
import { lifAt } from '../sizing/lif'

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
 * up front), while the cap-binding branch passes `seizedAssets = 0` and the contract derives the
 * seized amount from `repaidUnits` on-chain. There the loan-value of the seized collateral is
 * `repaidUnits * lif / WAD` (the inverse of the liquidation discount the contract applies), so we
 * estimate the output from `repaidUnits` instead. Both use floor division, matching the lens's
 * `_mulDivDown` valuation.
 */
export function expectedLoanOut(plan: LiquidationPlan, out: LensOut): bigint {
  if (plan.seizedAssets > 0n) {
    return (plan.seizedAssets * out.bestCollateralPrice) / ORACLE_PRICE_SCALE
  }
  const lif = lifAt({
    now: out.blockTimestamp,
    maturity: out.market.maturity,
    maxLif: out.bestCollateralMaxLif,
    postMaturityMode: plan.postMaturityMode
  })
  return (plan.repaidUnits * lif) / WAD
}

/**
 * Builds the single-hop {@link SwapStep} for a plan: the operator's per-collateral router + fee tier,
 * plus a slippage-bounded `amountOutMinimum` derived from the lens's fresh price. `slippageBps` is
 * the operator's tolerance in basis points; a higher value admits more DEX slippage. The bound fails
 * closed — if the pool can't fill it the swap reverts mid-`liquidate` and the whole tx rolls back (a
 * missed liquidation, never a loss).
 */
export function buildSwapStep(
  entry: SwapConfigEntry,
  plan: LiquidationPlan,
  out: LensOut
): SwapStep {
  const expected = expectedLoanOut(plan, out)
  const amountOutMinimum = (expected * (BPS - BigInt(entry.slippageBps))) / BPS
  return { router: entry.router, fee: entry.fee, amountOutMinimum }
}
