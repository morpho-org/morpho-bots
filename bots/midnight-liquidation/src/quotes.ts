import type { Logger } from '@repo/kit'
import type {
  QuoteOutcome,
  RateLimitedClient,
  Unwrapper,
  Venue,
  VenuePair,
  VenueSelector
} from '@repo/swaps'
import type { Address } from 'viem'

import { composeMultiVenueQuoting, previewUnwrapChain } from '@repo/swaps'
import { isAddressEqual } from 'viem'

import type { LiquidationPlan } from './sizing/plan'
import type { LensOut } from './state/lens.sol'

import { expectedLoanOut } from './execution/swap-step'

/**
 * What separates one position's `(slot, mode)` alternatives in a log row, for `@repo/swaps`'
 * `QuoteRequest.candidate`. Correlation only; the quoting layer never reads it.
 */
const candidateOf = (plan: LiquidationPlan) => ({
  collateralIndex: plan.collateralIndex,
  postMaturityMode: plan.postMaturityMode
})

/**
 * The Midnight-shaped adapter over `@repo/swaps`' {@link composeMultiVenueQuoting}: keeps the
 * `(plan, out)` signature the tick consumes and projects the lens output into the package's plain
 * `QuoteRequest`. The package resolves the pre-swap unwrap chain, then starts — without awaiting —
 * the venue probe for the POST-unwrap `(collateral, loan)` pair, gated to this liquidatable pair and
 * staleMs-cached so no venue calls hit quiet markets. Venues are ranked against whatever the cache
 * already holds, and only the chosen one is firm-quoted. A missing collateral slot or an operator-excluded collateral short-circuits
 * to `no_config` (no API call), preserving no-API-call semantics for a position the bot won't route.
 *
 * `resolvePair` exposes just the pair half of that pipeline, so the graph can learn which pair a
 * collateral sells through once and price it purely at any size. It walks {@link previewUnwrapChain}
 * rather than resolving, so an exotic collateral costs NO amount-dependent work — a PT's pair comes off
 * the TTL-cached markets list and a vault share's off the memoized `asset()`.
 */
export function composeQuoting(deps: {
  httpClient: RateLimitedClient
  selector: Pick<VenueSelector, 'refresh' | 'select'>
  chainId: number
  executor: Address
  venues: readonly Venue[]
  baseUrls: Partial<Record<Venue, string>>
  maxRouteImpactBps: number
  unwrappers: readonly Unwrapper[]
  excludeCollaterals: readonly Address[]
  logger: Logger
}): {
  quoteFor: (plan: LiquidationPlan, out: LensOut, label: string) => Promise<QuoteOutcome>
  /**
   * The pair `collateral` is sold through for `loan`, through the same unwrap chain and operator
   * opt-out `quoteFor` applies, so the graph prices the pair the firm quote will really use. Its size
   * is the seize itself at any size.
   *
   * `null` when there is no such pair to price: an excluded collateral, a sell path that already ends
   * in the loan token, or an unwrap chain whose pair only a size-dependent resolve can name, which is
   * left to the preparation's firm quote. Callers read it as unknown route cost, never as free.
   */
  resolvePair: (collateral: Address, loan: Address) => Promise<VenuePair | null>
} {
  const { selector, excludeCollaterals, logger, executor, unwrappers, ...rest } = deps
  const excluded = (token: Address) =>
    excludeCollaterals.some(candidate => isAddressEqual(candidate, token))
  const { quoteFor: quoteRequest } = composeMultiVenueQuoting({
    ...rest,
    executor,
    unwrappers,
    // Loan-as-collateral slots need no route, and `ALLOW_BAD_DEBT_ONLY` is supported here.
    swapFreeWithoutVenues: true,
    // The composer owns the probe refresh now: it runs after unwrap resolution so probes price the
    // tradable underlying, not an exotic collateral the venues can't quote.
    refresh: selector.refresh,
    select: selector.select,
    logger
  })

  return {
    async resolvePair(collateral, loan) {
      if (excluded(collateral)) return null
      const token = await previewUnwrapChain(unwrappers, { token: collateral, stopToken: loan })
      return token === null || isAddressEqual(token, loan) ? null : { collateral: token, loan }
    },

    async quoteFor(plan, out, label) {
      const collateral = out.market.collateralParams[plan.collateralIndex]
      // `firmCalls: 0` explicitly: an absent count reads as UNKNOWN, and these paths provably spent
      // nothing (see {@link QuoteOutcome.firmCalls}).
      if (!collateral) return { kind: 'no_config', firmCalls: 0 }
      // The operator opt-out applies to the RAW collateral — midnight has no per-collateral config
      // file, so this is its escape hatch from the auto-unwrap path too.
      if (excluded(collateral.token)) {
        logger.info('quote.excluded_collateral', {
          id: label,
          ...candidateOf(plan),
          collateral: collateral.token
        })
        return { kind: 'no_config', firmCalls: 0 }
      }

      return quoteRequest({
        collateralToken: collateral.token,
        loanToken: out.market.loanToken,
        amountIn: plan.seizedAssets,
        referenceAmountOut: expectedLoanOut(plan),
        // Break-even, straight off the plan: the repay `liquidate` will pull for this seize at the LIF
        // the plan was sized at. Read rather than recomputed — the matured-and-unhealthy branch picks a
        // mode by surplus, so the LIF is not recoverable from `postMaturityMode` or from chain time.
        minAcceptableAmountOut: plan.impliedRepaidUnits,
        id: label,
        candidate: candidateOf(plan)
      })
    }
  }
}
