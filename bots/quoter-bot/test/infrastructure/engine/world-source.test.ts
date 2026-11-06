import type { Hex } from 'viem'

import { MAX_OFFER_CAP } from '@morpho-org/midnight-sdk'
import { describe, expect, test } from 'vitest'

import type { WorldValue } from '../../../src/application/engine/world'
import type { WorldBlock, WorldReads } from '../../../src/infrastructure/engine/world-reads'

import { LadderAdapterError } from '../../../src/errors'
import { readWorld } from '../../../src/infrastructure/engine/quoter-sources'

const maker: Hex = '0x1111111111111111111111111111111111111111'
const marketId: Hex = `0x${'11'.repeat(32)}`
const otherMarketId: Hex = `0x${'12'.repeat(32)}`
const v0Group: Hex = `0x${'aa'.repeat(32)}`
const indexedGroup: Hex = `0x${'bb'.repeat(32)}`
const EVERY_MS = 1_000

const reads = (overrides: Partial<WorldReads> = {}): WorldReads => ({
  readLatestBlock: async () => ({ number: 7n, hash: `0x${'07'.repeat(32)}`, timestamp: 1_000n }),
  readMarket: async () => {
    throw new Error('world polls read no market')
  },
  readGroups: async () => [
    {
      id: indexedGroup,
      consumed: 0n,
      cap: { kind: 'units', maximum: 10n },
      offers: [{ marketId, maker, buy: true, tick: 4_400n }]
    }
  ],
  readBook: async () => [],
  readPosition: async (market, block) => ({
    marketId: market,
    credit: block.number,
    debt: 0n,
    lossFactor: 0n,
    maturity: 10_000n,
    tickSpacing: 4,
    continuousFee: 0
  }),
  readCash: async () => ({ cashBalance: 50n, allowance: 50n }),
  readConsumed: async groupIds =>
    groupIds.map(groupId => (groupId === v0Group ? MAX_OFFER_CAP : 0n)),
  ...overrides
})

/** One world read at the kernel head 7, for the ladder market and, unless off, the bootstrap one. */
const poll = async (parameters: { reads?: WorldReads; bootstrap?: boolean } = {}) => {
  const write = await readWorld({
    at: { number: 7, hash: `0x${'07'.repeat(32)}`, timestamp: 1_000n },
    readAt: 5_000,
    ownership: {
      ladderPublications: [],
      bootstrapGroupIds: [v0Group],
      bootstrapOffers: [],
      heldBuyGroups: [],
      retiredGroupIds: []
    },
    views: {},
    reads: parameters.reads ?? reads(),
    markets: [
      { strategy: 'ladder', marketId },
      ...(parameters.bootstrap === false ? [] : [{ strategy: 'bootstrap' as const, marketId }])
    ],
    accounting: { maker, marketIds: [marketId, otherMarketId], v0OfferGroupIds: [v0Group] },
    expiry: 5_000 + 3 * EVERY_MS
  })
  if (write.coverage !== 'complete') throw new TypeError('the world read failed')
  return write
}

const entry = (write: Awaited<ReturnType<typeof poll>>, key: string) =>
  (write.entries as Readonly<Record<string, WorldValue>>)[key]!

describe('readWorld', () => {
  test('vouches for every configured market at the kernel head it pinned every read to', async () => {
    const blocks: WorldBlock[] = []
    const write = await poll({
      reads: reads({
        readCash: async block => {
          blocks.push(block)
          return { cashBalance: 50n, allowance: 50n }
        },
        readConsumed: async (groupIds, block) => {
          blocks.push(block)
          return groupIds.map(() => 0n)
        }
      })
    })

    expect(Object.keys(write.entries)).toEqual([`ladder:${marketId}`, `bootstrap:${marketId}`])
    expect(write.basis).toEqual({
      block: 7,
      blockHash: `0x${'07'.repeat(32)}`,
      timestamp: 1_000n,
      readAt: 5_000
    })
    const world = entry(write, `ladder:${marketId}`)
    expect(world).not.toHaveProperty('timestamp')
    const pinned = { number: 7n, hash: `0x${'07'.repeat(32)}`, timestamp: 1_000n }
    expect(blocks).toEqual([pinned, pinned])
    expect(Object.keys(world.positions)).toEqual([marketId, otherMarketId])
    expect(world.positions[otherMarketId]).toMatchObject({ ok: true, value: { credit: 7n } })
    expect(world.book).toEqual({ ok: true, value: [] })
    expect(entry(write, `bootstrap:${marketId}`).book).toBeUndefined()
  })

  test('reads consumption for every indexed, owned, and intended group', async () => {
    const asked: (readonly Hex[])[] = []
    await poll({
      reads: reads({
        readConsumed: async groupIds => {
          asked.push(groupIds)
          return groupIds.map(() => 0n)
        }
      })
    })

    expect(asked).toEqual([[indexedGroup, v0Group]])
  })

  test('expires the read a fixed number of polls after it started', async () => {
    expect((await poll()).expiry).toBe(5_000 + 3 * EVERY_MS)
  })

  test('keeps a failed read as a failed value of the keys that read it', async () => {
    const write = await poll({
      reads: reads({
        readGroups: async () => {
          throw new LadderAdapterError('offer-groups-timeout')
        },
        readBook: async () => {
          throw new LadderAdapterError('book-timeout')
        }
      })
    })

    const world = entry(write, `ladder:${marketId}`)
    expect(world.groups).toEqual({
      ok: false,
      errorName: 'LadderAdapterError',
      adapterOperation: 'offer-groups-timeout'
    })
    expect(world.book).toEqual({ ok: true, value: null })
    expect(world.cash).toEqual({ ok: true, value: { cashBalance: 50n, allowance: 50n } })
  })

  test('fails every chain value when the chain no longer holds the kernel head it is pinned to', async () => {
    const held = `0x${'08'.repeat(32)}`
    const atHeld = <T>(block: WorldBlock, value: T) => {
      if (block.hash !== held) throw new TypeError('header not found')
      return value
    }
    const write = await poll({
      reads: reads({
        readPosition: async (market, block) =>
          atHeld(block, {
            marketId: market,
            credit: 0n,
            debt: 0n,
            lossFactor: 0n,
            maturity: 10_000n,
            tickSpacing: 4,
            continuousFee: 0
          }),
        readCash: async block => atHeld(block, { cashBalance: 50n, allowance: 50n }),
        readConsumed: async (groupIds, block) =>
          atHeld(
            block,
            groupIds.map(() => 0n)
          )
      })
    })

    const world = entry(write, `ladder:${marketId}`)
    const failed = { ok: false, errorName: 'TypeError' }
    expect(world.positions).toEqual({ [marketId]: failed, [otherMarketId]: failed })
    expect(world.cash).toEqual(failed)
    expect(world.consumed).toEqual(failed)
  })

  test('a book provider failure is a failed book, not a missing observation', async () => {
    const write = await poll({
      reads: reads({
        readBook: async () => {
          throw new TypeError('fetch failed')
        }
      })
    })

    expect(entry(write, `ladder:${marketId}`).book).toEqual({ ok: false, errorName: 'TypeError' })
  })
})
