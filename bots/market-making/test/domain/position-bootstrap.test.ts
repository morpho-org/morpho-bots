import type { Hex } from 'viem'

import { describe, expect, test } from 'bun:test'

import { BootstrapConfigurationError } from '../../src/domain/bootstrap-configuration.error'
import {
  decidePositionBootstrap,
  validateBootstrapConfig
} from '../../src/domain/position-bootstrap'

const marketId: Hex = `0x${'11'.repeat(32)}`

const parameters = {
  config: {
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
  },
  position: {
    credit: 900n,
    cashBalance: 2_000n,
    marketExposure: 0n,
    totalExposure: 0n
  },
  rate: {
    mode: 'static' as const,
    rateBps: 500n,
    observationId: 'static:500'
  },
  activeOffer: undefined,
  initialTargetCompleted: false
}

describe('validateBootstrapConfig', () => {
  test.each(['0x12', `0x${'gg'.repeat(32)}`, `0x${'11'.repeat(31)}`])(
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
    expect(
      validateBootstrapConfig({
        ...parameters.config,
        marketId: `0x${'aB'.repeat(32)}`
      })
    ).toBeUndefined()
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
    expect(
      validateBootstrapConfig({
        ...parameters.config,
        creditTarget: 1n,
        acceptanceAssets: 0n,
        offerSize: 1n,
        premiumBps: 0n,
        minimumRateBps: 0n,
        maximumRateBps: 0n,
        maximumMarketExposure: 1n,
        maximumTotalExposure: 1n
      })
    ).toBeUndefined()
    expect(
      validateBootstrapConfig({
        ...parameters.config,
        acceptanceAssets: parameters.config.creditTarget
      })
    ).toBeUndefined()
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

  test('rejects a negative acceptance threshold', () => {
    expect(() =>
      decidePositionBootstrap({
        ...parameters,
        config: { ...parameters.config, acceptanceAssets: -1n }
      })
    ).toThrow(new BootstrapConfigurationError('acceptanceAssets', 'must not be negative'))
  })

  test('rejects an acceptance threshold greater than the credit target', () => {
    expect(() =>
      decidePositionBootstrap({
        ...parameters,
        config: { ...parameters.config, acceptanceAssets: 1_001n },
        position: { ...parameters.position, credit: 0n }
      })
    ).toThrow(new BootstrapConfigurationError('acceptanceAssets', 'must not exceed creditTarget'))
  })

  test('allows a zero acceptance threshold', () => {
    expect(
      decidePositionBootstrap({
        ...parameters,
        config: { ...parameters.config, acceptanceAssets: 0n },
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
        config: { ...parameters.config, acceptanceAssets: 1_000n },
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

  test('leaves a static offer resting when only observation metadata changes', () => {
    const activeOffer = {
      marketId,
      assets: 500n,
      rateBps: 450n,
      referenceObservationId: 'static:old-observation'
    }

    expect(
      decidePositionBootstrap({
        ...parameters,
        position: { ...parameters.position, credit: 0n },
        rate: { mode: 'static', rateBps: 500n, observationId: 'static:new-observation' },
        activeOffer
      })
    ).toEqual({ kind: 'rest', offer: activeOffer })
  })

  test('rests a rehydrated variable offer when its protocol terms are unchanged', () => {
    const activeOffer = {
      marketId,
      assets: 500n,
      rateBps: 450n,
      referenceObservationId: 'group:rehydrated'
    }

    expect(
      decidePositionBootstrap({
        ...parameters,
        position: { ...parameters.position, credit: 0n },
        rate: { mode: 'variable', rateBps: 500n, observationId: 'blocks:100-200' },
        activeOffer
      })
    ).toEqual({ kind: 'rest', offer: activeOffer })
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

  test('rejects a premium-adjusted requested rate below the configured minimum', () => {
    expect(() =>
      decidePositionBootstrap({
        ...parameters,
        position: { ...parameters.position, credit: 0n },
        config: {
          ...parameters.config,
          minimumRateBps: 200n,
          maximumRateBps: 800n,
          premiumBps: -350n
        }
      })
    ).toThrow(
      new BootstrapConfigurationError('requestedRateBps', 'must be at least minimumRateBps')
    )
  })

  test('rejects a premium-adjusted requested rate above the configured maximum', () => {
    expect(() =>
      decidePositionBootstrap({
        ...parameters,
        position: { ...parameters.position, credit: 0n },
        rate: { mode: 'static', rateBps: 850n, observationId: 'static:850' },
        config: { ...parameters.config, premiumBps: 0n }
      })
    ).toThrow(new BootstrapConfigurationError('requestedRateBps', 'must be at most maximumRateBps'))
  })

  test.each([
    {
      label: 'below minimum',
      rateBps: 100n,
      error: new BootstrapConfigurationError('requestedRateBps', 'must be at least minimumRateBps')
    },
    {
      label: 'above maximum',
      rateBps: 900n,
      error: new BootstrapConfigurationError('requestedRateBps', 'must be at most maximumRateBps')
    }
  ])('rejects an out-of-bounds rate with zero capacity: $label', ({ rateBps, error }) => {
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
        () =>
          decidePositionBootstrap({
            ...parameters,
            position: { ...parameters.position, credit: 0n, ...capacity.values },
            rate: { mode: 'static', rateBps, observationId: `static:${rateBps}` },
            config: { ...parameters.config, premiumBps: 0n }
          }),
        capacity.label
      ).toThrow(error)
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
        config: { ...parameters.config, premiumBps: 0n }
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

  test('rejects a premium that would produce a requested rate below the minimum', () => {
    expect(() =>
      decidePositionBootstrap({
        ...parameters,
        position: { ...parameters.position, credit: 0n },
        config: { ...parameters.config, premiumBps: -501n }
      })
    ).toThrow(
      new BootstrapConfigurationError('requestedRateBps', 'must be at least minimumRateBps')
    )
  })

  test('rejects a positive bootstrap premium', () => {
    expect(() =>
      decidePositionBootstrap({
        ...parameters,
        position: { ...parameters.position, credit: 0n },
        config: { ...parameters.config, premiumBps: 1n }
      })
    ).toThrow(new BootstrapConfigurationError('premiumBps', 'must be zero or negative'))
  })
})
