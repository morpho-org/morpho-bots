import { delay, ensureError, fetchWithRetry, tryCatch } from '@repo/utils'
import chunk from 'lodash-es/chunk'

import type { MidnightClient, MidnightEventType, TransactionItem } from '../midnight/client'
import type { MarketDirectory } from '../midnight/markets'
import type { PollerDependencies } from '../polling/poller'
import type { TransactionFilter } from './filter'

import { MARKET_CONCURRENCY, MAX_PAGES, REQUEST_TIMEOUT_MS } from '../midnight/client'
import { Poller } from '../polling/poller'
import { formatTransactionAlert } from './format'

// The watermark design assumes items never appear in the feed with a created_at more than
// OVERLAP_SECONDS below what has already been returned (late indexing / out-of-order ingestion).
// Every fetch re-covers this window below the watermark and dedupes by stable id, so an item
// indexed up to OVERLAP_SECONDS late is still caught exactly once; anything later than that is
// missed by design (the assumption boundary).
const OVERLAP_SECONDS = 60

type MarketCursor = {
  /** Watermark: the newest created_at second processed for this market. */
  lastCreatedAt: number
  /** Item ids already alerted within [watermark − OVERLAP_SECONDS, watermark]. */
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

// Advance the per-market watermark to the newest second seen. `fetched` is the FULL page walk
// (including already-seen overlap items), so rebuilding seenIds from it covers the whole
// [watermark − OVERLAP_SECONDS, watermark] window the next fetch will re-query.
function advance(prev: MarketCursor, fetched: TransactionItem[]): MarketCursor {
  const last = fetched.at(-1)
  if (!last) return prev
  // max() so a watermark can never regress if the newest item vanished from the feed.
  const lastCreatedAt = Math.max(prev.lastCreatedAt, last.created_at)
  const cutoff = lastCreatedAt - OVERLAP_SECONDS
  const carried = prev.seenIds.length > 0 && prev.lastCreatedAt >= cutoff ? prev.seenIds : []
  const seenIds = [
    ...new Set([
      ...carried,
      ...fetched.filter(item => item.created_at >= cutoff).map(item => item.id)
    ])
  ]
  return { lastCreatedAt, seenIds }
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
    const from = Math.max(prev.lastCreatedAt - OVERLAP_SECONDS, 0)
    const { data: fetched, error } = await tryCatch(this.fetchMarket(marketId, from))
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
    return { marketId, cursor: advance(prev, fetched), fresh }
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
