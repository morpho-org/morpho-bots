import type { Logger } from '@repo/bot-kit'
import type { Address } from 'viem'

import { delay, ensureError, fetchWithRetry, tryCatch } from '@repo/utils'
import chunk from 'lodash-es/chunk'
import { getAddress, isAddress, isAddressEqual } from 'viem'

import type { CoreClient, TokenResponse } from '../core/client'
import type { TokenEntry, TokenRegistry } from './registry'

import { CORE_REQUEST_TIMEOUT_MS } from '../core/client'
import { tokenKey } from './registry'

/** Concurrent token lookups — one request per token, so keep it polite. */
const TOKEN_CONCURRENCY = 8

const MAX_DECIMALS = 255

type TokenMetadataLoaderDependencies = {
  client: CoreClient
  logger: Logger
  tokens: TokenRegistry
  sleep?: (ms: number) => Promise<void>
}

type RequestedToken = { chainId: number; address: Address }

/**
 * Narrows the generated response to what the registry stores.
 *
 * The generated types are compile-time only, so the runtime checks here are not redundant with
 * them: this is a separate service on a separate deploy cycle, and a drifted `decimals` would
 * otherwise flow straight into every formatted amount. The response identity must match the
 * requested token — storing a different token under the requested selector would leave the
 * requested one permanently "missing", refetched every sweep while logging as resolved. `name` is
 * nullable by contract and carried as-is; `symbol` is nullable upstream too, but the formatter
 * labels every amount with it, so a token returned without one is left unresolved (raw-units
 * fallback) rather than stored unlabeled.
 */
function parseToken(data: TokenResponse, requested: RequestedToken): TokenEntry | null {
  // Also covers a missing/NaN chain_id: nothing equals the requested integer.
  if (data.chain_id !== requested.chainId) return null
  if (!isAddress(data.address, { strict: false })) return null
  if (!isAddressEqual(data.address, requested.address)) return null
  if (!Number.isInteger(data.decimals) || data.decimals < 0 || data.decimals > MAX_DECIMALS) {
    return null
  }
  if (!data.symbol) return null
  return {
    chainId: data.chain_id,
    // Checksummed so stored metadata matches the addresses `TokenRegistry` holds for markets.
    address: getAddress(data.address),
    name: data.name,
    symbol: data.symbol,
    decimals: data.decimals
  }
}

/**
 * Fills in ERC-20 identity for tokens the registry knows about but has no metadata for.
 *
 * Kept separate from `TokenRegistry` so the registry stays a passive store that never performs
 * I/O — injecting it into every poller must not be able to add latency or a failure mode to a
 * tick. This loader is the one place that reaches the network for token data.
 *
 * Token identity is immutable, so a success is cached for the process lifetime and never refetched.
 * A failure simply leaves the token missing, so the next sweep retries it: at worst one request per
 * unresolvable token per market-refresh interval, and alerts fall back to raw units meanwhile.
 */
export class TokenMetadataLoader {
  /**
   * Tokens whose failure has already been reported at warn. A token that never resolves is retried
   * every sweep by design, so without this an unreachable endpoint emits one warn per token per
   * refresh — ~2,300/day for 16 tokens — indefinitely. That volume trains operators to ignore
   * warns, so only the first failure per token is warn-level and the repeats drop to debug. A
   * success clears the entry, keeping the set bounded to tokens that are still failing.
   */
  private readonly reported = new Set<string>()

  constructor(private readonly deps: TokenMetadataLoaderDependencies) {}

  /**
   * Resolves whatever is still missing. Safe to call after every sweep — once the set is fully
   * populated this makes no requests at all.
   */
  async ensure() {
    const missing = this.deps.tokens.missingTokens()
    if (missing.length === 0) return 0
    let resolved = 0
    for (const batch of chunk(missing, TOKEN_CONCURRENCY)) {
      const results = await Promise.all(batch.map(token => this.fetchToken(token)))
      for (const info of results) {
        if (!info) continue
        this.deps.tokens.recordToken(info)
        this.reported.delete(tokenKey(info.chainId, info.address))
        resolved++
      }
    }
    const summary = { requested: missing.length, resolved, unresolved: missing.length - resolved }
    // Resolving nothing at all is a misconfiguration, not routine: an info line named "resolved"
    // that permanently reports zero reads as success to anyone skimming the logs.
    if (resolved === 0) this.deps.logger.warn('tokens.unresolved', summary)
    else this.deps.logger.info('tokens.resolved', summary)
    return resolved
  }

  private async fetchToken(requested: RequestedToken) {
    const { chainId, address } = requested
    const { data: body, error } = await tryCatch(
      fetchWithRetry(
        () =>
          this.deps.client.GET('/v0/tokens/{token-selector}', {
            // The core API's documented selector format. openapi-fetch encodes path params, so the
            // colon reaches the server escaped rather than being read as a scheme separator.
            params: { path: { 'token-selector': `${chainId}:${address}` } },
            signal: AbortSignal.timeout(CORE_REQUEST_TIMEOUT_MS)
          }),
        // One quick in-sweep retry only: `marketIds()` awaits `ensure()`, so the default policy
        // would let a core-API brownout stall every poller's tick for ~20s per token. A failed
        // token is retried on the next sweep anyway (see class doc).
        { label: 'tokens.lookup', sleep: this.deps.sleep ?? delay, maxRetries: 1 }
      )
    )
    if (error) {
      // Warn, not throw: token metadata is a presentation nicety. Losing it degrades alerts to raw
      // units, which is strictly better than failing the sweep that discovers markets.
      this.report(requested, 'tokens.lookup_failed', {
        chainId,
        address,
        error: ensureError(error).message
      })
      return null
    }
    const info = parseToken(body.data, requested)
    if (!info) this.report(requested, 'tokens.unparsable', { chainId, address })
    return info
  }

  /** First failure per token warns; repeats drop to debug (see `reported`). */
  private report(token: RequestedToken, event: string, fields: Record<string, unknown>) {
    const key = tokenKey(token.chainId, token.address)
    if (this.reported.has(key)) this.deps.logger.debug(event, fields)
    else {
      this.reported.add(key)
      this.deps.logger.warn(event, fields)
    }
  }
}
