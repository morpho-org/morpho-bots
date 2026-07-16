import type { Logger } from '@repo/bot-kit'
import type { QuoteOutcome, RateLimitedClient, SwapConfigEntry } from '@repo/swaps'
import type { Address } from 'viem'

import { composeQuoting as composeSwapQuoting } from '@repo/swaps'

import type { LiquidationPlan } from './sizing/plan'
import type { LensOut } from './state/lens.sol'

import { expectedLoanOut } from './execution/swap-step'

/**
 * The thin Blue-shaped adapter over `@repo/swaps`' `composeQuoting`: keeps the `(plan, out)`
 * signature the tick consumes and projects the lens output into the package's plain
 * {@link QuoteRequest} — Blue markets have a single collateral, `out.params.collateralToken`.
 */
export function composeQuoting(deps: {
  httpClient: RateLimitedClient
  chainId: number
  executor: Address
  /** Per-collateral venue config for this chain, keyed by EIP-55-checksummed collateral address. */
  swapByCollateral: Map<string, SwapConfigEntry>
  maxRouteImpactBps: number
  logger: Logger
}): { quoteFor: (plan: LiquidationPlan, out: LensOut) => Promise<QuoteOutcome> } {
  const { quoteFor: quoteRequest } = composeSwapQuoting(deps)
  return {
    quoteFor: (plan, out) =>
      quoteRequest({
        collateralToken: out.params.collateralToken,
        loanToken: out.params.loanToken,
        amountIn: plan.seizedAssets,
        referenceAmountOut: expectedLoanOut(plan, out)
      })
  }
}
