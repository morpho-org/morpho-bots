import type { Logger } from '@repo/bot-kit'
import type { QuoteOutcome, RateLimitedClient, SwapConfigEntry } from '@repo/swaps'
import type { Address } from 'viem'

import { composeQuoting as composeSwapQuoting } from '@repo/swaps'

import type { LiquidationPlan } from './sizing/plan'
import type { LensOut } from './state/lens.sol'

import { expectedLoanOut } from './execution/swap-step'

/**
 * The thin Midnight-shaped adapter over `@repo/swaps`' `composeQuoting`: keeps the `(plan, out)`
 * signature the tick consumes and projects the lens output into the package's plain
 * {@link QuoteRequest}. Midnight markets are multi-collateral, so the plan's `collateralIndex`
 * addresses `out.market.collateralParams`; a missing slot short-circuits to `no_config` before the
 * package is consulted (preserving no-API-call semantics for an unconfigured position).
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
    async quoteFor(plan, out) {
      const collateral = out.market.collateralParams[plan.collateralIndex]
      if (!collateral) return { kind: 'no_config' }
      return quoteRequest({
        collateralToken: collateral.token,
        loanToken: out.market.loanToken,
        amountIn: plan.seizedAssets,
        referenceAmountOut: expectedLoanOut(plan, out)
      })
    }
  }
}
