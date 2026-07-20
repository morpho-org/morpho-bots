import type { Logger } from '@repo/bot-kit'

import { delay, ensureError, fetchWithRetry } from '@repo/utils'
import chunk from 'lodash-es/chunk'

import type { TokenMetadataLoader } from '../tokens/metadata'
import type { TokenRegistry } from '../tokens/registry'

import { MAX_PAGES, REQUEST_TIMEOUT_MS, type MidnightClient } from './client'

/**
 * The spec caps `market_ids` at 100, but URL length binds first: each id costs ~78 bytes of query
 * string, so a full 100-id batch lands within 4% of the 8 KB request-line limit common to nginx
 * and friends. Half that leaves headroom for the base URL and any param added later.
 */
const MARKET_IDS_PER_REQUEST = 50

type MarketDirectoryDependencies = {
  client: MidnightClient
  logger: Logger
  /** When non-empty, discovery is skipped and these ids are used as-is. */
  fixedMarketIds: string[]
  refreshMs: number
  /** Populated from the sweep so transaction pollers can resolve a market's tokens. */
  tokens: TokenRegistry
  /** Resolves ERC-20 metadata for whatever the sweep just recorded. */
  tokenMetadata: TokenMetadataLoader
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
    // Fixed scope still sweeps — not for the ids, which are already known, but for the token
    // metadata behind them. Without this the registry would stay empty whenever MARKET_IDS is set,
    // and every transaction alert would silently fall back to raw units.
    if (this.deps.fixedMarketIds.length > 0) return this.fixedWithTokens()
    const now = this.deps.now?.() ?? Date.now()
    if (this.cache && now - this.cache.fetchedAt < this.deps.refreshMs) return this.cache.promise
    const promise = this.discover().then(async ids => {
      this.deps.logger.info('markets.discovered', { count: ids.length })
      // After recording, not before: the loader reads what the sweep just wrote. Failures inside
      // are logged and swallowed there, so this can never fail market discovery.
      await this.deps.tokenMetadata.ensure()
      // Ids at debug so the info line stays a one-glance count — the full list is ~78 entries and
      // would bury every other startup log.
      this.deps.logger.debug('markets.listed', {
        count: ids.length,
        tokensKnown: this.deps.tokens.size,
        marketIds: ids
      })
      return ids
    })
    const entry = { promise, fetchedAt: now }
    this.cache = entry
    promise.catch(() => {
      if (this.cache === entry) this.cache = null
    })
    return promise
  }

  /**
   * Operator-fixed ids, hydrated once per TTL so their tokens are known. The ids are returned
   * as configured even if the sweep fails — a metadata outage must not shrink the polled scope.
   */
  private fixedWithTokens() {
    const ids = this.deps.fixedMarketIds
    const now = this.deps.now?.() ?? Date.now()
    if (this.cache && now - this.cache.fetchedAt < this.deps.refreshMs) return this.cache.promise
    const entry = {
      // Ids resolve even when hydration fails: a metadata outage must never shrink the polled
      // scope. The cache is cleared on failure so the next tick retries the metadata, matching
      // `discover`'s policy — otherwise one blip would leave the registry empty for a full TTL.
      promise: this.hydrate(ids)
        .then(() => this.deps.tokenMetadata.ensure())
        .then(() => [...ids])
        .catch(error => {
          this.deps.logger.warn('markets.tokens_unavailable', {
            error: ensureError(error).message
          })
          if (this.cache === entry) this.cache = null
          return [...ids]
        }),
      fetchedAt: now
    }
    this.cache = entry
    return entry.promise
  }

  private async hydrate(marketIds: string[]) {
    for (const batch of chunk(marketIds, MARKET_IDS_PER_REQUEST)) {
      const body = await fetchWithRetry(
        () =>
          this.deps.client.GET('/v0/midnight/markets', {
            params: { query: { market_ids: batch, limit: 1000 } },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
          }),
        { label: 'markets.hydrate', sleep: this.deps.sleep ?? delay }
      )
      this.reportDropped(this.deps.tokens.recordAll(body.data), batch.length)
    }
  }

  private reportDropped(dropped: number, total: number) {
    if (dropped > 0) {
      this.deps.logger.warn('markets.tokens_dropped', {
        dropped,
        total,
        size: this.deps.tokens.size
      })
    }
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
      // Recorded from the response already in hand — the tokens cost no extra request.
      this.reportDropped(this.deps.tokens.recordAll(body.data), body.data.length)
      ids.push(...body.data.map(market => market.market_id))
      if (!body.cursor) return ids
      cursor = body.cursor
    }
    this.deps.logger.warn('markets.pages_capped', { maxPages: MAX_PAGES, count: ids.length })
    return ids
  }
}
