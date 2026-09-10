import type { Address, Hex } from 'viem'

import { getAddress } from 'viem'
import { describe, expect, test } from 'vitest'

import { readLadderBookOffers } from '../../../src/infrastructure/ladder/ladder-book.utils'

const marketId: Hex = `0x${'11'.repeat(32)}`
const groupId: Hex = `0x${'22'.repeat(32)}`
const maker: Address = getAddress(`0x${'ab'.repeat(20)}`)
const ratifier: Address = getAddress(`0x${'cd'.repeat(20)}`)

describe('readLadderBookOffers', () => {
  test('rejects a book offer whose payload side disagrees with its endpoint', async () => {
    await expect(
      readLadderBookOffers({
        baseUrl: 'https://router.invalid',
        marketIds: [marketId],
        timeoutMs: 1_000,
        request: async url => ({
          data: url.includes('/asks/')
            ? [
                {
                  market_id: marketId,
                  offer: { group: groupId, maker, ratifier, buy: true, tick: 1 }
                }
              ]
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
          data: [
            { market_id: marketId, offer: { group: groupId, maker, ratifier, buy: false, tick: 1 } }
          ]
        }
      }
    })
    expect(offers).toEqual([{ groupId, marketId, maker, ratifier, buy: false, tick: 1n }])
    expect(urls).toEqual([
      `https://router.invalid/v0/midnight/books/${marketId}/asks/takeable-offers`,
      `https://router.invalid/v0/midnight/books/${marketId}/bids/takeable-offers`
    ])
  })

  test('filters ignored group IDs from the takeable-offer response', async () => {
    const retainedGroupId: Hex = `0x${'33'.repeat(32)}`
    const offers = await readLadderBookOffers({
      baseUrl: 'https://router.invalid',
      marketIds: [marketId],
      timeoutMs: 1_000,
      ignoredOfferGroupIds: [groupId],
      request: async url => ({
        data: url.includes('/bids/')
          ? []
          : [groupId, retainedGroupId].map(group => ({
              market_id: marketId,
              offer: { group, maker, ratifier, buy: false, tick: 1 }
            }))
      })
    })

    expect(offers.map(offer => offer.groupId)).toEqual([retainedGroupId])
  })

  test('rejects a takeable offer whose maker is not an address', async () => {
    await expect(
      readLadderBookOffers({
        baseUrl: 'https://router.invalid',
        marketIds: [marketId],
        timeoutMs: 1_000,
        request: async url => ({
          data: url.includes('/bids/')
            ? []
            : [
                {
                  market_id: marketId,
                  offer: { group: groupId, maker: '0xnotanaddress', ratifier, buy: false, tick: 1 }
                }
              ]
        })
      })
    ).rejects.toMatchObject({ name: 'LadderAdapterError', operation: 'book-response' })
  })

  test('checksums the maker and ratifier of every parsed offer', async () => {
    const offers = await readLadderBookOffers({
      baseUrl: 'https://router.invalid',
      marketIds: [marketId],
      timeoutMs: 1_000,
      request: async url => ({
        data: url.includes('/bids/')
          ? []
          : [
              {
                market_id: marketId,
                offer: {
                  group: groupId,
                  maker: maker.toLowerCase(),
                  ratifier: ratifier.toLowerCase(),
                  buy: false,
                  tick: 1
                }
              }
            ]
      })
    })

    expect(offers.map(offer => [offer.maker, offer.ratifier])).toEqual([[maker, ratifier]])
  })
})
