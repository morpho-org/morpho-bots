import type { Logger } from '@repo/evm-kit'
import type { QuoteOutcome, RateLimitedClient, Unwrapper, Venue, VenueSelector } from '@repo/swaps'
import type { Address } from 'viem'

import { composeMultiVenueQuoting } from '@repo/swaps'
import { isAddressEqual } from 'viem'

import type { LensOut } from './lens.sol'
import type { LiquidationPlan } from './sizing/plan'

import { expectedLoanOut } from './execution/swap-step'

/**
 * The Midnight-shaped adapter over `@repo/swaps`' {@link composeMultiVenueQuoting}: keeps the
 * `(plan, out)` signature the op consumes and projects the lens output into the package's plain
 * `QuoteRequest`. The package resolves the pre-swap unwrap chain, then refreshes the venue probe
 * for the POST-unwrap `(collateral, loan)` pair — gated to this liquidatable pair and
 * staleMs-cached, so no venue calls hit quiet markets — and picks the best venue from the warm
 * cache, firm-quoting only the chosen one. A missing collateral slot or an operator-excluded
 * collateral short-circuits to `no_config` (no API call), preserving no-API-call semantics for a
 * position the bot won't route.
 */
export function composeQuoting(deps: {
  httpClient: RateLimitedClient
  selector: VenueSelector
  chainId: number
  executor: Address
  venues: readonly Venue[]
  slippageBps: number
  baseUrls: Partial<Record<Venue, string>>
  maxRouteImpactBps: number
  unwrappers: readonly Unwrapper[]
  excludeCollaterals: readonly Address[]
  logger: Logger
}): { quoteFor: (plan: LiquidationPlan, out: LensOut, id: string) => Promise<QuoteOutcome> } {
  const { selector, excludeCollaterals, logger, ...rest } = deps
  const { quoteFor: quoteRequest } = composeMultiVenueQuoting({
    ...rest,
    refresh: selector.refresh,
    select: selector.select,
    logger
  })

  return {
    // `id` is the position's correlation id, threaded through so collateral-level skip reasons and
    // the package's unwrap/probe/quote events can be joined to the borrower that hit them.
    async quoteFor(plan, out, id) {
      const collateral = out.market.collateralParams[plan.collateralIndex]
      if (!collateral) return { kind: 'no_config' }
      // The operator opt-out applies to the RAW collateral — midnight has no per-collateral config
      // file, so this is its escape hatch from the auto-unwrap path too.
      if (excludeCollaterals.some(token => isAddressEqual(token, collateral.token))) {
        logger.info('quote.excluded_collateral', { id, collateral: collateral.token })
        return { kind: 'no_config' }
      }

      return quoteRequest({
        collateralToken: collateral.token,
        loanToken: out.market.loanToken,
        amountIn: plan.seizedAssets,
        referenceAmountOut: expectedLoanOut(plan, out),
        id
      })
    }
  }
}
