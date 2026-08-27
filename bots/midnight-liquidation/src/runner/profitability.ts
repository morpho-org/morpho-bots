import type { SwapPlan } from '@repo/swaps'

import type { LiquidationPlan } from '../sizing/plan'

import { BPS } from '../constants'
import { mulDivUp } from '../sizing/math'

type ProfitabilityAssessment = {
  viable: boolean
  /** Loan units `liquidate` will pull from the Executor — {@link LiquidationPlan.impliedRepaidUnits}. */
  requiredRepay: bigint
  /** Loan units the quoted route is expected to deliver. */
  achievableOut: bigint
  /** How far the route falls short of `requiredRepay`, in bps of it. Negative when profitable. */
  shortfallBps: bigint
}

/**
 * Whether a quoted route covers the repay `liquidate` will pull, evaluated BEFORE simulating.
 *
 * Midnight ends `liquidate` with `safeTransferFrom(loanToken, payer, this, repaidUnits)`, re-deriving
 * `repaidUnits` on-chain, while the Executor's callback approves only its own live balance. A route
 * returning less than that derived repay therefore reverts as
 * `ERC20: transfer amount exceeds allowance` — a balance shortfall wearing an allowance error's
 * clothes, which is why the failure reads as an approval bug and is not one. Gating here turns the
 * revert into a reported skip carrying the numbers the revert string omits.
 *
 * Break-even is read off {@link LiquidationPlan.impliedRepaidUnits} rather than recomputed. The
 * matured-and-unhealthy branch opens both on-chain gates and picks a mode by surplus, so the LIF a
 * plan was sized at is not recoverable from `postMaturityMode` or from chain time — recomputing it
 * here would silently apply the post-maturity ramp to a normal-mode plan and overstate the repay by
 * the whole un-ramped incentive.
 *
 * The comparison uses `expectedAmountOut`, not `amountOutMinimum`. The latter embeds the venue's
 * slippage allowance — 1% by default — which dwarfs the post-maturity incentive (a few bps for the
 * first minutes) and would suppress every viable liquidation for most of the ramp, and permanently on
 * high-LLTV tiers whose entire `maxLif` sits under that allowance.
 *
 * Pure — no RPC, no I/O.
 */
export const assessProfitability = ({
  plan,
  swapPlan,
  minSurplusBps
}: {
  plan: LiquidationPlan
  swapPlan: SwapPlan
  /** Surplus over break-even required to pass, in bps of `requiredRepay`. `0` is pure break-even. */
  minSurplusBps: number
}): ProfitabilityAssessment => {
  const requiredRepay = plan.impliedRepaidUnits
  const achievableOut = swapPlan.expectedAmountOut
  const threshold = requiredRepay + mulDivUp(requiredRepay, BigInt(minSurplusBps), BPS)

  return {
    viable: achievableOut >= threshold,
    requiredRepay,
    achievableOut,
    shortfallBps:
      requiredRepay === 0n ? 0n : ((requiredRepay - achievableOut) * BPS) / requiredRepay
  }
}
