import type { Address, Hex } from 'viem'

import { describe, expect, test } from 'vitest'

import type {
  BootstrapGroupInventory,
  BootstrapInventoryReader
} from '../../../src/infrastructure/bootstrap/bootstrap-position.service'
import type { ExposurePosition } from '../../../src/infrastructure/exposure/exposure-snapshot.utils'

import { bootstrapSizeCapacity } from '../../../src/domain/position-bootstrap'
import { bootstrapInventoryFromSnapshot } from '../../../src/infrastructure/bootstrap/bootstrap-inventory.utils'
import { MidnightBootstrapPositionService } from '../../../src/infrastructure/bootstrap/bootstrap-position.service'

const maker: Address = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const marketId: Hex = `0x${'11'.repeat(32)}`
const firstGroup: Hex = `0x${'22'.repeat(32)}`
const secondGroup: Hex = `0x${'33'.repeat(32)}`

const readerOf = (
  parts: Omit<BootstrapInventoryReader, 'readInventory'> & {
    readPositions: () => Promise<readonly ExposurePosition[]>
    readCashBalance: () => Promise<bigint>
    readGroupInventory: () => Promise<BootstrapGroupInventory>
  }
): BootstrapInventoryReader => ({
  readInventory: async () => ({
    positions: await parts.readPositions(),
    cashBalance: await parts.readCashBalance(),
    groupInventory: await parts.readGroupInventory()
  }),
  readMarketContinuousFeeCap: parts.readMarketContinuousFeeCap,
  readMarketMaturity: parts.readMarketMaturity
})

describe('MidnightBootstrapPositionService', () => {
  test('excludes a live group from the capacity available to replace itself', async () => {
    const service = new MidnightBootstrapPositionService(
      readerOf({
        readPositions: async () => [{ marketId, credit: 0n, debt: 0n, lossFactor: 0n }],
        readCashBalance: async () => 100n,
        readMarketContinuousFeeCap: async () => 17n,
        readMarketMaturity: async () => ({ maturityTimestamp: 2_000n, observedTimestamp: 1_000n }),
        readGroupInventory: async () => ({
          activeGroups: [{ id: firstGroup, marketId, assets: 100n, rateBps: 500n }],
          cashReservations: []
        })
      }),
      maker,
      new Map()
    )

    const position = await service.readPosition(marketId)

    expect(position.marketExposure).toBe(0n)
    expect(position.totalExposure).toBe(0n)
  })

  test('carries the snapshot rate window beside the maturity observation', async () => {
    const service = new MidnightBootstrapPositionService(
      readerOf({
        readPositions: async () => [{ marketId, credit: 0n, debt: 0n, lossFactor: 0n }],
        readCashBalance: async () => 100n,
        readMarketContinuousFeeCap: async () => 17n,
        readMarketMaturity: async () => ({
          maturityTimestamp: 2_000n,
          observedTimestamp: 1_000n,
          rateWindowEmpty: true
        }),
        readGroupInventory: async () => ({ activeGroups: [], cashReservations: [] })
      }),
      maker,
      new Map()
    )

    expect(await service.readPosition(marketId)).toMatchObject({
      maturityTimestamp: 2_000n,
      observedTimestamp: 1_000n,
      rateWindowEmpty: true
    })
  })

  test('keeps every other group in replacement exposure', async () => {
    const otherMarketId: Hex = `0x${'44'.repeat(32)}`
    const service = new MidnightBootstrapPositionService(
      readerOf({
        readPositions: async () => [
          { marketId, credit: 10n, debt: 0n, lossFactor: 0n },
          { marketId: otherMarketId, credit: 5n, debt: 0n, lossFactor: 0n }
        ],
        readCashBalance: async () => 100n,
        readMarketContinuousFeeCap: async () => 17n,
        readMarketMaturity: async () => ({ maturityTimestamp: 2_000n, observedTimestamp: 1_000n }),
        readGroupInventory: async () => ({
          activeGroups: [
            { id: firstGroup, marketId, assets: 20n, rateBps: 500n },
            { id: secondGroup, marketId, assets: 30n, rateBps: 500n },
            {
              id: `0x${'55'.repeat(32)}`,
              marketId: otherMarketId,
              assets: 40n,
              rateBps: 500n
            }
          ],
          cashReservations: []
        })
      }),
      maker,
      new Map()
    )

    const position = await service.readPosition(marketId)

    expect(position.marketExposure).toBe(40n)
    expect(position.totalExposure).toBe(85n)
  })

  test('subtracts other outstanding lend groups from wallet cash capacity', async () => {
    const otherMarketId: Hex = `0x${'44'.repeat(32)}`
    const service = new MidnightBootstrapPositionService(
      readerOf({
        readPositions: async () => [
          { marketId, credit: 0n, debt: 0n, lossFactor: 0n },
          { marketId: otherMarketId, credit: 0n, debt: 0n, lossFactor: 0n }
        ],
        readCashBalance: async () => 100n,
        readMarketContinuousFeeCap: async () => 17n,
        readMarketMaturity: async () => ({ maturityTimestamp: 2_000n, observedTimestamp: 1_000n }),
        readGroupInventory: async () => ({
          activeGroups: [
            { id: firstGroup, marketId, assets: 20n, rateBps: 500n },
            {
              id: secondGroup,
              marketId: otherMarketId,
              assets: 70n,
              rateBps: 500n
            }
          ],
          cashReservations: []
        })
      }),
      maker,
      new Map()
    )

    const position = await service.readPosition(marketId)

    expect(position.cashBalance).toBe(30n)
  })

  test('counts a shared multi-market group once in aggregate exposure', async () => {
    const otherMarketId: Hex = `0x${'44'.repeat(32)}`
    const inspectionMarketId: Hex = `0x${'55'.repeat(32)}`
    const service = new MidnightBootstrapPositionService(
      readerOf({
        readPositions: async () => [
          { marketId, credit: 0n, debt: 0n, lossFactor: 0n },
          { marketId: otherMarketId, credit: 0n, debt: 0n, lossFactor: 0n },
          { marketId: inspectionMarketId, credit: 0n, debt: 0n, lossFactor: 0n }
        ],
        readCashBalance: async () => 100n,
        readMarketContinuousFeeCap: async () => 17n,
        readMarketMaturity: async () => ({ maturityTimestamp: 2_000n, observedTimestamp: 1_000n }),
        readGroupInventory: async () => ({
          activeGroups: [
            { id: firstGroup, marketId, assets: 100n, rateBps: 500n },
            {
              id: firstGroup,
              marketId: otherMarketId,
              assets: 100n,
              rateBps: 600n
            }
          ],
          cashReservations: []
        })
      }),
      maker,
      new Map()
    )

    const first = await service.readPosition(marketId)
    const second = await service.readPosition(otherMarketId)
    const aggregate = await service.readPosition(inspectionMarketId)

    expect(first.activeOffer?.referenceObservationId).toBe(`group:${firstGroup}`)
    expect(second.activeOffer?.referenceObservationId).toBe(`group:${firstGroup}`)
    expect(aggregate.totalExposure).toBe(100n)
  })

  test('rehydrates persisted intended rate and reference observation', async () => {
    const service = new MidnightBootstrapPositionService(
      readerOf({
        readPositions: async () => [{ marketId, credit: 0n, debt: 0n, lossFactor: 0n }],
        readCashBalance: async () => 100n,
        readMarketContinuousFeeCap: async () => 17n,
        readMarketMaturity: async () => ({ maturityTimestamp: 2_000n, observedTimestamp: 1_000n }),
        readGroupInventory: async () => ({
          activeGroups: [
            {
              id: firstGroup,
              marketId,
              assets: 100n,
              rateBps: 450n,
              referenceObservationId: 'blocks:100-200'
            }
          ],
          cashReservations: []
        })
      }),
      maker,
      new Map()
    )

    expect((await service.readPosition(marketId)).activeOffer).toEqual({
      marketId,
      assets: 100n,
      rateBps: 450n,
      referenceObservationId: 'blocks:100-200'
    })
  })

  test('sizes the next bootstrap offer down to an allowance a fill has drained below cash', async () => {
    const inventory = bootstrapInventoryFromSnapshot({
      snapshot: {
        blockNumber: 10n,
        timestamp: 1_000n,
        cashBalance: 940n,
        allowance: 30n,
        positions: [{ marketId, credit: 60n, debt: 0n, lossFactor: 0n }],
        groups: []
      },
      groups: [],
      ownedGroupIds: [],
      ownedOffers: []
    })
    const service = new MidnightBootstrapPositionService(
      {
        readInventory: async () => inventory,
        readMarketContinuousFeeCap: async () => 17n,
        readMarketMaturity: async () => ({ maturityTimestamp: 2_000n, observedTimestamp: 1_000n })
      },
      maker,
      new Map()
    )

    expect(
      bootstrapSizeCapacity(
        {
          offerSize: 1_000n,
          creditTarget: 1_000n,
          maximumMarketExposure: 1_000n,
          maximumTotalExposure: 1_000n
        },
        await service.readPosition(marketId)
      )
    ).toEqual({ assets: 30n, cap: 'cash-balance' })
  })

  test('reads an unconsumed owned offer back at exactly its persisted size and rate', async () => {
    const offer = { marketId, assets: 500n, rateBps: 450n, referenceObservationId: 'static:450' }
    const inventory = bootstrapInventoryFromSnapshot({
      snapshot: {
        blockNumber: 10n,
        timestamp: 1_000n,
        cashBalance: 1_000n,
        allowance: 1_000n,
        positions: [{ marketId, credit: 0n, debt: 0n, lossFactor: 0n }],
        groups: [
          {
            groupId: firstGroup,
            marketIds: [marketId],
            state: 'indexed-live',
            remainingAssets: 500n,
            remainingCashAssets: 500n
          }
        ]
      },
      groups: [
        {
          id: firstGroup,
          cap: { kind: 'units', maximum: offer.assets },
          consumed: 0n,
          marketId,
          tick: 5_000n,
          maturity: 2_000n,
          continuousFeeCap: 17n,
          offers: [{ marketId, maker, buy: true, tick: 5_000n }]
        }
      ],
      ownedGroupIds: [firstGroup],
      ownedOffers: [{ groupId: firstGroup, ...offer }]
    })
    const service = new MidnightBootstrapPositionService(
      {
        readInventory: async () => inventory,
        readMarketContinuousFeeCap: async () => 17n,
        readMarketMaturity: async () => ({ maturityTimestamp: 2_000n, observedTimestamp: 1_000n })
      },
      maker,
      new Map()
    )

    expect(inventory.groupInventory.activeGroups).toMatchObject([
      { assets: offer.assets, maximumAssets: offer.assets }
    ])
    expect((await service.readPosition(marketId)).activeOffer).toEqual(offer)
  })

  test('forces reconciliation when duplicate active groups exist for one market', async () => {
    const service = new MidnightBootstrapPositionService(
      readerOf({
        readPositions: async () => [{ marketId, credit: 10n, debt: 0n, lossFactor: 0n }],
        readCashBalance: async () => 100n,
        readMarketContinuousFeeCap: async () => 17n,
        readMarketMaturity: async () => ({ maturityTimestamp: 2_000n, observedTimestamp: 1_000n }),
        readGroupInventory: async () => ({
          activeGroups: [
            { id: firstGroup, marketId, assets: 20n, rateBps: 500n },
            { id: secondGroup, marketId, assets: 20n, rateBps: 500n }
          ],
          cashReservations: []
        })
      }),
      maker,
      new Map()
    )

    const position = await service.readPosition(marketId)

    expect(position.activeOffer).toEqual({
      marketId,
      assets: 20n,
      rateBps: 500n,
      referenceObservationId: `group:${firstGroup}`
    })
    expect(position.requiresReconciliation).toBe(true)
    expect(position.marketExposure).toBe(30n)
  })

  test('forces reconciliation when one group contains multiple offers', async () => {
    const service = new MidnightBootstrapPositionService(
      readerOf({
        readPositions: async () => [{ marketId, credit: 10n, debt: 0n, lossFactor: 0n }],
        readCashBalance: async () => 100n,
        readMarketContinuousFeeCap: async () => 17n,
        readMarketMaturity: async () => ({ maturityTimestamp: 2_000n, observedTimestamp: 1_000n }),
        readGroupInventory: async () => ({
          activeGroups: [
            {
              id: firstGroup,
              marketId,
              assets: 20n,
              rateBps: 500n,
              offerCount: 2
            }
          ],
          cashReservations: []
        })
      }),
      maker,
      new Map()
    )

    expect((await service.readPosition(marketId)).requiresReconciliation).toBe(true)
  })

  test('forces reconciliation when a pending group has no persisted fee cap', async () => {
    const service = new MidnightBootstrapPositionService(
      readerOf({
        readPositions: async () => [{ marketId, credit: 10n, debt: 0n, lossFactor: 0n }],
        readCashBalance: async () => 100n,
        readMarketContinuousFeeCap: async () => 17n,
        readMarketMaturity: async () => ({ maturityTimestamp: 2_000n, observedTimestamp: 1_000n }),
        readGroupInventory: async () => ({
          activeGroups: [
            {
              id: firstGroup,
              marketId,
              assets: 20n,
              rateBps: 500n,
              offerCount: 1
            }
          ],
          cashReservations: []
        })
      }),
      maker,
      new Map()
    )

    expect((await service.readPosition(marketId)).requiresReconciliation).toBe(true)
  })

  test('forces reconciliation when a resting fee cap differs from live policy', async () => {
    const service = new MidnightBootstrapPositionService(
      readerOf({
        readPositions: async () => [{ marketId, credit: 10n, debt: 0n, lossFactor: 0n }],
        readCashBalance: async () => 100n,
        readMarketContinuousFeeCap: async () => 17n,
        readMarketMaturity: async () => ({ maturityTimestamp: 2_000n, observedTimestamp: 1_000n }),
        readGroupInventory: async () => ({
          activeGroups: [
            {
              id: firstGroup,
              marketId,
              assets: 20n,
              rateBps: 500n,
              offerCount: 1,
              continuousFeeCap: 16n
            }
          ],
          cashReservations: []
        })
      }),
      maker,
      new Map()
    )

    expect((await service.readPosition(marketId)).requiresReconciliation).toBe(true)
  })

  test('keeps a singleton group resting when its fee cap matches live policy', async () => {
    const service = new MidnightBootstrapPositionService(
      readerOf({
        readPositions: async () => [{ marketId, credit: 10n, debt: 0n, lossFactor: 0n }],
        readCashBalance: async () => 100n,
        readMarketContinuousFeeCap: async () => 17n,
        readMarketMaturity: async () => ({ maturityTimestamp: 2_000n, observedTimestamp: 1_000n }),
        readGroupInventory: async () => ({
          activeGroups: [
            {
              id: firstGroup,
              marketId,
              assets: 20n,
              rateBps: 500n,
              offerCount: 1,
              continuousFeeCap: 17n
            }
          ],
          cashReservations: []
        })
      }),
      maker,
      new Map()
    )

    expect((await service.readPosition(marketId)).requiresReconciliation).toBe(false)
  })

  test('reserves ladder buys without treating them as replaceable bootstrap offers', async () => {
    const otherMarketId: Hex = `0x${'44'.repeat(32)}`
    const service = new MidnightBootstrapPositionService(
      readerOf({
        readPositions: async () => [
          { marketId, credit: 10n, debt: 0n, lossFactor: 0n },
          { marketId: otherMarketId, credit: 5n, debt: 0n, lossFactor: 0n }
        ],
        readCashBalance: async () => 200n,
        readMarketContinuousFeeCap: async () => 17n,
        readMarketMaturity: async () => ({ maturityTimestamp: 2_000n, observedTimestamp: 1_000n }),
        readGroupInventory: async () => ({
          activeGroups: [],
          cashReservations: [
            { id: firstGroup, marketId, assets: 70n, rateBps: 500n },
            {
              id: secondGroup,
              marketId: otherMarketId,
              assets: 40n,
              rateBps: 600n
            }
          ]
        })
      }),
      maker,
      new Map()
    )

    const position = await service.readPosition(marketId)

    expect(position.activeOffer).toBeUndefined()
    expect(position.cashBalance).toBe(90n)
    expect(position.marketExposure).toBe(80n)
    expect(position.totalExposure).toBe(125n)
  })
  test('propagates market maturity beside the timestamp it was observed against', async () => {
    const service = new MidnightBootstrapPositionService(
      readerOf({
        readPositions: async () => [{ marketId, credit: 0n, debt: 0n, lossFactor: 0n }],
        readCashBalance: async () => 100n,
        readMarketContinuousFeeCap: async () => 17n,
        readMarketMaturity: async () => ({ maturityTimestamp: 1_000n, observedTimestamp: 1_200n }),
        readGroupInventory: async () => ({ activeGroups: [], cashReservations: [] })
      }),
      maker,
      new Map()
    )

    const position = await service.readPosition(marketId)

    expect(position.maturityTimestamp).toBe(1_000n)
    expect(position.observedTimestamp).toBe(1_200n)
  })

  test('counts an unattributed live buy group toward reserved cash and exposure', async () => {
    const orphanGroup: Hex = `0x${'66'.repeat(32)}`
    const service = new MidnightBootstrapPositionService(
      readerOf({
        readPositions: async () => [{ marketId, credit: 0n, debt: 0n, lossFactor: 0n }],
        readCashBalance: async () => 100n,
        readMarketContinuousFeeCap: async () => 17n,
        readMarketMaturity: async () => ({ maturityTimestamp: 2_000n, observedTimestamp: 1_000n }),
        readGroupInventory: async () => ({
          activeGroups: [],
          cashReservations: [{ id: orphanGroup, marketId, assets: 30n, rateBps: 500n }]
        })
      }),
      maker,
      new Map()
    )

    const position = await service.readPosition(marketId)

    expect(position.cashBalance).toBe(70n)
    expect(position.marketExposure).toBe(30n)
    expect(position.totalExposure).toBe(30n)
  })

  test('counts a partly filled other-market buy at its full committed exposure', async () => {
    const otherMarketId: Hex = `0x${'44'.repeat(32)}`
    const inventory = bootstrapInventoryFromSnapshot({
      snapshot: {
        blockNumber: 10n,
        timestamp: 1_000n,
        cashBalance: 1_000n,
        allowance: 1_000n,
        positions: [
          { marketId, credit: 0n, debt: 0n, lossFactor: 0n },
          { marketId: otherMarketId, credit: 50n, debt: 0n, lossFactor: 0n }
        ],
        groups: [
          {
            groupId: secondGroup,
            marketIds: [otherMarketId],
            state: 'indexed-live',
            remainingAssets: 50n,
            remainingCashAssets: 50n
          }
        ]
      },
      groups: [
        {
          id: secondGroup,
          cap: { kind: 'assets', maximum: 100n },
          consumed: 0n,
          offers: [{ marketId: otherMarketId, maker, buy: true, tick: 1n }]
        }
      ],
      ownedGroupIds: [],
      ownedOffers: []
    })
    const service = new MidnightBootstrapPositionService(
      {
        readInventory: async () => inventory,
        readMarketContinuousFeeCap: async () => 17n,
        readMarketMaturity: async () => ({ maturityTimestamp: 2_000n, observedTimestamp: 1_000n })
      },
      maker,
      new Map()
    )

    const position = await service.readPosition(marketId)

    expect(position.totalExposure).toBe(100n)
    expect(
      bootstrapSizeCapacity(
        {
          offerSize: 1_000n,
          creditTarget: 1_000n,
          maximumMarketExposure: 1_000n,
          maximumTotalExposure: 200n
        },
        position
      ).assets
    ).toBe(100n)
  })

  test('reports the snapshot-block loss factor beside the accepted or defaulted value', async () => {
    const otherMarketId: Hex = `0x${'44'.repeat(32)}`
    const service = new MidnightBootstrapPositionService(
      readerOf({
        readPositions: async () => [
          { marketId, credit: 0n, debt: 0n, lossFactor: 7n },
          { marketId: otherMarketId, credit: 0n, debt: 0n, lossFactor: 3n }
        ],
        readCashBalance: async () => 100n,
        readMarketContinuousFeeCap: async () => 17n,
        readMarketMaturity: async () => ({ maturityTimestamp: 2_000n, observedTimestamp: 1_000n }),
        readGroupInventory: async () => ({ activeGroups: [], cashReservations: [] })
      }),
      maker,
      new Map([[marketId, 7n]])
    )

    expect((await service.readPosition(marketId)).lossFactor).toEqual({
      lossFactor: 7n,
      acceptedLossFactor: 7n,
      defaulted: false
    })
    expect((await service.readPosition(otherMarketId)).lossFactor).toEqual({
      lossFactor: 3n,
      acceptedLossFactor: 0n,
      defaulted: true
    })
  })
})
