import type { Logger } from '@repo/bot-kit'
import type {
  QuoteOutcome,
  RateLimitedClient,
  Unwrapper,
  Venue,
  VenuePair,
  VenueSelector
} from '@repo/swaps'
import type { Address } from 'viem'

import { composeMultiVenueQuoting, previewUnwrapChain, resolveUnwraps } from '@repo/swaps'
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
 * `QuoteRequest`. The package resolves the pre-swap unwrap chain, then refreshes the venue probe
 * for the POST-unwrap `(collateral, loan)` pair — gated to this liquidatable pair and staleMs-cached,
 * so no venue calls hit quiet markets — and picks the best venue from the warm cache, firm-quoting
 * only the chosen one. A missing collateral slot or an operator-excluded collateral short-circuits
 * to `no_config` (no API call), preserving no-API-call semantics for a position the bot won't route.
 *
 * `resolveRoute` exposes just the pair half of that pipeline, for the tick's phase A.5, so the expensive
 * half is not duplicated: the probe refresh the composer then drives for the same pair is absorbed by
 * the selector's staleness gate, phase A.5 having already warmed it. It walks
 * {@link previewUnwrapChain} rather than resolving, so an exotic collateral costs NO amount-dependent
 * work here — a PT's pair comes off the TTL-cached markets list and a vault share's off the memoized
 * `asset()`, where resolving would have spent a hosted Pendle request whose calldata is then discarded
 * and re-fetched at quote time. Falls back to a full resolve only if some unwrapper lacks the seam.
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
}): {
  quoteFor: (plan: LiquidationPlan, out: LensOut, label: string) => Promise<QuoteOutcome>
  /**
   * The pair a candidate's seize would actually be sold through, resolved through the same unwrap
   * chain and the same operator opt-out `quoteFor` applies — so the tick warms and prices the venue
   * pair the firm quote will really use, not the raw collateral.
   *
   * `null` when there is nothing to probe: no such collateral slot, an excluded collateral, or a sell
   * path that already ends in the loan token. Callers must read that as unknown route cost rather than
   * as free; only sizing's `swapFree` flag asserts that no route is needed.
   */
  resolveRoute: (
    plan: LiquidationPlan,
    out: LensOut,
    label: string
  ) => Promise<{ pair: VenuePair; amountIn: bigint } | null>
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
    async resolveRoute(plan, out, label) {
      const collateral = out.market.collateralParams[plan.collateralIndex]
      if (!collateral || excluded(collateral.token)) return null
      const previewed = await previewUnwrapChain(unwrappers, {
        token: collateral.token,
        stopToken: out.market.loanToken
      })
      // `amountIn` is a probe-interpolation input, so the seize is close enough: it feeds a cost
      // estimate, never an encoded min-out. The full resolve is the fallback, and only it threads the
      // chain's worst-case output.
      const { token, amountIn } =
        previewed !== null
          ? { token: previewed, amountIn: plan.seizedAssets }
          : await resolveUnwraps(unwrappers, {
              token: collateral.token,
              amountIn: plan.seizedAssets,
              executor,
              stopToken: out.market.loanToken,
              correlation: { id: label, ...candidateOf(plan) }
            })
      if (isAddressEqual(token, out.market.loanToken)) return null
      return { pair: { collateral: token, loan: out.market.loanToken }, amountIn }
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
