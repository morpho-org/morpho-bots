import type { Hex } from 'viem'

import { describe, expect, test } from 'vitest'

import type { BootstrapRawGroup } from '../../../src/infrastructure/bootstrap/bootstrap-groups.utils'

import { ladderMarketMaturity } from '../../../src/infrastructure/ladder/ladder-maturity.utils'

const marketId: Hex = `0x${'11'.repeat(32)}`
const otherMarketId: Hex = `0x${'22'.repeat(32)}`
const groupId: Hex = `0x${'33'.repeat(32)}`
const maker = '0x4444444444444444444444444444444444444444' as const
const maturity = 1_800_000_000n

const group = (overrides: Partial<BootstrapRawGroup> = {}): BootstrapRawGroup => ({
  id: groupId,
  consumed: 0n,
  maxAssets: 100n,
  offers: [],
  ...overrides
})

describe('ladderMarketMaturity', () => {
  test('reads the maturity carried by the group itself', () => {
    expect(ladderMarketMaturity([group({ marketId, maturity })], marketId)).toBe(maturity)
  })

  test('falls back to a nested offer of the same market', () => {
    expect(
      ladderMarketMaturity(
        [
          group({ marketId: otherMarketId, maturity: 1n }),
          group({ offers: [{ marketId, maker, buy: true, tick: 5n, maturity }] })
        ],
        marketId
      )
    ).toBe(maturity)
  })

  test('reports no maturity for a market the maker holds no group in', () => {
    expect(
      ladderMarketMaturity(
        [
          group({
            marketId: otherMarketId,
            maturity,
            offers: [{ marketId: otherMarketId, maker, buy: true, tick: 5n, maturity }]
          })
        ],
        marketId
      )
    ).toBeUndefined()
  })

  test('reports no maturity when neither the group nor its offers carry one', () => {
    expect(
      ladderMarketMaturity(
        [group({ marketId, offers: [{ marketId, maker, buy: true, tick: 5n }] })],
        marketId
      )
    ).toBeUndefined()
  })
})
