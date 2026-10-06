import type { Hex } from 'viem'

import { MAX_OFFER_CAP } from '@morpho-org/midnight-sdk'
import { describe, expect, test } from 'vitest'

import type {
  MakerBookOffer,
  MakerOfferGroup
} from '../../../src/infrastructure/provider/offer-groups.utils'

import { offerInvalidationGroupIds } from '../../../src/infrastructure/invalidation/offer-invalidation-group.utils'

const indexedGroupId: Hex = `0x${'11'.repeat(32)}`
const bootstrapGroupId: Hex = `0x${'22'.repeat(32)}`
const ladderGroupId: Hex = `0x${'33'.repeat(32)}`

describe('offerInvalidationGroupIds', () => {
  test('includes persisted bootstrap and ladder groups before API indexing', () => {
    expect(
      offerInvalidationGroupIds(
        [{ id: indexedGroupId, consumed: 0n, cap: { kind: 'assets', maximum: 1n }, offers: [] }],
        [bootstrapGroupId],
        [ladderGroupId]
      )
    ).toEqual([indexedGroupId, bootstrapGroupId, ladderGroupId])
  })

  test('selects live groups of either cap kind and skips fully consumed ones', () => {
    const groups = [
      {
        id: indexedGroupId,
        consumed: 99n,
        cap: { kind: 'units' as const, maximum: 100n },
        offers: []
      },
      {
        id: bootstrapGroupId,
        consumed: 5n,
        cap: { kind: 'assets' as const, maximum: 5n },
        offers: []
      },
      {
        id: ladderGroupId,
        consumed: 100n,
        cap: { kind: 'units' as const, maximum: 100n },
        offers: []
      }
    ]

    expect(offerInvalidationGroupIds(groups, [], [])).toEqual([indexedGroupId])
  })

  test('selects a used-up buy until it is cancelled, since it can still be taken', () => {
    const buy: MakerBookOffer = {
      marketId: `0x${'44'.repeat(32)}`,
      maker: `0x${'55'.repeat(20)}`,
      buy: true,
      tick: 1n
    }
    const groups: MakerOfferGroup[] = [
      {
        id: indexedGroupId,
        consumed: 5n,
        cap: { kind: 'assets' as const, maximum: 5n },
        offers: [buy]
      },
      {
        id: bootstrapGroupId,
        consumed: MAX_OFFER_CAP,
        cap: { kind: 'assets' as const, maximum: 5n },
        offers: [buy]
      }
    ]

    expect(offerInvalidationGroupIds(groups, [], [])).toEqual([indexedGroupId])
  })
})
