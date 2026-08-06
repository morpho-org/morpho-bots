import type { Address, Hex } from 'viem'

import { describe, expect, mock, test } from 'bun:test'

import type { BootstrapRawGroup } from '../../../src/infrastructure/bootstrap/bootstrap-groups.utils'

import {
  pendingBootstrapOffers,
  readLivePendingBootstrapOffers
} from '../../../src/infrastructure/bootstrap/bootstrap-pending-offer.utils'

const marketId: Hex = `0x${'11'.repeat(32)}`
const groupId: Hex = `0x${'22'.repeat(32)}`
const maker: Address = '0x3333333333333333333333333333333333333333'
const offer = {
  groupId,
  marketId,
  assets: 100n,
  rateBps: 450n,
  referenceObservationId: 'blocks:100-200',
  tick: 123n,
  continuousFeeCap: 17n
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
  test('selects persisted publication intent while API indexing is pending', () => {
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

describe('readLivePendingBootstrapOffers', () => {
  test('does not read consumption for an offer already indexed by the API', async () => {
    const readGroupConsumed = mock(async () => 0n)

    const result = await readLivePendingBootstrapOffers({
      groups: [indexedGroup(0n)],
      ownedGroupIds: [groupId],
      offers: [offer],
      readGroupConsumed
    })

    expect(result).toEqual([])
    expect(readGroupConsumed).not.toHaveBeenCalled()
  })

  test('fails closed when an owned group is API-missing without persisted offer intent', async () => {
    const readGroupConsumed = mock(async () => 0n)

    await expect(
      readLivePendingBootstrapOffers({
        groups: [],
        ownedGroupIds: [groupId],
        offers: [],
        readGroupConsumed
      })
    ).rejects.toMatchObject({ operation: 'missing-owned-group-intent' })
    expect(readGroupConsumed).not.toHaveBeenCalled()
  })

  test('retains the remaining capacity of an API-missing partially consumed offer', async () => {
    const readGroupConsumed = mock(async () => 40n)

    const result = await readLivePendingBootstrapOffers({
      groups: [],
      ownedGroupIds: [groupId],
      offers: [offer],
      readGroupConsumed
    })

    expect(result).toEqual([{ ...offer, maximumAssets: 100n, assets: 60n }])
    expect(readGroupConsumed).toHaveBeenCalledWith(groupId)
  })

  test('omits an API-missing offer that is fully consumed on-chain', async () => {
    const readGroupConsumed = mock(async () => 100n)

    const result = await readLivePendingBootstrapOffers({
      groups: [],
      ownedGroupIds: [groupId],
      offers: [offer],
      readGroupConsumed
    })

    expect(result).toEqual([])
    expect(readGroupConsumed).toHaveBeenCalledWith(groupId)
  })
})
