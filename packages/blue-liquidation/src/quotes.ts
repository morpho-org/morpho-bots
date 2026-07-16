import type { Logger } from '@repo/evm-kit'
import type { QuoteOutcome, RateLimitedClient, SwapConfigEntry, Unwrapper } from '@repo/swaps'
import type { Address } from 'viem'

import { composeQuoting as composeSwapQuoting } from '@repo/swaps'

import type { LensOut } from './lens.sol'
import type { LiquidationPlan } from './sizing/plan'

import { expectedLoanOut } from './execution/swap-step'

/**
 * The thin Blue-shaped adapter over `@repo/swaps`' `composeQuoting`: keeps the `(plan, out)`
 * signature the op consumes and projects the lens output into the package's plain
 * {@link QuoteRequest} — Blue markets have a single collateral, `out.params.collateralToken`.
 * Exotic collateral (ERC4626 shares etc.) is auto-unwrapped by the package's pre-swap stage; the
 * per-collateral config then keys on the unwrapped underlying, with a direct entry for the raw
 * collateral winning verbatim as the operator escape hatch.
 */
export function composeQuoting(deps: {
  httpClient: RateLimitedClient
  chainId: number
  executor: Address
  /** Per-collateral venue config for this chain, keyed by EIP-55-checksummed collateral address. */
  swapByCollateral: Map<string, SwapConfigEntry>
  maxRouteImpactBps: number
  unwrappers: readonly Unwrapper[]
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
