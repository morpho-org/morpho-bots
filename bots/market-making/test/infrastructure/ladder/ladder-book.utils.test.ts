import type { Hex } from 'viem'

import { describe, expect, test } from 'bun:test'

import { readLadderBookOffers } from '../../../src/infrastructure/ladder/ladder-book.utils'

const marketId: Hex = `0x${'11'.repeat(32)}`
const groupId: Hex = `0x${'22'.repeat(32)}`

describe('readLadderBookOffers', () => {
  test('rejects a book offer whose payload side disagrees with its endpoint', async () => {
    await expect(
      readLadderBookOffers({
        baseUrl: 'https://router.invalid',
        marketIds: [marketId],
        timeoutMs: 1_000,
        request: async url => ({
          data: url.includes('/asks/')
            ? [{ market_id: marketId, offer: { group: groupId, buy: true, tick: 1 } }]
            : []
        })
      })
    ).rejects.toMatchObject({ name: 'LadderAdapterError', operation: 'book-response' })
  })

  test('reads the non-paginated takeable-offer response', async () => {
    const urls: string[] = []
    const offers = await readLadderBookOffers({
      baseUrl: 'https://router.invalid',
      marketIds: [marketId],
      timeoutMs: 1_000,
      request: async url => {
        urls.push(url)
        if (url.includes('/bids/')) return { data: [] }
        return {
          data: [{ market_id: marketId, offer: { group: groupId, buy: false, tick: 1 } }]
        }
      }
    })
    expect(offers.map(offer => offer.groupId)).toEqual([groupId])
    expect(urls).toEqual([
      `https://router.invalid/v0/midnight/books/${marketId}/asks/takeable-offers`,
      `https://router.invalid/v0/midnight/books/${marketId}/bids/takeable-offers`
    ])
  })
})
