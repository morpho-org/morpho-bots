import { describe, expect, it, vi } from 'vitest'

import type { MidnightClient, TransactionItem } from '../../src/midnight/client'
import type { MarketDirectory } from '../../src/midnight/markets'

import { AlertFormatter } from '../../src/alerts/formatter'
import { InMemoryCursorStore } from '../../src/cursor/cursor.store'
import { TransactionFilter } from '../../src/pollers/filter'
import { MarketTransactionsPoller } from '../../src/pollers/market-transactions.poller'
import { TokenRegistry } from '../../src/tokens/registry'
import { capturingDispatcher, fakeLogger } from '../helpers'
import {
  apiPage,
  borrowItem,
  lendItem,
  MARKET_A,
  MARKET_B,
  NO_PRICES,
  USER_TWO
} from '../midnight/fixtures'

const NOW_MS = 1_784_300_000_000
const NOW_S = 1_784_300_000

type Page = { cursor: string | null; data: TransactionItem[] }

function makePoller(
  pages: Record<string, Page[]>,
  marketIds: string[],
  filter = new TransactionFilter({ minAssets: 0n, users: [] })
) {
  // Each GET pops the next queued page for the requested market.
  const queues = new Map(Object.entries(pages).map(([key, value]) => [key, [...value]]))
  const calls: { marketId: string; query: Record<string, unknown> }[] = []
  const client = {
    GET: vi.fn(
      (
        _path: string,
        init: { params: { path: { 'market-id': string }; query: Record<string, unknown> } }
      ) => {
        const marketId = init.params.path['market-id']
        calls.push({ marketId, query: init.params.query })
        const queue = queues.get(marketId) ?? []
        const page = queue.shift() ?? { cursor: null, data: [] }
        return Promise.resolve(apiPage(page))
      }
    )
  } as unknown as MidnightClient
  const directory = { marketIds: () => Promise.resolve(marketIds) } as MarketDirectory
  const cursors = new InMemoryCursorStore()
  const dispatcher = capturingDispatcher()
  const logger = fakeLogger()
  const tokens = new TokenRegistry()
  const poller = new MarketTransactionsPoller(
    { id: 'take-orders', cron: '*/30 * * * * *', eventTypes: ['lend', 'borrow'] },
    {
      state: cursors,
      dispatcher,
      logger,
      tokens,
      formatter: new AlertFormatter({ tokens, prices: NO_PRICES }),
      client,
      directory,
      filter,
      now: () => NOW_MS,
      sleep: () => Promise.resolve()
    }
  )
  return { poller, calls, dispatcher, logger, cursors }
}

describe('MarketTransactionsPoller', () => {
  it('anchors at now on the first tick and queries asc with event types', async () => {
    const { poller, calls, logger } = makePoller({ [MARKET_A]: [{ cursor: null, data: [] }] }, [
      MARKET_A
    ])
    await poller.pollOnce()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.query).toEqual({
      event_types: ['lend', 'borrow'],
      // A fresh anchor has no overlap window — pre-boot history is never replayed.
      created_at_gte: NOW_S,
      sort_direction: 'asc',
      limit: 1000
    })
    expect(logger.info).toHaveBeenCalledWith('poll.anchor', {
      pollerId: 'take-orders',
      marketId: MARKET_A,
      from: NOW_S
    })
  })

  it('dispatches new items and dedupes same-second items on the next tick', async () => {
    const a = lendItem({ id: 'a', created_at: NOW_S + 5 })
    const b = lendItem({ id: 'b', created_at: NOW_S + 5 })
    const c = lendItem({ id: 'c', created_at: NOW_S + 5 })
    const { poller, calls, dispatcher } = makePoller(
      {
        [MARKET_A]: [
          { cursor: null, data: [a, b] },
          { cursor: null, data: [a, b, c] }
        ]
      },
      [MARKET_A]
    )
    await poller.pollOnce()
    expect(dispatcher.sent).toHaveLength(1)
    expect(dispatcher.sent[0]?.map(alert => alert.key)).toEqual(['a', 'b'])

    // Second tick re-queries from the same (inclusive) watermark; only c is new.
    await poller.pollOnce()
    expect(calls[1]?.query.created_at_gte).toBe(NOW_S + 5 - 60)
    expect(dispatcher.sent).toHaveLength(2)
    expect(dispatcher.sent[1]?.map(alert => alert.key)).toEqual(['c'])
  })

  it('catches an item indexed late within the overlap window exactly once', async () => {
    const early = lendItem({ id: 'early', created_at: NOW_S + 50 })
    // Indexed AFTER the watermark advanced to NOW_S+50, with an older timestamp (30s late).
    const late = lendItem({ id: 'late', created_at: NOW_S + 20 })
    const { poller, dispatcher } = makePoller(
      {
        [MARKET_A]: [
          { cursor: null, data: [early] },
          { cursor: null, data: [late, early] },
          { cursor: null, data: [late, early] }
        ]
      },
      [MARKET_A]
    )
    await poller.pollOnce()
    await poller.pollOnce()
    await poller.pollOnce()
    expect(dispatcher.sent.map(batch => batch.map(alert => alert.key))).toEqual([
      ['early'],
      ['late']
    ])
  })

  it('bounds seenIds to the overlap window — old ids expire instead of accreting', async () => {
    const a1 = lendItem({ id: 'a1', created_at: NOW_S + 10 })
    const a2 = lendItem({ id: 'a2', created_at: NOW_S + 30 })
    const a3 = lendItem({ id: 'a3', created_at: NOW_S + 80 })
    const { poller, cursors } = makePoller(
      {
        [MARKET_A]: [
          { cursor: null, data: [a1] },
          { cursor: null, data: [a1, a2] },
          { cursor: null, data: [a1, a2, a3] }
        ]
      },
      [MARKET_A]
    )
    await poller.pollOnce()
    await poller.pollOnce()
    await poller.pollOnce()
    const saved =
      await cursors.get<Record<string, { lastCreatedAt: number; seenIds: string[] }>>('take-orders')
    // Watermark NOW_S+80, cutoff NOW_S+20 — a1 (NOW_S+10) must have expired from seenIds.
    expect(saved?.[MARKET_A]).toEqual({ lastCreatedAt: NOW_S + 80, seenIds: ['a2', 'a3'] })
  })

  it('walks pagination cursors within one tick', async () => {
    const a = lendItem({ id: 'a', created_at: NOW_S + 1 })
    const b = lendItem({ id: 'b', created_at: NOW_S + 2 })
    const { poller, calls, dispatcher } = makePoller(
      {
        [MARKET_A]: [
          { cursor: 'next-page', data: [a] },
          { cursor: null, data: [b] }
        ]
      },
      [MARKET_A]
    )
    await poller.pollOnce()
    expect(calls).toHaveLength(2)
    expect(calls[1]?.query.cursor).toBe('next-page')
    expect(dispatcher.sent[0]?.map(alert => alert.key)).toEqual(['a', 'b'])
  })

  it('keeps per-market watermarks independent', async () => {
    const fastMarket = lendItem({ id: 'fast', created_at: NOW_S + 100, market_id: MARKET_A })
    const slowMarket = lendItem({ id: 'slow', created_at: NOW_S + 1, market_id: MARKET_B })
    const { poller, calls } = makePoller(
      {
        [MARKET_A]: [
          { cursor: null, data: [fastMarket] },
          { cursor: null, data: [] }
        ],
        [MARKET_B]: [
          { cursor: null, data: [slowMarket] },
          { cursor: null, data: [] }
        ]
      },
      [MARKET_A, MARKET_B]
    )
    await poller.pollOnce()
    await poller.pollOnce()
    const second = calls.slice(2)
    expect(second.find(call => call.marketId === MARKET_A)?.query.created_at_gte).toBe(
      NOW_S + 100 - 60
    )
    expect(second.find(call => call.marketId === MARKET_B)?.query.created_at_gte).toBe(
      NOW_S + 1 - 60
    )
  })

  it('caps pagination and logs when MAX_PAGES is hit', async () => {
    const endless = Array.from({ length: 25 }, (_, index) => ({
      cursor: 'more',
      data: [lendItem({ id: `item-${index}`, created_at: NOW_S + index })]
    }))
    const { poller, calls, logger } = makePoller({ [MARKET_A]: endless }, [MARKET_A])
    await poller.pollOnce()
    expect(calls).toHaveLength(20)
    expect(logger.warn).toHaveBeenCalledWith('poll.pages_capped', {
      pollerId: 'take-orders',
      marketId: MARKET_A,
      maxPages: 20
    })
  })

  it('isolates a failing market: others advance, the failed one retries from its cursor', async () => {
    const good = lendItem({ id: 'good', created_at: NOW_S + 10, market_id: MARKET_B })
    const { poller, calls, dispatcher, logger } = makePoller(
      {
        [MARKET_B]: [
          { cursor: null, data: [good] },
          { cursor: null, data: [] }
        ]
      },
      [MARKET_A, MARKET_B]
    )
    // MARKET_A has no queued pages — make its GET reject instead.
    const originalGet = (
      poller as unknown as { ext: { client: { GET: ReturnType<typeof vi.fn> } } }
    ).ext.client.GET
    originalGet.mockImplementation(
      (
        _path: string,
        init: { params: { path: { 'market-id': string }; query: Record<string, unknown> } }
      ) => {
        const marketId = init.params.path['market-id']
        calls.push({ marketId, query: init.params.query })
        if (marketId === MARKET_A) return Promise.reject(new Error('boom'))
        return Promise.resolve(
          apiPage({
            cursor: null,
            data: calls.filter(c => c.marketId === MARKET_B).length > 1 ? [] : [good]
          })
        )
      }
    )

    await poller.pollOnce()
    expect(dispatcher.sent[0]?.map(alert => alert.key)).toEqual(['good'])
    expect(logger.warn).toHaveBeenCalledWith(
      'poll.market_error',
      expect.objectContaining({ pollerId: 'take-orders', marketId: MARKET_A })
    )

    // Next tick: the failed market retries from its anchor watermark, the good one advanced.
    const afterFirstTick = calls.length
    await poller.pollOnce()
    const second = calls.slice(afterFirstTick)
    expect(second.find(call => call.marketId === MARKET_A)?.query.created_at_gte).toBe(NOW_S - 60)
    expect(second.find(call => call.marketId === MARKET_B)?.query.created_at_gte).toBe(
      NOW_S + 10 - 60
    )
  })

  it('throws when every market fails so the tick surfaces as poll.error', async () => {
    const { poller } = makePoller({}, [MARKET_A, MARKET_B])
    const client = (poller as unknown as { ext: { client: { GET: ReturnType<typeof vi.fn> } } }).ext
      .client
    client.GET.mockImplementation(() => Promise.reject(new Error('outage')))
    await expect(poller.pollOnce()).rejects.toThrow('all 2 markets failed')
  })

  it('dispatches one alert when both legs of a take arrive in the same tick', async () => {
    const lend = lendItem({ id: 'l', created_at: NOW_S + 5 })
    const borrow = borrowItem({ id: 'b', created_at: NOW_S + 5 })
    const { poller, dispatcher } = makePoller(
      { [MARKET_A]: [{ cursor: null, data: [lend, borrow] }] },
      [MARKET_A]
    )
    await poller.pollOnce()
    expect(dispatcher.sent[0]?.map(alert => alert.key)).toEqual(['l+b'])
  })

  it('sends the merged take when only one leg passes the user filter', async () => {
    // lendItem's account is USER_ONE (buyer); borrowItem's is USER_TWO (seller) — scope to seller.
    const lend = lendItem({ id: 'l', created_at: NOW_S + 5 })
    const borrow = borrowItem({ id: 'b', created_at: NOW_S + 5 })
    const { poller, dispatcher } = makePoller(
      { [MARKET_A]: [{ cursor: null, data: [lend, borrow] }] },
      [MARKET_A],
      new TransactionFilter({ minAssets: 0n, users: [USER_TWO] })
    )
    await poller.pollOnce()
    expect(dispatcher.sent[0]?.map(alert => alert.key)).toEqual(['l+b'])
  })

  it('alerts a late-indexed second leg singly instead of dropping it', async () => {
    const lend = lendItem({ id: 'l', created_at: NOW_S + 5 })
    const borrow = borrowItem({ id: 'b', created_at: NOW_S + 5 })
    const { poller, dispatcher } = makePoller(
      {
        [MARKET_A]: [
          { cursor: null, data: [lend] },
          { cursor: null, data: [lend, borrow] }
        ]
      },
      [MARKET_A]
    )
    await poller.pollOnce()
    await poller.pollOnce()
    expect(dispatcher.sent.map(batch => batch.map(alert => alert.key))).toEqual([['l'], ['b']])
  })

  it('sorts dispatched items across markets by created_at', async () => {
    const late = lendItem({ id: 'late', created_at: NOW_S + 50, market_id: MARKET_A })
    const early = lendItem({ id: 'early', created_at: NOW_S + 10, market_id: MARKET_B })
    const { poller, dispatcher } = makePoller(
      {
        [MARKET_A]: [{ cursor: null, data: [late] }],
        [MARKET_B]: [{ cursor: null, data: [early] }]
      },
      [MARKET_A, MARKET_B]
    )
    await poller.pollOnce()
    expect(dispatcher.sent[0]?.map(alert => alert.key)).toEqual(['early', 'late'])
  })
})
