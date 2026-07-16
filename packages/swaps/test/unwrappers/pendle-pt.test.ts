import { describe, expect, it } from 'bun:test'
import { getAddress } from 'viem'

import type { HttpVenue, RateLimitedClient } from '../../src/http-client'
import type { QuoteLogger } from '../../src/quoting'
import type { PendleMarketsState } from '../../src/unwrappers/pendle-pt'

import { QuoteError } from '../../src/types'
import { createPendlePtUnwrapper } from '../../src/unwrappers/pendle-pt'

const NOOP_LOGGER: QuoteLogger = { info: () => {}, warn: () => {} }

function spyLogger() {
  const events: { level: string; event: string; fields?: Record<string, unknown> }[] = []
  return {
    logger: {
      info: (event: string, fields?: Record<string, unknown>) =>
        events.push({ level: 'info', event, fields }),
      warn: (event: string, fields?: Record<string, unknown>) =>
        events.push({ level: 'warn', event, fields })
    } satisfies QuoteLogger,
    events
  }
}

const CHAIN_ID = 8453
const PT = getAddress('0x1111111111111111111111111111111111111101')
const YT = getAddress('0x1111111111111111111111111111111111111102')
const MARKET = getAddress('0x1111111111111111111111111111111111111103')
const UNDERLYING = getAddress('0x1111111111111111111111111111111111111104')
const ROUTER = getAddress('0x888888888889758F76e7103c6CbF23ABbF58F946')
const EXECUTOR = getAddress('0x2222222222222222222222222222222222222222')
const NOT_A_PT = getAddress('0x3333333333333333333333333333333333333333')

const T0 = 1_800_000_000_000 // fixed "now" (ms)
const FUTURE = new Date(T0 + 86_400_000).toISOString()
const PAST = new Date(T0 - 86_400_000).toISOString()

function marketsBody(expiry: string) {
  return {
    markets: [
      {
        address: MARKET,
        pt: `${CHAIN_ID}-${PT.toLowerCase()}`,
        yt: `${CHAIN_ID}-${YT.toLowerCase()}`,
        underlyingAsset: `${CHAIN_ID}-${UNDERLYING.toLowerCase()}`,
        expiry
      }
    ]
  }
}

const convertBody = {
  tx: { to: ROUTER, data: '0xdeadbeef', value: '0' },
  data: { amountOut: '10000' }
}

type Call = { venue: HttpVenue; url: string; searchParams?: Record<string, string> }

// A fake RateLimitedClient dispatching by URL path, recording every request.
function fakeHttp(bodies: { markets?: () => unknown; convert?: () => unknown }) {
  const calls: Call[] = []
  const client: RateLimitedClient = {
    async getJson<T>(args: Call) {
      calls.push(args)
      if (args.url.includes('/v1/markets/all')) {
        if (!bodies.markets) throw new QuoteError('api_error', 'markets stub missing')
        return bodies.markets() as T
      }
      if (!bodies.convert) throw new QuoteError('api_error', 'convert stub missing')
      return bodies.convert() as T
    }
  }
  return { client, calls }
}

function unwrapperWith(
  bodies: { markets?: () => unknown; convert?: () => unknown },
  overrides: { initialState?: PendleMarketsState; logger?: QuoteLogger } = {}
) {
  const { client, calls } = fakeHttp(bodies)
  const unwrapper = createPendlePtUnwrapper({
    client,
    chainId: CHAIN_ID,
    slippageBps: 50,
    baseUrl: 'https://pendle.test/core',
    logger: overrides.logger ?? NOOP_LOGGER,
    now: () => T0,
    ...(overrides.initialState ? { initialState: overrides.initialState } : {})
  })
  return { unwrapper, calls }
}

describe('createPendlePtUnwrapper', () => {
  it('converts an ACTIVE PT via the market swap endpoint into a fixed router step', async () => {
    const { unwrapper, calls } = unwrapperWith({
      markets: () => marketsBody(FUTURE),
      convert: () => convertBody
    })

    const result = await unwrapper.resolve({ token: PT, amountIn: 5000n, executor: EXECUTOR })
    expect(result).not.toBeNull()
    if (!result) return

    // One markets fetch, then the swap endpoint (active PT — expiry is in the future).
    expect(calls).toHaveLength(2)
    expect(calls[0]!.venue).toBe('pendle')
    expect(calls[1]!.url).toBe(`https://pendle.test/core/v2/sdk/${CHAIN_ID}/markets/${MARKET}/swap`)
    expect(calls[1]!.searchParams).toEqual({
      receiver: EXECUTOR,
      slippage: '0.005', // 50 bps as a decimal fraction
      tokenIn: PT,
      tokenOut: UNDERLYING,
      amountIn: '5000'
    })

    expect(result.step).toMatchObject({
      tokenIn: PT,
      tokenOut: UNDERLYING,
      target: ROUTER,
      value: 0n,
      callData: '0xdeadbeef',
      amountIn: { source: 'fixed', value: 5000n },
      approvalSpender: ROUTER // the Router pulls the PT via transferFrom
    })
    expect(result.expectedAmountOut).toBe(10000n)
    // Conservative floor estimate: 10000 × (10000 − 50) / 10000.
    expect(result.amountOutMinimum).toBe(9950n)
  })

  it('converts an EXPIRED PT via the redeem endpoint (yt-addressed, aggregator off)', async () => {
    const { unwrapper, calls } = unwrapperWith({
      markets: () => marketsBody(PAST),
      convert: () => convertBody
    })

    const result = await unwrapper.resolve({ token: PT, amountIn: 5000n, executor: EXECUTOR })
    expect(result?.step.target).toBe(ROUTER)
    expect(calls[1]!.url).toBe(`https://pendle.test/core/v2/sdk/${CHAIN_ID}/redeem`)
    expect(calls[1]!.searchParams).toEqual({
      receiver: EXECUTOR,
      slippage: '0.005',
      yt: YT,
      amountIn: '5000',
      tokenOut: UNDERLYING,
      enableAggregator: 'false'
    })
  })

  it('resolves a non-PT to null off ONE cached markets fetch', async () => {
    const { unwrapper, calls } = unwrapperWith({ markets: () => marketsBody(FUTURE) })
    expect(
      await unwrapper.resolve({ token: NOT_A_PT, amountIn: 1n, executor: EXECUTOR })
    ).toBeNull()
    expect(
      await unwrapper.resolve({ token: NOT_A_PT, amountIn: 1n, executor: EXECUTOR })
    ).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('skips the markets fetch entirely when restored from a fresh initialState, and dumps it back', async () => {
    const initialState: PendleMarketsState = {
      fetchedAt: T0 - 1000, // fresh (staleMs default is 6h)
      markets: [{ pt: PT, yt: YT, market: MARKET, expiry: FUTURE, underlying: UNDERLYING }]
    }
    const { unwrapper, calls } = unwrapperWith({ convert: () => convertBody }, { initialState })

    const result = await unwrapper.resolve({ token: PT, amountIn: 5000n, executor: EXECUTOR })
    expect(result?.step.tokenOut).toBe(UNDERLYING)
    // Only the convert call — no /v1/markets/all request.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('/swap')
    expect(unwrapper.dump()).toEqual(initialState)
  })

  it('refetches when the restored state is older than staleMs', async () => {
    const initialState: PendleMarketsState = { fetchedAt: T0 - 7 * 60 * 60 * 1000, markets: [] }
    const { unwrapper, calls } = unwrapperWith(
      { markets: () => marketsBody(FUTURE), convert: () => convertBody },
      { initialState }
    )
    const result = await unwrapper.resolve({ token: PT, amountIn: 5000n, executor: EXECUTOR })
    expect(result).not.toBeNull()
    expect(calls[0]!.url).toContain('/v1/markets/all')
    expect(unwrapper.dump()?.fetchedAt).toBe(T0)
  })

  it('falls back to a STALE list on fetch failure (warn) without re-stamping it', async () => {
    const initialState: PendleMarketsState = {
      fetchedAt: T0 - 7 * 60 * 60 * 1000, // stale
      markets: [{ pt: PT, yt: YT, market: MARKET, expiry: FUTURE, underlying: UNDERLYING }]
    }
    const { logger, events } = spyLogger()
    const { unwrapper, calls } = unwrapperWith(
      {
        markets: () => {
          throw new QuoteError('api_error', 'pendle down')
        },
        convert: () => convertBody
      },
      { initialState, logger }
    )

    const result = await unwrapper.resolve({ token: PT, amountIn: 5000n, executor: EXECUTOR })
    expect(result?.step.tokenOut).toBe(UNDERLYING)
    expect(events.some(e => e.event === 'pendle.markets_stale')).toBe(true)

    // The stale cache was NOT re-stamped as fresh — the next resolve retries the fetch.
    await unwrapper.resolve({ token: PT, amountIn: 5000n, executor: EXECUTOR })
    expect(calls.filter(call => call.url.includes('/v1/markets/all'))).toHaveLength(2)
  })

  it('throws on fetch failure with NO cached data — never persisted as an empty list', async () => {
    const { unwrapper, calls } = unwrapperWith({
      markets: () => {
        throw new QuoteError('rate_limited', 'pendle down')
      }
    })

    expect(unwrapper.resolve({ token: PT, amountIn: 1n, executor: EXECUTOR })).rejects.toThrow(
      'pendle down'
    )
    expect(unwrapper.dump()).toBeNull()

    // The failure was not cached: the next resolve fetches again.
    expect(unwrapper.resolve({ token: PT, amountIn: 1n, executor: EXECUTOR })).rejects.toThrow()
    expect(calls).toHaveLength(2)
  })

  it('drops a market entry with a malformed expiry (warn) instead of treating it as active', async () => {
    const { logger, events } = spyLogger()
    const { unwrapper } = unwrapperWith({ markets: () => marketsBody('not-a-date') }, { logger })
    expect(await unwrapper.resolve({ token: PT, amountIn: 1n, executor: EXECUTOR })).toBeNull()
    expect(events.some(e => e.event === 'pendle.market_malformed')).toBe(true)
  })

  it('throws api_error on malformed convert responses', async () => {
    const badData = unwrapperWith({
      markets: () => marketsBody(FUTURE),
      convert: () => ({ tx: { to: ROUTER, data: 'nothex' }, data: { amountOut: '1' } })
    })
    expect(
      badData.unwrapper.resolve({ token: PT, amountIn: 1n, executor: EXECUTOR })
    ).rejects.toThrow(/malformed swap tx/)

    const badAmount = unwrapperWith({
      markets: () => marketsBody(FUTURE),
      convert: () => ({ tx: { to: ROUTER, data: '0xabc1' }, data: { amountOut: 'NaN' } })
    })
    expect(
      badAmount.unwrapper.resolve({ token: PT, amountIn: 1n, executor: EXECUTOR })
    ).rejects.toThrow(/malformed amountOut/)
  })
})
