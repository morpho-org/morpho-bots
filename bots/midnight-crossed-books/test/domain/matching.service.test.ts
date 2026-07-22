import { describe, expect, test } from 'bun:test'

import { MatchingService } from '../../src/domain/matching.service'
import { MARKET_ID, OTHER_MARKET_ID, makeOffer } from '../fixtures/offers'

const service = new MatchingService()

describe('MatchingService', () => {
  test('returns no matches for an empty book', () => {
    expect(service.match({ asks: [], bids: [] })).toEqual([])
  })

  test('returns no matches for a one-sided book', () => {
    expect(service.match({ asks: [makeOffer('ask', 5n, 2n)], bids: [] })).toEqual([])
    expect(service.match({ asks: [], bids: [makeOffer('bid', 7n, 2n)] })).toEqual([])
  })

  test('sorts unsorted levels and matches the best prices first', () => {
    const [match] = service.match({
      asks: [makeOffer('ask', 9n, 8n), makeOffer('ask', 5n, 4n)],
      bids: [makeOffer('bid', 6n, 9n), makeOffer('bid', 7n, 6n)]
    })

    expect(match?.ask.offer.tick).toBe(5n)
    expect(match?.bid.offer.tick).toBe(7n)
    expect(match?.units).toBe(4n)
  })

  test('uses the smaller takeable size for a partial fill', () => {
    const [match] = service.match({
      asks: [makeOffer('ask', 5n, 100n)],
      bids: [makeOffer('bid', 7n, 30n)]
    })

    expect(match?.units).toBe(30n)
  })

  test('walks both sides without overfilling any offer', () => {
    const matches = service.match({
      asks: [makeOffer('ask', 5n, 2n), makeOffer('ask', 6n, 5n)],
      bids: [makeOffer('bid', 8n, 4n), makeOffer('bid', 7n, 4n)],
      maxMatches: 3
    })

    expect(matches.map(match => match.units)).toEqual([2n, 2n, 3n])
  })

  test('stops at the first non-crossing price', () => {
    expect(
      service.match({
        asks: [makeOffer('ask', 7n, 1n)],
        bids: [makeOffer('bid', 7n, 1n)]
      })
    ).toEqual([])

    expect(
      service.match({
        asks: [makeOffer('ask', 8n, 1n)],
        bids: [makeOffer('bid', 7n, 1n)]
      })
    ).toEqual([])
  })

  test('ignores zero-sized and wrong-side rows', () => {
    const [match] = service.match({
      asks: [makeOffer('ask', 1n, 0n), makeOffer('bid', 1n, 10n), makeOffer('ask', 5n, 2n)],
      bids: [makeOffer('ask', 9n, 10n), makeOffer('bid', 7n, 2n)]
    })

    expect(match?.units).toBe(2n)
  })

  test('never matches offers from different markets', () => {
    const bid = makeOffer('bid', 7n, 2n, { marketId: OTHER_MARKET_ID })

    expect(service.match({ asks: [makeOffer('ask', 5n, 2n)], bids: [bid] })).toEqual([])
  })

  test('caps matches at 10 by default', () => {
    const matches = service.match({
      asks: Array.from({ length: 11 }, () => makeOffer('ask', 5n, 1n)),
      bids: [makeOffer('bid', 7n, 11n)]
    })

    expect(matches).toHaveLength(10)
  })

  test('respects the requested match cap', () => {
    const matches = service.match({
      asks: [makeOffer('ask', 5n, 2n), makeOffer('ask', 6n, 2n)],
      bids: [makeOffer('bid', 8n, 2n), makeOffer('bid', 7n, 2n)],
      maxMatches: 1
    })

    expect(matches).toHaveLength(1)
    expect(matches[0]?.ask.marketId).toBe(MARKET_ID)
  })
})
