import type { Logger } from '@repo/bot-kit'
import type { QuoteOutcome, RateLimitedClient, Unwrapper, Venue, VenueSelector } from '@repo/swaps'
import type { Address } from 'viem'

import { composeMultiVenueQuoting } from '@repo/swaps'
import { isAddressEqual } from 'viem'

import type { LiquidationPlan } from './sizing/plan'
import type { LensOut } from './state/lens.sol'

import { expectedLoanOut } from './execution/swap-step'

/**
 * The Blue-shaped adapter over `@repo/swaps`' {@link composeMultiVenueQuoting}: keeps the
 * `(plan, out)` signature the tick consumes and projects the lens output into the package's plain
 * `QuoteRequest` — Blue markets have a single collateral, `out.params.collateralToken`. The package
 * resolves the pre-swap unwrap chain, then refreshes the venue probe for the POST-unwrap
 * `(collateral, loan)` pair — gated to this liquidatable pair and staleMs-cached, so no venue calls
 * hit quiet markets — and picks the best venue from the warm cache, firm-quoting only the chosen
 * one. An operator-excluded collateral short-circuits to `no_config` (no API call), preserving
 * no-API-call semantics for a position the bot won't route.
 */
export function composeQuoting(deps: {
  httpClient: RateLimitedClient
  selector: VenueSelector
  chainId: number
  executor: Address
  venues: readonly Venue[]
  baseUrls: Partial<Record<Venue, string>>
  maxRouteImpactBps: number
  unwrappers: readonly Unwrapper[]
  excludeCollaterals: readonly Address[]
  logger: Logger
}): { quoteFor: (plan: LiquidationPlan, out: LensOut, label: string) => Promise<QuoteOutcome> } {
  const { selector, excludeCollaterals, logger, ...rest } = deps
  const { quoteFor: quoteRequest } = composeMultiVenueQuoting({
    ...rest,
    // The composer owns the probe refresh: it runs after unwrap resolution so probes price the
    // tradable underlying, not an exotic collateral the venues can't quote.
    refresh: selector.refresh,
    select: selector.select,
    logger
  })

  return {
    async quoteFor(plan, out, label) {
      // The operator opt-out applies to the RAW collateral — blue has no per-collateral config file
      // anymore, so this is its escape hatch from the auto-unwrap path too.
      if (excludeCollaterals.some(token => isAddressEqual(token, out.params.collateralToken))) {
        logger.info('quote.excluded_collateral', {
          id: label,
          collateral: out.params.collateralToken
        })
        // `firmCalls: 0` explicitly: an absent count reads as UNKNOWN, and this path provably spent
        // nothing (see {@link QuoteOutcome.firmCalls}).
        return { kind: 'no_config', firmCalls: 0 }
      }

      return quoteRequest({
        collateralToken: out.params.collateralToken,
        loanToken: out.params.loanToken,
        amountIn: plan.seizedAssets,
        referenceAmountOut: expectedLoanOut(plan, out),
        // Break-even, straight off the plan: the loan assets `liquidate` will pull for this seize,
        // including the shares round-trip Blue settles through.
        minAcceptableAmountOut: plan.impliedRepaidAssets,
        id: label
      })
    }
  }
}
