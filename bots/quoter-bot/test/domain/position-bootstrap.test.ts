import type { Hex } from 'viem'

import { describe, expect, expectTypeOf, test } from 'vitest'

import type { BootstrapConfig, ValidBootstrapConfig } from '../../src/domain/position-bootstrap'

import { BootstrapConfigurationError } from '../../src/domain/bootstrap-configuration.error'
import { MATURITY_PREMIUM_YEAR_SECONDS } from '../../src/domain/maturity-premium'
import {
  decidePositionBootstrap,
  decidePositionBootstrapTransition,
  decidePositionBootstrapWithDiagnostics,
  effectiveBootstrapPremiumBps,
  validateBootstrapConfig
} from '../../src/domain/position-bootstrap'

const marketId: Hex = `0x${'11'.repeat(32)}`

const parameters = {
  config: validateBootstrapConfig({
    marketId,
    creditTarget: 1_000n,
    acceptanceAssets: 100n,
    offerSize: 500n,
    premiumBps: -50n,
    maximumMarketExposure: 2_000n,
    maximumTotalExposure: 4_000n,
    minimumRateBps: 200n,
    maximumRateBps: 800n,
    autoRefill: false
  }),
  position: {
    credit: 900n,
    cashBalance: 2_000n,
    marketExposure: 0n,
    totalExposure: 0n
  },
  lossFactor: { lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true },
  rate: {
    mode: 'static' as const,
    rateBps: 500n,
    observationId: 'static:500'
  },
  activeOffer: undefined,
  initialTargetCompleted: false
}

describe('validateBootstrapConfig', () => {
  test('admits only a validated config into a bootstrap decision', () => {
    expectTypeOf<BootstrapConfig>().not.toExtend<ValidBootstrapConfig>()
    expectTypeOf(validateBootstrapConfig<BootstrapConfig>).returns.toExtend<ValidBootstrapConfig>()
    expectTypeOf(decidePositionBootstrapWithDiagnostics)
      .parameter(0)
      .toHaveProperty('config')
      .toEqualTypeOf<ValidBootstrapConfig>()
  })

  test.each<Hex>(['0x12', `0x${'gg'.repeat(32)}`, `0x${'11'.repeat(31)}`])(
    'rejects malformed market id %s',
    malformedMarketId => {
      expect(() =>
        validateBootstrapConfig({
          ...parameters.config,
          marketId: malformedMarketId
        })
      ).toThrow(
        new BootstrapConfigurationError('marketId', 'must be a 0x-prefixed bytes32 hex value')
      )
    }
  )

  test('accepts an exact mixed-case bytes32 market id', () => {
    const config: BootstrapConfig = {
      ...parameters.config,
      marketId: `0x${'aB'.repeat(32)}`
    }
    expect(validateBootstrapConfig(config)).toEqual(config)
  })

  test('returns a frozen copy that later writes to the input cannot reach', () => {
    const input: BootstrapConfig = {
      ...parameters.config,
      premiumBps: -50n,
      maturityPremium: { shape: 'linear', premiumPerYearBps: 120n }
    }
    const validated = validateBootstrapConfig(input)
    input.premiumBps = 1n
    input.maturityPremium!.premiumPerYearBps = 999n

    expect(validated.premiumBps).toBe(-50n)
    expect(validated.maturityPremium?.premiumPerYearBps).toBe(120n)
    expect(Object.isFrozen(validated)).toBe(true)
    expect(Object.isFrozen(validated.maturityPremium)).toBe(true)
  })

  test('rejects a non-positive credit target', () => {
    expect(() => validateBootstrapConfig({ ...parameters.config, creditTarget: 0n })).toThrow(
      new BootstrapConfigurationError('creditTarget', 'must be positive')
    )
  })

  test('rejects a negative acceptance threshold', () => {
    expect(() => validateBootstrapConfig({ ...parameters.config, acceptanceAssets: -1n })).toThrow(
      new BootstrapConfigurationError('acceptanceAssets', 'must not be negative')
    )
  })

  test('rejects an acceptance threshold greater than the credit target', () => {
    expect(() =>
      validateBootstrapConfig({ ...parameters.config, acceptanceAssets: 1_001n })
    ).toThrow(new BootstrapConfigurationError('acceptanceAssets', 'must not exceed creditTarget'))
  })

  test('rejects a non-positive offer size', () => {
    expect(() => validateBootstrapConfig({ ...parameters.config, offerSize: 0n })).toThrow(
      new BootstrapConfigurationError('offerSize', 'must be positive')
    )
  })

  test('rejects a positive bootstrap premium', () => {
    expect(() => validateBootstrapConfig({ ...parameters.config, premiumBps: 1n })).toThrow(
      new BootstrapConfigurationError('premiumBps', 'must be zero or negative')
    )
  })

  test('accepts a linear maturity premium with and without a cap', () => {
    const uncapped: BootstrapConfig = {
      ...parameters.config,
      maturityPremium: { shape: 'linear', premiumPerYearBps: 120n }
    }
    expect(validateBootstrapConfig(uncapped)).toEqual(uncapped)
    const capped: BootstrapConfig = {
      ...parameters.config,
      maturityPremium: { shape: 'linear', premiumPerYearBps: 120n, maximumPremiumBps: 300n }
    }
    expect(validateBootstrapConfig(capped)).toEqual(capped)
  })

  test('rejects a non-positive maturity-premium slope', () => {
    expect(() =>
      validateBootstrapConfig({
        ...parameters.config,
        maturityPremium: { shape: 'linear', premiumPerYearBps: 0n }
      })
    ).toThrow(
      new BootstrapConfigurationError('maturityPremium.premiumPerYearBps', 'must be positive')
    )
  })

  test('rejects a non-positive maturity-premium cap', () => {
    expect(() =>
      validateBootstrapConfig({
        ...parameters.config,
        maturityPremium: { shape: 'linear', premiumPerYearBps: 120n, maximumPremiumBps: 0n }
      })
    ).toThrow(
      new BootstrapConfigurationError('maturityPremium.maximumPremiumBps', 'must be positive')
    )
  })

  test('rejects a negative minimum rate', () => {
    expect(() => validateBootstrapConfig({ ...parameters.config, minimumRateBps: -1n })).toThrow(
      new BootstrapConfigurationError('minimumRateBps', 'must not be negative')
    )
  })

  test('rejects a negative maximum rate', () => {
    expect(() => validateBootstrapConfig({ ...parameters.config, maximumRateBps: -1n })).toThrow(
      new BootstrapConfigurationError('maximumRateBps', 'must not be negative')
    )
  })

  test('rejects a minimum rate greater than the maximum rate', () => {
    expect(() =>
      validateBootstrapConfig({
        ...parameters.config,
        minimumRateBps: 801n,
        maximumRateBps: 800n
      })
    ).toThrow(new BootstrapConfigurationError('minimumRateBps', 'must not exceed maximumRateBps'))
  })

  test('rejects a non-positive maximum market exposure', () => {
    expect(() =>
      validateBootstrapConfig({ ...parameters.config, maximumMarketExposure: 0n })
    ).toThrow(new BootstrapConfigurationError('maximumMarketExposure', 'must be positive'))
  })

  test('rejects a non-positive maximum total exposure', () => {
    expect(() =>
      validateBootstrapConfig({ ...parameters.config, maximumTotalExposure: 0n })
    ).toThrow(new BootstrapConfigurationError('maximumTotalExposure', 'must be positive'))
  })

  test('rejects a maximum market exposure greater than maximum total exposure', () => {
    expect(() =>
      validateBootstrapConfig({
        ...parameters.config,
        maximumMarketExposure: 4_001n,
        maximumTotalExposure: 4_000n
      })
    ).toThrow(
      new BootstrapConfigurationError(
        'maximumMarketExposure',
        'must not exceed maximumTotalExposure'
      )
    )
  })

  test('accepts inclusive structural boundaries', () => {
    const minimal = {
      ...parameters.config,
      creditTarget: 1n,
      acceptanceAssets: 0n,
      offerSize: 1n,
      premiumBps: 0n,
      minimumRateBps: 0n,
      maximumRateBps: 0n,
      maximumMarketExposure: 1n,
      maximumTotalExposure: 1n
    }
    expect(validateBootstrapConfig(minimal)).toEqual(minimal)
    const fullAcceptance = {
      ...parameters.config,
      acceptanceAssets: parameters.config.creditTarget
    }
    expect(validateBootstrapConfig(fullAcceptance)).toEqual(fullAcceptance)
  })
})

describe('decidePositionBootstrap', () => {
  test('accepts the credit target at the configured threshold', () => {
    expect(decidePositionBootstrap(parameters)).toEqual({
      kind: 'target-reached',
      completesInitialTarget: true,
      credit: 900n,
      acceptedCredit: 900n
    })
  })

  test('allows a zero acceptance threshold', () => {
    expect(
      decidePositionBootstrap({
        ...parameters,
        config: validateBootstrapConfig({ ...parameters.config, acceptanceAssets: 0n }),
        position: { ...parameters.position, credit: 1_000n }
      })
    ).toEqual({
      kind: 'target-reached',
      completesInitialTarget: true,
      credit: 1_000n,
      acceptedCredit: 1_000n
    })
  })

  test('allows an acceptance threshold equal to the credit target', () => {
    expect(
      decidePositionBootstrap({
        ...parameters,
        config: validateBootstrapConfig({ ...parameters.config, acceptanceAssets: 1_000n }),
        position: { ...parameters.position, credit: 0n }
      })
    ).toEqual({
      kind: 'target-reached',
      completesInitialTarget: true,
      credit: 0n,
      acceptedCredit: 0n
    })
  })

  test('invalidates a live bootstrap offer when the accepted target is reached', () => {
    expect(
      decidePositionBootstrap({
        ...parameters,
        activeOffer: {
          marketId,
          assets: 100n,
          rateBps: 450n,
          referenceObservationId: 'static:500'
        }
      })
    ).toEqual({
      kind: 'invalidate',
      reason: 'target-reached',
      completesInitialTarget: true
    })
  })

  test('caps the offer by every remaining target, balance, market, and total exposure limit', () => {
    const limits = [
      { field: 'remaining-target', expected: 400n, values: {} },
      { field: 'balance', expected: 300n, values: { cashBalance: 300n } },
      { field: 'market-exposure', expected: 200n, values: { marketExposure: 1_800n } },
      { field: 'total-exposure', expected: 100n, values: { totalExposure: 3_900n } }
    ] as const

    for (const limit of limits) {
      const decision = decidePositionBootstrap({
        ...parameters,
        position: {
          ...parameters.position,
          credit: 600n,
          ...limit.values
        }
      })

      expect(decision).toEqual({
        kind: 'publish',
        offer: {
          marketId,
          assets: limit.expected,
          rateBps: 450n,
          referenceObservationId: 'static:500'
        }
      })
    }
  })

  test('leaves an unchanged static bootstrap offer resting', () => {
    const offer = {
      marketId,
      assets: 500n,
      rateBps: 450n,
      referenceObservationId: 'static:500'
    }

    expect(
      decidePositionBootstrap({
        ...parameters,
        position: { ...parameters.position, credit: 0n },
        activeOffer: offer
      })
    ).toEqual({ kind: 'rest', offer })
  })

  test('replaces duplicate active groups even when the representative terms match', () => {
    const activeOffer = {
      marketId,
      assets: 500n,
      rateBps: 450n,
      referenceObservationId: 'group:first'
    }
    const offer = { ...activeOffer, referenceObservationId: 'static:500' }

    expect(
      decidePositionBootstrap({
        ...parameters,
        position: { ...parameters.position, credit: 0n },
        activeOffer,
        requiresReconciliation: true
      })
    ).toEqual({ kind: 'replace', activeOffer, offer })
  })

  test('refreshes a static offer when its time-bucket observation changes', () => {
    const activeOffer = {
      marketId,
      assets: 500n,
      rateBps: 450n,
      referenceObservationId: 'static:500:hour:1'
    }
    const offer = { ...activeOffer, referenceObservationId: 'static:500:hour:2' }

    expect(
      decidePositionBootstrap({
        ...parameters,
        position: { ...parameters.position, credit: 0n },
        rate: { mode: 'static', rateBps: 500n, observationId: 'static:500:hour:2' },
        activeOffer
      })
    ).toEqual({ kind: 'replace', activeOffer, offer })
  })

  test('refreshes a rehydrated variable offer for a new observation', () => {
    const activeOffer = {
      marketId,
      assets: 500n,
      rateBps: 450n,
      referenceObservationId: 'group:rehydrated'
    }

    const decision = decidePositionBootstrap({
      ...parameters,
      position: { ...parameters.position, credit: 0n },
      rate: { mode: 'variable', rateBps: 500n, observationId: 'blocks:100-200' },
      activeOffer
    })

    expect(decision).toMatchObject({
      kind: 'replace',
      activeOffer,
      offer: { referenceObservationId: 'blocks:100-200' }
    })
  })

  test('leaves a variable offer resting within the same reference observation', () => {
    const activeOffer = {
      marketId,
      assets: 500n,
      rateBps: 450n,
      referenceObservationId: 'block:200'
    }

    expect(
      decidePositionBootstrap({
        ...parameters,
        position: { ...parameters.position, credit: 0n },
        rate: { mode: 'variable', rateBps: 500n, observationId: 'block:200' },
        activeOffer
      })
    ).toEqual({ kind: 'rest', offer: activeOffer })
  })

  test('publishes no offer for a premium-adjusted rate below the configured minimum', () => {
    expect(
      decidePositionBootstrap({
        ...parameters,
        position: { ...parameters.position, credit: 0n },
        config: validateBootstrapConfig({
          ...parameters.config,
          minimumRateBps: 200n,
          maximumRateBps: 800n,
          premiumBps: -350n
        })
      })
    ).toEqual({ kind: 'observe', reason: 'rate-out-of-range' })
  })

  test('publishes no offer for a premium-adjusted rate above the configured maximum', () => {
    expect(
      decidePositionBootstrap({
        ...parameters,
        position: { ...parameters.position, credit: 0n },
        rate: { mode: 'static', rateBps: 850n, observationId: 'static:850' },
        config: validateBootstrapConfig({ ...parameters.config, premiumBps: 0n })
      })
    ).toEqual({ kind: 'observe', reason: 'rate-out-of-range' })
  })

  test.each([
    { label: 'below minimum', rateBps: 199n },
    { label: 'above maximum', rateBps: 801n }
  ])('invalidates an active offer instead of clamping a rate $label', ({ rateBps }) => {
    expect(
      decidePositionBootstrap({
        ...parameters,
        position: { ...parameters.position, credit: 0n },
        rate: { mode: 'static', rateBps, observationId: `static:${rateBps}` },
        config: validateBootstrapConfig({ ...parameters.config, premiumBps: 0n }),
        activeOffer: {
          marketId,
          assets: 500n,
          rateBps: 450n,
          referenceObservationId: 'static:500'
        }
      })
    ).toEqual({ kind: 'invalidate', reason: 'rate-out-of-range', completesInitialTarget: false })
  })

  test('publishes no offer for an in-range rate when the range holds no tick', () => {
    expect(
      decidePositionBootstrap({
        ...parameters,
        position: { ...parameters.position, credit: 0n, rateWindowEmpty: true }
      })
    ).toEqual({ kind: 'observe', reason: 'rate-out-of-range' })
  })

  test('invalidates an active offer for an in-range rate when the range holds no tick', () => {
    expect(
      decidePositionBootstrap({
        ...parameters,
        position: { ...parameters.position, credit: 0n, rateWindowEmpty: true },
        activeOffer: {
          marketId,
          assets: 500n,
          rateBps: 450n,
          referenceObservationId: 'static:500'
        }
      })
    ).toEqual({ kind: 'invalidate', reason: 'rate-out-of-range', completesInitialTarget: false })
  })

  test.each([200n, 800n])('publishes a rate exactly on a bound (%s BPS)', rateBps => {
    expect(
      decidePositionBootstrap({
        ...parameters,
        position: { ...parameters.position, credit: 0n },
        rate: { mode: 'static', rateBps, observationId: `static:${rateBps}` },
        config: validateBootstrapConfig({ ...parameters.config, premiumBps: 0n })
      })
    ).toMatchObject({ kind: 'publish', offer: { rateBps } })
  })

  test.each([
    { label: 'below minimum', rateBps: 100n },
    { label: 'above maximum', rateBps: 900n }
  ])('reports an out-of-bounds rate before a zero capacity: $label', ({ rateBps }) => {
    const zeroCapacityPositions = [
      { label: 'cash', values: { cashBalance: 0n } },
      {
        label: 'market exposure',
        values: { marketExposure: parameters.config.maximumMarketExposure }
      },
      {
        label: 'total exposure',
        values: { totalExposure: parameters.config.maximumTotalExposure }
      }
    ] as const

    for (const capacity of zeroCapacityPositions) {
      expect(
        decidePositionBootstrap({
          ...parameters,
          position: { ...parameters.position, credit: 0n, ...capacity.values },
          rate: { mode: 'static', rateBps, observationId: `static:${rateBps}` },
          config: validateBootstrapConfig({ ...parameters.config, premiumBps: 0n })
        }),
        capacity.label
      ).toEqual({ kind: 'observe', reason: 'rate-out-of-range' })
    }
  })

  test('keeps an in-bounds zero-capacity position observational', () => {
    expect(
      decidePositionBootstrap({
        ...parameters,
        position: { ...parameters.position, credit: 0n, cashBalance: 0n }
      })
    ).toEqual({ kind: 'observe', reason: 'no-capacity', assets: 0n })
  })

  test('stays observational after initial completion when auto-refill is disabled', () => {
    expect(
      decidePositionBootstrap({
        ...parameters,
        position: { ...parameters.position, credit: 500n },
        initialTargetCompleted: true
      })
    ).toEqual({
      kind: 'observe',
      reason: 'auto-refill-disabled',
      credit: 500n,
      acceptedCredit: 900n
    })
  })

  test('invalidates instead of publishing when no safe offer capacity remains', () => {
    const activeOffer = {
      marketId,
      assets: 100n,
      rateBps: 450n,
      referenceObservationId: 'static:500'
    }

    expect(
      decidePositionBootstrap({
        ...parameters,
        position: { ...parameters.position, credit: 500n, marketExposure: 2_001n },
        activeOffer
      })
    ).toEqual({ kind: 'invalidate', reason: 'no-capacity', completesInitialTarget: false })
  })

  test('uses the target rate unchanged when the bootstrap premium is zero', () => {
    expect(
      decidePositionBootstrap({
        ...parameters,
        position: { ...parameters.position, credit: 0n },
        config: validateBootstrapConfig({ ...parameters.config, premiumBps: 0n })
      })
    ).toEqual({
      kind: 'publish',
      offer: {
        marketId,
        assets: 500n,
        rateBps: 500n,
        referenceObservationId: 'static:500'
      }
    })
  })

  test('publishes no offer for a premium overshooting the reference rate below the minimum', () => {
    expect(
      decidePositionBootstrap({
        ...parameters,
        position: { ...parameters.position, credit: 0n },
        config: validateBootstrapConfig({ ...parameters.config, premiumBps: -501n })
      })
    ).toEqual({ kind: 'observe', reason: 'rate-out-of-range' })
  })

  test('raises the requested rate by the maturity premium for a further maturity', () => {
    expect(
      decidePositionBootstrap({
        ...parameters,
        position: { ...parameters.position, credit: 0n },
        rate: { ...parameters.rate, secondsToMaturity: MATURITY_PREMIUM_YEAR_SECONDS / 2n },
        config: validateBootstrapConfig({
          ...parameters.config,
          maturityPremium: { shape: 'linear', premiumPerYearBps: 200n }
        })
      })
    ).toMatchObject({ kind: 'publish', offer: { rateBps: 550n } })
  })

  test('caps the maturity premium before applying it to the requested rate', () => {
    expect(
      decidePositionBootstrap({
        ...parameters,
        position: { ...parameters.position, credit: 0n },
        rate: { ...parameters.rate, secondsToMaturity: MATURITY_PREMIUM_YEAR_SECONDS },
        config: validateBootstrapConfig({
          ...parameters.config,
          maturityPremium: { shape: 'linear', premiumPerYearBps: 200n, maximumPremiumBps: 120n }
        })
      })
    ).toMatchObject({ kind: 'publish', offer: { rateBps: 570n } })
  })

  test('publishes no offer for a maturity-premium-adjusted rate above the maximum', () => {
    expect(
      decidePositionBootstrap({
        ...parameters,
        position: { ...parameters.position, credit: 0n },
        rate: { ...parameters.rate, secondsToMaturity: MATURITY_PREMIUM_YEAR_SECONDS },
        config: validateBootstrapConfig({
          ...parameters.config,
          maturityPremium: { shape: 'linear', premiumPerYearBps: 800n }
        })
      })
    ).toEqual({ kind: 'observe', reason: 'rate-out-of-range' })
  })

  test('adds no maturity premium for a market at or past maturity', () => {
    expect(
      decidePositionBootstrap({
        ...parameters,
        position: { ...parameters.position, credit: 0n },
        rate: { ...parameters.rate, secondsToMaturity: 0n },
        config: validateBootstrapConfig({
          ...parameters.config,
          maturityPremium: { shape: 'linear', premiumPerYearBps: 200n }
        })
      })
    ).toMatchObject({ kind: 'publish', offer: { rateBps: 450n } })
  })

  test('rejects a configured maturity premium without a maturity observation', () => {
    expect(() =>
      decidePositionBootstrap({
        ...parameters,
        position: { ...parameters.position, credit: 0n },
        config: validateBootstrapConfig({
          ...parameters.config,
          maturityPremium: { shape: 'linear', premiumPerYearBps: 200n }
        })
      })
    ).toThrow(new BootstrapConfigurationError('maturityPremium', 'requires a maturity observation'))
  })
})

describe('effectiveBootstrapPremiumBps', () => {
  test('returns the static premium unchanged without a maturity-premium configuration', () => {
    expect(effectiveBootstrapPremiumBps(parameters.config, undefined)).toBe(-50n)
    expect(effectiveBootstrapPremiumBps(parameters.config, MATURITY_PREMIUM_YEAR_SECONDS)).toBe(
      -50n
    )
  })

  test('adds the resolved maturity premium to the static premium', () => {
    expect(
      effectiveBootstrapPremiumBps(
        {
          ...parameters.config,
          maturityPremium: { shape: 'linear', premiumPerYearBps: 120n }
        },
        MATURITY_PREMIUM_YEAR_SECONDS / 2n
      )
    ).toBe(10n)
  })

  test('fails loud when the required maturity observation is missing', () => {
    expect(() =>
      effectiveBootstrapPremiumBps(
        {
          ...parameters.config,
          maturityPremium: { shape: 'linear', premiumPerYearBps: 120n }
        },
        undefined
      )
    ).toThrow(new BootstrapConfigurationError('maturityPremium', 'requires a maturity observation'))
  })
})

describe('decidePositionBootstrapWithDiagnostics', () => {
  const funding = { ...parameters, position: { ...parameters.position, credit: 0n } }

  test('reports the requested rate and no bound while the premium keeps it in range', () => {
    const { diagnostics } = decidePositionBootstrapWithDiagnostics(funding)

    expect(diagnostics).toStrictEqual({
      requestedRateBps: 450n,
      requestedAssets: 500n,
      cappedAssets: 500n,
      cap: 'offer-size'
    })
  })

  test('reports the bound an out-of-range premium-adjusted rate violates', () => {
    expect(
      decidePositionBootstrapWithDiagnostics({
        ...funding,
        rate: { mode: 'static', rateBps: 900n, observationId: 'static:900' }
      })
    ).toMatchObject({
      decision: { kind: 'observe', reason: 'rate-out-of-range' },
      diagnostics: { requestedRateBps: 850n, outOfRangeBound: 'maximum' }
    })

    expect(
      decidePositionBootstrapWithDiagnostics({
        ...funding,
        rate: { mode: 'static', rateBps: 200n, observationId: 'static:200' }
      })
    ).toMatchObject({
      decision: { kind: 'observe', reason: 'rate-out-of-range' },
      diagnostics: { requestedRateBps: 150n, outOfRangeBound: 'minimum' }
    })
  })

  test('reports an empty tick window without naming a violated bound', () => {
    expect(
      decidePositionBootstrapWithDiagnostics({
        ...funding,
        position: { ...funding.position, rateWindowEmpty: true }
      })
    ).toStrictEqual({
      decision: { kind: 'observe', reason: 'rate-out-of-range' },
      diagnostics: {
        requestedRateBps: 450n,
        rateWindowEmpty: true,
        requestedAssets: 500n,
        cappedAssets: 500n,
        cap: 'offer-size'
      }
    })
  })

  test('names the cash balance as the binding size cap', () => {
    expect(
      decidePositionBootstrapWithDiagnostics({
        ...funding,
        position: { ...funding.position, cashBalance: 300n }
      }).diagnostics
    ).toMatchObject({ requestedAssets: 500n, cappedAssets: 300n, cap: 'cash-balance' })
  })

  test('names the remaining credit target as the binding size cap', () => {
    expect(
      decidePositionBootstrapWithDiagnostics({
        ...funding,
        position: { ...funding.position, credit: 700n }
      }).diagnostics
    ).toMatchObject({ requestedAssets: 500n, cappedAssets: 300n, cap: 'credit-target' })
  })

  test('floors the reported size at zero while naming the exceeded exposure bound', () => {
    const { decision, diagnostics } = decidePositionBootstrapWithDiagnostics({
      ...funding,
      position: { ...funding.position, marketExposure: 2_500n }
    })

    expect(diagnostics).toMatchObject({
      requestedAssets: 500n,
      cappedAssets: 0n,
      cap: 'market-exposure'
    })
    expect(decision).toEqual({ kind: 'observe', reason: 'no-capacity', assets: 0n })
  })

  test('omits diagnostics for a transition that never derives a rate', () => {
    const { decision, diagnostics } = decidePositionBootstrapWithDiagnostics(parameters)

    expect(decision).toEqual({
      kind: 'target-reached',
      completesInitialTarget: true,
      credit: 900n,
      acceptedCredit: 900n
    })
    expect(diagnostics).toBeUndefined()
  })
})

describe('decidePositionBootstrapTransition loss factor', () => {
  const activeOffer = {
    marketId,
    assets: 100n,
    rateBps: 450n,
    referenceObservationId: 'static:500'
  }
  const lossFactor = (observed: bigint) => ({
    lossFactor: observed,
    acceptedLossFactor: 5n,
    defaulted: false
  })

  test('lends only when the loss factor equals the accepted value', () => {
    expect(
      decidePositionBootstrap({
        ...parameters,
        position: { ...parameters.position, credit: 0n },
        lossFactor: lossFactor(5n)
      })
    ).toMatchObject({ kind: 'publish' })
    expect(
      decidePositionBootstrap({
        ...parameters,
        position: { ...parameters.position, credit: 0n },
        lossFactor: lossFactor(6n)
      })
    ).toEqual({
      kind: 'observe',
      reason: 'loss-factor-mismatch',
      halt: { ...lossFactor(6n), direction: 'above' }
    })
    expect(
      decidePositionBootstrap({
        ...parameters,
        position: { ...parameters.position, credit: 0n },
        lossFactor: lossFactor(4n)
      })
    ).toEqual({
      kind: 'observe',
      reason: 'loss-factor-mismatch',
      halt: { ...lossFactor(4n), direction: 'below' }
    })
  })

  test.each([
    ['a resting offer', { credit: 0n }, false, false],
    ['a reached target', { credit: 1_000n }, false, false],
    ['a completed market without refill', { credit: 0n }, true, false],
    ['a completed market with refill', { credit: 0n }, true, true]
  ])(
    'invalidates the active buy over %s without completing the target',
    (_name, position, initialTargetCompleted, autoRefill) => {
      const decision = decidePositionBootstrapTransition({
        config: validateBootstrapConfig({ ...parameters.config, autoRefill }),
        position: { ...parameters.position, ...position },
        lossFactor: lossFactor(6n),
        activeOffer,
        initialTargetCompleted
      })

      expect(decision).toEqual({
        kind: 'invalidate',
        reason: 'loss-factor-mismatch',
        completesInitialTarget: false,
        halt: { ...lossFactor(6n), direction: 'above' }
      })
    }
  )

  test('observes without an active buy even when the target is reached', () => {
    expect(
      decidePositionBootstrapTransition({
        config: parameters.config,
        position: { ...parameters.position, credit: 1_000n },
        lossFactor: lossFactor(0n),
        activeOffer: undefined,
        initialTargetCompleted: false
      })
    ).toMatchObject({ kind: 'observe', reason: 'loss-factor-mismatch' })
  })
})
