import type { Hex } from 'viem'

import type { BootstrapActiveGroup } from './bootstrap-position.service'

import { BootstrapAdapterError } from './bootstrap-adapter.error'

type BootstrapBookOffer = { groupId?: Hex; marketId: Hex; buy: boolean; tick: bigint }

/**
 * Resolves the strategy group IDs that may be reconciled for one market.
 * @param groups - Fresh active strategy-group projections.
 * @param marketId - Canonical market selected for reconciliation.
 * @returns Distinct active group IDs owned only by the selected market.
 * @throws `BootstrapAdapterError` when a selected group also contains another market.
 */
export const bootstrapMarketGroupIds = (groups: readonly BootstrapActiveGroup[], marketId: Hex) => {
  const groupIds = new Set(
    groups.filter(group => group.marketId === marketId).map(group => group.id)
  )
  if (groups.some(group => group.marketId !== marketId && groupIds.has(group.id))) {
    throw new BootstrapAdapterError('shared-group-reconciliation')
  }
  return groupIds
}

/**
 * Rejects a prospective buy when it crosses any still-live sell in the complete maker book.
 * @param parameters - Market, replaced group IDs, current book, and exact prospective protocol tick.
 * @returns Nothing after the resulting selected-market book is proven non-crossing.
 * @throws `BootstrapAdapterError` when the prospective book has a negative or zero spread.
 */
export const assertBootstrapProspectiveSpread = (parameters: {
  marketId: Hex
  replacedGroupIds: ReadonlySet<Hex>
  book: readonly BootstrapBookOffer[]
  prospective: BootstrapBookOffer
}) => {
  const resultingBook = [...parameters.book, parameters.prospective].filter(
    offer =>
      offer.marketId === parameters.marketId &&
      (offer.groupId === undefined || !parameters.replacedGroupIds.has(offer.groupId))
  )
  const buys = resultingBook.filter(offer => offer.buy).map(offer => offer.tick)
  const sells = resultingBook.filter(offer => !offer.buy).map(offer => offer.tick)
  if (buys.length === 0 || sells.length === 0) return

  const highestBuy = buys.reduce((highest, tick) => (tick > highest ? tick : highest))
  const lowestSell = sells.reduce((lowest, tick) => (tick < lowest ? tick : lowest))
  if (highestBuy >= lowestSell) {
    throw new BootstrapAdapterError('negative-spread')
  }
}
