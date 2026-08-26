import type { Hex } from 'viem'

import { describe, expect, test } from 'vitest'

import {
  assertLadderShapeAtReference,
  effectiveLadderPremiumBps,
  generateLadder,
  shouldRecenter,
  validateLadderConfig,
  type LadderConfig
} from '../../../src/domain/ladder/ladder'
import { LadderConfigurationError } from '../../../src/domain/ladder/ladder-configuration.error'
import { MATURITY_PREMIUM_YEAR_SECONDS } from '../../../src/domain/maturity-premium'

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
  minimumOfferAssets: 1n,
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
    [-1_000n, [36n, 33n, 31n]]
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

  test('applies fresh lend-exposure capacity only to the higher-rate buy side', () => {
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
    expect(ladder.lower.reduce((sum, rung) => sum + rung.assets, 0n)).toBe(100n)
    expect(ladder.higher.reduce((sum, rung) => sum + rung.assets, 0n)).toBe(20n)
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

  test('funds the closest rung first when capacity supports only one minimum offer', () => {
    const ladder = generateLadder({
      config: config(),
      referenceRateBps: 500n,
      capacities: { lowerRateCapacityAssets: 1n, higherRateCapacityAssets: 0n }
    })

    expect(ladder.lower).toEqual([{ index: 0, rateBps: 400n, assets: 1n }])
    expect(ladder.higher).toEqual([])
  })

  test('funds only the closest rungs that can each satisfy the offer floor', () => {
    const ladder = generateLadder({
      config: config({
        lowerRateBudgetAssets: 250n,
        higherRateBudgetAssets: 250n,
        targetMarketExposureAssets: 250n,
        maximumTotalExposureAssets: 250n,
        minimumOfferAssets: 101n
      }),
      referenceRateBps: 500n
    })

    expect(ladder.lower).toEqual([
      { index: 0, rateBps: 400n, assets: 125n },
      { index: 1, rateBps: 300n, assets: 125n }
    ])
    expect(ladder.higher).toEqual([
      { index: 0, rateBps: 600n, assets: 125n },
      { index: 1, rateBps: 700n, assets: 125n }
    ])
  })

  test('requires the full offer floor independently from balance and credit', () => {
    const ladder = generateLadder({
      config: config({
        rungCount: 1,
        lowerRateBudgetAssets: 150n,
        higherRateBudgetAssets: 150n,
        targetMarketExposureAssets: 300n,
        maximumTotalExposureAssets: 300n,
        minimumOfferAssets: 101n
      }),
      referenceRateBps: 500n,
      capacities: {
        lowerRateCapacityAssets: 101n,
        higherRateCapacityAssets: 100n,
        targetMarketCapacityAssets: 300n,
        maximumTotalCapacityAssets: 300n
      }
    })

    expect(ladder.lower).toEqual([{ index: 0, rateBps: 400n, assets: 101n }])
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

  test('rejects configured side budgets below the offer floor', () => {
    expect(() =>
      validateLadderConfig(
        config({
          lowerRateBudgetAssets: 100n,
          higherRateBudgetAssets: 101n,
          minimumOfferAssets: 101n
        })
      )
    ).toThrow('lowerRateBudgetAssets must be at least minimumOfferAssets')
  })

  test('clamps runtime rungs at the hard range instead of rejecting them', () => {
    const above = generateLadder({ config: config(), referenceRateBps: 501n })
    expect(above.higher.map(rung => rung.rateBps)).toEqual([601n, 701n, 800n])
    expect(above.lower.map(rung => rung.rateBps)).toEqual([401n, 301n, 201n])

    const below = generateLadder({ config: config(), referenceRateBps: 499n })
    expect(below.lower.map(rung => rung.rateBps)).toEqual([399n, 299n, 200n])
    expect(below.higher.map(rung => rung.rateBps)).toEqual([599n, 699n, 799n])
  })

  test('saturates every rung walking past a bound onto that bound', () => {
    const ladder = generateLadder({ config: config(), referenceRateBps: 350n })
    expect(ladder.lower.map(rung => rung.rateBps)).toEqual([250n, 200n, 200n])
    expect(ladder.higher.map(rung => rung.rateBps)).toEqual([450n, 550n, 650n])
  })

  test('quotes sells at least the clearance below the live own bootstrap buy', () => {
    const ladder = generateLadder({
      config: config(),
      referenceRateBps: 500n,
      capacities: { bootstrapBuyRateBps: 380n }
    })
    expect(ladder.lower.map(rung => rung.rateBps)).toEqual([370n, 300n, 200n])
    expect(ladder.higher.map(rung => rung.rateBps)).toEqual([600n, 700n, 800n])
  })

  test('keeps bootstrap-cleared sells inside the hard range', () => {
    const ladder = generateLadder({
      config: config(),
      referenceRateBps: 500n,
      capacities: { bootstrapBuyRateBps: 205n }
    })
    expect(ladder.lower.map(rung => rung.rateBps)).toEqual([200n, 200n, 200n])
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

  test('rejects monitor intervals above the runtime timer limit', () => {
    expect(() => validateLadderConfig(config({ loopIntervalSeconds: 2_147_484 }))).toThrow(
      'loopIntervalSeconds must not exceed 2147483'
    )
  })

  test('recenters only when absolute movement is strictly greater than tolerance', () => {
    expect(shouldRecenter(500n, 510n, 10n)).toBe(false)
    expect(shouldRecenter(500n, 490n, 10n)).toBe(false)
    expect(shouldRecenter(500n, 511n, 10n)).toBe(true)
  })
})

describe('ladder maturity premium', () => {
  const premiumConfig = (overrides: Partial<LadderConfig> = {}) =>
    config({
      maturityPremium: { shape: 'linear', premiumPerYearBps: 200n },
      minimumRateBps: 0n,
      maximumRateBps: 2_000n,
      ...overrides
    })

  test('accepts a linear maturity premium with and without a cap', () => {
    expect(validateLadderConfig(premiumConfig())).toBeUndefined()
    expect(
      validateLadderConfig(
        premiumConfig({
          maturityPremium: { shape: 'linear', premiumPerYearBps: 120n, maximumPremiumBps: 300n }
        })
      )
    ).toBeUndefined()
  })

  test('rejects a non-positive maturity-premium slope', () => {
    expect(() =>
      validateLadderConfig(
        premiumConfig({ maturityPremium: { shape: 'linear', premiumPerYearBps: 0n } })
      )
    ).toThrow(new LadderConfigurationError('maturityPremium.premiumPerYearBps', 'must be positive'))
  })

  test('rejects a non-positive maturity-premium cap', () => {
    expect(() =>
      validateLadderConfig(
        premiumConfig({
          maturityPremium: { shape: 'linear', premiumPerYearBps: 120n, maximumPremiumBps: 0n }
        })
      )
    ).toThrow(new LadderConfigurationError('maturityPremium.maximumPremiumBps', 'must be positive'))
  })

  test('raises the fresh center by the resolved maturity premium', () => {
    const ladder = generateLadder({
      config: premiumConfig(),
      referenceRateBps: 500n,
      secondsToMaturity: MATURITY_PREMIUM_YEAR_SECONDS / 2n
    })
    expect(ladder.centerRateBps).toBe(600n)
    expect(ladder.lower[0]?.rateBps).toBe(500n)
    expect(ladder.higher[0]?.rateBps).toBe(700n)
  })

  test('caps the maturity premium before raising the center', () => {
    const ladder = generateLadder({
      config: premiumConfig({
        maturityPremium: { shape: 'linear', premiumPerYearBps: 200n, maximumPremiumBps: 120n }
      }),
      referenceRateBps: 500n,
      secondsToMaturity: MATURITY_PREMIUM_YEAR_SECONDS
    })
    expect(ladder.centerRateBps).toBe(620n)
  })

  test('adds no premium for a market at or past maturity', () => {
    const ladder = generateLadder({
      config: premiumConfig(),
      referenceRateBps: 500n,
      secondsToMaturity: 0n
    })
    expect(ladder.centerRateBps).toBe(500n)
  })

  test('retains a previously active center over the premium-adjusted fresh center', () => {
    const ladder = generateLadder({
      config: premiumConfig(),
      referenceRateBps: 500n,
      retainedCenterRateBps: 590n,
      secondsToMaturity: MATURITY_PREMIUM_YEAR_SECONDS / 2n
    })
    expect(ladder.centerRateBps).toBe(590n)
  })

  test('rejects a configured maturity premium without an observation, even at a retained center', () => {
    const expected = new LadderConfigurationError(
      'maturityPremium',
      'requires a maturity observation'
    )
    expect(() => generateLadder({ config: premiumConfig(), referenceRateBps: 500n })).toThrow(
      expected
    )
    expect(() =>
      generateLadder({
        config: premiumConfig(),
        referenceRateBps: 500n,
        retainedCenterRateBps: 500n
      })
    ).toThrow(expected)
  })
})

describe('effectiveLadderPremiumBps', () => {
  test('returns the signed quote premium unchanged without a maturity-premium configuration', () => {
    expect(effectiveLadderPremiumBps(config({ quotePremiumBps: -25n }), undefined)).toBe(-25n)
    expect(
      effectiveLadderPremiumBps(config({ quotePremiumBps: -25n }), MATURITY_PREMIUM_YEAR_SECONDS)
    ).toBe(-25n)
  })

  test('adds the resolved maturity premium to the signed quote premium', () => {
    expect(
      effectiveLadderPremiumBps(
        config({
          quotePremiumBps: -25n,
          maturityPremium: { shape: 'linear', premiumPerYearBps: 120n }
        }),
        MATURITY_PREMIUM_YEAR_SECONDS / 2n
      )
    ).toBe(35n)
  })

  test('fails loud when the required maturity observation is missing', () => {
    expect(() =>
      effectiveLadderPremiumBps(
        config({ maturityPremium: { shape: 'linear', premiumPerYearBps: 120n } }),
        undefined
      )
    ).toThrow(new LadderConfigurationError('maturityPremium', 'requires a maturity observation'))
  })
})

describe('assertLadderShapeAtReference', () => {
  test('accepts a static shape that exactly fills the hard range', () => {
    expect(assertLadderShapeAtReference(config(), 500n)).toBeUndefined()
  })

  test.each([
    [499n, 'lowerRateBps lower rung is outside the configured hard range'],
    [501n, 'higherRateBps higher rung is outside the configured hard range']
  ])('rejects a static shape leaving the range at reference %s', (referenceRateBps, message) => {
    expect(() => assertLadderShapeAtReference(config(), referenceRateBps)).toThrow(message)
  })

  test('accepts a lower breach reachable through an uncapped maturity premium', () => {
    expect(
      assertLadderShapeAtReference(
        config({ maturityPremium: { shape: 'linear', premiumPerYearBps: 200n } }),
        400n
      )
    ).toBeUndefined()
  })

  test('accepts a lower breach whose capped premium can lift the whole shape inside', () => {
    expect(
      assertLadderShapeAtReference(
        config({
          maturityPremium: { shape: 'linear', premiumPerYearBps: 200n, maximumPremiumBps: 300n }
        }),
        400n
      )
    ).toBeUndefined()
  })

  test('rejects a lower rung pinned below the minimum at every reachable maturity', () => {
    expect(() =>
      assertLadderShapeAtReference(
        config({
          maturityPremium: { shape: 'linear', premiumPerYearBps: 200n, maximumPremiumBps: 50n }
        }),
        400n
      )
    ).toThrow('lowerRateBps lower rung is outside the configured hard range')
  })

  test('rejects a higher rung pinned above the maximum at the premium-free base', () => {
    expect(() =>
      assertLadderShapeAtReference(
        config({ maturityPremium: { shape: 'linear', premiumPerYearBps: 200n } }),
        501n
      )
    ).toThrow('higherRateBps higher rung is outside the configured hard range')
  })

  test('rejects an uncapped slope too shallow to lift the shape within the protocol horizon', () => {
    expect(() =>
      assertLadderShapeAtReference(
        config({ maturityPremium: { shape: 'linear', premiumPerYearBps: 1n } }),
        300n
      )
    ).toThrow('lowerRateBps lower rung is outside the configured hard range')
  })

  test('rejects a slope whose floored premium steps skip every interior fit', () => {
    // A slope above one BPS per second steps premiums {0, 2, …}, so the only unclamped fit
    // (center 1) is never attained even though the dense envelope overlaps it; the exact
    // attainability gate rejects the configuration instead of quoting permanently clamped.
    expect(() =>
      assertLadderShapeAtReference(
        config({
          spreadBps: 2n,
          stepBps: 1n,
          rungCount: 1,
          minimumRateBps: 0n,
          maximumRateBps: 2n,
          maturityPremium: {
            shape: 'linear',
            premiumPerYearBps: 2n * MATURITY_PREMIUM_YEAR_SECONDS,
            maximumPremiumBps: 2n
          }
        }),
        0n
      )
    ).toThrow('centerRateBps must be attainable with the full shape inside the hard range')
  })

  test('accepts a stepping slope once some attainable premium fits the full shape', () => {
    expect(
      assertLadderShapeAtReference(
        config({
          spreadBps: 2n,
          stepBps: 1n,
          rungCount: 1,
          minimumRateBps: 0n,
          maximumRateBps: 4n,
          maturityPremium: {
            shape: 'linear',
            premiumPerYearBps: 2n * MATURITY_PREMIUM_YEAR_SECONDS,
            maximumPremiumBps: 2n
          }
        }),
        0n
      )
    ).toBeUndefined()
  })
})
