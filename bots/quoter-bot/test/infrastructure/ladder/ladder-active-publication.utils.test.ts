import type { Hex } from 'viem'

import { describe, expect, test } from 'vitest'

import type { BootstrapRawGroup } from '../../../src/infrastructure/bootstrap/bootstrap-groups.utils'
import type { OwnedLadderPublication } from '../../../src/infrastructure/ladder/ladder-group-ownership.utils'

import {
  activeOwnedLadderGroupIds,
  ownedLadderGroupConsumption,
  pendingLadderQuoteSets,
  reconstructOwnedLadderPublication
} from '../../../src/infrastructure/ladder/ladder-active-publication.utils'

const marketId: Hex = `0x${'11'.repeat(32)}`
const lowerGroupId: Hex = `0x${'22'.repeat(32)}`
const higherGroupId: Hex = `0x${'33'.repeat(32)}`
const maker = '0x4444444444444444444444444444444444444444' as const

const publication: OwnedLadderPublication = {
  marketId,
  status: 'confirmed',
  quote: {
    marketId,
    centerRateBps: 500n,
    groupMode: 'per-book',
    lower: [{ index: 0, rateBps: 450n, assets: 100n }],
    higher: [{ index: 0, rateBps: 550n, assets: 80n }]
  },
  groups: [
    { groupId: lowerGroupId, side: 'lower', rungIndexes: [0] },
    { groupId: higherGroupId, side: 'higher', rungIndexes: [0] }
  ]
}

const indexedGroup = (id: Hex, consumed: bigint, maxAssets: bigint): BootstrapRawGroup => ({
  id,
  consumed,
  maxAssets,
  offers: [{ marketId, maker, buy: true, tick: 1n }]
})

describe('ladder active publication indexing', () => {
  test('retains API-missing confirmed groups as pending active rungs', () => {
    expect(reconstructOwnedLadderPublication(publication, [])).toEqual(publication.quote)
    expect(activeOwnedLadderGroupIds([publication], [], marketId)).toEqual([
      lowerGroupId,
      higherGroupId
    ])
  })

  test('uses indexed remaining capacity and drops only indexed consumed groups', () => {
    const groups = [indexedGroup(lowerGroupId, 40n, 100n), indexedGroup(higherGroupId, 80n, 80n)]

    expect(reconstructOwnedLadderPublication(publication, groups)).toEqual({
      ...publication.quote,
      lower: [{ index: 0, rateBps: 450n, assets: 60n }],
      higher: []
    })
    expect(activeOwnedLadderGroupIds([publication], groups, marketId)).toEqual([lowerGroupId])
    expect(pendingLadderQuoteSets([publication], groups)).toEqual([])
  })

  test('projects only API-missing ladder groups into pending spread offers', () => {
    const groups = [indexedGroup(higherGroupId, 0n, 80n)]

    expect(pendingLadderQuoteSets([publication], groups)).toEqual([
      {
        ...publication.quote,
        lower: [...publication.quote.lower],
        higher: []
      }
    ])
  })
})

describe('ownedLadderGroupConsumption', () => {
  const otherMarketId: Hex = `0x${'55'.repeat(32)}`
  const otherGroupId: Hex = `0x${'66'.repeat(32)}`

  const lowerPublication: OwnedLadderPublication = {
    marketId,
    status: 'confirmed',
    quote: {
      marketId,
      centerRateBps: 500n,
      groupMode: 'per-book',
      lower: [
        { index: 0, rateBps: 450n, assets: 60n },
        { index: 1, rateBps: 350n, assets: 40n }
      ],
      higher: []
    },
    groups: [{ groupId: lowerGroupId, side: 'lower', rungIndexes: [1, 0] }]
  }

  const higherPublication: OwnedLadderPublication = {
    marketId,
    status: 'confirmed',
    quote: {
      marketId,
      centerRateBps: 500n,
      groupMode: 'per-book',
      lower: [],
      higher: [{ index: 0, rateBps: 550n, assets: 80n }]
    },
    groups: [{ groupId: higherGroupId, side: 'higher', rungIndexes: [0] }]
  }

  test('resolves each side rate independently when both sides reuse the same rung indexes', () => {
    expect(
      ownedLadderGroupConsumption(
        [publication],
        [indexedGroup(lowerGroupId, 10n, 100n), indexedGroup(higherGroupId, 20n, 80n)]
      )
    ).toMatchObject([
      { groupId: lowerGroupId, side: 'lower', groupRateBps: 450n },
      { groupId: higherGroupId, side: 'higher', groupRateBps: 550n }
    ])
  })

  test('joins each indexed group to its side, nearest rate, and remaining capacity', () => {
    expect(
      ownedLadderGroupConsumption(
        [lowerPublication, higherPublication],
        [indexedGroup(lowerGroupId, 40n, 100n), indexedGroup(higherGroupId, 90n, 80n)]
      )
    ).toEqual([
      {
        groupId: lowerGroupId,
        marketId,
        side: 'lower',
        groupRateBps: 450n,
        maxAssets: 100n,
        consumed: 40n,
        remainingAssets: 60n
      },
      {
        groupId: higherGroupId,
        marketId,
        side: 'higher',
        groupRateBps: 550n,
        maxAssets: 80n,
        consumed: 90n,
        remainingAssets: 0n
      }
    ])
  })

  test('omits owned groups the indexer has not returned yet', () => {
    expect(
      ownedLadderGroupConsumption(
        [lowerPublication, higherPublication],
        [indexedGroup(higherGroupId, 0n, 80n)]
      ).map(group => group.groupId)
    ).toEqual([higherGroupId])
  })

  test('keeps the first publication that claims a repeated group id', () => {
    const republished: OwnedLadderPublication = {
      ...lowerPublication,
      status: 'reserved',
      quote: {
        ...lowerPublication.quote,
        lower: [{ index: 0, rateBps: 410n, assets: 100n }]
      },
      groups: [{ groupId: lowerGroupId, side: 'lower', rungIndexes: [0] }]
    }

    expect(
      ownedLadderGroupConsumption(
        [lowerPublication, republished],
        [indexedGroup(lowerGroupId, 0n, 100n)]
      )
    ).toMatchObject([{ groupId: lowerGroupId, groupRateBps: 450n }])
  })

  test('restricts consumption to the requested strategy market', () => {
    const foreign: OwnedLadderPublication = {
      marketId: otherMarketId,
      status: 'confirmed',
      quote: {
        marketId: otherMarketId,
        centerRateBps: 600n,
        groupMode: 'per-book',
        lower: [{ index: 0, rateBps: 550n, assets: 50n }],
        higher: []
      },
      groups: [{ groupId: otherGroupId, side: 'lower', rungIndexes: [0] }]
    }
    const groups = [indexedGroup(lowerGroupId, 0n, 100n), indexedGroup(otherGroupId, 0n, 50n)]

    expect(
      ownedLadderGroupConsumption([lowerPublication, foreign], groups, marketId).map(
        group => group.groupId
      )
    ).toEqual([lowerGroupId])
    expect(
      ownedLadderGroupConsumption([lowerPublication, foreign], groups, otherMarketId)
    ).toMatchObject([{ groupId: otherGroupId, marketId: otherMarketId }])
  })
})
