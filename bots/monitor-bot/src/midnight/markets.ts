import type { Logger } from '@repo/bot-kit'

import { delay, fetchWithRetry } from '@repo/utils'

import { MAX_PAGES, REQUEST_TIMEOUT_MS, type MidnightClient } from './client'

type MarketDirectoryDependencies = {
  client: MidnightClient
  logger: Logger
  /** When non-empty, discovery is skipped and these ids are used as-is. */
  fixedMarketIds: string[]
  refreshMs: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

// Supplies the market-id universe the transaction pollers iterate. Either a fixed operator list
// (MARKET_IDS) or all active markets discovered from the API, cached with a TTL so four pollers
// ticking every ~30s don't re-enumerate markets on every tick.
export class MarketDirectory {
  // Caches the in-flight promise (not the result) so concurrent first ticks from several pollers
  // share one discovery sweep; a failed sweep clears the cache so the next tick retries.
  private cache: { promise: Promise<string[]>; fetchedAt: number } | null = null

  constructor(private readonly deps: MarketDirectoryDependencies) {}

  marketIds() {
    if (this.deps.fixedMarketIds.length > 0) return Promise.resolve(this.deps.fixedMarketIds)
    const now = this.deps.now?.() ?? Date.now()
    if (this.cache && now - this.cache.fetchedAt < this.deps.refreshMs) return this.cache.promise
    const promise = this.discover().then(ids => {
      this.deps.logger.info('markets.discovered', { count: ids.length })
      return ids
    })
    const entry = { promise, fetchedAt: now }
    this.cache = entry
    promise.catch(() => {
      if (this.cache === entry) this.cache = null
    })
    return promise
  }

  private async discover() {
    const ids: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await fetchWithRetry(
        () =>
          this.deps.client.GET('/v0/midnight/markets', {
            params: {
              query: { active_only: 'true', limit: 1000, ...(cursor ? { cursor } : {}) }
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
          }),
        { label: 'markets.discover', sleep: this.deps.sleep ?? delay }
      )
      ids.push(...body.data.map(market => market.market_id))
      if (!body.cursor) return ids
      cursor = body.cursor
    }
    this.deps.logger.warn('markets.pages_capped', { maxPages: MAX_PAGES, count: ids.length })
    return ids
  }
}
