import { describe, expect, it, vi } from 'vitest'

import type { MidnightClient } from '../../src/midnight/client'

import { MarketDirectory } from '../../src/midnight/markets'
import { TokenRegistry } from '../../src/tokens/registry'
import { fakeLogger } from '../helpers'
import { apiPage, MARKET_A, MARKET_B } from './fixtures'

function marketsClient(pages: { cursor: string | null; ids: string[] }[]) {
  const queue = [...pages]
  return {
    GET: vi.fn(() => {
      const page = queue.shift() ?? { cursor: null, ids: [] }
      return Promise.resolve(
        apiPage({
          cursor: page.cursor,
          data: page.ids.map(id => ({
            market_id: id,
            chain_id: 8453,
            loan_token: LOAN_TOKEN,
            collaterals: [{ token: COLLATERAL_TOKEN }]
          }))
        })
      )
    })
  } as unknown as MidnightClient
}

const LOAN_TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const COLLATERAL_TOKEN = '0x4200000000000000000000000000000000000006'

const noSleep = () => Promise.resolve()

describe('MarketDirectory', () => {
  // Fixed scope still issues one hydration call per TTL, because MARKET_IDS supplies ids but not
  // the token addresses every alert needs to render a denomination — without it the registry
  // would stay permanently empty in this mode.
  it('returns fixed ids and hydrates their tokens', async () => {
    const client = marketsClient([{ cursor: null, ids: [MARKET_A] }])
    const directory = new MarketDirectory({
      client,
      logger: fakeLogger(),
      fixedMarketIds: [MARKET_A],
      tokens: new TokenRegistry(),
      refreshMs: 1000,
      sleep: noSleep
    })
    expect(await directory.marketIds()).toEqual([MARKET_A])
    expect(client.GET).toHaveBeenCalledTimes(1)
  })

  it('discovers across pages and caches within the TTL', async () => {
    const client = marketsClient([
      { cursor: 'page-2', ids: [MARKET_A] },
      { cursor: null, ids: [MARKET_B] }
    ])
    let now = 0
    const directory = new MarketDirectory({
      client,
      logger: fakeLogger(),
      fixedMarketIds: [],
      tokens: new TokenRegistry(),
      refreshMs: 10_000,
      now: () => now,
      sleep: noSleep
    })
    expect(await directory.marketIds()).toEqual([MARKET_A, MARKET_B])
    expect(client.GET).toHaveBeenCalledTimes(2)

    now = 9_999
    expect(await directory.marketIds()).toEqual([MARKET_A, MARKET_B])
    expect(client.GET).toHaveBeenCalledTimes(2)
  })

  it('shares one discovery across concurrent callers', async () => {
    const client = marketsClient([{ cursor: null, ids: [MARKET_A] }])
    const directory = new MarketDirectory({
      client,
      logger: fakeLogger(),
      fixedMarketIds: [],
      tokens: new TokenRegistry(),
      refreshMs: 10_000,
      now: () => 0,
      sleep: noSleep
    })
    const [first, second] = await Promise.all([directory.marketIds(), directory.marketIds()])
    expect(first).toEqual([MARKET_A])
    expect(second).toEqual([MARKET_A])
    expect(client.GET).toHaveBeenCalledTimes(1)
  })

  it('clears the cache when discovery fails so the next call retries', async () => {
    const client = {
      GET: vi
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockRejectedValueOnce(new Error('boom'))
        .mockRejectedValueOnce(new Error('boom'))
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue(apiPage({ cursor: null, data: [{ market_id: MARKET_A }] }))
    } as unknown as MidnightClient
    const directory = new MarketDirectory({
      client,
      logger: fakeLogger(),
      fixedMarketIds: [],
      tokens: new TokenRegistry(),
      refreshMs: 10_000,
      now: () => 0,
      sleep: noSleep
    })
    // fetchWithRetry exhausts its 3 retries on the persistent failure, then the call rejects.
    await expect(directory.marketIds()).rejects.toThrow('markets.discover request failed')
    expect(await directory.marketIds()).toEqual([MARKET_A])
  })

  it('refetches after the TTL expires', async () => {
    const client = marketsClient([
      { cursor: null, ids: [MARKET_A] },
      { cursor: null, ids: [MARKET_A, MARKET_B] }
    ])
    let now = 0
    const directory = new MarketDirectory({
      client,
      logger: fakeLogger(),
      fixedMarketIds: [],
      tokens: new TokenRegistry(),
      refreshMs: 10_000,
      now: () => now,
      sleep: noSleep
    })
    expect(await directory.marketIds()).toEqual([MARKET_A])
    now = 10_001
    expect(await directory.marketIds()).toEqual([MARKET_A, MARKET_B])
    expect(client.GET).toHaveBeenCalledTimes(2)
  })

  // The whole point of the change: both sweeps must populate the registry. Without these, the
  // recordAll calls in markets.ts could be deleted and the suite would still pass.
  it('populates the token registry from a discovery sweep', async () => {
    const tokens = new TokenRegistry()
    const client = marketsClient([{ cursor: null, ids: [MARKET_A, MARKET_B] }])
    const directory = new MarketDirectory({
      client,
      logger: fakeLogger(),
      fixedMarketIds: [],
      tokens,
      refreshMs: 1000,
      sleep: noSleep
    })
    await directory.marketIds()
    expect(tokens.size).toBe(2)
    expect(tokens.loanToken(MARKET_A)).toBe(LOAN_TOKEN)
    expect(tokens.get(MARKET_B)?.collaterals).toEqual([COLLATERAL_TOKEN])
  })

  it('populates the token registry in fixed-id mode too', async () => {
    const tokens = new TokenRegistry()
    const client = marketsClient([{ cursor: null, ids: [MARKET_A] }])
    const directory = new MarketDirectory({
      client,
      logger: fakeLogger(),
      fixedMarketIds: [MARKET_A],
      tokens,
      refreshMs: 1000,
      sleep: noSleep
    })
    expect(await directory.marketIds()).toEqual([MARKET_A])
    expect(tokens.loanToken(MARKET_A)).toBe(LOAN_TOKEN)
  })

  it('still returns fixed ids when hydration fails, and retries on the next tick', async () => {
    const tokens = new TokenRegistry()
    const logger = fakeLogger()
    const client = {
      GET: vi.fn(() => Promise.reject(new Error('boom')))
    } as unknown as MidnightClient
    const directory = new MarketDirectory({
      client,
      logger,
      fixedMarketIds: [MARKET_A],
      tokens,
      refreshMs: 1_000_000,
      sleep: noSleep
    })
    // Scope must not shrink because metadata is unavailable.
    expect(await directory.marketIds()).toEqual([MARKET_A])
    expect(tokens.size).toBe(0)
    expect(logger.warn).toHaveBeenCalledWith('markets.tokens_unavailable', expect.anything())

    // A failed hydration must NOT be cached for the whole TTL — the next tick retries.
    const calls = (client.GET as ReturnType<typeof vi.fn>).mock.calls.length
    await directory.marketIds()
    expect((client.GET as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(calls)
  })

  it('batches fixed ids so the market_ids query string stays bounded', async () => {
    const tokens = new TokenRegistry()
    const many = Array.from({ length: 120 }, (_, i) => `0x${String(i).padStart(64, '0')}`)
    const client = marketsClient([
      { cursor: null, ids: many.slice(0, 50) },
      { cursor: null, ids: many.slice(50, 100) },
      { cursor: null, ids: many.slice(100) }
    ])
    const directory = new MarketDirectory({
      client,
      logger: fakeLogger(),
      fixedMarketIds: many,
      tokens,
      refreshMs: 1000,
      sleep: noSleep
    })
    await directory.marketIds()
    // 120 ids at 50 per request = 3 calls.
    expect(client.GET).toHaveBeenCalledTimes(3)
    expect(tokens.size).toBe(120)
  })
})
