import type { Hex } from 'viem'

import { describe, expect, test } from 'bun:test'

import type { BootstrapRawGroup } from '../../../src/infrastructure/bootstrap/bootstrap-groups.utils'
import type { OwnedLadderPublication } from '../../../src/infrastructure/ladder/ladder-group-ownership.utils'

import {
  activeOwnedLadderGroupIds,
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
  })
})
