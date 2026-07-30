import type { Hex } from 'viem'

import { LadderAdapterError } from './ladder-adapter.error'

type LadderBookOffer = { groupId?: Hex; marketId: Hex; buy: boolean; tick: bigint }

/**
 * Rejects a prospective ladder that crosses itself or any retained maker offer.
 * @param parameters - Selected market, replaced groups, full maker book, and prospective ticks.
 * @returns Nothing after strict positive spread is proven.
 * @throws `LadderAdapterError` when the resulting selected-market book is crossed.
 */
export const assertLadderProspectiveSpread = (parameters: {
  marketId: Hex
  replacedGroupIds: ReadonlySet<Hex>
  book: readonly LadderBookOffer[]
  prospective: readonly LadderBookOffer[]
}) => {
  const resultingBook = [...parameters.book, ...parameters.prospective].filter(
    offer =>
      offer.marketId === parameters.marketId &&
      (offer.groupId === undefined || !parameters.replacedGroupIds.has(offer.groupId))
  )
  const buys = resultingBook.filter(offer => offer.buy).map(offer => offer.tick)
  const sells = resultingBook.filter(offer => !offer.buy).map(offer => offer.tick)
  if (buys.length === 0 || sells.length === 0) return

  const highestBuy = buys.reduce((highest, tick) => (tick > highest ? tick : highest))
  const lowestSell = sells.reduce((lowest, tick) => (tick < lowest ? tick : lowest))
  if (highestBuy >= lowestSell) throw new LadderAdapterError('negative-spread')
}
