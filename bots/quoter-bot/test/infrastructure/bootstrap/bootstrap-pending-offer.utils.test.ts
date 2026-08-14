import type { Address, Hex } from 'viem'

import { MAX_OFFER_CAP } from '@morpho-org/midnight-sdk'
import { describe, expect, test } from 'vitest'

import type { BootstrapRawGroup } from '../../../src/infrastructure/bootstrap/bootstrap-groups.utils'

import { BootstrapAdapterError } from '../../../src/infrastructure/bootstrap/bootstrap-adapter.error'
import {
  pendingBootstrapOffers,
  readLivePendingBootstrapOffers,
  readOwnedGroupIdsForCleanup,
  readUncanceledGroupIds,
  readUncanceledGroupIdsForCleanup
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

const indexedGroup = (consumed: bigint): BootstrapRawGroup => ({
  id: groupId,
  consumed,
  maxAssets: 100n,
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

describe('readUncanceledGroupIds', () => {
  test('excludes only groups conclusively canceled at the SDK cap', async () => {
    const activeGroupId: Hex = `0x${'44'.repeat(32)}`
    const consumedByGroup = new Map<Hex, bigint>([
      [groupId, MAX_OFFER_CAP],
      [activeGroupId, MAX_OFFER_CAP - 1n]
    ])

    const result = await readUncanceledGroupIds({
      groupIds: [groupId, activeGroupId],
      readGroupConsumed: async id => consumedByGroup.get(id) ?? 0n
    })

    expect(result).toEqual([activeGroupId])
  })

  test('sanitizes consumption read failures', async () => {
    const error = await readUncanceledGroupIds({
      groupIds: [groupId],
      readGroupConsumed: async () => {
        throw new Error('provider URL and response body')
      }
    }).catch(cause => cause)

    expect(error).toBeInstanceOf(BootstrapAdapterError)
    expect(error).toMatchObject({ operation: 'group-consumption-read' })
  })
})

describe('readUncanceledGroupIdsForCleanup', () => {
  test('keeps unreadable groups eligible for cancellation while excluding confirmed cancellations', async () => {
    const unreadableGroupId: Hex = `0x${'44'.repeat(32)}`

    const result = await readUncanceledGroupIdsForCleanup({
      groupIds: [groupId, unreadableGroupId],
      readGroupConsumed: async id => {
        if (id === unreadableGroupId) throw new Error('transient provider failure')
        return MAX_OFFER_CAP
      }
    })

    expect(result).toEqual([unreadableGroupId])
  })
})

describe('readOwnedGroupIdsForCleanup', () => {
  test('keeps every owned group eligible for cancellation when the block read fails', async () => {
    const secondGroupId: Hex = `0x${'55'.repeat(32)}`

    const result = await readOwnedGroupIdsForCleanup({
      readOwnedGroupIds: async () => [groupId, secondGroupId],
      readBlockNumber: async () => {
        throw new Error('transient block read failure')
      },
      readGroupConsumed: async () => MAX_OFFER_CAP
    })

    expect(result).toEqual([groupId, secondGroupId])
  })
})

describe('readLivePendingBootstrapOffers', () => {
  test('accepts an API-missing configured group after confirmed cancellation', async () => {
    const result = await readLivePendingBootstrapOffers({
      groups: [],
      ownedGroupIds: [groupId],
      offers: [],
      readGroupConsumed: async () => MAX_OFFER_CAP
    })

    expect(result).toEqual([])
  })

  test('fails closed for an API-missing configured group without cancellation or intent', async () => {
    const error = await readLivePendingBootstrapOffers({
      groups: [],
      ownedGroupIds: [groupId],
      offers: [],
      readGroupConsumed: async () => MAX_OFFER_CAP - 1n
    }).catch(cause => cause)

    expect(error).toBeInstanceOf(BootstrapAdapterError)
    expect(error).toMatchObject({ operation: 'missing-owned-group-intent' })
  })

  test('projects remaining persisted intent while provider indexing is pending', async () => {
    const result = await readLivePendingBootstrapOffers({
      groups: [],
      ownedGroupIds: [groupId],
      offers: [offer],
      readGroupConsumed: async () => 25n
    })

    expect(result).toEqual([{ ...offer, maximumAssets: 100n, assets: 75n }])
  })
})
