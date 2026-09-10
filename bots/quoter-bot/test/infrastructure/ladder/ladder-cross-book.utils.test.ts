import type { Address, Hex } from 'viem'

import { TakeAmountsLib } from '@morpho-org/midnight-sdk'
import { describe, expect, test } from 'vitest'

import type { OwnedOverlapBookOffer } from '../../../src/infrastructure/intentional-overlap.utils'

import {
  bookCrossesRestingLadder,
  clearableOpposingBook,
  retainedOpposingBookTicks
} from '../../../src/infrastructure/ladder/ladder-cross-book.utils'

const marketId: Hex = `0x${'77'.repeat(32)}`
const otherMarketId: Hex = `0x${'88'.repeat(32)}`
const groupId = (byte: string): Hex => `0x${byte.repeat(32)}`

const offer = (
  overrides: Partial<OwnedOverlapBookOffer> & Pick<OwnedOverlapBookOffer, 'buy' | 'tick'>
): OwnedOverlapBookOffer => ({ marketId, ...overrides })

describe('retainedOpposingBookTicks', () => {
  test('selects the best tick on each side of the selected market', () => {
    expect(
      retainedOpposingBookTicks({
        marketId,
        replacedGroupIds: new Set(),
        book: [
          offer({ groupId: groupId('01'), buy: true, tick: 3_900n }),
          offer({ groupId: groupId('02'), buy: true, tick: 3_950n }),
          offer({ groupId: groupId('03'), buy: false, tick: 4_100n }),
          offer({ groupId: groupId('04'), buy: false, tick: 4_000n })
        ]
      })
    ).toEqual({ highestBuyTick: 3_950n, lowestSellTick: 4_000n })
  })

  test('omits a side the book does not hold', () => {
    expect(
      retainedOpposingBookTicks({
        marketId,
        replacedGroupIds: new Set(),
        book: [offer({ groupId: groupId('01'), buy: true, tick: 3_900n })]
      })
    ).toEqual({ highestBuyTick: 3_900n })
  })

  test('ignores offers in other markets and offers this cycle replaces', () => {
    expect(
      retainedOpposingBookTicks({
        marketId,
        replacedGroupIds: new Set([groupId('02')]),
        book: [
          offer({ groupId: groupId('01'), buy: true, tick: 3_900n }),
          offer({ groupId: groupId('02'), buy: true, tick: 3_950n }),
          offer({ marketId: otherMarketId, groupId: groupId('03'), buy: true, tick: 3_990n }),
          offer({ marketId: otherMarketId, groupId: groupId('04'), buy: false, tick: 4_000n })
        ]
      })
    ).toEqual({ highestBuyTick: 3_900n })
  })

  test('ignores own bootstrap buys, which carry their own clearance', () => {
    expect(
      retainedOpposingBookTicks({
        marketId,
        replacedGroupIds: new Set(),
        book: [
          offer({ groupId: groupId('01'), buy: true, tick: 3_900n }),
          offer({ groupId: groupId('02'), buy: true, tick: 4_050n, overlapOwner: 'bootstrap-buy' })
        ]
      })
    ).toEqual({ highestBuyTick: 3_900n })
  })

  test('keeps a book offer that carries no group ID', () => {
    expect(
      retainedOpposingBookTicks({
        marketId,
        replacedGroupIds: new Set([groupId('01')]),
        book: [offer({ buy: false, tick: 4_000n })]
      })
    ).toEqual({ lowestSellTick: 4_000n })
  })
})

const maker: Address = '0x1111111111111111111111111111111111111111'
const counterparty: Address = '0x2222222222222222222222222222222222222222'
const ownLadderSell = { groupId: groupId('aa'), buy: false, tick: 4_000n, maker } as const
const ownLadderBuy = { groupId: groupId('bb'), buy: true, tick: 3_900n, maker } as const
const activeLadderGroupIds = {
  lower: new Set([ownLadderSell.groupId]),
  higher: new Set([ownLadderBuy.groupId])
}

const crossing = (book: readonly OwnedOverlapBookOffer[], minimumOpposingAssets?: bigint) =>
  bookCrossesRestingLadder({
    marketId,
    maker,
    book,
    activeLadderGroupIds,
    ...(minimumOpposingAssets === undefined ? {} : { minimumOpposingAssets })
  })

describe('bookCrossesRestingLadder', () => {
  test('reports the lower side crossed by a third-party bid above our ladder sell', () => {
    expect(
      crossing([
        offer(ownLadderSell),
        offer({ groupId: groupId('01'), buy: true, tick: 4_050n, maker: counterparty })
      ])
    ).toEqual({ lower: true, higher: false })
  })

  test('ignores a third-party offer smaller than the minimum opposing size', () => {
    const tick = 4_050n
    const minimumUnits = TakeAmountsLib.toUnitsAtTick({ assets: 100n, tick, rounding: 'Up' })
    const bid = (units: bigint) =>
      offer({ groupId: groupId('01'), buy: true, tick, maker: counterparty, units })

    expect(crossing([offer(ownLadderSell), bid(minimumUnits - 1n)], 100n)).toEqual({
      lower: false,
      higher: false
    })
    expect(crossing([offer(ownLadderSell), bid(minimumUnits)], 100n)).toEqual({
      lower: true,
      higher: false
    })
    expect(crossing([offer(ownLadderSell), offer({ ...bid(1n), units: undefined })], 100n)).toEqual(
      { lower: true, higher: false }
    )
  })

  test('treats an offer at a zero-price tick as dust whatever its units', () => {
    const ask = offer({
      groupId: groupId('01'),
      buy: false,
      tick: 0n,
      maker: counterparty,
      units: 10n ** 30n
    })
    expect(crossing([offer(ownLadderBuy), ask], 100n)).toEqual({ lower: false, higher: false })
    expect(crossing([offer(ownLadderBuy), ask])).toEqual({ lower: false, higher: true })
  })

  test('reports the higher side crossed by a third-party ask below our ladder buy', () => {
    expect(
      crossing([
        offer(ownLadderBuy),
        offer({ groupId: groupId('01'), buy: false, tick: 3_850n, maker: counterparty })
      ])
    ).toEqual({ lower: false, higher: true })
  })

  test('counts a tie as crossed, matching the protocol matching rule', () => {
    expect(
      crossing([
        offer(ownLadderSell),
        offer({ groupId: groupId('01'), buy: true, tick: 4_000n, maker: counterparty })
      ])
    ).toEqual({ lower: true, higher: false })
  })

  test('reports only the crossed side of a two-sided ladder', () => {
    expect(
      crossing([
        offer(ownLadderSell),
        offer(ownLadderBuy),
        offer({ groupId: groupId('01'), buy: true, tick: 4_010n, maker: counterparty }),
        offer({ groupId: groupId('02'), buy: false, tick: 4_020n, maker: counterparty })
      ])
    ).toEqual({ lower: true, higher: false })
  })

  test('ignores a third party crossing an own offer outside the ladder groups', () => {
    expect(
      crossing([
        offer({ groupId: groupId('cc'), buy: true, tick: 3_900n, maker }),
        offer({ groupId: groupId('01'), buy: false, tick: 3_850n, maker: counterparty })
      ])
    ).toEqual({ lower: false, higher: false })
  })

  test("never treats the maker's own crossing offers as third party", () => {
    expect(
      crossing([
        offer(ownLadderSell),
        offer({ groupId: groupId('cc'), buy: true, tick: 4_050n, maker })
      ])
    ).toEqual({ lower: false, higher: false })
  })

  test('treats an offer carrying no maker as own', () => {
    expect(
      crossing([offer(ownLadderSell), offer({ groupId: groupId('01'), buy: true, tick: 4_050n })])
    ).toEqual({
      lower: false,
      higher: false
    })
  })

  test('ignores other markets and ladder groups that are no longer active', () => {
    expect(
      crossing([
        offer({ groupId: groupId('dd'), buy: false, tick: 4_000n, maker }),
        offer({ groupId: groupId('01'), buy: true, tick: 4_050n, maker: counterparty }),
        offer({ marketId: otherMarketId, ...ownLadderSell }),
        offer({
          marketId: otherMarketId,
          groupId: groupId('02'),
          buy: true,
          tick: 4_050n,
          maker: counterparty
        })
      ])
    ).toEqual({ lower: false, higher: false })
  })
})

describe('clearableOpposingBook', () => {
  test('clears a cross the configured window still has room for', () => {
    expect(
      clearableOpposingBook({
        ticks: { highestBuyTick: 3_950n, lowestSellTick: 4_000n },
        window: { lowestTick: 3_900n, highestTick: 4_050n },
        tickSpacing: 5n
      })
    ).toEqual({ lower: true, higher: true })
  })

  test('reports the lower side unclearable when clearing would saturate at the window top', () => {
    expect(
      clearableOpposingBook({
        ticks: { highestBuyTick: 4_050n },
        window: { lowestTick: 3_900n, highestTick: 4_050n },
        tickSpacing: 5n
      })
    ).toEqual({ lower: false, higher: true })
  })

  test('reports the higher side unclearable when clearing would saturate at the window bottom', () => {
    expect(
      clearableOpposingBook({
        ticks: { lowestSellTick: 3_900n },
        window: { lowestTick: 3_900n, highestTick: 4_050n },
        tickSpacing: 5n
      })
    ).toEqual({ lower: true, higher: false })
  })

  test('reports a sell resting at tick zero unclearable, since a buy can only tie it', () => {
    expect(
      clearableOpposingBook({ ticks: { lowestSellTick: 0n }, window: {}, tickSpacing: 5n })
    ).toEqual({ lower: true, higher: false })
  })

  test('clears every side against an unbounded window', () => {
    expect(
      clearableOpposingBook({
        ticks: { highestBuyTick: 4_050n, lowestSellTick: 3_900n },
        window: {},
        tickSpacing: 5n
      })
    ).toEqual({ lower: true, higher: true })
  })

  test('clears a side the book does not hold', () => {
    expect(
      clearableOpposingBook({
        ticks: {},
        window: { lowestTick: 3_900n, highestTick: 4_050n },
        tickSpacing: 5n
      })
    ).toEqual({ lower: true, higher: true })
  })
})
