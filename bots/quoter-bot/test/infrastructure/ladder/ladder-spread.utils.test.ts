import type { Hex } from 'viem'

import { describe, expect, test } from 'vitest'

import { LadderAdapterError } from '../../../src/infrastructure/ladder/ladder-adapter.error'
import { assertLadderProspectiveSpread } from '../../../src/infrastructure/ladder/ladder-spread.utils'

const marketId: Hex = `0x${'aa'.repeat(32)}`
const otherMarketId: Hex = `0x${'bb'.repeat(32)}`
const replacedGroupId: Hex = `0x${'11'.repeat(32)}`

describe('assertLadderProspectiveSpread', () => {
  test('accepts a strictly positive resulting spread', () => {
    expect(() =>
      assertLadderProspectiveSpread({
        marketId,
        replacedGroupIds: new Set(),
        book: [{ marketId, buy: false, tick: 10n }],
        prospective: [{ marketId, buy: true, tick: 9n }]
      })
    ).not.toThrow()
  })

  test('rejects a prospective ladder crossing a retained sell', () => {
    let caught: unknown
    try {
      assertLadderProspectiveSpread({
        marketId,
        replacedGroupIds: new Set(),
        book: [{ marketId, buy: false, tick: 10n }],
        prospective: [{ marketId, buy: true, tick: 10n }]
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(LadderAdapterError)
    expect((caught as LadderAdapterError).operation).toBe('negative-spread')
  })

  test('allows the exact owned bootstrap-buy and prospective ladder-sell equality', () => {
    expect(() =>
      assertLadderProspectiveSpread({
        marketId,
        replacedGroupIds: new Set(),
        book: [
          {
            groupId: replacedGroupId,
            marketId,
            buy: true,
            tick: 10n,
            overlapOwner: 'bootstrap-buy'
          }
        ],
        prospective: [{ marketId, buy: false, tick: 10n, overlapOwner: 'ladder-sell' }]
      })
    ).not.toThrow()
  })

  test('rejects ownership ties even at the intentional overlap tick', () => {
    expect(() =>
      assertLadderProspectiveSpread({
        marketId,
        replacedGroupIds: new Set(),
        book: [
          { marketId, buy: true, tick: 10n, overlapOwner: 'bootstrap-buy' },
          { marketId, buy: true, tick: 10n, overlapOwner: 'bootstrap-buy' }
        ],
        prospective: [{ marketId, buy: false, tick: 10n, overlapOwner: 'ladder-sell' }]
      })
    ).toThrow(LadderAdapterError)
  })

  test('rejects a self-crossing prospective ladder even with an empty book', () => {
    expect(() =>
      assertLadderProspectiveSpread({
        marketId,
        replacedGroupIds: new Set(),
        book: [],
        prospective: [
          { marketId, buy: true, tick: 5n },
          { marketId, buy: false, tick: 4n }
        ]
      })
    ).toThrow(LadderAdapterError)
  })

  test('ignores replaced groups and other markets when projecting the book', () => {
    expect(() =>
      assertLadderProspectiveSpread({
        marketId,
        replacedGroupIds: new Set([replacedGroupId]),
        book: [
          { groupId: replacedGroupId, marketId, buy: false, tick: 3n },
          { marketId: otherMarketId, buy: false, tick: 3n }
        ],
        prospective: [{ marketId, buy: true, tick: 5n }]
      })
    ).not.toThrow()
  })
})
