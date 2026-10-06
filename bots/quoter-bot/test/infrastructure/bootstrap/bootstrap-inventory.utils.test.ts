import type { Address, Hex } from 'viem'

import { describe, expect, test } from 'vitest'

import { bootstrapInventoryFromSnapshot } from '../../../src/infrastructure/bootstrap/bootstrap-inventory.utils'

const maker: Address = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const marketId: Hex = `0x${'11'.repeat(32)}`
const firstGroup: Hex = `0x${'22'.repeat(32)}`
const secondGroup: Hex = `0x${'33'.repeat(32)}`

describe('bootstrapInventoryFromSnapshot', () => {
  test('reports cash capped by an allowance below the wallet balance', () => {
    const inventory = bootstrapInventoryFromSnapshot({
      snapshot: {
        blockNumber: 10n,
        timestamp: 1_000n,
        cashBalance: 500n,
        allowance: 70n,
        positions: [{ marketId, credit: 0n, debt: 0n, lossFactor: 0n }],
        groups: []
      },
      groups: [],
      ownedGroupIds: [],
      ownedOffers: []
    })

    expect(inventory.cashBalance).toBe(70n)
  })

  test('sizes owned groups from snapshot consumption and drops cancelled ones', () => {
    const pendingGroup: Hex = `0x${'66'.repeat(32)}`
    const inventory = bootstrapInventoryFromSnapshot({
      snapshot: {
        blockNumber: 10n,
        timestamp: 1_000n,
        cashBalance: 500n,
        allowance: 500n,
        positions: [{ marketId, credit: 0n, debt: 0n, lossFactor: 0n }],
        groups: [
          {
            groupId: firstGroup,
            marketIds: [marketId],
            state: 'indexed-live',
            remainingAssets: 40n,
            remainingCashAssets: 40n
          },
          {
            groupId: secondGroup,
            marketIds: [marketId],
            state: 'cancelled',
            remainingAssets: 0n,
            remainingCashAssets: 0n
          },
          {
            groupId: pendingGroup,
            marketIds: [marketId],
            state: 'reserved-pending',
            remainingAssets: 25n,
            remainingCashAssets: 25n
          }
        ]
      },
      groups: [firstGroup, secondGroup].map(id => ({
        id,
        cap: { kind: 'assets', maximum: 100n },
        consumed: 0n,
        marketId,
        tick: 5_000n,
        maturity: 2_000n,
        continuousFeeCap: 17n,
        offers: [{ marketId, maker, buy: true, tick: 5_000n }]
      })),
      ownedGroupIds: [firstGroup, secondGroup],
      ownedOffers: [
        {
          groupId: pendingGroup,
          marketId,
          assets: 30n,
          rateBps: 700n,
          referenceObservationId: 'pending'
        }
      ]
    })

    expect(inventory.groupInventory.activeGroups).toEqual([
      expect.objectContaining({ id: firstGroup, assets: 40n, maximumAssets: 100n }),
      {
        id: pendingGroup,
        marketId,
        assets: 25n,
        maximumAssets: 30n,
        rateBps: 700n,
        referenceObservationId: 'pending',
        offerCount: 1
      }
    ])
    expect(inventory.groupInventory.cashReservations.map(group => group.id)).toEqual([
      firstGroup,
      pendingGroup
    ])
  })
})
