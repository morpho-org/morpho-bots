import type { Logger } from '@repo/evm-kit'
import type { RateLimitedClient, SwapConfigEntry } from '@repo/swaps'

import { describe, expect, it } from 'bun:test'
import { getAddress } from 'viem'

import type { MarketParams } from '../src/market'
import type { LiquidationPlan } from '../src/sizing/plan'
import type { LensOut } from '../src/state/lens.sol'

import { ORACLE_PRICE_SCALE, WAD } from '../src/constants'
import { composeQuoting } from '../src/quotes'

// The Blue-shaped adapter over @repo/swaps' composeQuoting: these cases pin the LENS PROJECTION
// (out.params.* → QuoteRequest); the venue/floor behavior itself is tested in the package.

const NOOP_LOGGER: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const ROUTER = getAddress('0x5555555555555555555555555555555555555555')
const LOAN = getAddress('0x6666666666666666666666666666666666666666')
const COLLATERAL = getAddress('0x7777777777777777777777777777777777777777')
const ORACLE = getAddress('0x8888888888888888888888888888888888888888')
const IRM = getAddress('0x46415998764C29aB2a25CbeA6254146D50D22687')
const EXECUTOR = getAddress('0x1111111111111111111111111111111111111111')

const PARAMS: MarketParams = {
  loanToken: LOAN,
  collateralToken: COLLATERAL,
  oracle: ORACLE,
  irm: IRM,
  lltv: (WAD * 86n) / 100n
}

// price = 1e36 → expectedLoanOut = seizedAssets = 1000 (the route-quality reference).
const PLAN: LiquidationPlan = { seizedAssets: 1000n }

const OUT: LensOut = {
  params: PARAMS,
  valid: true,
  hasDebt: true,
  healthy: false,
  blockTimestamp: 1000n,
  borrowShares: 2000n,
  collateral: 1000n,
  accruedTotalBorrowAssets: 2000n,
  totalBorrowShares: 2000n,
  collateralPrice: ORACLE_PRICE_SCALE,
  lltv: PARAMS.lltv
}

const NOOP_HTTP: RateLimitedClient = { getJson: async <T>() => ({}) as T }

function compose(entry: SwapConfigEntry | null) {
  const swapByCollateral = new Map<string, SwapConfigEntry>()
  if (entry) swapByCollateral.set(getAddress(COLLATERAL), entry)
  return composeQuoting({
    httpClient: NOOP_HTTP,
    chainId: 8453,
    executor: EXECUTOR,
    swapByCollateral,
    maxRouteImpactBps: 500,
    logger: NOOP_LOGGER
  })
}

describe('composeQuoting (Blue lens-projection adapter)', () => {
  it('returns no_config when the market collateral has no configured venue', async () => {
    const { quoteFor } = compose(null)
    expect(await quoteFor(PLAN, OUT)).toEqual({ kind: 'no_config' })
  })

  it('projects out.params + the oracle reference into an executable swap', async () => {
    const { quoteFor } = compose({ venue: 'uniswap-v3', router: ROUTER, fee: 3000, slippageBps: 0 })
    const outcome = await quoteFor(PLAN, OUT)
    expect(outcome.kind).toBe('swap')
    if (outcome.kind === 'swap') {
      expect(outcome.swap.spender).toBe(ROUTER)
      // slippageBps 0 → the min-out IS the oracle reference (seizedAssets at price 1e36) — proving
      // expectedLoanOut(plan, out) was passed as referenceAmountOut.
      expect(outcome.swap.amountOutMinimum).toBe(1000n)
    }
  })
})
