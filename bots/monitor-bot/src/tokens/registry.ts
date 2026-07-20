import type { Address } from 'viem'

import { Injectable } from '@nestjs/common'
import { getAddress, isAddress } from 'viem'

export const TOKEN_REGISTRY = Symbol('TOKEN_REGISTRY')

/** The token addresses a market's amounts are denominated in. Inferred through `get()`. */
type MarketTokens = {
  /** The chain the market lives on, per the listing response. */
  chainId: number
  /** The token `assets` amounts are denominated in for this market. */
  loanToken: Address
  /** Every collateral the market accepts — markets routinely list more than one. */
  collaterals: Address[]
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
 * to raw units — never a throw, since token denominations are a presentation nicety and alerting
 * is the job that must not break.
 *
 * Collateral-denominated amounts (`supply_collateral`, `withdraw_collateral`, and a liquidation's
 * `seized_assets`) must use the event's own `data.collateral` field, NOT `collaterals` here — this
 * lists what a market accepts, which is usually more than one token, so it cannot identify which
 * one a given event moved.
 */
@Injectable()
export class TokenRegistry {
  private readonly byMarket = new Map<string, MarketTokens>()

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
}
