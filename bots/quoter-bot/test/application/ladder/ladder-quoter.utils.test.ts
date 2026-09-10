import type { Hex } from 'viem'

import { describe, expect, test } from 'vitest'

import type { LadderQuoteSet } from '../../../src/domain/ladder/ladder'

import { sameLadderQuoteSet } from '../../../src/application/ladder/ladder-quoter.utils'

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
  test('rests an unchanged quote', () => {
    expect(sameLadderQuoteSet(quote(), quote())).toBe(true)
    expect(
      sameLadderQuoteSet(
        quote({ referenceObservationId: 'blue:19000000' }),
        quote({ referenceObservationId: 'blue:19000000' })
      )
    ).toBe(true)
  })

  test('reconciles when the center moves', () => {
    expect(sameLadderQuoteSet(quote(), quote({ centerRateBps: 501n }))).toBe(false)
  })

  test('reconciles when the reference observation moves', () => {
    expect(
      sameLadderQuoteSet(
        quote({ referenceObservationId: 'blue:19000000' }),
        quote({ referenceObservationId: 'blue:19000001' })
      )
    ).toBe(false)
    expect(sameLadderQuoteSet(quote({ referenceObservationId: 'blue:19000000' }), quote())).toBe(
      false
    )
  })

  test('reconciles when a rung rate, size, or count changes', () => {
    expect(
      sameLadderQuoteSet(quote(), quote({ higher: [{ index: 0, rateBps: 601n, assets: 10n }] }))
    ).toBe(false)
    expect(
      sameLadderQuoteSet(quote(), quote({ lower: [{ index: 0, rateBps: 400n, assets: 11n }] }))
    ).toBe(false)
    expect(
      sameLadderQuoteSet(
        quote(),
        quote({
          lower: [
            { index: 0, rateBps: 400n, assets: 10n },
            { index: 1, rateBps: 300n, assets: 10n }
          ]
        })
      )
    ).toBe(false)
  })

  test('reconciles when the group mode changes', () => {
    expect(sameLadderQuoteSet(quote(), quote({ groupMode: 'per-book' }))).toBe(false)
  })
})
