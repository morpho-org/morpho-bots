import type { Hex } from 'viem'

import { describe, expect, test } from 'vitest'

import { mapSelectedMarketItems } from '../../src/infrastructure/selected-market-items.utils'

const selectedMarketId: Hex = `0x${'11'.repeat(32)}`
const unrelatedMarketId: Hex = `0x${'22'.repeat(32)}`

describe('mapSelectedMarketItems', () => {
  test('does not reconstruct pending items from unrelated markets', async () => {
    const reconstructed: Hex[] = []

    const result = await mapSelectedMarketItems(
      selectedMarketId,
      [{ marketId: unrelatedMarketId }, { marketId: selectedMarketId }],
      async item => {
        reconstructed.push(item.marketId)
        if (item.marketId === unrelatedMarketId) throw new Error('unrelated market unavailable')
        return item.marketId
      }
    )

    expect(result).toEqual([selectedMarketId])
    expect(reconstructed).toEqual([selectedMarketId])
  })
})
