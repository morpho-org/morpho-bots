import { describe, expect, test } from 'vitest'

import {
  bootstrapReferenceBand,
  ladderReferenceBand
} from '../../playground/reference-response.utils'
import { ladderConfigsValue, parseBytes32 } from '../../src/config/market-collections'

const MARKET = `0x${'5'.repeat(64)}`
const ladder = (overrides: Record<string, string>) => {
  const entry = {
    marketId: MARKET,
    targetRate: { strategy: 'variable_rate_avg' },
    quotePremiumBps: '0',
    spreadBps: '200',
    stepBps: '100',
    rungCount: '3',
    sizeSkewBps: '0',
    lowerRateBudgetAssets: '10000000000',
    higherRateBudgetAssets: '10000000000',
    targetMarketExposureAssets: '20000000000',
    maximumTotalExposureAssets: '30000000000',
    minimumOfferAssets: '101000000',
    groupMode: 'shared-rung',
    loopIntervalSeconds: '60',
    movementToleranceBps: '10',
    minimumRateBps: '200',
    maximumRateBps: '800',
    ...overrides
  }
  return ladderConfigsValue([entry], [parseBytes32(MARKET, 'marketId')])[0]!
}

describe('ladderReferenceBand', () => {
  test('reports the clamp-free band a single deterministic preview cannot show', () => {
    // spread 100 / step 50 / 4 rungs reaches center ± 200 against 200–800 bounds.
    expect(
      ladderReferenceBand(ladder({ spreadBps: '100', stepBps: '50', rungCount: '4' }))
    ).toEqual({ lowestRateBps: '400', highestRateBps: '600', contiguous: true })
  })

  test('shifts the band by the quote premium, which offsets the center', () => {
    expect(
      ladderReferenceBand(
        ladder({ spreadBps: '100', stepBps: '50', rungCount: '4', quotePremiumBps: '-50' })
      )
    ).toEqual({ lowestRateBps: '450', highestRateBps: '650', contiguous: true })
  })

  test('collapses to a single clean reference when the rungs exactly span the bounds', () => {
    // spread 200 / step 100 / 3 rungs reaches reference ± 300, the full half-range.
    expect(ladderReferenceBand(ladder({}))).toEqual({
      lowestRateBps: '500',
      highestRateBps: '500',
      contiguous: true
    })
  })

  test('never has to omit the band: the parser rejects a shape that fits at no reference', () => {
    expect(() => ladder({ spreadBps: '800', stepBps: '400' })).toThrow(
      'full ladder shape cannot fit in the hard range'
    )
  })

  test('widens the band as the ladder reaches less far from its center', () => {
    const narrow = ladderReferenceBand(ladder({ spreadBps: '100', stepBps: '50', rungCount: '1' }))
    expect(narrow).toEqual({ lowestRateBps: '250', highestRateBps: '750', contiguous: true })
  })
})

describe('bootstrapReferenceBand', () => {
  test('reports where the quote tracks rather than saturating', () => {
    // quote = reference - 90 must land inside 200-800, so the reference may run to 890.
    expect(bootstrapReferenceBand(-90n, 200n, 800n)).toEqual({
      lowestRateBps: '290',
      highestRateBps: '890',
      contiguous: true
    })
  })

  test('measures past the configured bounds, which never constrain a market reference', () => {
    const band = bootstrapReferenceBand(-50n, 200n, 800n)
    expect(band).toEqual({ lowestRateBps: '250', highestRateBps: '850', contiguous: true })
  })

  test('covers the whole range at a zero premium', () => {
    expect(bootstrapReferenceBand(0n, 200n, 800n)).toEqual({
      lowestRateBps: '200',
      highestRateBps: '800',
      contiguous: true
    })
  })

  test('follows a large premium out to the references that keep the quote in range', () => {
    expect(bootstrapReferenceBand(-700n, 200n, 800n)).toEqual({
      lowestRateBps: '900',
      highestRateBps: '1500',
      contiguous: true
    })
  })
})
