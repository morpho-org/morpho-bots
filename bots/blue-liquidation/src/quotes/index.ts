import type { Address } from 'viem'

import { assertNever, ensureError, tryCatch } from '@repo/utils'
import { getAddress } from 'viem'

import type { SwapConfigEntry } from '../config'
import type { Logger } from '../logger'
import type { LiquidationPlan } from '../sizing/plan'
import type { LensOut } from '../state/lens.sol'
import type { RateLimitedClient } from './http-client'
import type { QuoteOutcome, QuoteParameters, Swap } from './types'

import { BPS } from '../constants'
import { expectedLoanOut } from '../execution/swap-step'
import { QuoteError } from './types'
import { quoteOneInch } from './venues/oneinch'
import { quoteUniswapV3 } from './venues/uniswap-v3'
import { quoteZerox } from './venues/zerox'

// Dispatches one quote to the configured venue's adapter. Uniswap is local; aggregators hit the API.
// `async` so a SYNCHRONOUS throw from the local Uniswap arm (e.g. calldata encoding) becomes a
// rejection caught by the caller's tryCatch — not an escape that aborts the whole tick.
async function quoteByVenue(
  client: RateLimitedClient,
  entry: SwapConfigEntry,
  params: QuoteParameters
): Promise<Swap> {
  switch (entry.venue) {
    case 'uniswap-v3':
      return quoteUniswapV3(entry, params)
    case '0x':
      return quoteZerox(client, entry, params)
    case '1inch':
      return quoteOneInch(client, entry, params)
    default:
      return assertNever(entry)
  }
}

/**
 * Builds the `quoteFor` the tick consumes. For each liquidatable position it resolves the operator's
 * per-collateral venue (Blue markets have a single collateral, `out.params.collateralToken`), fetches
 * ONE executable quote (Uniswap is local; aggregators make a single API call), and sanity-checks an
 * aggregator's quoted output against the free oracle reference — rejecting a route worse than
 * `maxRouteImpactBps` below it. Quote/route failures return `failed` (the tick backs the position
 * off); an unconfigured collateral returns `no_config` (no API call, no backoff). Quotes are made
 * ONLY for liquidatable positions, so API usage is bounded by the (small) liquidatable set, never the
 * full candidate universe.
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
  const { httpClient, chainId, executor, swapByCollateral, maxRouteImpactBps, logger } = deps

  return {
    async quoteFor(plan, out) {
      const collateralToken = out.params.collateralToken
      const entry = swapByCollateral.get(getAddress(collateralToken))
      if (!entry) return { kind: 'no_config' }

      const referenceAmountOut = expectedLoanOut(plan, out)
      const params: QuoteParameters = {
        chainId,
        tokenIn: collateralToken,
        tokenOut: out.params.loanToken,
        // Seize-exact: the contract transfers exactly `plan.seizedAssets` to the Executor before the
        // callback, so this is exactly the collateral the swap will sell — no prediction needed.
        amountIn: plan.seizedAssets,
        slippageBps: entry.slippageBps,
        executor,
        referenceAmountOut
      }

      const { data: swap, error } = await tryCatch(quoteByVenue(httpClient, entry, params))
      if (error || !swap) {
        const reason = error instanceof QuoteError ? error.reason : 'api_error'
        logger.warn('quote.failed', {
          venue: entry.venue,
          collateral: collateralToken,
          reason,
          detail: ensureError(error).message
        })
        return { kind: 'failed', reason }
      }

      // Free, oracle-based route-quality check (no extra API call): reject a route whose output is
      // more than `maxRouteImpactBps` below the oracle's no-slippage reference. The aggregator's own
      // min-out is still the on-chain bound; this is a pre-broadcast guard against a bad route.
      const floor = (referenceAmountOut * (BPS - BigInt(maxRouteImpactBps))) / BPS
      if (swap.expectedAmountOut < floor) {
        logger.warn('quote.bad_route', {
          venue: entry.venue,
          collateral: collateralToken,
          expected: swap.expectedAmountOut,
          oracle: referenceAmountOut
        })
        return { kind: 'failed', reason: 'bad_route' }
      }

      logger.info('quote.ok', {
        venue: entry.venue,
        collateral: collateralToken,
        expected: swap.expectedAmountOut,
        oracle: referenceAmountOut,
        amountOutMinimum: swap.amountOutMinimum
      })
      return { kind: 'swap', swap }
    }
  }
}
