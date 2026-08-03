import type { Hex } from 'viem'

import { describe, expect, test } from 'bun:test'

import { offerInvalidationGroupIds } from '../../../src/infrastructure/invalidation/offer-invalidation-group.utils'

const indexedGroupId: Hex = `0x${'11'.repeat(32)}`
const bootstrapGroupId: Hex = `0x${'22'.repeat(32)}`
const ladderGroupId: Hex = `0x${'33'.repeat(32)}`

describe('offerInvalidationGroupIds', () => {
  test('includes persisted bootstrap and ladder groups before API indexing', () => {
    expect(
      offerInvalidationGroupIds(
        [{ id: indexedGroupId, consumed: 0n, maxAssets: 1n, offers: [] }],
        [bootstrapGroupId],
        [ladderGroupId]
      )
    ).toEqual([indexedGroupId, bootstrapGroupId, ladderGroupId])
  })
})
