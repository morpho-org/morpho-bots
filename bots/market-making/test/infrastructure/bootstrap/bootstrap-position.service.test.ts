import type { Address, Hex } from 'viem'

import { describe, expect, test } from 'bun:test'

import { MidnightBootstrapPositionService } from '../../../src/infrastructure/bootstrap/bootstrap-position.service'

const maker: Address = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const marketId: Hex = `0x${'11'.repeat(32)}`
const firstGroup: Hex = `0x${'22'.repeat(32)}`
const secondGroup: Hex = `0x${'33'.repeat(32)}`

describe('MidnightBootstrapPositionService', () => {
  test('excludes a live group from the capacity available to replace itself', async () => {
    const service = new MidnightBootstrapPositionService(
      {
        readPositions: async () => [{ marketId, credit: 0n, debt: 0n }],
        readCashBalance: async () => 100n,
        readGroupInventory: async () => ({
          activeGroups: [{ id: firstGroup, marketId, assets: 100n, rateBps: 500n }],
          cashReservations: []
        })
      },
      maker
    )

    const position = await service.readPosition(marketId)

    expect(position.marketExposure).toBe(0n)
    expect(position.totalExposure).toBe(0n)
  })

  test('keeps every other group in replacement exposure', async () => {
    const otherMarketId: Hex = `0x${'44'.repeat(32)}`
    const service = new MidnightBootstrapPositionService(
      {
        readPositions: async () => [
          { marketId, credit: 10n, debt: 0n },
          { marketId: otherMarketId, credit: 5n, debt: 0n }
        ],
        readCashBalance: async () => 100n,
        readGroupInventory: async () => ({
          activeGroups: [
            { id: firstGroup, marketId, assets: 20n, rateBps: 500n },
            { id: secondGroup, marketId, assets: 30n, rateBps: 500n },
            { id: `0x${'55'.repeat(32)}`, marketId: otherMarketId, assets: 40n, rateBps: 500n }
          ],
          cashReservations: []
        })
      },
      maker
    )

    const position = await service.readPosition(marketId)

    expect(position.marketExposure).toBe(40n)
    expect(position.totalExposure).toBe(85n)
  })

  test('subtracts other outstanding lend groups from wallet cash capacity', async () => {
    const otherMarketId: Hex = `0x${'44'.repeat(32)}`
    const service = new MidnightBootstrapPositionService(
      {
        readPositions: async () => [
          { marketId, credit: 0n, debt: 0n },
          { marketId: otherMarketId, credit: 0n, debt: 0n }
        ],
        readCashBalance: async () => 100n,
        readGroupInventory: async () => ({
          activeGroups: [
            { id: firstGroup, marketId, assets: 20n, rateBps: 500n },
            { id: secondGroup, marketId: otherMarketId, assets: 70n, rateBps: 500n }
          ],
          cashReservations: []
        })
      },
      maker
    )

    const position = await service.readPosition(marketId)

    expect(position.cashBalance).toBe(30n)
  })

  test('counts a shared multi-market group once in aggregate exposure', async () => {
    const otherMarketId: Hex = `0x${'44'.repeat(32)}`
    const inspectionMarketId: Hex = `0x${'55'.repeat(32)}`
    const service = new MidnightBootstrapPositionService(
      {
        readPositions: async () => [
          { marketId, credit: 0n, debt: 0n },
          { marketId: otherMarketId, credit: 0n, debt: 0n },
          { marketId: inspectionMarketId, credit: 0n, debt: 0n }
        ],
        readCashBalance: async () => 100n,
        readGroupInventory: async () => ({
          activeGroups: [
            { id: firstGroup, marketId, assets: 100n, rateBps: 500n },
            { id: firstGroup, marketId: otherMarketId, assets: 100n, rateBps: 600n }
          ],
          cashReservations: []
        })
      },
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
      {
        readPositions: async () => [{ marketId, credit: 0n, debt: 0n }],
        readCashBalance: async () => 100n,
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
      },
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
      {
        readPositions: async () => [{ marketId, credit: 10n, debt: 0n }],
        readCashBalance: async () => 100n,
        readGroupInventory: async () => ({
          activeGroups: [
            { id: firstGroup, marketId, assets: 20n, rateBps: 500n },
            { id: secondGroup, marketId, assets: 20n, rateBps: 500n }
          ],
          cashReservations: []
        })
      },
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

  test('reserves ladder buys without treating them as replaceable bootstrap offers', async () => {
    const otherMarketId: Hex = `0x${'44'.repeat(32)}`
    const service = new MidnightBootstrapPositionService(
      {
        readPositions: async () => [
          { marketId, credit: 10n, debt: 0n },
          { marketId: otherMarketId, credit: 5n, debt: 0n }
        ],
        readCashBalance: async () => 200n,
        readGroupInventory: async () => ({
          activeGroups: [],
          cashReservations: [
            { id: firstGroup, marketId, assets: 70n, rateBps: 500n },
            { id: secondGroup, marketId: otherMarketId, assets: 40n, rateBps: 600n }
          ]
        })
      },
      maker
    )

    const position = await service.readPosition(marketId)

    expect(position.activeOffer).toBeUndefined()
    expect(position.cashBalance).toBe(90n)
    expect(position.marketExposure).toBe(80n)
    expect(position.totalExposure).toBe(125n)
  })
})
