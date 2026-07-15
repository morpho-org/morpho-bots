import { describe, expect, it } from 'bun:test'
import { getAddress } from 'viem'

import type { SwapConfigEntry } from '../src/config'
import type { RateLimitedClient } from '../src/http-client'
import type { QuoteLogger, QuoteRequest } from '../src/quoting'
import type { Venue } from '../src/types'

import { ONEINCH_ROUTER, ZEROX_ALLOWANCE_HOLDER } from '../src/constants'
import { composeMultiVenueQuoting, composeQuoting, passesRouteQuality } from '../src/quoting'
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

describe('passesRouteQuality', () => {
  // floor = 1000 × (10000 - 500) / 10000 = 950.
  it('accepts an output at or above the floor', () => {
    expect(passesRouteQuality({ expected: 950n, reference: 1000n, maxBps: 500 })).toBe(true)
    expect(passesRouteQuality({ expected: 1200n, reference: 1000n, maxBps: 500 })).toBe(true)
  })

  it('rejects an output below the floor', () => {
    expect(passesRouteQuality({ expected: 949n, reference: 1000n, maxBps: 500 })).toBe(false)
  })
})

// A 0x-shaped firm-quote body (AllowanceHolder) with the given buyAmount.
function zeroxBody(buyAmount: string) {
  return {
    liquidityAvailable: true,
    buyAmount,
    minBuyAmount: buyAmount,
    transaction: { to: ROUTER, data: '0xabc', value: '0' }
  }
}

// A 1inch-shaped firm-swap body with the given dstAmount.
function oneInchBody(dstAmount: string) {
  return { dstAmount, tx: { to: ROUTER, data: '0xdef', value: '0' } }
}

const LIFI_SPENDER = getAddress('0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB')

// A LiFi-shaped firm-quote body with the given toAmount.
function lifiBody(toAmount: string) {
  return {
    estimate: { approvalAddress: LIFI_SPENDER, toAmount, toAmountMin: toAmount },
    transactionRequest: { to: ROUTER, data: '0xfee', value: '0x0' }
  }
}

const LIQUIDSWAP_TARGET = getAddress('0x2222222222222222222222222222222222222222')

// A LiquidSwap-shaped firm-route body; `amountOut` is a decimal string parsed at `decimals: 0`.
function liquidSwapBody(amountOut: string) {
  return {
    success: true,
    amountOut,
    tokens: { tokenOut: { decimals: 0 } },
    execution: { to: LIQUIDSWAP_TARGET, calldata: '0x0abc', details: { minAmountOut: amountOut } }
  }
}

// A client that dispatches a fixed body per venue (throws no_route for an unstubbed venue).
function multiHttp(bodies: Partial<Record<Venue, unknown>>): RateLimitedClient {
  return {
    getJson: async <T>(args: { venue: Venue }) => {
      const body = bodies[args.venue]
      if (body === undefined) throw new QuoteError('no_route', `no stub for ${args.venue}`)
      return body as T
    }
  }
}

function composeMulti(
  venues: Venue[],
  order: { venue: Venue; expectedOut: bigint }[],
  httpClient: RateLimitedClient
) {
  return composeMultiVenueQuoting({
    httpClient,
    chainId: 8453,
    executor: EXECUTOR,
    venues,
    slippageBps: 50,
    baseUrls: {},
    maxRouteImpactBps: 500, // floor = 950
    select: () => order,
    logger: NOOP_LOGGER
  })
}

describe('composeMultiVenueQuoting', () => {
  it('returns no_config (no API call) when no venues are enabled', async () => {
    const { quoteFor } = composeMulti([], [], multiHttp({}))
    expect(await quoteFor(REQUEST)).toEqual({ kind: 'no_config' })
  })

  it('quotes the top-ranked venue when it passes route quality', async () => {
    const { quoteFor } = composeMulti(
      ['0x', '1inch'],
      [
        { venue: '0x', expectedOut: 1000n },
        { venue: '1inch', expectedOut: 980n }
      ],
      multiHttp({ '0x': zeroxBody('1000'), '1inch': oneInchBody('980') })
    )
    const outcome = await quoteFor(REQUEST)
    expect(outcome.kind).toBe('swap')
    // 0x's AllowanceHolder spender proves the 0x arm won (not 1inch's router).
    if (outcome.kind === 'swap') expect(outcome.swap.spender).toBe(ZEROX_ALLOWANCE_HOLDER)
  })

  it('falls through to the runner-up venue when the top one fails route quality', async () => {
    const { quoteFor } = composeMulti(
      ['0x', '1inch'],
      [
        { venue: '0x', expectedOut: 900n },
        { venue: '1inch', expectedOut: 990n }
      ],
      // 0x quotes 900 (< floor 950) → fall through; 1inch quotes 990 (≥ 950) → win.
      multiHttp({ '0x': zeroxBody('900'), '1inch': oneInchBody('990') })
    )
    const outcome = await quoteFor(REQUEST)
    expect(outcome.kind).toBe('swap')
    if (outcome.kind === 'swap') expect(outcome.swap.spender).toBe(ONEINCH_ROUTER[8453]!)
  })

  it('uses the deterministic enabled-venue order when the pair is not yet probed (cold cache)', async () => {
    const { quoteFor } = composeMulti(['0x', '1inch'], [], multiHttp({ '0x': zeroxBody('1000') }))
    const outcome = await quoteFor(REQUEST)
    expect(outcome.kind).toBe('swap')
    if (outcome.kind === 'swap') expect(outcome.swap.spender).toBe(ZEROX_ALLOWANCE_HOLDER)
  })

  it('quotes the lifi arm (approvalAddress spender) when it is ranked top', async () => {
    const { quoteFor } = composeMulti(
      ['lifi', '0x'],
      [
        { venue: 'lifi', expectedOut: 1000n },
        { venue: '0x', expectedOut: 980n }
      ],
      multiHttp({ lifi: lifiBody('1000'), '0x': zeroxBody('980') })
    )
    const outcome = await quoteFor(REQUEST)
    expect(outcome.kind).toBe('swap')
    // LiFi's approvalAddress proves the lifi arm won (entryFor + quoteByVenue dispatch).
    if (outcome.kind === 'swap') expect(outcome.swap.spender).toBe(LIFI_SPENDER)
  })

  it('quotes the liquidswap arm (execution.to spender) when ranked top, with tokenInDecimals', async () => {
    const { quoteFor } = composeMulti(
      ['liquidswap', '0x'],
      [
        { venue: 'liquidswap', expectedOut: 1000n },
        { venue: '0x', expectedOut: 980n }
      ],
      multiHttp({ liquidswap: liquidSwapBody('1000'), '0x': zeroxBody('980') })
    )
    // tokenInDecimals is required for liquidswap to denominate amountIn.
    const outcome = await quoteFor({ ...REQUEST, tokenInDecimals: 6 })
    expect(outcome.kind).toBe('swap')
    if (outcome.kind === 'swap') expect(outcome.swap.spender).toBe(LIQUIDSWAP_TARGET)
  })

  it('falls through liquidswap (fails, no escape) when the request omits tokenInDecimals', async () => {
    const { quoteFor } = composeMulti(
      ['liquidswap', '0x'],
      [
        { venue: 'liquidswap', expectedOut: 1000n },
        { venue: '0x', expectedOut: 1000n }
      ],
      multiHttp({ liquidswap: liquidSwapBody('1000'), '0x': zeroxBody('1000') })
    )
    // No tokenInDecimals → liquidswap throws api_error → coverage-first fall-through to 0x.
    const outcome = await quoteFor(REQUEST)
    expect(outcome.kind).toBe('swap')
    if (outcome.kind === 'swap') expect(outcome.swap.spender).toBe(ZEROX_ALLOWANCE_HOLDER)
  })

  it('fails with the last reason when every ranked venue fails', async () => {
    const { quoteFor } = composeMulti(
      ['0x'],
      [{ venue: '0x', expectedOut: 1000n }],
      multiHttp({ '0x': { liquidityAvailable: false } })
    )
    expect(await quoteFor(REQUEST)).toEqual({ kind: 'failed', reason: 'no_route' })
  })
})
