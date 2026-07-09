import { describe, expect, it } from 'bun:test'
import { getAddress } from 'viem'

import type { SwapConfigEntry } from '../src/config'
import type { RateLimitedClient } from '../src/http-client'
import type { QuoteLogger, QuoteRequest } from '../src/quoting'

import { composeQuoting } from '../src/quoting'
import { QuoteError } from '../src/types'

const NOOP_LOGGER: QuoteLogger = { info: () => {}, warn: () => {} }

const ROUTER = getAddress('0x5555555555555555555555555555555555555555')
const LOAN = getAddress('0x6666666666666666666666666666666666666666')
const COLLATERAL = getAddress('0x7777777777777777777777777777777777777777')
const EXECUTOR = getAddress('0x1111111111111111111111111111111111111111')

// referenceAmountOut = amountIn = 1000 (i.e. an oracle price of exactly 1) — the route-quality
// reference the maxRouteImpactBps floor is applied to.
const REQUEST: QuoteRequest = {
  collateralToken: COLLATERAL,
  loanToken: LOAN,
  amountIn: 1000n,
  referenceAmountOut: 1000n
}

function httpStub(body: unknown): RateLimitedClient {
  return { getJson: async <T>() => body as T }
}

const throwingHttp: RateLimitedClient = {
  getJson: async () => {
    throw new QuoteError('rate_limited', 'boom')
  }
}

function compose(entry: SwapConfigEntry | null, httpClient: RateLimitedClient) {
  const swapByCollateral = new Map<string, SwapConfigEntry>()
  if (entry) swapByCollateral.set(getAddress(COLLATERAL), entry)
  return composeQuoting({
    httpClient,
    chainId: 8453,
    executor: EXECUTOR,
    swapByCollateral,
    maxRouteImpactBps: 500, // floor = 1000 × 0.95 = 950
    logger: NOOP_LOGGER
  })
}

describe('composeQuoting', () => {
  it('returns no_config when the collateral has no configured venue', async () => {
    const { quoteFor } = compose(null, httpStub({}))
    expect(await quoteFor(REQUEST)).toEqual({ kind: 'no_config' })
  })

  it('returns a uniswap swap (local, no API) when configured', async () => {
    const { quoteFor } = compose(
      { venue: 'uniswap-v3', router: ROUTER, fee: 3000, slippageBps: 50 },
      httpStub({})
    )
    const outcome = await quoteFor(REQUEST)
    expect(outcome.kind).toBe('swap')
    if (outcome.kind === 'swap') expect(outcome.swap.spender).toBe(ROUTER)
  })

  it('rejects an aggregator route worse than maxRouteImpactBps below the oracle reference', async () => {
    // buyAmount 900 < floor 950 → bad route.
    const { quoteFor } = compose(
      { venue: '0x', slippageBps: 50 },
      httpStub({
        liquidityAvailable: true,
        buyAmount: '900',
        minBuyAmount: '895',
        transaction: { to: ROUTER, data: '0xabc' }
      })
    )
    expect(await quoteFor(REQUEST)).toEqual({ kind: 'failed', reason: 'bad_route' })
  })

  it('accepts an aggregator route at or above the floor', async () => {
    const { quoteFor } = compose(
      { venue: '0x', slippageBps: 50 },
      httpStub({
        liquidityAvailable: true,
        buyAmount: '990',
        minBuyAmount: '985',
        transaction: { to: ROUTER, data: '0xabc' }
      })
    )
    expect((await quoteFor(REQUEST)).kind).toBe('swap')
  })

  it('maps an adapter QuoteError to a failed outcome with its reason', async () => {
    const { quoteFor } = compose({ venue: '0x', slippageBps: 50 }, throwingHttp)
    expect(await quoteFor(REQUEST)).toEqual({ kind: 'failed', reason: 'rate_limited' })
  })
})
