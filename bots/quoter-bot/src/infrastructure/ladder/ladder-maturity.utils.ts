import type { Hex } from 'viem'

import type { BootstrapRawGroup } from '../bootstrap/bootstrap-groups.utils'

/**
 * Projects one market's maturity timestamp from maker groups already read this cycle.
 * @param groups - Current maker groups returned by the Morpho API.
 * @param marketId - Market whose maturity is wanted.
 * @returns The market maturity, or `undefined` when no read group carries one for this market.
 * @remarks Deliberately a projection rather than a market read: monitoring must not add an RPC
 * round trip to the quoting path. A maker holding no indexed group in the market therefore reports
 * no maturity, so downstream carry attribution must treat the field as optional.
 */
export const ladderMarketMaturity = (groups: readonly BootstrapRawGroup[], marketId: Hex) => {
  for (const group of groups) {
    if (group.marketId === marketId && group.maturity !== undefined) return group.maturity
    for (const offer of group.offers) {
      if (offer.marketId === marketId && offer.maturity !== undefined) return offer.maturity
    }
  }
  return undefined
}
