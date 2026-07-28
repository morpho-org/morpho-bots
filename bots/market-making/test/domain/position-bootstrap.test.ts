import type { Hex } from 'viem'

import { describe, expect, test } from 'bun:test'

import { BootstrapConfigurationError } from '../../src/domain/bootstrap-configuration.error'
import { decidePositionBootstrap } from '../../src/domain/position-bootstrap'

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

describe('decidePositionBootstrap', () => {
  test('accepts the credit target at the configured threshold', () => {
    expect(decidePositionBootstrap(parameters)).toEqual({
      kind: 'target-reached',
      completesInitialTarget: true,
      credit: 900n,
      acceptedCredit: 900n
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

  test('replaces a variable bootstrap offer after a new reference observation', () => {
    const activeOffer = {
      marketId,
      assets: 500n,
      rateBps: 450n,
      referenceObservationId: 'block:100'
    }
    const offer = { ...activeOffer, referenceObservationId: 'block:200' }

    expect(
      decidePositionBootstrap({
        ...parameters,
        position: { ...parameters.position, credit: 0n },
        rate: { mode: 'variable', rateBps: 500n, observationId: 'block:200' },
        activeOffer
      })
    ).toEqual({ kind: 'replace', activeOffer, offer })
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
