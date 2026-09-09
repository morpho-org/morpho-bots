import type { Hex } from 'viem'

import { describe, expect, test } from 'vitest'

import type { OwnedOverlapBookOffer } from '../../../src/infrastructure/intentional-overlap.utils'

import {
  opposingBookObservationId,
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

describe('opposingBookObservationId', () => {
  test('changes for any change to either best opposing tick', () => {
    const base = opposingBookObservationId({ highestBuyTick: 4_172n, lowestSellTick: 4_200n })

    expect(opposingBookObservationId({ highestBuyTick: 4_172n, lowestSellTick: 4_200n })).toBe(base)
    expect(opposingBookObservationId({ highestBuyTick: 4_171n, lowestSellTick: 4_200n })).not.toBe(
      base
    )
    expect(opposingBookObservationId({ highestBuyTick: 4_172n, lowestSellTick: 4_201n })).not.toBe(
      base
    )
  })

  test('separates neighbouring ticks one strict clearance apart', () => {
    expect(opposingBookObservationId({ lowestSellTick: 3_902n })).not.toBe(
      opposingBookObservationId({ lowestSellTick: 3_900n })
    )
  })

  test('distinguishes an empty side from a present one', () => {
    expect(opposingBookObservationId({})).not.toBe(
      opposingBookObservationId({ highestBuyTick: 0n })
    )
  })
})
