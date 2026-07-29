import type { Hex } from 'viem'

import { describe, expect, test } from 'bun:test'

import {
  generateLadder,
  shouldRecenter,
  validateLadderConfig,
  type LadderConfig
} from '../../../src/domain/ladder/ladder'
import { LadderConfigurationError } from '../../../src/domain/ladder/ladder-configuration.error'

const marketId: Hex = `0x${'55'.repeat(32)}`
const config = (overrides: Partial<LadderConfig> = {}): LadderConfig => ({
  marketId,
  quotePremiumBps: 0n,
  spreadBps: 200n,
  stepBps: 100n,
  rungCount: 3,
  sizeSkewBps: 0n,
  lowerRateBudgetAssets: 10n,
  higherRateBudgetAssets: 10n,
  targetMarketExposureAssets: 20n,
  maximumTotalExposureAssets: 20n,
  groupMode: 'shared-rung',
  loopIntervalSeconds: 3600,
  movementToleranceBps: 10n,
  minimumRateBps: 200n,
  maximumRateBps: 800n,
  ...overrides
})

describe('ladder domain', () => {
  test('generates the pilot ladder around a 500 BPS center', () => {
    const ladder = generateLadder({ config: config(), referenceRateBps: 500n })

    expect(ladder.lower.map(rung => rung.rateBps)).toEqual([400n, 300n, 200n])
    expect(ladder.higher.map(rung => rung.rateBps)).toEqual([600n, 700n, 800n])
    expect(ladder.lower.reduce((sum, rung) => sum + rung.assets, 0n)).toBe(10n)
    expect(ladder.higher.reduce((sum, rung) => sum + rung.assets, 0n)).toBe(10n)
    expect(ladder.lower.map(rung => rung.assets)).toEqual([3n, 3n, 4n])
  })

  test('adds quote premium before deriving rung rates', () => {
    const ladder = generateLadder({
      config: config({ quotePremiumBps: 25n, minimumRateBps: 0n, maximumRateBps: 1_000n }),
      referenceRateBps: 500n
    })
    expect(ladder.centerRateBps).toBe(525n)
    expect(ladder.lower[0]?.rateBps).toBe(425n)
    expect(ladder.higher[0]?.rateBps).toBe(625n)
  })

  test.each([
    [1_000n, [30n, 33n, 37n]],
    [-1_000n, [37n, 33n, 30n]]
  ])('allocates skew %p with exact outer-rung remainder', (sizeSkewBps, expected) => {
    const ladder = generateLadder({
      config: config({
        sizeSkewBps,
        lowerRateBudgetAssets: 100n,
        higherRateBudgetAssets: 100n,
        targetMarketExposureAssets: 200n,
        maximumTotalExposureAssets: 200n,
        minimumRateBps: 0n,
        maximumRateBps: 1_000n
      }),
      referenceRateBps: 500n
    })
    expect(ladder.lower.map(rung => rung.assets)).toEqual(expected)
    expect(ladder.lower.reduce((sum, rung) => sum + rung.assets, 0n)).toBe(100n)
  })

  test('shares fresh aggregate exposure capacity across both ladder sides', () => {
    const ladder = generateLadder({
      config: config({
        lowerRateBudgetAssets: 100n,
        higherRateBudgetAssets: 100n,
        targetMarketExposureAssets: 100n,
        maximumTotalExposureAssets: 100n
      }),
      referenceRateBps: 500n,
      capacities: {
        lowerRateCapacityAssets: 100n,
        higherRateCapacityAssets: 100n,
        targetMarketCapacityAssets: 50n,
        maximumTotalCapacityAssets: 20n
      }
    })
    expect(ladder.lower.reduce((sum, rung) => sum + rung.assets, 0n)).toBe(10n)
    expect(ladder.higher.reduce((sum, rung) => sum + rung.assets, 0n)).toBe(10n)
  })

  test('omits a side whose fresh capacity is zero', () => {
    const ladder = generateLadder({
      config: config(),
      referenceRateBps: 500n,
      capacities: { lowerRateCapacityAssets: 0n, higherRateCapacityAssets: 10n }
    })

    expect(ladder.lower).toEqual([])
    expect(ladder.higher.reduce((sum, rung) => sum + rung.assets, 0n)).toBe(10n)
  })

  test('omits individual rungs whose proportional allocation rounds to zero', () => {
    const ladder = generateLadder({
      config: config(),
      referenceRateBps: 500n,
      capacities: { lowerRateCapacityAssets: 1n, higherRateCapacityAssets: 0n }
    })

    expect(ladder.lower).toEqual([{ index: 2, rateBps: 200n, assets: 1n }])
    expect(ladder.higher).toEqual([])
  })

  test('does not apply rate bounds to an exhausted side that emits no rungs', () => {
    const ladder = generateLadder({
      config: config(),
      referenceRateBps: 150n,
      capacities: { lowerRateCapacityAssets: 0n, higherRateCapacityAssets: 10n }
    })

    expect(ladder.lower).toEqual([])
    expect(ladder.higher.map(rung => rung.rateBps)).toEqual([250n, 350n, 450n])
  })

  test('rejects a static shape that cannot fit the hard range', () => {
    expect(() => validateLadderConfig(config({ maximumRateBps: 700n }))).toThrow(
      LadderConfigurationError
    )
  })

  test('rejects a runtime rung outside the hard range instead of clamping', () => {
    expect(() => generateLadder({ config: config(), referenceRateBps: 501n })).toThrow(
      'higher rung is outside the configured hard range'
    )
  })

  test('requires every deterministic skew weight to stay positive', () => {
    expect(() => validateLadderConfig(config({ sizeSkewBps: -5_000n }))).toThrow(
      'every rung weight must be positive'
    )
  })

  test('rejects rung counts above the practical ladder limit before allocating weights', () => {
    expect(() =>
      validateLadderConfig(
        config({
          rungCount: 513,
          stepBps: 1n,
          minimumRateBps: 0n,
          maximumRateBps: 2_000n
        })
      )
    ).toThrow('rungCount must not exceed 512')
  })

  test('recenters only when absolute movement is strictly greater than tolerance', () => {
    expect(shouldRecenter(500n, 510n, 10n)).toBe(false)
    expect(shouldRecenter(500n, 490n, 10n)).toBe(false)
    expect(shouldRecenter(500n, 511n, 10n)).toBe(true)
  })
})
