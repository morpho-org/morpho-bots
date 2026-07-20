import type { Address } from 'viem'

import { Injectable } from '@nestjs/common'
import { getAddress, isAddress } from 'viem'

export const TOKEN_REGISTRY = Symbol('TOKEN_REGISTRY')

/** Matches the core API's own `<chain_id>:<address>` token selector, lowercased for lookup. */
function tokenKey(chainId: number, address: string) {
  return `${chainId}:${address.toLowerCase()}`
}

/** The token addresses a market's amounts are denominated in. Inferred through `get()`. */
type MarketTokens = {
  /** Needed to key token metadata, which the core API selects as `<chain_id>:<address>`. */
  chainId: number
  /** The token `assets` amounts are denominated in for this market. */
  loanToken: Address
  /** Every collateral the market accepts — markets routinely list more than one. */
  collaterals: Address[]
}

/**
 * ERC-20 identity from `GET /v0/tokens/{chain_id}:{address}` on the Morpho core API. Transcribed
 * from that endpoint's OpenAPI schema: every field is required, but only `chain_id`, `address` and
 * `decimals` are non-nullable — `name` and `symbol` are explicitly nullable and "may be overridden
 * by the Morpho team", so neither can be relied on for formatting.
 */
export type TokenInfo = {
  chainId: number
  address: Address
  name: string | null
  symbol: string | null
  /** The one field that makes a raw amount human-readable. Never null per the schema. */
  decimals: number
}

/** Shape shared by `/markets` and `/books` entries; both carry the tokens we need. */
type MarketLike = {
  market_id: string
  chain_id: number
  loan_token: string
  collaterals: { token: string }[]
}

/**
 * market id → token addresses, learned from responses the bot already fetches.
 *
 * It exists because `/markets/{id}/transactions` items carry only `market_id` — no token address
 * anywhere in the envelope — so the four transaction pollers cannot tell what their `assets` and
 * `units` figures are denominated in. `/markets` and `/books` both do carry `loan_token` and
 * `collaterals[]`, so whoever sweeps those records them here and every poller can resolve a market
 * without an extra request.
 *
 * Deliberately a passive store, not a fetcher: it never performs I/O, so injecting it cannot add
 * latency to a tick or a failure mode to a poller. A miss returns null and the caller falls back
 * to raw units — never a throw, since token metadata is a presentation nicety and alerting is the
 * job that must not break.
 *
 * Collateral-denominated amounts (`supply_collateral`, `withdraw_collateral`, and a liquidation's
 * `seized_assets`) must use the event's own `data.collateral` field, NOT `collaterals` here — this
 * lists what a market accepts, which is usually more than one token, so it cannot identify which
 * one a given event moved.
 */
@Injectable()
export class TokenRegistry {
  private readonly byMarket = new Map<string, MarketTokens>()
  private readonly byToken = new Map<string, TokenInfo>()

  /**
   * Idempotent by design: a re-listed or re-discovered market simply overwrites, so the registry
   * self-heals if a market's configuration ever changes without the process restarting.
   */
  record(market: MarketLike) {
    // `strict: false` — checksum casing is not the precondition here, 20 bytes of hex is. The API
    // returns lowercase on some endpoints and checksummed on others, and `getAddress` normalises
    // either; rejecting a mismatched checksum would blank an otherwise usable market.
    if (!isAddress(market.loan_token, { strict: false })) return false
    this.byMarket.set(market.market_id.toLowerCase(), {
      chainId: market.chain_id,
      loanToken: getAddress(market.loan_token),
      collaterals: market.collaterals
        .map(collateral => collateral.token)
        .filter((token): token is Address => isAddress(token, { strict: false }))
        .map(token => getAddress(token))
    })
    return true
  }

  /** Returns how many markets were rejected, so the caller can surface it rather than swallow it. */
  recordAll(markets: MarketLike[]) {
    let dropped = 0
    for (const market of markets) {
      if (!this.record(market)) dropped++
    }
    return dropped
  }

  /** Null when the market has not been swept yet — callers fall back to raw units. */
  get(marketId: string): MarketTokens | null {
    return this.byMarket.get(marketId.toLowerCase()) ?? null
  }

  loanToken(marketId: string): Address | null {
    return this.get(marketId)?.loanToken ?? null
  }

  get size() {
    return this.byMarket.size
  }

  /** Token metadata is immutable ERC-20 identity, so a hit is cached for the process lifetime. */
  recordToken(info: TokenInfo) {
    this.byToken.set(tokenKey(info.chainId, info.address), info)
  }

  token(chainId: number, address: Address): TokenInfo | null {
    return this.byToken.get(tokenKey(chainId, address)) ?? null
  }

  /** Metadata for the token a market's `assets` amounts are denominated in. */
  loanTokenInfo(marketId: string): TokenInfo | null {
    const market = this.get(marketId)
    return market ? this.token(market.chainId, market.loanToken) : null
  }

  /**
   * Every (chain, token) seen across recorded markets that has no metadata yet — the exact set a
   * loader needs to fetch. Loan and collateral tokens both, deduped: the same token is typically
   * the loan asset of several markets and the collateral of others.
   */
  missingTokens() {
    const missing = new Map<string, { chainId: number; address: Address }>()
    for (const market of this.byMarket.values()) {
      for (const address of [market.loanToken, ...market.collaterals]) {
        const key = tokenKey(market.chainId, address)
        if (!this.byToken.has(key)) missing.set(key, { chainId: market.chainId, address })
      }
    }
    return [...missing.values()]
  }
}
