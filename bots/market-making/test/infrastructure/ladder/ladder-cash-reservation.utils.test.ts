import type { Hex } from 'viem'

import { describe, expect, test } from 'bun:test'

import type { OwnedLadderPublication } from '../../../src/infrastructure/ladder/ladder-group-ownership.utils'

import {
  ladderCashReservations,
  pendingLadderBuyReservations
} from '../../../src/infrastructure/ladder/ladder-cash-reservation.utils'

const marketId: Hex = `0x${'11'.repeat(32)}`
const ladderGroupId: Hex = `0x${'22'.repeat(32)}`
const bootstrapGroupId: Hex = `0x${'33'.repeat(32)}`
const publication: OwnedLadderPublication = {
  marketId,
  status: 'confirmed',
  quote: {
    marketId,
    centerRateBps: 500n,
    groupMode: 'shared-rung',
    lower: [],
    higher: [
      { index: 0, rateBps: 600n, assets: 30n },
      { index: 1, rateBps: 700n, assets: 20n }
    ]
  },
  groups: [{ groupId: ladderGroupId, side: 'higher', rungIndexes: [0, 1] }]
}

describe('ladder cash reservations', () => {
  test('projects an API-missing persisted ladder buy at its full intended assets', () => {
    expect(pendingLadderBuyReservations([], [publication])).toEqual([
      { id: ladderGroupId, marketIds: [marketId], assets: 50n }
    ])
  })

  test('combines API-missing ladder and bootstrap buys for cash and exposure sizing', () => {
    expect(
      ladderCashReservations({
        groups: [],
        publications: [publication],
        bootstrapGroupIds: [bootstrapGroupId],
        bootstrapOffers: [
          {
            groupId: bootstrapGroupId,
            marketId,
            assets: 40n
          }
        ],
        replacedGroupIds: new Set()
      })
    ).toEqual([
      { id: ladderGroupId, marketIds: [marketId], assets: 50n },
      { id: bootstrapGroupId, marketIds: [marketId], assets: 40n }
    ])
  })

  test('does not reserve the current market ladder group being replaced', () => {
    expect(
      ladderCashReservations({
        groups: [],
        publications: [publication],
        bootstrapGroupIds: [],
        bootstrapOffers: [],
        replacedGroupIds: new Set([ladderGroupId])
      })
    ).toEqual([])
  })
})
