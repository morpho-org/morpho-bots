import type { Hex } from 'viem'

import type { MaturityPremiumConfig } from '../domain/maturity-premium'

import { BootstrapAdapterError } from './bootstrap/bootstrap-adapter.error'

/** Milliseconds one latest-block read is shared across a same-cycle sweep of maturity reads. */
const BLOCK_SHARE_MS = 15_000

/** Minimal market-data reader resolving the SDK maturity helper for one market. */
type MaturityMarketReader = {
  getMarketData(marketId: Hex): Promise<{ timeToMaturity(timestamp: bigint): bigint }>
}

/** Minimal latest-block reader supplying the timestamp the SDK helper zero-floors against. */
type LatestBlockReader = {
  getBlock(parameters: { blockTag: 'latest' }): Promise<{ timestamp: bigint }>
}

/**
 * Builds the per-market fresh seconds-to-maturity readers required by maturity premiums.
 * @param parameters - Input object: `entries` are one workflow's configured markets, whose
 * optional `maturityPremium` selects the markets that need the observation beside every rate
 * read; `midnight` resolves SDK market data; and `client` reads the latest block.
 * @returns Readers indexed by market, present only for entries configuring a maturity premium.
 * @throws Nothing while building; a returned reader rejects with the stable sanitized
 * `BootstrapAdapterError` `maturity-read` classification when its market or block read fails, so
 * the composed reference-rate service halts on a repository-owned failure instead of an
 * implementation-specific provider error, and never quotes without the configured premium input.
 * @remarks Shared by the bootstrap and ladder production factories so both workflows resolve the
 * identical curve input. Reads are batched across a cycle instead of issuing two requests per
 * market: the market read is cached per market after its first success because the on-chain
 * maturity is immutable (only `timeToMaturity` is consumed from the cached data), and one
 * latest-block read is shared for a bounded fifteen-second monotonic-clock window so a serial
 * multi-market sweep sees about one block request per cycle and a wall-clock step (NTP correction,
 * restored VM snapshot) can never extend the share window. The bounded timestamp staleness is harmless because integer
 * flooring moves a resolved premium roughly one BPS per several days. Each reader still resolves
 * its market and block inputs concurrently through `Promise.all`, decay stays clocked on
 * `block.timestamp` via SDK `Market.timeToMaturity` rather than wall clock, and a failed read is
 * evicted so the next cycle retries instead of caching the failure.
 */
export const maturityReadsByMarket = (parameters: {
  entries: readonly { marketId: Hex; maturityPremium?: MaturityPremiumConfig }[]
  midnight: MaturityMarketReader
  client: LatestBlockReader
}): ReadonlyMap<Hex, () => Promise<bigint>> => {
  const marketReads = new Map<Hex, Promise<{ timeToMaturity(timestamp: bigint): bigint }>>()
  let sharedBlock: { at: number; read: Promise<{ timestamp: bigint }> } | undefined
  const marketData = (marketId: Hex) => {
    const cached = marketReads.get(marketId)
    if (cached !== undefined) return cached
    const read = parameters.midnight.getMarketData(marketId).catch((error: unknown) => {
      marketReads.delete(marketId)
      throw error
    })
    marketReads.set(marketId, read)
    return read
  }
  const latestBlock = () => {
    if (sharedBlock !== undefined && performance.now() - sharedBlock.at < BLOCK_SHARE_MS) {
      return sharedBlock.read
    }
    const refreshed = {
      at: performance.now(),
      read: parameters.client.getBlock({ blockTag: 'latest' }).catch((error: unknown) => {
        if (sharedBlock === refreshed) sharedBlock = undefined
        throw error
      })
    }
    sharedBlock = refreshed
    return refreshed.read
  }
  return new Map(
    parameters.entries
      .filter(entry => entry.maturityPremium !== undefined)
      .map(
        entry =>
          [
            entry.marketId,
            async () => {
              try {
                const [market, block] = await Promise.all([
                  marketData(entry.marketId),
                  latestBlock()
                ])
                return market.timeToMaturity(block.timestamp)
              } catch {
                throw new BootstrapAdapterError('maturity-read')
              }
            }
          ] as const
      )
  )
}
