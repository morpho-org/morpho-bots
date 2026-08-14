import type { Hex } from 'viem'

import { describe, expect, test } from 'vitest'

import { calculateLadderCapacities } from '../../../src/infrastructure/ladder/ladder-capacity.utils'

const marketId: Hex = `0x${'11'.repeat(32)}`
const groupId: Hex = `0x${'22'.repeat(32)}`

describe('calculateLadderCapacities', () => {
  test('subtracts current credit from fresh per-market lend room', () => {
    expect(
      calculateLadderCapacities({
        marketId,
        balance: 100n,
        currentCredit: 90n,
        otherMarketCredit: 0n,
        creditSaleCapacityAssets: 90n,
        targetMarketExposureAssets: 100n,
        maximumTotalExposureAssets: 1_000n,
        reservations: []
      })
    ).toEqual({
      lowerRateCapacityAssets: 90n,
      higherRateCapacityAssets: 10n,
      targetMarketCapacityAssets: 100n,
      maximumTotalCapacityAssets: 1_000n
    })
  })

  test('counts active reservations against market and aggregate production room', () => {
    expect(
      calculateLadderCapacities({
        marketId,
        balance: 100n,
        currentCredit: 20n,
        otherMarketCredit: 30n,
        creditSaleCapacityAssets: 0n,
        targetMarketExposureAssets: 100n,
        maximumTotalExposureAssets: 200n,
        reservations: [{ id: groupId, marketIds: [marketId], assets: 40n }]
      })
    ).toEqual({
      lowerRateCapacityAssets: 0n,
      higherRateCapacityAssets: 40n,
      targetMarketCapacityAssets: 40n,
      maximumTotalCapacityAssets: 110n
    })
  })
})
