import type { Address, Hex } from 'viem'

import { batchProspectiveBook } from '@repo/offers'
import { isAddressEqual } from 'viem'

import type { LadderBookSideCrossing } from '../../domain/ladder/ladder'
import type { OwnedOverlapBookOffer } from '../intentional-overlap.utils'
import type { TickWindow } from '../tick-window.utils'

import { alignTickDown, alignTickUp, LOWEST_TICK } from '../tick-window.utils'

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

const highestTick = (ticks: readonly bigint[]) =>
  ticks.length === 0
    ? undefined
    : ticks.reduce((highest, tick) => (tick > highest ? tick : highest))

const lowestTick = (ticks: readonly bigint[]) =>
  ticks.length === 0 ? undefined : ticks.reduce((lowest, tick) => (tick < lowest ? tick : lowest))

const crosses = (buyTicks: readonly bigint[], sellTicks: readonly bigint[]) => {
  const buy = highestTick(buyTicks)
  const sell = lowestTick(sellTicks)
  return buy !== undefined && sell !== undefined && buy >= sell
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
  const highestBuyTick = highestTick(retained.filter(offer => offer.buy).map(offer => offer.tick))
  const lowestSellTick = lowestTick(retained.filter(offer => !offer.buy).map(offer => offer.tick))
  return {
    ...(highestBuyTick === undefined ? {} : { highestBuyTick }),
    ...(lowestSellTick === undefined ? {} : { lowestSellTick })
  }
}

/**
 * Sides on which a third-party offer currently crosses one of this strategy's resting ladder offers.
 * @param parameters - Selected market, configured maker, complete market book, and the strategy's
 * active ladder group IDs per side.
 * @returns Whether a third-party offer crosses the resting ladder on each side.
 * @remarks An offer carrying no maker counts as own, as `hasInvalidOwnedBootstrapLadderSpread`
 * already fails closed on one. Own offers outside the active ladder groups are on neither side: a
 * third party crossing the bootstrap buy is bootstrap's concern, not a reason to replace the ladder.
 */
export const bookCrossesRestingLadder = (parameters: {
  marketId: Hex
  maker: Address
  book: readonly OwnedOverlapBookOffer[]
  activeLadderGroupIds: { lower: ReadonlySet<Hex>; higher: ReadonlySet<Hex> }
}) => {
  const market = parameters.book.filter(offer => offer.marketId === parameters.marketId)
  const ticks = (offers: readonly OwnedOverlapBookOffer[], buy: boolean) =>
    offers.filter(offer => offer.buy === buy).map(offer => offer.tick)
  const thirdParty = market.filter(
    offer => offer.maker !== undefined && !isAddressEqual(offer.maker, parameters.maker)
  )
  const ownLadder = (side: 'lower' | 'higher') =>
    market.filter(
      offer =>
        offer.groupId !== undefined && parameters.activeLadderGroupIds[side].has(offer.groupId)
    )
  return {
    lower: crosses(ticks(thirdParty, true), ticks(ownLadder('lower'), false)),
    higher: crosses(ticks(ownLadder('higher'), true), ticks(thirdParty, false))
  }
}

/**
 * Whether the configured rate window still holds an aligned tick strictly clear of the best
 * retained opposing offer, per side.
 * @param parameters - Best retained opposing ticks, the configured rate window, and tick spacing.
 * @returns Whether each side could be cleared inside the window; an empty side or an unbounded
 * window is clearable.
 */
export const clearableOpposingBook = (parameters: {
  ticks: OpposingBookTicks
  window: TickWindow
  tickSpacing: bigint
}) => {
  const { ticks, window, tickSpacing } = parameters
  return {
    lower:
      ticks.highestBuyTick === undefined ||
      window.highestTick === undefined ||
      alignTickUp(ticks.highestBuyTick + 1n, tickSpacing) <= window.highestTick,
    higher:
      ticks.lowestSellTick === undefined ||
      (ticks.lowestSellTick > LOWEST_TICK &&
        (window.lowestTick === undefined ||
          alignTickDown(ticks.lowestSellTick - 1n, tickSpacing) >= window.lowestTick))
  }
}

/**
 * Whether one of the given sides reports a crossing the configured rate window can still clear.
 * @param crossing - Per-side crossing and feasibility observed on one book read.
 * @param sides - Sides the decision admitted the replacement for; defaults to both.
 * @returns `true` when a `book-crossed` replacement still has something to clear on an admitted
 * side; a cross that moved to a side still in cooldown, or that cannot be cleared, never mutates.
 */
export const hasClearableCrossing = (
  crossing: { lower: LadderBookSideCrossing; higher: LadderBookSideCrossing },
  sides: readonly ('lower' | 'higher')[] = ['lower', 'higher']
) => sides.some(side => crossing[side].crossed && crossing[side].clearable)
