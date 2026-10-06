import type { Address, Hex } from 'viem'

import { MAX_OFFER_CAP, MAX_TICK, TickLib } from '@morpho-org/midnight-sdk'
import { MathLib } from '@morpho-org/morpho-ts'
import { describe, expect, test } from 'vitest'

import type {
  DurableBuyReservation,
  ExposureSnapshotReader
} from '../../../src/infrastructure/exposure/exposure-snapshot.utils'
import type { OwnedLadderPublication } from '../../../src/infrastructure/ladder/ladder-group-ownership.utils'
import type { MakerOfferGroup } from '../../../src/infrastructure/provider/offer-groups.utils'

import { MAX_LOSS_FACTOR } from '../../../src/domain/loss-factor'
import {
  createExposureSnapshotReader,
  durableBuyReservations,
  readExposureSnapshot,
  waitForMinimumBlock
} from '../../../src/infrastructure/exposure/exposure-snapshot.utils'
import { LadderAdapterError } from '../../../src/infrastructure/ladder/ladder-adapter.error'

const maker: Address = '0x1111111111111111111111111111111111111111'
const marketId: Hex = `0x${'11'.repeat(32)}`
const otherMarketId: Hex = `0x${'12'.repeat(32)}`
const groupA: Hex = `0x${'aa'.repeat(32)}`
const groupB: Hex = `0x${'bb'.repeat(32)}`
const groupC: Hex = `0x${'cc'.repeat(32)}`

const buyGroup = (
  id: Hex,
  parameters: {
    maxAssets?: bigint
    maxUnits?: bigint
    consumed?: bigint
    marketIds?: readonly Hex[]
    tick?: bigint
  }
): MakerOfferGroup => ({
  id,
  cap:
    parameters.maxUnits === undefined
      ? { kind: 'assets', maximum: parameters.maxAssets ?? 0n }
      : { kind: 'units', maximum: parameters.maxUnits },
  consumed: parameters.consumed ?? 0n,
  offers: (parameters.marketIds ?? [marketId]).map(offerMarketId => ({
    marketId: offerMarketId,
    maker,
    buy: true,
    tick: parameters.tick ?? MAX_TICK
  }))
})

const chain = (parameters: {
  heads?: readonly bigint[]
  consumed?: Readonly<Record<Hex, bigint>>
  reads?: { kind: string; blockNumber: bigint }[]
  lossFactor?: unknown
}): ExposureSnapshotReader => {
  const heads = [...(parameters.heads ?? [100n])]
  return {
    readLatestBlock: async () => {
      const number = heads.length > 1 ? heads.shift()! : heads[0]!
      return { number, timestamp: number * 10n }
    },
    readPositions: async block => {
      parameters.reads?.push({ kind: 'positions', blockNumber: block.number })
      return [
        {
          marketId,
          credit: block.timestamp,
          debt: 0n,
          lossFactor: ('lossFactor' in parameters ? parameters.lossFactor : 0n) as bigint
        }
      ]
    },
    readCash: async blockNumber => {
      parameters.reads?.push({ kind: 'cash', blockNumber })
      return { cashBalance: 500n, allowance: 400n }
    },
    readConsumed: async (groupIds, blockNumber) => {
      parameters.reads?.push({ kind: 'consumed', blockNumber })
      return groupIds.map(groupId => parameters.consumed?.[groupId] ?? 0n)
    }
  }
}

const snapshot = (
  reader: ExposureSnapshotReader,
  parameters: {
    indexedGroups?: readonly MakerOfferGroup[]
    durableReservations?: readonly DurableBuyReservation[]
    minimumBlockNumber?: bigint
  } = {}
) =>
  readExposureSnapshot({
    reader,
    indexedGroups: parameters.indexedGroups ?? [],
    durableReservations: parameters.durableReservations ?? [],
    ...(parameters.minimumBlockNumber === undefined
      ? {}
      : { minimumBlockNumber: parameters.minimumBlockNumber }),
    adapterError: LadderAdapterError
  })

describe('readExposureSnapshot', () => {
  test('pins every position, cash, and consumption read to one block', async () => {
    const reads: { kind: string; blockNumber: bigint }[] = []

    const result = await snapshot(chain({ heads: [42n], reads }), {
      indexedGroups: [buyGroup(groupA, { maxUnits: 10n })]
    })

    expect(result).toMatchObject({ blockNumber: 42n, timestamp: 420n })
    expect(result.positions).toEqual([{ marketId, credit: 420n, debt: 0n, lossFactor: 0n }])
    expect(reads).toEqual([
      { kind: 'positions', blockNumber: 42n },
      { kind: 'cash', blockNumber: 42n },
      { kind: 'consumed', blockNumber: 42n }
    ])
  })

  test('waits for a head behind the minimum block to catch up', async () => {
    const reads: { kind: string; blockNumber: bigint }[] = []

    const result = await snapshot(chain({ heads: [9n, 10n], reads }), { minimumBlockNumber: 10n })

    expect(result.blockNumber).toBe(10n)
    expect(reads.map(read => read.blockNumber)).toEqual([10n, 10n])
  })

  test('fails closed as snapshot-unavailable when the head never reaches the minimum block', async () => {
    await expect(
      snapshot(chain({ heads: [9n] }), { minimumBlockNumber: 10n })
    ).rejects.toMatchObject({ name: 'LadderAdapterError', operation: 'snapshot-unavailable' })
  })

  test('takes consumption from the chain when the indexer is ahead of it', async () => {
    const result = await snapshot(chain({ consumed: { [groupA]: 30n } }), {
      indexedGroups: [buyGroup(groupA, { maxUnits: 100n, consumed: 80n })]
    })

    expect(result.groups).toEqual([
      {
        groupId: groupA,
        marketIds: [marketId],
        state: 'indexed-live',
        remainingAssets: 70n,
        remainingCashAssets: 70n
      }
    ])
  })

  test('reserves an indexed buy group no durable store attributes', async () => {
    const result = await snapshot(chain({ consumed: { [groupA]: 10n } }), {
      indexedGroups: [buyGroup(groupA, { maxUnits: 80n, consumed: 10n })]
    })

    expect(result.groups).toEqual([
      {
        groupId: groupA,
        marketIds: [marketId],
        state: 'indexed-live',
        remainingAssets: 70n,
        remainingCashAssets: 70n
      }
    ])
  })

  test('bounds a discounted buy by its cash at its tick, and an unindexed one at face', async () => {
    const tick = 4_440n
    const result = await snapshot(chain({ consumed: { [groupA]: 10n } }), {
      indexedGroups: [buyGroup(groupA, { maxUnits: 1_000_001n, consumed: 10n, tick })],
      durableReservations: [{ groupId: groupB, marketIds: [otherMarketId], maxUnits: 40n }]
    })

    expect(result.groups).toEqual([
      {
        groupId: groupA,
        marketIds: [marketId],
        state: 'indexed-live',
        remainingAssets: 999_991n,
        remainingCashAssets: MathLib.mulDiv(999_991n, TickLib.tickToPrice(tick), MathLib.WAD, 'Up')
      },
      {
        groupId: groupB,
        marketIds: [otherMarketId],
        state: 'reserved-pending',
        remainingAssets: 40n,
        remainingCashAssets: 40n
      }
    ])
    expect(result.groups[0]!.remainingCashAssets).toBe(995_154n)
  })

  test('fails closed on a live cash-capped buy published before unit caps', async () => {
    await expect(
      snapshot(chain({}), { indexedGroups: [buyGroup(groupA, { maxAssets: 100n })] })
    ).rejects.toMatchObject({ operation: 'cash-capped-buy-group' })
  })

  test('fails closed on a used-up cash-capped buy that was never cancelled', async () => {
    await expect(
      snapshot(chain({ consumed: { [groupA]: 100n } }), {
        indexedGroups: [buyGroup(groupA, { maxAssets: 100n })]
      })
    ).rejects.toMatchObject({ operation: 'cash-capped-buy-group' })
  })

  test('accepts a cancelled cash-capped buy', async () => {
    const result = await snapshot(chain({ consumed: { [groupA]: MAX_OFFER_CAP } }), {
      indexedGroups: [buyGroup(groupA, { maxAssets: 100n })]
    })

    expect(result.groups.map(group => group.state)).toEqual(['cancelled'])
  })

  test('counts an indexed group at the cancellation sentinel as zero', async () => {
    const result = await snapshot(chain({ consumed: { [groupA]: MAX_OFFER_CAP } }), {
      indexedGroups: [buyGroup(groupA, { maxUnits: 100n })]
    })

    expect(result.groups).toEqual([
      {
        groupId: groupA,
        marketIds: [marketId],
        state: 'cancelled',
        remainingAssets: 0n,
        remainingCashAssets: 0n
      }
    ])
  })

  test('never counts consumption above the cap as a negative reservation', async () => {
    const result = await snapshot(chain({ consumed: { [groupA]: 150n } }), {
      indexedGroups: [buyGroup(groupA, { maxUnits: 100n })]
    })

    expect(result.groups[0]?.remainingAssets).toBe(0n)
  })

  test('counts an unindexed durable reservation from its persisted cap', async () => {
    const result = await snapshot(chain({ consumed: { [groupB]: 15n } }), {
      durableReservations: [{ groupId: groupB, marketIds: [otherMarketId], maxUnits: 40n }]
    })

    expect(result.groups).toEqual([
      {
        groupId: groupB,
        marketIds: [otherMarketId],
        state: 'reserved-pending',
        remainingAssets: 25n,
        remainingCashAssets: 25n
      }
    ])
  })

  test('fails closed on a live pending group without a persisted cap', async () => {
    await expect(
      snapshot(chain({}), { durableReservations: [{ groupId: groupB, marketIds: [] }] })
    ).rejects.toMatchObject({ operation: 'missing-owned-group-intent' })
  })

  test('accepts a pending group without a persisted cap once it is cancelled', async () => {
    const result = await snapshot(chain({ consumed: { [groupB]: MAX_OFFER_CAP } }), {
      durableReservations: [{ groupId: groupB, marketIds: [] }]
    })

    expect(result.groups).toEqual([
      {
        groupId: groupB,
        marketIds: [],
        state: 'cancelled',
        remainingAssets: 0n,
        remainingCashAssets: 0n
      }
    ])
  })

  test('fails closed when the indexer and durable intent disagree on a cap kind', async () => {
    await expect(
      snapshot(chain({}), {
        indexedGroups: [buyGroup(groupA, { maxAssets: 100n })],
        durableReservations: [{ groupId: groupA, marketIds: [marketId], maxUnits: 100n }]
      })
    ).rejects.toMatchObject({ operation: 'group-ownership-state' })
  })

  test('reserves the larger of indexed and durable caps and ignores sell-only groups', async () => {
    const sellOnly: MakerOfferGroup = {
      id: groupC,
      cap: { kind: 'assets', maximum: 90n },
      consumed: 0n,
      offers: [{ marketId, maker, buy: false, tick: 1n }]
    }

    const result = await snapshot(chain({}), {
      indexedGroups: [
        buyGroup(groupA, { maxUnits: 60n, marketIds: [marketId] }),
        buyGroup(groupA, { maxUnits: 60n, marketIds: [otherMarketId] }),
        sellOnly
      ],
      durableReservations: [
        { groupId: groupA, marketIds: [marketId], maxUnits: 999n },
        { groupId: groupC, marketIds: [marketId], maxUnits: 999n }
      ]
    })

    expect(result.groups).toEqual([
      {
        groupId: groupA,
        marketIds: [marketId, otherMarketId],
        state: 'indexed-live',
        remainingAssets: 999n,
        remainingCashAssets: 999n
      }
    ])
  })
})

describe('readExposureSnapshot loss factor', () => {
  test('carries each position loss factor from the snapshot block', async () => {
    const result = await snapshot(chain({ heads: [42n], lossFactor: 7n }))

    expect(result.positions).toEqual([{ marketId, credit: 420n, debt: 0n, lossFactor: 7n }])
  })

  test.each([[undefined as unknown], [null], [-1n], [MAX_LOSS_FACTOR + 1n], [1]])(
    'fails closed as loss-factor-read on a malformed loss factor %s',
    async lossFactor => {
      await expect(snapshot(chain({ lossFactor }))).rejects.toMatchObject({
        operation: 'loss-factor-read'
      })
    }
  )

  test('reads the loss factor from the market fetched at the snapshot block', async () => {
    const requests: unknown[] = []
    const reader = createExposureSnapshotReader({
      client: {
        getBlock: async () => ({ number: 42n, timestamp: 420n }),
        readContract: async () => 0n,
        multicall: async () => []
      } as never,
      positions: {
        getPositionData: async request => {
          requests.push(request)
          return {
            market: { lossFactor: 9n },
            accrueInterest: () => ({ credit: 5n, debt: 1n })
          }
        }
      },
      maker,
      midnight: maker,
      loanAsset: maker,
      marketIds: [marketId]
    })

    expect(await reader.readPositions({ number: 42n, timestamp: 420n })).toEqual([
      { marketId, credit: 5n, debt: 1n, lossFactor: 9n }
    ])
    expect(requests).toEqual([
      { marketId, accountAddress: maker, parameters: { blockNumber: 42n } }
    ])
  })
})

describe('waitForMinimumBlock', () => {
  test('returns the current head without a minimum block', async () => {
    await expect(
      waitForMinimumBlock({
        readLatestBlock: async () => ({ number: 3n, timestamp: 30n }),
        adapterError: LadderAdapterError
      })
    ).resolves.toEqual({ number: 3n, timestamp: 30n })
  })
})

describe('durableBuyReservations', () => {
  test('projects higher ladder groups and every owned bootstrap group', () => {
    const publication: OwnedLadderPublication = {
      marketId,
      status: 'reserved',
      quote: {
        marketId,
        centerRateBps: 500n,
        groupMode: 'shared-rung',
        lower: [{ index: 0, rateBps: 400n, assets: 7n }],
        higher: [
          { index: 0, rateBps: 600n, assets: 30n },
          { index: 1, rateBps: 700n, assets: 20n }
        ]
      },
      groups: [
        { groupId: groupA, side: 'higher', rungIndexes: [0, 1], ticks: [100n] },
        { groupId: groupC, side: 'lower', rungIndexes: [0], ticks: [100n] }
      ]
    }

    expect(
      durableBuyReservations({
        ladderPublications: [publication],
        bootstrapGroupIds: [groupB, groupC],
        bootstrapOffers: [
          {
            groupId: groupB,
            marketId: otherMarketId,
            assets: 40n,
            rateBps: 500n,
            referenceObservationId: 'observation'
          }
        ]
      })
    ).toEqual([
      { groupId: groupA, marketIds: [marketId], maxUnits: 50n },
      { groupId: groupB, marketIds: [otherMarketId], maxUnits: 40n },
      { groupId: groupC, marketIds: [] }
    ])
  })
})
