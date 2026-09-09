import type { Hex } from 'viem'

import { describe, expect, test } from 'vitest'

import type { LadderQuoteSet } from '../../../src/domain/ladder/ladder'

import { sameLadderQuoteSet } from '../../../src/application/ladder/ladder-quoter.utils'
import { opposingBookObservationId } from '../../../src/infrastructure/ladder/ladder-cross-book.utils'

const marketId: Hex = `0x${'55'.repeat(32)}`
const quote = (overrides: Partial<LadderQuoteSet> = {}): LadderQuoteSet => ({
  marketId,
  centerRateBps: 500n,
  groupMode: 'shared-rung',
  lower: [{ index: 0, rateBps: 400n, assets: 10n }],
  higher: [{ index: 0, rateBps: 600n, assets: 10n }],
  ...overrides
})

describe('sameLadderQuoteSet', () => {
  test('rests an unchanged quote against an unchanged book', () => {
    const observed = { bookObservationId: opposingBookObservationId({ highestBuyTick: 4_172n }) }

    expect(sameLadderQuoteSet(quote(observed), quote(observed))).toBe(true)
  })

  test('reconciles when the constraining book moves', () => {
    const before = quote({
      bookObservationId: opposingBookObservationId({ lowestSellTick: 3_902n })
    })
    const after = quote({
      bookObservationId: opposingBookObservationId({ lowestSellTick: 3_900n })
    })

    expect(sameLadderQuoteSet(before, after)).toBe(false)
  })

  test('reconciles when the book stops constraining the ladder', () => {
    const constrained = quote({
      bookObservationId: opposingBookObservationId({ highestBuyTick: 4_172n })
    })
    const clear = quote({ bookObservationId: opposingBookObservationId({}) })

    expect(sameLadderQuoteSet(constrained, clear)).toBe(false)
  })

  test('separates each side of the book in the identity', () => {
    expect(opposingBookObservationId({ highestBuyTick: 4_172n })).not.toBe(
      opposingBookObservationId({ lowestSellTick: 4_172n })
    )
  })
})
