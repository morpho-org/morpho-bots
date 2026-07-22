import type { Logger } from '@repo/bot-kit'
import type { Address } from 'viem'

import { delay, ensureError, fetchWithRetry, tryCatch } from '@repo/utils'
import chunk from 'lodash-es/chunk'

import type { CoreClient } from '../core/client'
import type { TokenRegistry } from './registry'

import { CORE_REQUEST_TIMEOUT_MS } from '../core/client'

/** Concurrent price lookups — one request per token, same politeness as the metadata loader. */
const PRICE_CONCURRENCY = 8

type TokenPriceCacheDependencies = {
  client: CoreClient
  logger: Logger
  tokens: TokenRegistry
  sleep?: (ms: number) => Promise<void>
}

function priceKey(chainId: number, address: string) {
  return `${chainId}:${address.toLowerCase()}`
}

/** What formatters need from the cache — the sync lookup, without the refresh machinery. */
export type PriceLookup = Pick<TokenPriceCache, 'usd'>

/**
 * USD spot prices for the tokens alerts mention, from the core API's hourly price feed.
 *
 * Unlike `TokenMetadataLoader`'s immutable identity, prices are volatile — so every `refresh()`
 * refetches the registry's full referenced-token set (~tens of tokens each market sweep, which is
 * the refresh cadence). A failed lookup keeps the previous price: a slightly stale figure beats a
 * blank one, and alerts only ever use prices as display context next to the exact token amount.
 * Lookups are synchronous so a poller can never be slowed or failed by pricing.
 */
export class TokenPriceCache {
  private readonly byToken = new Map<string, number>()

  constructor(private readonly deps: TokenPriceCacheDependencies) {}

  /** USD spot price, or null for a token never priced (no quote upstream, or lookups failing). */
  usd(chainId: number, address: string): number | null {
    return this.byToken.get(priceKey(chainId, address)) ?? null
  }

  /** Refetches every referenced token's price. Called after each market sweep. */
  async refresh() {
    const wanted = this.deps.tokens.referencedTokens()
    if (wanted.length === 0) return 0
    let resolved = 0
    for (const batch of chunk(wanted, PRICE_CONCURRENCY)) {
      const results = await Promise.all(batch.map(token => this.fetchPrice(token)))
      for (const price of results) {
        if (price === null) continue
        this.byToken.set(priceKey(price.chainId, price.address), price.usd)
        resolved++
      }
    }
    // Resolving zero prices with the whole set requested means the feed (or key) is broken —
    // worth a warn, since every alert silently loses its $-figures while this persists.
    const summary = { requested: wanted.length, resolved }
    if (resolved === 0) this.deps.logger.warn('prices.unresolved', summary)
    else this.deps.logger.debug('prices.refreshed', summary)
    return resolved
  }

  private async fetchPrice({ chainId, address }: { chainId: number; address: Address }) {
    const { data: body, error } = await tryCatch(
      fetchWithRetry(
        () =>
          this.deps.client.GET('/v0/tokens/{token-selector}/price', {
            params: { path: { 'token-selector': `${chainId}:${address}` } },
            signal: AbortSignal.timeout(CORE_REQUEST_TIMEOUT_MS)
          }),
        { label: 'prices.lookup', sleep: this.deps.sleep ?? delay }
      )
    )
    if (error) {
      // Debug, not warn: a whole-feed outage already warns once per refresh via `prices.unresolved`,
      // and a single flaky token self-heals next sweep while its stale price keeps serving.
      this.deps.logger.debug('prices.lookup_failed', {
        chainId,
        address,
        error: ensureError(error).message
      })
      return null
    }
    const usd = body.data.price
    // Null is a contract value ("no USD quote available"), not an error — leave the token unpriced.
    if (typeof usd !== 'number' || !Number.isFinite(usd)) return null
    return { chainId, address, usd }
  }
}
