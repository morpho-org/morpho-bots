import { describe, expect, test } from 'vitest'

import { calculateRequiredAllowance } from '../../../src/application/setup/required-allowance.utils'

let marketCount = 0
const nextMarketId = () => `0x${(++marketCount).toString(16).padStart(64, '0')}` as const

const ladderMarket = (
  higherRateBudgetAssets: bigint,
  targetMarketExposureAssets: bigint,
  maximumTotalExposureAssets: bigint,
  marketId = nextMarketId()
) => ({ marketId, higherRateBudgetAssets, targetMarketExposureAssets, maximumTotalExposureAssets })

const bootstrapMarket = (
  offerSize: bigint,
  maximumMarketExposure: bigint,
  maximumTotalExposure: bigint,
  creditTarget = maximumMarketExposure,
  marketId = nextMarketId()
) => ({ marketId, offerSize, creditTarget, maximumMarketExposure, maximumTotalExposure })

describe('calculateRequiredAllowance', () => {
  test('returns zero when nothing is configured', () => {
    expect(calculateRequiredAllowance({ ladder: [], bootstrap: [] })).toBe(0n)
  })

  test('caps a single ladder market at the budget when it is below the exposure target', () => {
    expect(
      calculateRequiredAllowance({
        ladder: [ladderMarket(100n, 200n, 500n)],
        bootstrap: []
      })
    ).toBe(100n)
  })

  test('caps a single ladder market at the exposure target when it is below the budget', () => {
    expect(
      calculateRequiredAllowance({
        ladder: [ladderMarket(200n, 100n, 500n)],
        bootstrap: []
      })
    ).toBe(100n)
  })

  test('caps the ladder total at the loosest configured total-exposure bound', () => {
    expect(
      calculateRequiredAllowance({
        ladder: [ladderMarket(300n, 300n, 400n), ladderMarket(300n, 300n, 400n)],
        bootstrap: []
      })
    ).toBe(400n)
  })

  test('lets the loosest of differing total-exposure caps bound the ladder total', () => {
    expect(
      calculateRequiredAllowance({
        ladder: [ladderMarket(300n, 300n, 400n), ladderMarket(300n, 300n, 500n)],
        bootstrap: []
      })
    ).toBe(500n)
  })

  test('covers bootstrap markets alone', () => {
    expect(
      calculateRequiredAllowance({
        ladder: [],
        bootstrap: [bootstrapMarket(100n, 150n, 200n), bootstrapMarket(60n, 40n, 200n)]
      })
    ).toBe(140n)
  })

  test('caps a bootstrap market at its credit target below offer size and market exposure', () => {
    expect(
      calculateRequiredAllowance({
        ladder: [],
        bootstrap: [bootstrapMarket(100n, 100n, 200n, 10n)]
      })
    ).toBe(10n)
  })

  test('caps the bootstrap total at the loosest configured total-exposure bound', () => {
    expect(
      calculateRequiredAllowance({
        ladder: [],
        bootstrap: [bootstrapMarket(300n, 300n, 250n), bootstrapMarket(300n, 300n, 250n)]
      })
    ).toBe(250n)
  })

  test('sums ladder and bootstrap requirements', () => {
    expect(
      calculateRequiredAllowance({
        ladder: [ladderMarket(100n, 200n, 500n)],
        bootstrap: [bootstrapMarket(30n, 40n, 100n)]
      })
    ).toBe(130n)
  })

  test('caps the combined total once across both workflows sharing the maker portfolio', () => {
    expect(
      calculateRequiredAllowance({
        ladder: [ladderMarket(100n, 200n, 100n)],
        bootstrap: [bootstrapMarket(100n, 100n, 100n)]
      })
    ).toBe(100n)
  })

  test('lets the loosest cap across both sides bound the combined total', () => {
    expect(
      calculateRequiredAllowance({
        ladder: [ladderMarket(100n, 200n, 200n)],
        bootstrap: [bootstrapMarket(100n, 100n, 100n)]
      })
    ).toBe(200n)
  })

  test('does not double count a market configured in both workflows', () => {
    const marketId = nextMarketId()
    expect(
      calculateRequiredAllowance({
        ladder: [ladderMarket(100n, 100n, 1000n, marketId)],
        bootstrap: [bootstrapMarket(100n, 100n, 1000n, 100n, marketId)]
      })
    ).toBe(100n)
  })

  test('lets the loosest market-exposure bound across sides cap a shared market', () => {
    const marketId = nextMarketId()
    expect(
      calculateRequiredAllowance({
        ladder: [ladderMarket(100n, 100n, 1000n, marketId)],
        bootstrap: [bootstrapMarket(100n, 150n, 1000n, 100n, marketId)]
      })
    ).toBe(150n)
  })

  test('stays exact for values beyond the uint256 range', () => {
    const huge = 2n ** 200n
    expect(
      calculateRequiredAllowance({
        ladder: [ladderMarket(huge, huge, 2n * huge)],
        bootstrap: [bootstrapMarket(huge, huge, 2n * huge)]
      })
    ).toBe(2n * huge)
  })

  test('ignores fields outside the cash-side shape, including group mode', () => {
    const market = {
      ...ladderMarket(100n, 200n, 500n),
      groupMode: 'shared-rung' as const,
      lowerRateBudgetAssets: 999n
    }
    const perBook = { ...market, groupMode: 'per-book' as const }

    const shared = calculateRequiredAllowance({ ladder: [market], bootstrap: [] })
    const book = calculateRequiredAllowance({ ladder: [perBook], bootstrap: [] })

    expect(shared).toBe(100n)
    expect(book).toBe(shared)
  })
})
