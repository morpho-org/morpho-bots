import type { Hex } from 'viem'

import { batchProspectiveBook } from '@repo/offers'

import type { OwnedOverlapBookOffer } from '../intentional-overlap.utils'

/**
 * Best opposing retained ticks a prospective ladder must clear on each side.
 * @remarks An absent side leaves that direction unbounded. Own bootstrap buys are excluded because
 * `ownBootstrapBuyTickCeiling` clears those under the intentional-overlap exemption, which this
 * bound must not tighten.
 */
export type OpposingBookTicks = {
  highestBuyTick?: bigint
  lowestSellTick?: bigint
}

/**
 * Selects the opposing ticks a prospective ladder must clear to leave the book uncrossed.
 * @param parameters - Selected market, groups this cycle replaces, and the complete market book.
 * @returns The highest retained buy tick and lowest retained sell tick, each omitted when that side
 * of the book is empty.
 * @remarks Pure projection, and best-effort against a book that keeps moving: the publication spread
 * guard reads the book again after preparation, so this bound narrows how often that guard trips
 * rather than proving it cannot. Passing a `replacedGroupIds` subset of the guard's own set keeps
 * the bound on the conservative side of it.
 */
export const retainedOpposingBookTicks = (parameters: {
  marketId: Hex
  replacedGroupIds: ReadonlySet<Hex>
  book: readonly OwnedOverlapBookOffer[]
}): OpposingBookTicks => {
  const retained = batchProspectiveBook({
    marketId: parameters.marketId,
    replacedGroupIds: parameters.replacedGroupIds,
    book: parameters.book.filter(offer => offer.overlapOwner !== 'bootstrap-buy'),
    prospective: []
  })
  const buyTicks = retained.filter(offer => offer.buy).map(offer => offer.tick)
  const sellTicks = retained.filter(offer => !offer.buy).map(offer => offer.tick)
  return {
    ...(buyTicks.length === 0
      ? {}
      : { highestBuyTick: buyTicks.reduce((highest, tick) => (tick > highest ? tick : highest)) }),
    ...(sellTicks.length === 0
      ? {}
      : { lowestSellTick: sellTicks.reduce((lowest, tick) => (tick < lowest ? tick : lowest)) })
  }
}
