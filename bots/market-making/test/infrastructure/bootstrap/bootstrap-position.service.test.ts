import type { Address, Hex } from 'viem'

import { TickLib } from '@morpho-org/midnight-sdk'
import { describe, expect, test } from 'bun:test'

import type { BootstrapInventoryReader } from '../../../src/infrastructure/bootstrap/bootstrap-position.service'

import { MidnightBootstrapPositionService } from '../../../src/infrastructure/bootstrap/bootstrap-position.service'

const maker: Address = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const marketId: Hex = `0x${'11'.repeat(32)}`
const firstGroup: Hex = `0x${'22'.repeat(32)}`
const secondGroup: Hex = `0x${'33'.repeat(32)}`

type FixtureReader = Omit<
  BootstrapInventoryReader,
  'readReservationCredit' | 'prepareReservationCredit'
> &
  Partial<Pick<BootstrapInventoryReader, 'readReservationCredit' | 'prepareReservationCredit'>>

const fixtureReader = (reader: FixtureReader): BootstrapInventoryReader => ({
  readReservationCredit: async group => group.assets,
  prepareReservationCredit: async () => assets => assets,
  ...reader
})

describe('MidnightBootstrapPositionService', () => {
  test('excludes a live group from the capacity available to replace itself', async () => {
    const service = new MidnightBootstrapPositionService(
      fixtureReader({
        readPositions: async () => [{ marketId, credit: 0n, debt: 0n }],
        readCashBalance: async () => 100n,
        readMarketContinuousFeeCap: async () => 17n,
        readGroupInventory: async () => ({
          activeGroups: [{ id: firstGroup, marketId, assets: 100n, rateBps: 500n }],
          cashReservations: []
        })
      }),
      maker
    )

    const position = await service.readPosition(marketId)

    expect(position.marketExposure).toBe(0n)
    expect(position.totalExposure).toBe(0n)
  })

  test('keeps every other group in replacement exposure', async () => {
    const otherMarketId: Hex = `0x${'44'.repeat(32)}`
    const service = new MidnightBootstrapPositionService(
      fixtureReader({
        readPositions: async () => [
          { marketId, credit: 10n, debt: 0n },
          { marketId: otherMarketId, credit: 5n, debt: 0n }
        ],
        readCashBalance: async () => 100n,
        readMarketContinuousFeeCap: async () => 17n,
        readGroupInventory: async () => ({
          activeGroups: [
            { id: firstGroup, marketId, assets: 20n, rateBps: 500n },
            { id: secondGroup, marketId, assets: 30n, rateBps: 500n },
            { id: `0x${'55'.repeat(32)}`, marketId: otherMarketId, assets: 40n, rateBps: 500n }
          ],
          cashReservations: []
        })
      }),
      maker
    )

    const position = await service.readPosition(marketId)

    expect(position.marketExposure).toBe(40n)
    expect(position.totalExposure).toBe(85n)
  })

  test('subtracts other outstanding lend groups from wallet cash capacity', async () => {
    const otherMarketId: Hex = `0x${'44'.repeat(32)}`
    const service = new MidnightBootstrapPositionService(
      fixtureReader({
        readPositions: async () => [
          { marketId, credit: 0n, debt: 0n },
          { marketId: otherMarketId, credit: 0n, debt: 0n }
        ],
        readCashBalance: async () => 100n,
        readMarketContinuousFeeCap: async () => 17n,
        readGroupInventory: async () => ({
          activeGroups: [
            { id: firstGroup, marketId, assets: 20n, rateBps: 500n },
            { id: secondGroup, marketId: otherMarketId, assets: 70n, rateBps: 500n }
          ],
          cashReservations: []
        })
      }),
      maker
    )

    const position = await service.readPosition(marketId)

    expect(position.cashBalance).toBe(30n)
  })

  test('counts a shared multi-market group once in aggregate exposure', async () => {
    const otherMarketId: Hex = `0x${'44'.repeat(32)}`
    const inspectionMarketId: Hex = `0x${'55'.repeat(32)}`
    const service = new MidnightBootstrapPositionService(
      fixtureReader({
        readPositions: async () => [
          { marketId, credit: 0n, debt: 0n },
          { marketId: otherMarketId, credit: 0n, debt: 0n },
          { marketId: inspectionMarketId, credit: 0n, debt: 0n }
        ],
        readCashBalance: async () => 100n,
        readMarketContinuousFeeCap: async () => 17n,
        readGroupInventory: async () => ({
          activeGroups: [
            { id: firstGroup, marketId, assets: 100n, rateBps: 500n },
            { id: firstGroup, marketId: otherMarketId, assets: 100n, rateBps: 600n }
          ],
          cashReservations: []
        })
      }),
      maker
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
      fixtureReader({
        readPositions: async () => [{ marketId, credit: 0n, debt: 0n }],
        readCashBalance: async () => 100n,
        readMarketContinuousFeeCap: async () => 17n,
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
      maker
    )

    expect((await service.readPosition(marketId)).activeOffer).toEqual({
      marketId,
      assets: 100n,
      rateBps: 450n,
      referenceObservationId: 'blocks:100-200'
    })
  })

  test('forces reconciliation when duplicate active groups exist for one market', async () => {
    const service = new MidnightBootstrapPositionService(
      fixtureReader({
        readPositions: async () => [{ marketId, credit: 10n, debt: 0n }],
        readCashBalance: async () => 100n,
        readMarketContinuousFeeCap: async () => 17n,
        readGroupInventory: async () => ({
          activeGroups: [
            { id: firstGroup, marketId, assets: 20n, rateBps: 500n },
            { id: secondGroup, marketId, assets: 20n, rateBps: 500n }
          ],
          cashReservations: []
        })
      }),
      maker
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
      fixtureReader({
        readPositions: async () => [{ marketId, credit: 10n, debt: 0n }],
        readCashBalance: async () => 100n,
        readMarketContinuousFeeCap: async () => 17n,
        readGroupInventory: async () => ({
          activeGroups: [{ id: firstGroup, marketId, assets: 20n, rateBps: 500n, offerCount: 2 }],
          cashReservations: []
        })
      }),
      maker
    )

    expect((await service.readPosition(marketId)).requiresReconciliation).toBe(true)
  })

  test('forces reconciliation when a pending group has no persisted fee cap', async () => {
    const service = new MidnightBootstrapPositionService(
      fixtureReader({
        readPositions: async () => [{ marketId, credit: 10n, debt: 0n }],
        readCashBalance: async () => 100n,
        readMarketContinuousFeeCap: async () => 17n,
        readGroupInventory: async () => ({
          activeGroups: [{ id: firstGroup, marketId, assets: 20n, rateBps: 500n, offerCount: 1 }],
          cashReservations: []
        })
      }),
      maker
    )

    expect((await service.readPosition(marketId)).requiresReconciliation).toBe(true)
  })

  test('forces reconciliation when a resting fee cap differs from live policy', async () => {
    const service = new MidnightBootstrapPositionService(
      fixtureReader({
        readPositions: async () => [{ marketId, credit: 10n, debt: 0n }],
        readCashBalance: async () => 100n,
        readMarketContinuousFeeCap: async () => 17n,
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
      maker
    )

    expect((await service.readPosition(marketId)).requiresReconciliation).toBe(true)
  })

  test('keeps a singleton group resting when its fee cap matches live policy', async () => {
    const service = new MidnightBootstrapPositionService(
      fixtureReader({
        readPositions: async () => [{ marketId, credit: 10n, debt: 0n }],
        readCashBalance: async () => 100n,
        readMarketContinuousFeeCap: async () => 17n,
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
      maker
    )

    expect((await service.readPosition(marketId)).requiresReconciliation).toBe(false)
  })

  test('converts reserved buyer assets to worst-case credit units', async () => {
    expect(TickLib.tickToPrice(3_976n)).toBe(953_129_400_000_000_000n)
    const service = new MidnightBootstrapPositionService(
      fixtureReader({
        readPositions: async () => [{ marketId, credit: 0n, debt: 0n }],
        readCashBalance: async () => 200n,
        readMarketContinuousFeeCap: async () => 0n,
        readGroupInventory: async () => ({
          activeGroups: [],
          cashReservations: [
            {
              id: firstGroup,
              marketId,
              assets: 100n,
              rateBps: 500n,
              tick: 3_976n,
              continuousFeeCap: 0n
            }
          ]
        }),
        readReservationCredit: async () => 105n
      }),
      maker
    )

    const position = await service.readPosition(marketId)

    expect(position.cashBalance).toBe(100n)
    expect(position.marketExposure).toBe(105n)
    expect(position.totalExposure).toBe(105n)
  })

  test('reconciles filled credit against the reduced reserve without growing exposure', async () => {
    const service = new MidnightBootstrapPositionService(
      fixtureReader({
        readPositions: async () => [{ marketId, credit: 10n, debt: 0n }],
        readCashBalance: async () => 100n,
        readMarketContinuousFeeCap: async () => 0n,
        readGroupInventory: async () => ({
          activeGroups: [],
          cashReservations: [
            {
              id: firstGroup,
              marketId,
              assets: 90n,
              rateBps: 500n,
              tick: 3_976n,
              continuousFeeCap: 0n
            }
          ]
        }),
        readReservationCredit: async group =>
          ((group.assets + 1n) * 10n ** 18n - 1n) / 953_129_400_000_000_000n
      }),
      maker
    )

    const position = await service.readPosition(marketId)
    expect(position.cashBalance).toBe(10n)
    expect(position.marketExposure).toBe(105n)
    expect(position.totalExposure).toBe(105n)
  })

  test('reserves the maximum canonical credit outcome once for a shared group', async () => {
    const otherMarketId: Hex = `0x${'44'.repeat(32)}`
    const service = new MidnightBootstrapPositionService(
      fixtureReader({
        readPositions: async () => [
          { marketId, credit: 0n, debt: 0n },
          { marketId: otherMarketId, credit: 0n, debt: 0n }
        ],
        readCashBalance: async () => 1_000n,
        readMarketContinuousFeeCap: async () => 0n,
        readGroupInventory: async () => ({
          activeGroups: [],
          cashReservations: [
            { id: firstGroup, marketId: otherMarketId, assets: 100n, rateBps: 500n, tick: 3_000n },
            { id: firstGroup, marketId, assets: 100n, rateBps: 500n, tick: 3_976n }
          ]
        }),
        readReservationCredit: async group => (group.tick === 3_000n ? 740n : 105n)
      }),
      maker
    )

    const selected = await service.readPosition(marketId)

    expect(selected.cashBalance).toBe(900n)
    expect(selected.marketExposure).toBe(105n)
    expect(selected.totalExposure).toBe(740n)
  })

  test('reserves ladder buys without treating them as replaceable bootstrap offers', async () => {
    const otherMarketId: Hex = `0x${'44'.repeat(32)}`
    const service = new MidnightBootstrapPositionService(
      fixtureReader({
        readPositions: async () => [
          { marketId, credit: 10n, debt: 0n },
          { marketId: otherMarketId, credit: 5n, debt: 0n }
        ],
        readCashBalance: async () => 200n,
        readMarketContinuousFeeCap: async () => 17n,
        readGroupInventory: async () => ({
          activeGroups: [],
          cashReservations: [
            { id: firstGroup, marketId, assets: 70n, rateBps: 500n },
            { id: secondGroup, marketId: otherMarketId, assets: 40n, rateBps: 600n }
          ]
        })
      }),
      maker
    )

    const position = await service.readPosition(marketId)

    expect(position.activeOffer).toBeUndefined()
    expect(position.cashBalance).toBe(90n)
    expect(position.marketExposure).toBe(80n)
    expect(position.totalExposure).toBe(125n)
  })
})
