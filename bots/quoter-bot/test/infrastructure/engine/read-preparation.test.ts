import type { IMarket } from '@morpho-org/midnight-sdk'
import type { Hex } from 'viem'

import { describe, expect, test, vi } from 'vitest'

import type { WorldReads } from '../../../src/infrastructure/engine/world-reads'

import { BootstrapAdapterError, LadderAdapterError } from '../../../src/errors'
import { readPreparation } from '../../../src/infrastructure/engine/quoter-sources'
import { createQuoterOwnership } from '../../../src/infrastructure/kernel/quoter-holdings'

const maker: Hex = '0x1111111111111111111111111111111111111111'
const marketId: Hex = `0x${'11'.repeat(32)}`
const v0Group: Hex = `0x${'aa'.repeat(32)}`
const indexed: Hex = `0x${'bb'.repeat(32)}`
const intended: Hex = `0x${'cc'.repeat(32)}`
const HEAD = 50n
const HEAD_HASH: Hex = `0x${'50'.repeat(32)}`
const head = { number: HEAD, hash: HEAD_HASH, timestamp: 1_000n }
const market = { params: { maturity: 9_000n }, tickSpacing: 4 } as unknown as IMarket

const reads = (overrides: Partial<WorldReads> = {}): WorldReads => ({
  readLatestBlock: async () => head,
  readMarket: async () => market,
  readGroups: async () => [
    {
      id: indexed,
      consumed: 0n,
      cap: { kind: 'units', maximum: 10n },
      offers: [{ marketId, maker, buy: true, tick: 4_400n }]
    }
  ],
  readBook: async () => [],
  readPosition: async () => {
    throw new Error('preparations read no position')
  },
  readCash: async () => {
    throw new Error('preparations read no cash')
  },
  readConsumed: async groupIds => groupIds.map((_, index) => BigInt(index)),
  ...overrides
})

const prepare = async (
  value: WorldReads,
  adapterError: typeof LadderAdapterError | typeof BootstrapAdapterError = LadderAdapterError,
  atLeastBlock = 0n
) => {
  const intentId = `bootstrap:${marketId}#run.0`
  const executing = { entries: {}, plans: { [intentId]: { status: 'executing' } } }
  const ownership = createQuoterOwnership(
    () => executing as never,
    () => [
      {
        workflow: 'bootstrap',
        intentId,
        groupId: intended,
        offer: { marketId, assets: 5n, rateBps: 500n, referenceObservationId: 'hour:1' }
      }
    ],
    [v0Group]
  )
  return readPreparation({
    reads: value,
    ownership: ownership.current(),
    marketId,
    atLeastBlock,
    adapterError
  })
}

describe('readPreparation', () => {
  test('fails when the head it read is reorged out before its pinned reads, reading nothing by number', async () => {
    const pinned: unknown[] = []
    const reorged = reads({
      readMarket: async (_, block) => {
        pinned.push(block)
        throw new TypeError('header not found')
      },
      readConsumed: async (_, block) => {
        pinned.push(block)
        throw new TypeError('header not found')
      }
    })

    await expect(prepare(reorged)).rejects.toThrow()
    expect(pinned).toEqual([head, head])
  })

  test('pins the market and every known group consumption to the head it read', async () => {
    const readMarket = vi.fn(async () => market)
    const readConsumed = vi.fn(async (groupIds: readonly Hex[]) => groupIds.map(() => 3n))

    const reading = await prepare(reads({ readMarket, readConsumed }))

    expect(readMarket).toHaveBeenCalledWith(marketId, head)
    expect(readConsumed).toHaveBeenCalledWith([indexed, v0Group, intended], head)
    expect(reading).toMatchObject({
      block: head,
      market,
      book: [],
      consumed: { [indexed]: 3n, [v0Group]: 3n, [intended]: 3n },
      ownership: { bootstrapGroupIds: [v0Group, intended] }
    })
  })

  test('fails on a book it cannot read, named as the preparing strategy', async () => {
    const malformed = reads({
      readBook: async () => {
        throw new LadderAdapterError('book-response')
      }
    })

    await expect(prepare(malformed)).rejects.toMatchObject({
      name: 'LadderAdapterError',
      operation: 'book-response'
    })
    await expect(prepare(malformed, BootstrapAdapterError)).rejects.toMatchObject({
      name: 'BootstrapAdapterError',
      operation: 'book-response'
    })
  })

  test('refuses a head older than the world block its decision read, and reads nothing at it', async () => {
    const readMarket = vi.fn(async () => market)
    await expect(
      prepare(reads({ readMarket }), BootstrapAdapterError, HEAD + 1n)
    ).rejects.toMatchObject({ name: 'BootstrapAdapterError', operation: 'head-behind-world' })
    expect(readMarket).not.toHaveBeenCalled()
    await expect(prepare(reads(), LadderAdapterError, HEAD)).resolves.toMatchObject({
      block: { number: HEAD }
    })
  })

  test.each([
    [
      'fails',
      async () => {
        throw new Error('rpc')
      }
    ],
    ['returns too few values', async () => [0n]]
  ])('fails closed when the consumption read %s', async (_label, readConsumed) => {
    await expect(prepare(reads({ readConsumed }))).rejects.toMatchObject({
      name: 'LadderAdapterError',
      operation: 'group-consumption-read'
    })
  })
})
