import type { Address, Hex } from 'viem'

import { describe, expect, mock, test } from 'bun:test'

import type { BootstrapRawGroup } from '../../../src/infrastructure/bootstrap/bootstrap-groups.utils'

import { readLivePendingBootstrapOffers } from '../../../src/infrastructure/ladder/ladder-bootstrap-offer.utils'

const marketId: Hex = `0x${'11'.repeat(32)}`
const groupId: Hex = `0x${'22'.repeat(32)}`
const maker: Address = '0x3333333333333333333333333333333333333333'
const offer = {
  groupId,
  marketId,
  assets: 150n,
  rateBps: 380n,
  referenceObservationId: 'blocks:100-200'
}

const indexedGroup: BootstrapRawGroup = {
  id: groupId,
  consumed: 0n,
  maxAssets: 150n,
  marketId,
  tick: 1n,
  maturity: 2_000n,
  offers: [{ marketId, maker, buy: true, tick: 1n }]
}

describe('readLivePendingBootstrapOffers', () => {
  test('does not read consumption for an offer already indexed by the API', async () => {
    const readGroupConsumed = mock(async () => 0n)

    const result = await readLivePendingBootstrapOffers({
      groups: [indexedGroup],
      offers: [offer],
      readGroupConsumed
    })

    expect(result).toEqual([])
    expect(readGroupConsumed).not.toHaveBeenCalled()
  })

  test('retains the remaining capacity of an API-missing partially consumed offer', async () => {
    const readGroupConsumed = mock(async () => 50n)

    const result = await readLivePendingBootstrapOffers({
      groups: [],
      offers: [offer],
      readGroupConsumed
    })

    expect(result).toEqual([{ ...offer, assets: 100n }])
    expect(readGroupConsumed).toHaveBeenCalledWith(groupId)
  })

  test('omits an API-missing offer that is fully consumed on-chain', async () => {
    const readGroupConsumed = mock(async () => 150n)

    const result = await readLivePendingBootstrapOffers({
      groups: [],
      offers: [offer],
      readGroupConsumed
    })

    expect(result).toEqual([])
    expect(readGroupConsumed).toHaveBeenCalledWith(groupId)
  })
})
