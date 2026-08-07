import type { Address, Hex } from 'viem'

import { describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readLadderBookOffers } from '../../../src/infrastructure/ladder/ladder-book.utils'
import { calculateLadderCapacities } from '../../../src/infrastructure/ladder/ladder-capacity.utils'
import { createLadderGroupOwnership } from '../../../src/infrastructure/ladder/ladder-group-ownership.utils'
import { readLadderGroups } from '../../../src/infrastructure/ladder/ladder-groups.utils'

const maker: Address = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const marketId: Hex = `0x${'11'.repeat(32)}`
const groupId: Hex = `0x${'22'.repeat(32)}`

const quote = {
  marketId,
  centerRateBps: 500n,
  groupMode: 'shared-rung' as const,
  lower: [{ index: 0, rateBps: 400n, assets: 10n }],
  higher: [{ index: 0, rateBps: 600n, assets: 10n }]
}

describe('ladder review feedback regressions', () => {
  test('subtracts current credit from fresh per-market lend room', () => {
    expect(
      calculateLadderCapacities({
        marketId,
        balance: 100n,
        currentCredit: 90n,
        otherMarketCredit: 0n,
        creditSaleCapacityAssets: 90n,
        targetMarketExposureAssets: 100n,
        maximumTotalExposureAssets: 1_000n,
        reservations: []
      })
    ).toEqual({
      lowerRateCapacityAssets: 90n,
      higherRateCapacityAssets: 10n,
      targetMarketCapacityAssets: 100n,
      maximumTotalCapacityAssets: 1_000n
    })
  })

  test('counts active reservations against market and aggregate production room', () => {
    expect(
      calculateLadderCapacities({
        marketId,
        balance: 100n,
        currentCredit: 20n,
        otherMarketCredit: 30n,
        creditSaleCapacityAssets: 0n,
        targetMarketExposureAssets: 100n,
        maximumTotalExposureAssets: 200n,
        reservations: [{ id: groupId, marketIds: [marketId], assets: 40n }]
      })
    ).toEqual({
      lowerRateCapacityAssets: 0n,
      higherRateCapacityAssets: 40n,
      targetMarketCapacityAssets: 40n,
      maximumTotalCapacityAssets: 110n
    })
  })

  test('rejects an ownership file with group-readable permissions', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'ladder-ownership-security-'))
    try {
      const ownership = createLadderGroupOwnership(
        { maker, strategyMarketIds: [marketId] },
        { stateDirectory }
      )
      await ownership.reserve({
        marketId,
        quote,
        groups: [{ groupId, side: 'higher', rungIndexes: [0] }]
      })
      const [path] = Array.from(new Bun.Glob('*.json').scanSync(stateDirectory))
      if (!path) throw new Error('Expected ownership state')
      await chmod(join(stateDirectory, path), 0o644)
      await expect(ownership.read()).rejects.toMatchObject({
        name: 'LadderAdapterError',
        operation: 'group-ownership-state'
      })
    } finally {
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })

  test('keeps bounded Router readers available for the fork harness', async () => {
    expect(typeof readLadderBookOffers).toBe('function')
    expect(typeof readLadderGroups).toBe('function')
    const temporary = await mkdtemp(join(tmpdir(), 'ladder-reader-'))
    try {
      await writeFile(join(temporary, 'marker'), '')
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

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
