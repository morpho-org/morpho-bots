import { describe, expect, it, vi } from 'vitest'

import type { MidnightClient } from '../../src/midnight/client'

import { MarketDirectory } from '../../src/midnight/markets'
import { fakeLogger } from '../helpers'
import { apiPage, MARKET_A, MARKET_B } from './fixtures'

function marketsClient(pages: { cursor: string | null; ids: string[] }[]) {
  const queue = [...pages]
  return {
    GET: vi.fn(() => {
      const page = queue.shift() ?? { cursor: null, ids: [] }
      return Promise.resolve(
        apiPage({ cursor: page.cursor, data: page.ids.map(id => ({ market_id: id })) })
      )
    })
  } as unknown as MidnightClient
}

const noSleep = () => Promise.resolve()

describe('MarketDirectory', () => {
  it('returns fixed ids without calling the API', async () => {
    const client = marketsClient([])
    const directory = new MarketDirectory({
      client,
      logger: fakeLogger(),
      fixedMarketIds: [MARKET_A],
      refreshMs: 1000,
      sleep: noSleep
    })
    expect(await directory.marketIds()).toEqual([MARKET_A])
    expect(client.GET).not.toHaveBeenCalled()
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
      refreshMs: 10_000,
      now: () => now,
      sleep: noSleep
    })
    expect(await directory.marketIds()).toEqual([MARKET_A])
    now = 10_001
    expect(await directory.marketIds()).toEqual([MARKET_A, MARKET_B])
    expect(client.GET).toHaveBeenCalledTimes(2)
  })
})
