import type { Hex } from 'viem'

import { TickLib } from '@morpho-org/midnight-sdk'
import { MathLib } from '@morpho-org/morpho-ts'
import { batchProspectiveBook } from '@repo/offers'

import type { OwnedOverlapBookOffer } from '../intentional-overlap.utils'

const BPS_WAD = MathLib.WAD / 10_000n

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

/**
 * Converts opposing book ticks into the annual rates ladder generation clears.
 * @param ticks - Best opposing ticks from {@link retainedOpposingBookTicks}.
 * @param timeToMaturity - Seconds until the market matures; must be positive.
 * @returns `bookBuyRateBps` and `bookSellRateBps` for the sides the book holds.
 * @remarks Truncation to integer basis points is the deadband that keeps a sub-basis-point book
 * wobble from recentering the ladder. Because a tick's implied rate is a function of time to
 * maturity, a resting offer's rate still drifts as maturity approaches, exactly as the own
 * bootstrap-buy rate already does.
 */
export const opposingBookRatesBps = (ticks: OpposingBookTicks, timeToMaturity: bigint) => ({
  ...(ticks.highestBuyTick === undefined
    ? {}
    : { bookBuyRateBps: TickLib.tickToApr(ticks.highestBuyTick, timeToMaturity) / BPS_WAD }),
  ...(ticks.lowestSellTick === undefined
    ? {}
    : { bookSellRateBps: TickLib.tickToApr(ticks.lowestSellTick, timeToMaturity) / BPS_WAD })
})
