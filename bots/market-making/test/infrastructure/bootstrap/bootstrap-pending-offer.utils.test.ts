import type { Address, Hex } from 'viem'

import { describe, expect, test } from 'bun:test'

import type { BootstrapRawGroup } from '../../../src/infrastructure/bootstrap/bootstrap-groups.utils'

import { pendingBootstrapGroups } from '../../../src/infrastructure/bootstrap/bootstrap-pending-offer.utils'

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

describe('pendingBootstrapGroups', () => {
  test('projects persisted publication intent while API indexing is pending', () => {
    expect(pendingBootstrapGroups([], [offer])).toEqual([
      {
        id: groupId,
        marketId,
        assets: 100n,
        rateBps: 450n,
        referenceObservationId: 'blocks:100-200'
      }
    ])
  })

  test.each([0n, 100n])(
    'does not project an offer after its group is indexed (%p consumed)',
    consumed => {
      expect(pendingBootstrapGroups([indexedGroup(consumed)], [offer])).toEqual([])
    }
  )
})
