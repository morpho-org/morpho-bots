import type { Address, Hex } from 'viem'

import { MAX_OFFER_CAP } from '@morpho-org/midnight-sdk'
import { describe, expect, test } from 'vitest'

import type { MakerOfferGroup } from '../../../src/infrastructure/provider/offer-groups.utils'

import { BootstrapAdapterError } from '../../../src/errors'
import {
  livePendingBootstrapOffers,
  pendingBootstrapOffers
} from '../../../src/infrastructure/bootstrap/bootstrap-pending-offer.utils'

const marketId: Hex = `0x${'11'.repeat(32)}`
const groupId: Hex = `0x${'22'.repeat(32)}`
const maker: Address = '0x3333333333333333333333333333333333333333'
const offer = {
  groupId,
  marketId,
  assets: 100n,
  rateBps: 450n,
  referenceObservationId: 'blocks:100-200'
}

const indexedGroup = (consumed: bigint): MakerOfferGroup => ({
  id: groupId,
  consumed,
  cap: { kind: 'assets', maximum: 100n },
  marketId,
  tick: 1n,
  maturity: 2_000n,
  offers: [{ marketId, maker, buy: true, tick: 1n }]
})

describe('pendingBootstrapOffers', () => {
  test('projects persisted publication intent while API indexing is pending', () => {
    expect(pendingBootstrapOffers([], [offer])).toEqual([offer])
  })

  test.each([0n, 100n])(
    'does not project an offer after its group is indexed (%p consumed)',
    consumed => {
      const groups = [indexedGroup(consumed)]
      expect(pendingBootstrapOffers(groups, [offer])).toEqual([])
    }
  )
})

describe('livePendingBootstrapOffers', () => {
  test('accepts an API-missing configured group after confirmed cancellation', () => {
    expect(
      livePendingBootstrapOffers({
        groups: [],
        ownedGroupIds: [groupId],
        offers: [],
        consumed: { [groupId]: MAX_OFFER_CAP }
      })
    ).toEqual([])
  })

  test('fails closed for an API-missing configured group without cancellation or intent', () => {
    expect(() =>
      livePendingBootstrapOffers({
        groups: [],
        ownedGroupIds: [groupId],
        offers: [],
        consumed: { [groupId]: MAX_OFFER_CAP - 1n }
      })
    ).toThrow(expect.objectContaining({ operation: 'missing-owned-group-intent' }))
  })

  test('fails closed for a group whose consumption was not read', () => {
    expect(() =>
      livePendingBootstrapOffers({ groups: [], ownedGroupIds: [], offers: [offer], consumed: {} })
    ).toThrow(BootstrapAdapterError)
  })

  test('projects remaining persisted intent while provider indexing is pending', () => {
    expect(
      livePendingBootstrapOffers({
        groups: [],
        ownedGroupIds: [groupId],
        offers: [offer],
        consumed: { [groupId]: 25n }
      })
    ).toEqual([{ ...offer, maximumAssets: 100n, assets: 75n }])
  })

  test('drops a pending intent once its consumed units reach its size', () => {
    expect(
      livePendingBootstrapOffers({
        groups: [],
        ownedGroupIds: [groupId],
        offers: [offer],
        consumed: { [groupId]: offer.assets }
      })
    ).toEqual([])
  })
})
