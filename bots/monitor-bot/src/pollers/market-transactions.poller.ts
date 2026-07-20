import { delay, ensureError, fetchWithRetry, tryCatch } from '@repo/utils'
import chunk from 'lodash-es/chunk'

import type { MidnightClient, MidnightEventType, TransactionItem } from '../midnight/client'
import type { MarketDirectory } from '../midnight/markets'
import type { PollerDependencies } from '../polling/poller'
import type { TransactionFilter } from './filter'

import { MARKET_CONCURRENCY, MAX_PAGES, REQUEST_TIMEOUT_MS } from '../midnight/client'
import { Poller } from '../polling/poller'
import { formatTransactionAlert } from './format'

type MarketCursor = {
  /** Watermark: everything strictly before this unix second has been processed. */
  lastCreatedAt: number
  /** Item ids already alerted AT the watermark second (created_at_gte is inclusive). */
  seenIds: string[]
}

type TxCursor = Record<string, MarketCursor>

type MarketTransactionsPollerOptions = {
  id: string
  cron: string
  eventTypes: MidnightEventType[]
}

type MarketTransactionsPollerDependencies = PollerDependencies & {
  client: MidnightClient
  directory: MarketDirectory
  filter: TransactionFilter
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

// Advance the per-market watermark to the newest second seen, carrying same-second ids so the
// next (inclusive) created_at_gte query can drop already-processed items.
function advance(prev: MarketCursor, items: TransactionItem[]): MarketCursor {
  const last = items.at(-1)
  if (!last) return prev
  const carried = prev.lastCreatedAt === last.created_at ? prev.seenIds : []
  const seenIds = [
    ...carried,
    ...items.filter(item => item.created_at === last.created_at).map(item => item.id)
  ]
  return { lastCreatedAt: last.created_at, seenIds }
}

// One poller instance per observe target (take orders, repays, collateral, liquidations) — the
// event_types filter is the only behavioral difference, so they share this class and are
// instantiated with different options in the polling module.
export class MarketTransactionsPoller extends Poller<TxCursor, TransactionItem> {
  readonly id: string
  readonly cron: string
  private readonly eventTypes: MidnightEventType[]

  constructor(
    options: MarketTransactionsPollerOptions,
    private readonly ext: MarketTransactionsPollerDependencies
  ) {
    super(ext)
    this.id = options.id
    this.cron = options.cron
    this.eventTypes = options.eventTypes
  }

  protected async fetch(cursor: TxCursor | null) {
    const marketIds = await this.ext.directory.marketIds()
    // No saved position (first tick, restart, or newly-discovered market): anchor at now rather
    // than replaying history; the skipped window is surfaced via poll.anchor.
    const anchor = Math.floor((this.ext.now?.() ?? Date.now()) / 1000)
    const nextCursor: TxCursor = {}
    const items: TransactionItem[] = []
    let failures = 0
    for (const batch of chunk(marketIds, MARKET_CONCURRENCY)) {
      const results = await Promise.all(batch.map(id => this.pollMarket(id, cursor, anchor)))
      for (const result of results) {
        nextCursor[result.marketId] = result.cursor
        if (result.fresh === null) failures++
        else items.push(...result.fresh)
      }
    }
    // Per-market failures keep their own cursor and retry next tick; only a full sweep failure
    // (systemic outage) aborts the tick so the cron errorHandler surfaces it.
    if (marketIds.length > 0 && failures === marketIds.length) {
      throw new Error(`all ${failures} markets failed`)
    }
    items.sort((a, b) => a.created_at - b.created_at)
    return { items, nextCursor }
  }

  // One market's fetch, error-isolated: a market that persistently fails (e.g. delisted id
  // returning 400) must not starve every other market's alerts forever.
  private async pollMarket(marketId: string, cursor: TxCursor | null, anchor: number) {
    const prev = cursor?.[marketId] ?? this.anchorMarket(marketId, anchor)
    const { data: fetched, error } = await tryCatch(this.fetchMarket(marketId, prev.lastCreatedAt))
    if (error) {
      this.ext.logger.warn('poll.market_error', {
        pollerId: this.id,
        marketId,
        error: ensureError(error).message
      })
      return { marketId, cursor: prev, fresh: null }
    }
    const seen = new Set(prev.seenIds)
    const fresh = fetched.filter(item => !seen.has(item.id))
    return { marketId, cursor: advance(prev, fresh), fresh }
  }

  protected toAlerts(items: TransactionItem[]) {
    return items.filter(item => this.ext.filter.matches(item)).map(formatTransactionAlert)
  }

  private anchorMarket(marketId: string, anchor: number): MarketCursor {
    this.ext.logger.info('poll.anchor', { pollerId: this.id, marketId, from: anchor })
    return { lastCreatedAt: anchor, seenIds: [] }
  }

  private async fetchMarket(marketId: string, from: number) {
    const collected: TransactionItem[] = []
    let pageCursor: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await fetchWithRetry(
        () =>
          this.ext.client.GET('/v0/midnight/markets/{market-id}/transactions', {
            params: {
              path: { 'market-id': marketId },
              query: {
                event_types: this.eventTypes,
                created_at_gte: from,
                sort_direction: 'asc',
                limit: 1000,
                ...(pageCursor ? { cursor: pageCursor } : {})
              }
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
          }),
        { label: `${this.id}.transactions`, sleep: this.ext.sleep ?? delay }
      )
      collected.push(...body.data)
      if (!body.cursor) return collected
      pageCursor = body.cursor
    }
    this.ext.logger.warn('poll.pages_capped', { pollerId: this.id, marketId, maxPages: MAX_PAGES })
    return collected
  }
}
