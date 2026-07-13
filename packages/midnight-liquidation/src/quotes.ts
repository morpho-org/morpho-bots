import type { Logger } from '@repo/evm-kit'
import type { QuoteOutcome, RateLimitedClient, Venue, VenueSelector } from '@repo/swaps'
import type { Address } from 'viem'

import { composeMultiVenueQuoting } from '@repo/swaps'
import { tryCatch } from '@repo/utils'
import { isAddressEqual } from 'viem'

import type { LiquidationPlan } from './sizing/plan'
import type { LensOut } from './state/lens.sol'

import { expectedLoanOut } from './execution/swap-step'

/**
 * The Midnight-shaped adapter over `@repo/swaps`' {@link composeMultiVenueQuoting}: keeps the
 * `(plan, out)` signature the tick consumes and projects the lens output into the package's plain
 * `QuoteRequest`. Before quoting, it refreshes the venue probe for the position's `(collateral, loan)`
 * pair — gated to this liquidatable pair and staleMs-cached, so no venue calls hit quiet markets — so
 * the package picks the best venue from a warm cache and firm-quotes only the chosen one. A missing
 * collateral slot or an operator-excluded collateral short-circuits to `no_config` (no API call),
 * preserving no-API-call semantics for a position the bot won't route.
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
  excludeCollaterals: readonly Address[]
  logger: Logger
}): { quoteFor: (plan: LiquidationPlan, out: LensOut) => Promise<QuoteOutcome> } {
  const { selector, excludeCollaterals, logger, ...rest } = deps
  const { quoteFor: quoteRequest } = composeMultiVenueQuoting({
    ...rest,
    select: selector.select,
    logger
  })

  return {
    async quoteFor(plan, out) {
      const collateral = out.market.collateralParams[plan.collateralIndex]
      if (!collateral) return { kind: 'no_config' }
      if (excludeCollaterals.some(token => isAddressEqual(token, collateral.token))) {
        logger.info('quote.excluded_collateral', { collateral: collateral.token })
        return { kind: 'no_config' }
      }

      // Probe (indicative, isolated rate budget) then let the package decide the venue order. A probe
      // failure is non-fatal: the firm-quote step falls back to a deterministic default venue. Skip
      // entirely in bad-debt-only mode (no venues) — the quote would return `no_config` anyway, so a
      // probe (and its decimals RPC read) would be wasted work.
      const loan = out.market.loanToken
      if (deps.venues.length > 0) {
        const { error } = await tryCatch(selector.refresh({ collateral: collateral.token, loan }))
        if (error) {
          logger.warn('probe.error', { collateral: collateral.token, loan, detail: error.message })
        }
      }

      return quoteRequest({
        collateralToken: collateral.token,
        loanToken: loan,
        amountIn: plan.seizedAssets,
        referenceAmountOut: expectedLoanOut(plan, out)
      })
    }
  }
}
