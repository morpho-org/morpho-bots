import type { Hex } from 'viem'

import { describe, expect, expectTypeOf, test } from 'vitest'

import {
  assertLadderShapeAtReference,
  effectiveLadderPremiumBps,
  generateLadder,
  generateLadderWithDiagnostics,
  higherRungsRepriced,
  inventorySkewBps,
  isLendOnlyLadder,
  offerCapsByRung,
  shouldRecenter,
  validateLadderConfig,
  type LadderConfig,
  type ValidLadderConfig
} from '../../src/domain/ladder'
import { LadderConfigurationError } from '../../src/domain/ladder-configuration.error'
import { MATURITY_PREMIUM_YEAR_SECONDS } from '../../src/domain/maturity-premium'

const marketId: Hex = `0x${'55'.repeat(32)}`
const rawConfig = (overrides: Partial<LadderConfig> = {}): LadderConfig => ({
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
  bookCrossedCooldownSeconds: 180,
  movementToleranceBps: 10n,
  minimumRateBps: 200n,
  maximumRateBps: 800n,
  ...overrides
})
const config = (overrides: Partial<LadderConfig> = {}) => validateLadderConfig(rawConfig(overrides))

describe('ladder domain', () => {
  test('admits only a validated config into generation and the reference preflight', () => {
    expectTypeOf<LadderConfig>().not.toExtend<ValidLadderConfig>()
    expectTypeOf(validateLadderConfig<LadderConfig>).returns.toExtend<ValidLadderConfig>()
    expectTypeOf(generateLadderWithDiagnostics)
      .parameter(0)
      .toHaveProperty('config')
      .toEqualTypeOf<ValidLadderConfig>()
    expectTypeOf(assertLadderShapeAtReference).parameter(0).toEqualTypeOf<ValidLadderConfig>()
  })

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

  test('returns a frozen copy that later writes to the input cannot reach', () => {
    const input = rawConfig({ maturityPremium: { shape: 'linear', premiumPerYearBps: 120n } })
    const validated = validateLadderConfig(input)
    input.spreadBps = 0n
    input.maturityPremium!.premiumPerYearBps = 999n

    expect(validated.spreadBps).toBe(rawConfig().spreadBps)
    expect(validated.maturityPremium?.premiumPerYearBps).toBe(120n)
    expect(Object.isFrozen(validated)).toBe(true)
    expect(Object.isFrozen(validated.maturityPremium)).toBe(true)
  })

  test('rejects a static shape that cannot fit the hard range', () => {
    expect(() => validateLadderConfig(rawConfig({ maximumRateBps: 700n }))).toThrow(
      LadderConfigurationError
    )
  })

  test('rejects configured side budgets below the offer floor', () => {
    expect(() =>
      validateLadderConfig(
        rawConfig({
          lowerRateBudgetAssets: 100n,
          higherRateBudgetAssets: 101n,
          minimumOfferAssets: 101n
        })
      )
    ).toThrow('lowerRateBudgetAssets must be zero or at least minimumOfferAssets')
  })

  test('omits one outer rung outside the hard range instead of clamping it', () => {
    const above = generateLadder({ config: config(), referenceRateBps: 501n })
    expect(above.higher).toEqual([
      { index: 0, rateBps: 601n, assets: 3n },
      { index: 1, rateBps: 701n, assets: 3n }
    ])
    expect(above.lower.map(rung => rung.rateBps)).toEqual([401n, 301n, 201n])

    const below = generateLadder({ config: config(), referenceRateBps: 499n })
    expect(below.lower).toEqual([
      { index: 0, rateBps: 399n, assets: 3n },
      { index: 1, rateBps: 299n, assets: 3n }
    ])
    expect(below.higher.map(rung => rung.rateBps)).toEqual([599n, 699n, 799n])
  })

  test('admits a rung exactly on either bound', () => {
    const ladder = generateLadder({ config: config(), referenceRateBps: 500n })
    expect(ladder.lower.at(-1)).toEqual({ index: 2, rateBps: 200n, assets: 4n })
    expect(ladder.higher.at(-1)).toEqual({ index: 2, rateBps: 800n, assets: 4n })
  })

  test('never concentrates the allocations of several omitted rungs on the survivors', () => {
    const ladder = generateLadder({ config: config(), referenceRateBps: 350n })
    expect(ladder.lower).toEqual([{ index: 0, rateBps: 250n, assets: 3n }])
    expect(ladder.higher.map(rung => rung.assets)).toEqual([3n, 3n, 4n])
    expect(new Set(ladder.lower.map(rung => rung.rateBps)).size).toBe(ladder.lower.length)
  })

  test('withdraws one side whose every rung leaves the range while the other keeps quoting', () => {
    const ladder = generateLadder({
      config: config({ spreadBps: 2n, stepBps: 1n, minimumRateBps: 200n, maximumRateBps: 800n }),
      referenceRateBps: 199n
    })
    expect(ladder.lower).toEqual([])
    expect(ladder.higher.map(rung => rung.rateBps)).toEqual([200n, 201n, 202n])
  })

  test('omits sells above the maximum and buys below the minimum too', () => {
    const high = generateLadder({ config: config(), referenceRateBps: 5_000n })
    expect(high.lower).toEqual([])
    expect(high.higher).toEqual([])

    const low = generateLadder({ config: config(), referenceRateBps: 1n })
    expect(low.lower).toEqual([])
    expect(low.higher).toEqual([
      { index: 1, rateBps: 201n, assets: 3n },
      { index: 2, rateBps: 301n, assets: 4n }
    ])
  })

  test('omits a rung the static quote premium pushes past the maximum', () => {
    const ladder = generateLadder({
      config: config({ quotePremiumBps: 25n }),
      referenceRateBps: 500n
    })
    expect(ladder.centerRateBps).toBe(525n)
    expect(ladder.higher.map(rung => rung.rateBps)).toEqual([625n, 725n])
    expect(ladder.lower.map(rung => rung.rateBps)).toEqual([425n, 325n, 225n])
  })

  test('quotes sells at least the clearance below the live own bootstrap buy', () => {
    const { quote, diagnostics } = generateLadderWithDiagnostics({
      config: config(),
      referenceRateBps: 500n,
      capacities: { bootstrapBuyRateBps: 380n }
    })
    expect(quote.lower.map(rung => rung.rateBps)).toEqual([370n, 300n, 200n])
    expect(quote.higher.map(rung => rung.rateBps)).toEqual([600n, 700n, 800n])
    expect(diagnostics.lower.clearedRungs).toBe(1)
  })

  test('leaves rung rates untouched by an observed book crossing', () => {
    const withBook = generateLadder({
      config: config(),
      referenceRateBps: 500n,
      capacities: {
        bookCrossing: {
          lower: { crossed: true, clearable: true },
          higher: { crossed: false, clearable: true }
        }
      }
    })
    const withoutBook = generateLadder({ config: config(), referenceRateBps: 500n })

    expect(withBook.lower.map(rung => rung.rateBps)).toEqual(
      withoutBook.lower.map(rung => rung.rateBps)
    )
    expect(withBook.higher.map(rung => rung.rateBps)).toEqual(
      withoutBook.higher.map(rung => rung.rateBps)
    )
  })

  test('withdraws sells the own bootstrap buy would clear below the minimum', () => {
    const ladder = generateLadder({
      config: config(),
      referenceRateBps: 500n,
      capacities: { bootstrapBuyRateBps: 205n }
    })
    expect(ladder.lower).toEqual([])
    expect(ladder.higher.map(rung => rung.rateBps)).toEqual([600n, 700n, 800n])
  })

  test('keeps a bootstrap-cleared sell that lands exactly on the minimum', () => {
    const ladder = generateLadder({
      config: config(),
      referenceRateBps: 500n,
      capacities: { bootstrapBuyRateBps: 210n }
    })
    expect(ladder.lower).toEqual([
      { index: 0, rateBps: 200n, assets: 3n },
      { index: 1, rateBps: 200n, assets: 3n },
      { index: 2, rateBps: 200n, assets: 4n }
    ])
  })

  test('requires every deterministic skew weight to stay positive', () => {
    expect(() => validateLadderConfig(rawConfig({ sizeSkewBps: -5_000n }))).toThrow(
      'every rung weight must be positive'
    )
  })

  test('rejects rung counts above the practical ladder limit before allocating weights', () => {
    expect(() =>
      validateLadderConfig(
        rawConfig({
          rungCount: 513,
          stepBps: 1n,
          minimumRateBps: 0n,
          maximumRateBps: 2_000n
        })
      )
    ).toThrow('rungCount must not exceed 512')
  })

  test('rejects monitor intervals above the runtime timer limit', () => {
    expect(() => validateLadderConfig(rawConfig({ loopIntervalSeconds: 2_147_484 }))).toThrow(
      'loopIntervalSeconds must not exceed 2147483'
    )
  })

  test('rejects a book-crossed cooldown that is not a positive in-range interval', () => {
    expect(() => validateLadderConfig(rawConfig({ bookCrossedCooldownSeconds: 0 }))).toThrow(
      'bookCrossedCooldownSeconds must be a positive safe integer'
    )
    expect(() =>
      validateLadderConfig(rawConfig({ bookCrossedCooldownSeconds: 2_147_484 }))
    ).toThrow('bookCrossedCooldownSeconds must not exceed 2147483')
  })

  test('recenters only when absolute movement is strictly greater than tolerance', () => {
    expect(shouldRecenter(500n, 510n, 10n)).toBe(false)
    expect(shouldRecenter(500n, 490n, 10n)).toBe(false)
    expect(shouldRecenter(500n, 511n, 10n)).toBe(true)
  })
})

describe('generateLadderWithDiagnostics', () => {
  test('funds only rungs that meet the units floor', () => {
    const generated = generateLadder({
      config: config(),
      referenceRateBps: 500n,
      capacities: { minimumOfferUnits: 4n }
    })

    expect(generated.higher.map(rung => rung.assets)).toEqual([5n, 5n])
  })

  test('rejects a units floor that is not positive', () => {
    expect(() =>
      generateLadder({
        config: config(),
        referenceRateBps: 500n,
        capacities: { minimumOfferUnits: 0n }
      })
    ).toThrow(LadderConfigurationError)
  })

  test('reports every configured rung funded, admitted, and uncleared', () => {
    const parameters = { config: config(), referenceRateBps: 500n }
    const { diagnostics } = generateLadderWithDiagnostics(parameters)

    expect(diagnostics).toStrictEqual({
      lower: {
        configuredRungs: 3,
        fundedRungs: 3,
        omittedBelowMinimumRungs: 0,
        omittedBelowMinimumAssets: 0n,
        omittedAboveMaximumRungs: 0,
        omittedAboveMaximumAssets: 0n,
        clearedRungs: 0
      },
      higher: {
        configuredRungs: 3,
        fundedRungs: 3,
        omittedBelowMinimumRungs: 0,
        omittedBelowMinimumAssets: 0n,
        omittedAboveMaximumRungs: 0,
        omittedAboveMaximumAssets: 0n,
        clearedRungs: 0
      }
    })
  })

  test('reports fewer funded rungs than configured when a side budget truncates the ladder', () => {
    const { quote, diagnostics } = generateLadderWithDiagnostics({
      config: config(),
      referenceRateBps: 500n,
      capacities: { lowerRateCapacityAssets: 2n, higherRateCapacityAssets: 10n }
    })

    expect(quote.lower).toHaveLength(2)
    expect(diagnostics.lower.configuredRungs).toBe(3)
    expect(diagnostics.lower.fundedRungs).toBe(2)
    expect(diagnostics.higher.configuredRungs).toBe(3)
    expect(diagnostics.higher.fundedRungs).toBe(3)
  })

  test('counts omitted rungs and assets per bound, keeping funded rungs pre-omission', () => {
    const belowRange = { config: config(), referenceRateBps: 350n }
    const below = generateLadderWithDiagnostics(belowRange)

    expect(below.quote.lower.map(rung => rung.rateBps)).toEqual([250n])
    expect(below.diagnostics.lower).toStrictEqual({
      configuredRungs: 3,
      fundedRungs: 3,
      omittedBelowMinimumRungs: 2,
      omittedBelowMinimumAssets: 7n,
      lowestOmittedRateBps: 50n,
      omittedAboveMaximumRungs: 0,
      omittedAboveMaximumAssets: 0n,
      clearedRungs: 0
    })
    expect(below.diagnostics.higher.omittedBelowMinimumRungs).toBe(0)
    expect(below.diagnostics.higher.omittedAboveMaximumRungs).toBe(0)

    const aboveRange = { config: config(), referenceRateBps: 650n }
    const above = generateLadderWithDiagnostics(aboveRange)

    expect(above.quote.higher.map(rung => rung.rateBps)).toEqual([750n])
    expect(above.diagnostics.higher).toStrictEqual({
      configuredRungs: 3,
      fundedRungs: 3,
      omittedBelowMinimumRungs: 0,
      omittedBelowMinimumAssets: 0n,
      omittedAboveMaximumRungs: 2,
      omittedAboveMaximumAssets: 7n,
      highestOmittedRateBps: 950n,
      clearedRungs: 0
    })
    expect(above.diagnostics.lower.omittedBelowMinimumRungs).toBe(0)
    expect(above.diagnostics.lower.omittedAboveMaximumRungs).toBe(0)
  })

  test('counts only the sells the own bootstrap buy repriced', () => {
    const { quote, diagnostics } = generateLadderWithDiagnostics({
      config: config(),
      referenceRateBps: 500n,
      capacities: { bootstrapBuyRateBps: 380n }
    })

    expect(quote.lower.map(rung => rung.rateBps)).toEqual([370n, 300n, 200n])
    expect(diagnostics.lower).toStrictEqual({
      configuredRungs: 3,
      fundedRungs: 3,
      omittedBelowMinimumRungs: 0,
      omittedBelowMinimumAssets: 0n,
      omittedAboveMaximumRungs: 0,
      omittedAboveMaximumAssets: 0n,
      clearedRungs: 1
    })
    expect(diagnostics.higher.clearedRungs).toBe(0)
  })

  test('counts a cleared sell that the minimum bound also omits on both guardrails', () => {
    const { quote, diagnostics } = generateLadderWithDiagnostics({
      config: config(),
      referenceRateBps: 500n,
      capacities: { bootstrapBuyRateBps: 205n }
    })

    expect(quote.lower).toEqual([])
    expect(diagnostics.lower).toStrictEqual({
      configuredRungs: 3,
      fundedRungs: 3,
      omittedBelowMinimumRungs: 3,
      omittedBelowMinimumAssets: 10n,
      lowestOmittedRateBps: 195n,
      omittedAboveMaximumRungs: 0,
      omittedAboveMaximumAssets: 0n,
      clearedRungs: 3
    })
  })
})

describe('ladder maturity premium', () => {
  const rawPremiumConfig = (overrides: Partial<LadderConfig> = {}) =>
    rawConfig({
      maturityPremium: { shape: 'linear', premiumPerYearBps: 200n },
      minimumRateBps: 0n,
      maximumRateBps: 2_000n,
      ...overrides
    })
  const premiumConfig = (overrides: Partial<LadderConfig> = {}) =>
    validateLadderConfig(rawPremiumConfig(overrides))

  test('accepts a linear maturity premium with and without a cap', () => {
    const uncapped = rawPremiumConfig()
    expect(validateLadderConfig(uncapped)).toEqual(uncapped)
    const capped = rawPremiumConfig({
      maturityPremium: { shape: 'linear', premiumPerYearBps: 120n, maximumPremiumBps: 300n }
    })
    expect(validateLadderConfig(capped)).toEqual(capped)
  })

  test('rejects a non-positive maturity-premium slope', () => {
    expect(() =>
      validateLadderConfig(
        rawPremiumConfig({ maturityPremium: { shape: 'linear', premiumPerYearBps: 0n } })
      )
    ).toThrow(new LadderConfigurationError('maturityPremium.premiumPerYearBps', 'must be positive'))
  })

  test('rejects a non-positive maturity-premium cap', () => {
    expect(() =>
      validateLadderConfig(
        rawPremiumConfig({
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

  test('omits a rung the maturity premium walks past the maximum', () => {
    const ladder = generateLadder({
      config: premiumConfig({ minimumRateBps: 200n, maximumRateBps: 800n }),
      referenceRateBps: 500n,
      secondsToMaturity: MATURITY_PREMIUM_YEAR_SECONDS / 2n
    })
    expect(ladder.centerRateBps).toBe(600n)
    expect(ladder.higher.map(rung => rung.rateBps)).toEqual([700n, 800n])
    expect(ladder.lower.map(rung => rung.rateBps)).toEqual([500n, 400n, 300n])
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

describe('ladder inventory skew', () => {
  const skewed = (
    inventorySkew: LadderConfig['inventorySkew'],
    overrides: Partial<LadderConfig> = {}
  ) => config({ maximumRateBps: 2_000n, inventorySkew, ...overrides })
  const rates = (rungs: readonly { rateBps: bigint }[]) => rungs.map(rung => rung.rateBps)

  test('floors stepBps times the credit above neutral over unitsPerStep', () => {
    expect(inventorySkewBps(skewed({ unitsPerStep: 30n }), 70n)).toBe(233n)
    expect(inventorySkewBps(skewed({ unitsPerStep: 30n, neutralCredit: 40n }), 70n)).toBe(100n)
    expect(inventorySkewBps(skewed({ unitsPerStep: 30n, neutralCredit: 40n }), 40n)).toBe(0n)
    expect(inventorySkewBps(skewed({ unitsPerStep: 30n, neutralCredit: 40n }), 10n)).toBe(0n)
    expect(inventorySkewBps(skewed({ unitsPerStep: 30n, maxSkewBps: 150n }), 70n)).toBe(150n)
    expect(inventorySkewBps(config(), undefined)).toBe(0n)
  })

  test('generates exactly the unskewed quote and diagnostics when no skew is configured', () => {
    for (const creditAssets of [undefined, 0n, 1_000n]) {
      const generated = generateLadderWithDiagnostics({
        config: config(),
        referenceRateBps: 500n,
        capacities: { creditAssets }
      })
      expect(generated).toStrictEqual({
        quote: {
          marketId,
          centerRateBps: 500n,
          groupMode: 'shared-rung',
          lower: [
            { index: 0, rateBps: 400n, assets: 3n },
            { index: 1, rateBps: 300n, assets: 3n },
            { index: 2, rateBps: 200n, assets: 4n }
          ],
          higher: [
            { index: 0, rateBps: 600n, assets: 3n },
            { index: 1, rateBps: 700n, assets: 3n },
            { index: 2, rateBps: 800n, assets: 4n }
          ]
        },
        diagnostics: {
          lower: {
            configuredRungs: 3,
            fundedRungs: 3,
            omittedBelowMinimumRungs: 0,
            omittedBelowMinimumAssets: 0n,
            omittedAboveMaximumRungs: 0,
            omittedAboveMaximumAssets: 0n,
            clearedRungs: 0
          },
          higher: {
            configuredRungs: 3,
            fundedRungs: 3,
            omittedBelowMinimumRungs: 0,
            omittedBelowMinimumAssets: 0n,
            omittedAboveMaximumRungs: 0,
            omittedAboveMaximumAssets: 0n,
            clearedRungs: 0
          }
        }
      })
    }
  })

  test('raises only the higher side, leaving sells and sizes identical', () => {
    const unskewed = generateLadder({
      config: config({ maximumRateBps: 2_000n }),
      referenceRateBps: 500n,
      capacities: { creditAssets: 30n }
    })
    const generated = generateLadderWithDiagnostics({
      config: skewed({ unitsPerStep: 30n }),
      referenceRateBps: 500n,
      capacities: { creditAssets: 30n }
    })

    expect(generated.quote.lower).toEqual(unskewed.lower)
    expect(generated.quote.higher.map(rung => rung.assets)).toEqual(
      unskewed.higher.map(rung => rung.assets)
    )
    expect(rates(generated.quote.higher)).toEqual([700n, 800n, 900n])
    expect(generated.quote.centerRateBps).toBe(unskewed.centerRateBps)
    expect(generated.quote.higherSkewBps).toBe(100n)
    expect(generated.diagnostics.inventorySkew).toEqual({
      inventorySkewBps: 100n,
      skewClamped: false,
      creditAssets: 30n,
      neutralCredit: 0n
    })
  })

  test('reports a skew bounded by maxSkewBps and omits the higher rungs it pushes past the maximum', () => {
    const generated = generateLadderWithDiagnostics({
      config: config({ inventorySkew: { unitsPerStep: 10n, maxSkewBps: 150n } }),
      referenceRateBps: 500n,
      capacities: { creditAssets: 1_000n }
    })

    expect(generated.quote.higher).toEqual([{ index: 0, rateBps: 750n, assets: 3n }])
    expect(generated.diagnostics.inventorySkew).toMatchObject({
      inventorySkewBps: 150n,
      skewClamped: true
    })
    expect(generated.diagnostics.higher.omittedAboveMaximumRungs).toBe(2)
    expect(generated.diagnostics.higher.highestOmittedRateBps).toBe(950n)
    expect(generated.diagnostics.lower.omittedAboveMaximumRungs).toBe(0)
  })

  test('adds the skew on top of a retained center', () => {
    const generated = generateLadder({
      config: skewed({ unitsPerStep: 30n }),
      referenceRateBps: 505n,
      retainedCenterRateBps: 500n,
      capacities: { creditAssets: 60n }
    })

    expect(generated.centerRateBps).toBe(500n)
    expect(rates(generated.lower)).toEqual([400n, 300n, 200n])
    expect(rates(generated.higher)).toEqual([800n, 900n, 1_000n])
  })

  test.each([
    ['a missing', undefined],
    ['a negative', -1n],
    ['a non-bigint', 5 as unknown as bigint]
  ])('fails closed on %s credit observation', (_label, creditAssets) => {
    expect(() =>
      generateLadder({
        config: skewed({ unitsPerStep: 30n }),
        referenceRateBps: 500n,
        capacities: { creditAssets }
      })
    ).toThrow(
      new LadderConfigurationError('inventorySkew', 'requires a non-negative credit observation')
    )
  })

  test.each([
    [{ unitsPerStep: 0n }, 'inventorySkew.unitsPerStep'],
    [{ unitsPerStep: 1n, neutralCredit: -1n }, 'inventorySkew.neutralCredit'],
    [{ unitsPerStep: 1n, maxSkewBps: 0n }, 'inventorySkew.maxSkewBps'],
    [{ unitsPerStep: 1n, maxSkewBps: 601n }, 'inventorySkew.maxSkewBps']
  ])('rejects an invalid inventory skew %o', (inventorySkew, field) => {
    expect(() => config({ inventorySkew })).toThrow(expect.objectContaining({ field }))
  })

  test('accepts a maxSkewBps spanning the whole hard range', () => {
    expect(config({ inventorySkew: { unitsPerStep: 1n, maxSkewBps: 600n } }).inventorySkew).toEqual(
      { unitsPerStep: 1n, maxSkewBps: 600n }
    )
  })

  test('reports a repricing only when fresh credit makes a planned buy dearer', () => {
    const skewConfig = config({ inventorySkew: { unitsPerStep: 30n } })
    const planned = generateLadder({
      config: skewConfig,
      referenceRateBps: 400n,
      capacities: { creditAssets: 30n }
    })

    expect(rates(planned.higher)).toEqual([600n, 700n, 800n])
    expect(higherRungsRepriced(skewConfig, planned, 60n)).toBe(true)
    expect(higherRungsRepriced(skewConfig, planned, 31n)).toBe(true)
    expect(higherRungsRepriced(skewConfig, planned, 30n)).toBe(false)
    expect(higherRungsRepriced(skewConfig, planned, 0n)).toBe(false)
    expect(higherRungsRepriced(config(), planned, 1_000n)).toBe(false)
  })

  test('reports a repricing when fresh skew pushes a buy planned at the maximum past it', () => {
    const skewConfig = config({ inventorySkew: { unitsPerStep: 10n } })
    const planned = generateLadder({
      config: skewConfig,
      referenceRateBps: 400n,
      capacities: { creditAssets: 10n }
    })

    expect(planned.higher).toEqual([
      { index: 0, rateBps: 600n, assets: 3n },
      { index: 1, rateBps: 700n, assets: 3n },
      { index: 2, rateBps: 800n, assets: 4n }
    ])
    const fresh = generateLadder({
      config: skewConfig,
      referenceRateBps: 400n,
      retainedCenterRateBps: planned.centerRateBps,
      capacities: { creditAssets: 11n }
    })
    expect(rates(fresh.higher)).toEqual([610n, 710n])
    expect(higherRungsRepriced(skewConfig, planned, 11n)).toBe(true)
  })

  test('reports a repricing when fresh skew omits the only planned buy, sitting at the maximum', () => {
    const skewConfig = config({ inventorySkew: { unitsPerStep: 10n } })
    const planned = generateLadder({
      config: skewConfig,
      referenceRateBps: 500n,
      capacities: { creditAssets: 20n }
    })

    expect(rates(planned.higher)).toEqual([800n])
    expect(higherRungsRepriced(skewConfig, planned, 21n)).toBe(true)
    expect(higherRungsRepriced(skewConfig, planned, 20n)).toBe(false)
  })

  test('lets one per-book offer take the whole side, then prices the next cycle higher', () => {
    const perBook = skewed({ unitsPerStep: 10n }, { groupMode: 'per-book' })
    const before = generateLadder({
      config: perBook,
      referenceRateBps: 500n,
      capacities: { creditAssets: 0n }
    })
    const [nearestCap] = offerCapsByRung(before).higher
    const sideAssets = before.higher.reduce((sum, rung) => sum + rung.assets, 0n)
    expect(nearestCap).toBe(sideAssets)

    const after = generateLadder({
      config: perBook,
      referenceRateBps: 500n,
      capacities: { creditAssets: nearestCap }
    })

    expect(rates(before.higher)).toEqual([600n, 700n, 800n])
    expect(rates(after.higher)).toEqual([700n, 800n, 900n])
    expect(after.lower).toEqual(before.lower)
  })
})

describe('lend-only ladder', () => {
  const lendOnly = (overrides: Partial<LadderConfig> = {}) =>
    config({ lowerRateBudgetAssets: 0n, ...overrides })

  test('validates a zero lower budget while a non-zero one below the floor still fails', () => {
    expect(isLendOnlyLadder(lendOnly())).toBe(true)
    expect(isLendOnlyLadder(config())).toBe(false)
    expect(() => lendOnly({ minimumOfferAssets: 101n, higherRateBudgetAssets: 101n })).not.toThrow()
    expect(() =>
      config({
        lowerRateBudgetAssets: 100n,
        higherRateBudgetAssets: 101n,
        minimumOfferAssets: 101n
      })
    ).toThrow('lowerRateBudgetAssets must be zero or at least minimumOfferAssets')
    expect(() => config({ lowerRateBudgetAssets: -1n })).toThrow(
      'lowerRateBudgetAssets must not be negative'
    )
  })

  test('fits only the span of the lending rungs inside the hard range', () => {
    expect(() => lendOnly({ maximumRateBps: 400n })).not.toThrow()
    expect(() => config({ maximumRateBps: 400n })).toThrow(
      'spreadBps full ladder shape cannot fit in the hard range'
    )
    expect(() => lendOnly({ maximumRateBps: 399n })).toThrow(
      'spreadBps full ladder shape cannot fit in the hard range'
    )
  })

  test('checks only the higher rungs against a pinned reference', () => {
    expect(assertLadderShapeAtReference(lendOnly(), 100n)).toBeUndefined()
    expect(() => assertLadderShapeAtReference(config(), 100n)).toThrow(
      'lowerRateBps lower rung is outside the configured hard range'
    )
    expect(() => assertLadderShapeAtReference(lendOnly(), 99n)).toThrow(
      'higherRateBps higher rung is outside the configured hard range'
    )
    expect(() => assertLadderShapeAtReference(lendOnly(), 501n)).toThrow(
      'higherRateBps higher rung is outside the configured hard range'
    )
  })

  test('lifts the inner lend rung into range only through an attainable maturity premium', () => {
    const premium = (maximumPremiumBps: bigint) =>
      lendOnly({ maturityPremium: { shape: 'linear', premiumPerYearBps: 200n, maximumPremiumBps } })

    expect(assertLadderShapeAtReference(premium(100n), 50n)).toBeUndefined()
    expect(() => assertLadderShapeAtReference(premium(49n), 50n)).toThrow(
      'higherRateBps higher rung is outside the configured hard range'
    )
  })

  test.each([0n, 1n, 10n, 10n ** 30n])(
    'publishes no sell rung and the two-sided buys while holding %s credit',
    creditAssets => {
      const capacities = { lowerRateCapacityAssets: creditAssets, creditAssets }
      const oneSided = generateLadderWithDiagnostics({
        config: lendOnly(),
        referenceRateBps: 500n,
        capacities
      })
      const twoSided = generateLadderWithDiagnostics({
        config: config(),
        referenceRateBps: 500n,
        capacities
      })

      expect(oneSided.quote.lower).toEqual([])
      expect(oneSided.quote.higher).toEqual(twoSided.quote.higher)
      expect(oneSided.diagnostics.lower).toMatchObject({ configuredRungs: 0, fundedRungs: 0 })
      expect(oneSided.diagnostics.higher).toStrictEqual(twoSided.diagnostics.higher)
      for (const groupMode of ['shared-rung', 'per-book'] as const) {
        expect(offerCapsByRung({ ...oneSided.quote, groupMode }).lower).toEqual([])
      }
    }
  )
})
