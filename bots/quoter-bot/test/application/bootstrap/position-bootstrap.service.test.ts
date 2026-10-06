import type { Hex } from 'viem'

import { describe, expect, expectTypeOf, test, vi } from 'vitest'

import type {
  BootstrapMakeService,
  BootstrapPositionService,
  BootstrapReferenceRateService
} from '../../../src/application/bootstrap/position-bootstrap.service'
import type { BootstrapConfig, ValidBootstrapConfig } from '../../../src/domain/position-bootstrap'

import { BootstrapOwnershipCleanupError } from '../../../src/application/bootstrap/bootstrap-ownership-cleanup.error'
import { PositionBootstrapService } from '../../../src/application/bootstrap/position-bootstrap.service'
import { bootstrapMonitoringEvents } from '../../../src/application/monitoring/bootstrap-monitoring.utils'
import { createMonitoringProjection } from '../../../src/application/monitoring/monitoring-projection.utils'
import { BootstrapConfigurationError } from '../../../src/domain/bootstrap-configuration.error'
import { MARKET_FAILURE_BUDGET_CYCLES } from '../../../src/domain/market-failure-budget'
import { validateBootstrapConfig } from '../../../src/domain/position-bootstrap'
import { BootstrapAdapterError } from '../../../src/infrastructure/bootstrap/bootstrap-adapter.error'
import { BootstrapMempoolValidationError } from '../../../src/infrastructure/bootstrap/bootstrap-mempool-validation.error'

const marketId: Hex = `0x${'11'.repeat(32)}`
const secondMarketId: Hex = `0x${'22'.repeat(32)}`
const publicationHash: Hex = `0x${'aa'.repeat(32)}`
const cancellationHash: Hex = `0x${'bb'.repeat(32)}`
const ratificationHash: Hex = `0x${'cc'.repeat(32)}`

const config = (id = marketId, autoRefill = false): BootstrapConfig => ({
  marketId: id,
  creditTarget: 1_000n,
  acceptanceAssets: 100n,
  offerSize: 500n,
  premiumBps: -50n,
  maximumMarketExposure: 2_000n,
  maximumTotalExposure: 4_000n,
  minimumRateBps: 200n,
  maximumRateBps: 800n,
  autoRefill
})

const setup = ({
  configs = [config()],
  credit = 0n
}: {
  configs?: BootstrapConfig[]
  credit?: bigint
} = {}) => {
  const readPosition = vi.fn(async () => ({
    credit,
    debt: 0n,
    lossFactor: { lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true },
    cashBalance: 2_000n,
    marketExposure: 0n,
    totalExposure: 0n,
    activeOffer: undefined
  }))
  const readRate = vi.fn(async () => ({
    mode: 'static' as const,
    rateBps: 500n,
    observationId: 'static:500'
  }))
  const reconcile = vi.fn(async () => undefined)
  const hardHalt = vi.fn(async () => undefined)
  const cleanup = vi.fn(async () => undefined)
  const positions: BootstrapPositionService = { readPosition }
  const rates: BootstrapReferenceRateService = { readRate }
  const make: BootstrapMakeService = { reconcile, hardHalt, cleanup }
  const service = new PositionBootstrapService(
    positions,
    rates,
    make,
    configs.map(entry => validateBootstrapConfig(entry))
  )

  return {
    service,
    positions,
    rates,
    make,
    readPosition,
    readRate,
    reconcile,
    hardHalt,
    cleanup
  }
}

describe('PositionBootstrapService', () => {
  test('is constructed only from validated configs', () => {
    expectTypeOf<ConstructorParameters<typeof PositionBootstrapService>[3]>().toEqualTypeOf<
      readonly ValidBootstrapConfig[]
    >()
  })

  test('monitors sequential cycles and cleans owned groups after shutdown', async () => {
    const events: string[] = []
    const controller = new AbortController()
    const { service, make } = setup()
    make.reconcile = vi.fn(async () => {
      events.push('reconcile')
    })
    const cleanup = vi.fn(async () => {
      events.push('cleanup')
    })
    make.cleanup = cleanup

    const report = await service.runContinuously({
      signal: controller.signal,
      intervalMs: 1,
      runOperation: async operation => {
        events.push('operation:start')
        const result = await operation()
        events.push('operation:end')
        return result
      },
      onCycle: results => {
        events.push(`cycle:${results.length}`)
        if (events.filter(event => event.startsWith('cycle:')).length === 2) {
          controller.abort()
        }
      }
    })

    expect(report).toEqual({
      status: 'stopped',
      reason: 'signal',
      cycles: 2,
      cleanup: { status: 'applied' }
    })
    expect(events).toEqual([
      'operation:start',
      'reconcile',
      'cycle:1',
      'operation:end',
      'operation:start',
      'reconcile',
      'cycle:1',
      'operation:end',
      'operation:start',
      'cleanup',
      'operation:end'
    ])
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  test('counts only cycles successfully delivered to the output callback', async () => {
    const { service, cleanup } = setup()

    const report = await service.runContinuously({
      signal: new AbortController().signal,
      intervalMs: 1,
      onCycle: () => {
        throw new TypeError('private output failure')
      }
    })

    expect(report).toEqual({
      status: 'halted',
      reason: 'cycle-error',
      cycles: 0,
      cleanup: { status: 'applied' },
      cycleErrorName: 'TypeError'
    })
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  test('retries a handled failed cycle instead of cancelling the book', async () => {
    const controller = new AbortController()
    const { service, make } = setup()
    const reconcile = vi.fn(async () => {
      throw new Error('publication unavailable')
    })
    make.reconcile = reconcile
    const cleanup = vi.fn(async () => 'logged' as const)
    make.cleanup = cleanup
    let observed = 0

    const report = await service.runContinuously({
      signal: controller.signal,
      intervalMs: 1,
      onCycle: () => {
        observed += 1
        if (observed === 2) controller.abort()
      }
    })

    expect(report).toMatchObject({
      status: 'stopped',
      reason: 'signal',
      cycles: 2,
      cleanup: { status: 'logged' },
      lastCycle: [{ status: 'failed', stage: 'make', errorName: 'UnknownError' }]
    })
    expect(reconcile).toHaveBeenCalledTimes(2)
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  test('halts once one market exhausts its consecutive failure budget', async () => {
    const { service, make } = setup()
    make.reconcile = vi.fn(async () => {
      throw new Error('publication unavailable')
    })
    make.cleanup = vi.fn(async () => 'logged' as const)

    const report = await service.runContinuously({
      signal: new AbortController().signal,
      intervalMs: 1
    })

    expect(report).toMatchObject({
      status: 'halted',
      reason: 'cycle-failed',
      cycles: MARKET_FAILURE_BUDGET_CYCLES,
      lastCycle: [{ status: 'failed', stage: 'make' }]
    })
  })

  test('stops monitoring on a halted cycle and still cleans owned groups', async () => {
    const controller = new AbortController()
    const { service, positions, make } = setup()
    positions.readPosition = vi.fn(async () => {
      throw new TypeError('position unavailable')
    })
    make.reconcile = vi.fn(async () => {
      throw new RangeError('invalidation reverted')
    })
    const cleanup = vi.fn(async () => 'logged' as const)
    make.cleanup = cleanup

    const report = await service.runContinuously({
      signal: controller.signal,
      intervalMs: 1
    })

    expect(report).toMatchObject({
      status: 'halted',
      reason: 'cycle-failed',
      cycles: 1,
      cleanup: { status: 'logged' },
      lastCycle: [{ status: 'halted', stage: 'position-read' }]
    })
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  test.each([
    { cleanupFails: false, reason: 'cycle-failed', cleanup: { status: 'applied' } },
    {
      cleanupFails: true,
      reason: 'cleanup-failed',
      cleanup: { status: 'failed', errorName: 'URIError' }
    }
  ])(
    'retries a failed hard-halt cancellation once through cleanup (cleanup fails: $cleanupFails)',
    async ({ cleanupFails, reason, cleanup }) => {
      const calls: string[] = []
      const { service, rates, make } = setup()
      rates.readRate = vi.fn(async () => {
        throw new TypeError('stale reference')
      })
      make.hardHalt = vi.fn(async () => {
        calls.push('hardHalt')
        throw new RangeError('cancellation reverted')
      })
      make.cleanup = vi.fn(async () => {
        calls.push('cleanup')
        if (cleanupFails) throw new URIError('cancellation reverted again')
        return { submittedTransactions: [] }
      })

      const report = await service.runContinuously({
        signal: new AbortController().signal,
        intervalMs: 1
      })

      expect(calls).toEqual(['hardHalt', 'cleanup'])
      expect(report).toEqual({
        status: 'halted',
        reason,
        cycles: 1,
        cleanup,
        lastCycle: [
          {
            marketId,
            status: 'halted',
            stage: 'reference-read',
            strategyInvalidated: false,
            errorName: 'TypeError',
            invalidationErrorName: 'RangeError'
          }
        ]
      })
    }
  )

  test('reports a sanitized cleanup failure after a stop signal', async () => {
    const controller = new AbortController()
    const { service, make } = setup()
    make.cleanup = vi.fn(async () => {
      const error = new Error('provider https://rpc.example/?key=secret')
      error.name = 'https://rpc.example/?key=secret'
      throw error
    })
    controller.abort()

    const report = await service.runContinuously({
      signal: controller.signal,
      intervalMs: 1
    })

    expect(report).toEqual({
      status: 'halted',
      reason: 'cleanup-failed',
      cycles: 0,
      cleanup: { status: 'failed', errorName: 'UnknownError' }
    })
    expect(JSON.stringify(report)).not.toContain('secret')
  })

  test('rejects empty monitoring configuration before cleanup', async () => {
    const controller = new AbortController()
    const { service, cleanup } = setup({ configs: [] })

    const error = await service
      .runContinuously({ signal: controller.signal, intervalMs: 1 })
      .catch(value => value)

    expect(error).toBeInstanceOf(BootstrapConfigurationError)
    expect(cleanup).not.toHaveBeenCalled()
  })

  test('publishes the maturity-premium-adjusted rate and reports it in verbose diagnostics', async () => {
    const halfYearSeconds = 15_768_000n
    const { service, rates, reconcile } = setup({
      configs: [{ ...config(), maturityPremium: { shape: 'linear', premiumPerYearBps: 200n } }]
    })
    rates.readRate = vi.fn(async () => ({
      mode: 'static' as const,
      rateBps: 500n,
      observationId: 'static:500',
      secondsToMaturity: halfYearSeconds
    }))

    const results = await service.runOnce({ verbose: true })

    expect(results[0]).toMatchObject({
      marketId,
      status: 'applied',
      action: 'publish',
      verbose: {
        referenceRate: { rateBps: 500n, secondsToMaturity: halfYearSeconds },
        maturityPremiumBps: 100n,
        targetRateBps: 550n,
        decision: { kind: 'publish', offer: { rateBps: 550n } }
      }
    })
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ desiredOffer: expect.objectContaining({ rateBps: 550n }) })
    )
  })

  test('halts the strategy when a configured maturity premium lacks its observation', async () => {
    const { service, hardHalt, reconcile } = setup({
      configs: [{ ...config(), maturityPremium: { shape: 'linear', premiumPerYearBps: 200n } }]
    })

    expect(await service.runOnce()).toEqual([
      {
        marketId,
        status: 'halted',
        stage: 'decision',
        strategyInvalidated: true,
        errorName: 'BootstrapConfigurationError'
      }
    ])
    expect(hardHalt).toHaveBeenCalledWith({ reason: 'bootstrap-decision-failed' })
    expect(reconcile).not.toHaveBeenCalled()
  })

  test('publishes the capped desired offer from fresh position and reference reads', async () => {
    const { service, readPosition, readRate, reconcile } = setup()

    const result = await service.runOnce()

    expect(readPosition).toHaveBeenCalledWith(marketId)
    expect(readRate).toHaveBeenCalledWith(marketId)
    expect(reconcile).toHaveBeenCalledWith({
      marketId,
      desiredOffer: {
        marketId,
        assets: 500n,
        rateBps: 450n,
        referenceObservationId: 'static:500'
      },
      reason: 'publish'
    })
    expect(result).toEqual([
      {
        marketId,
        status: 'applied',
        action: 'publish'
      }
    ])
  })

  test('reports config, target rate, offer, transaction hash, and fresh after-state when verbose', async () => {
    const { service, positions, make } = setup()
    const submittedEvents: unknown[] = []
    const transactionOrder: string[] = []
    let read = 0
    const readPosition = vi.fn(async () => {
      read += 1
      return {
        credit: read === 1 ? 0n : 100n,
        debt: 25n,
        lossFactor: { lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true },
        cashBalance: read === 1 ? 2_000n : 1_500n,
        marketExposure: read === 1 ? 0n : 500n,
        totalExposure: read === 1 ? 0n : 500n,
        activeOffer:
          read === 1
            ? undefined
            : {
                marketId,
                assets: 500n,
                rateBps: 450n,
                referenceObservationId: 'static:500'
              },
        requiresReconciliation: false
      }
    })
    positions.readPosition = readPosition
    make.reconcile = vi.fn(async parameters => {
      await parameters.onTransactionSubmitted?.({
        operation: 'publish',
        txHash: publicationHash
      })
      transactionOrder.push('confirmed')
      return {
        submittedTransactions: [{ operation: 'publish' as const, txHash: publicationHash }]
      }
    })

    const result = await service.runOnce({
      verbose: true,
      onTransactionSubmitted: event => {
        submittedEvents.push(event)
        transactionOrder.push('submitted')
      }
    })

    expect(result).toEqual([
      {
        marketId,
        status: 'applied',
        action: 'publish',
        verbose: {
          config: config(),
          currentState: {
            status: 'observed',
            position: {
              credit: 0n,
              debt: 25n,
              lossFactor: { lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true },
              cashBalance: 2_000n,
              marketExposure: 0n,
              totalExposure: 0n,
              requiresReconciliation: false,
              initialTargetCompleted: false
            }
          },
          effectiveState: {
            credit: 0n,
            debt: 25n,
            lossFactor: { lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true },
            cashBalance: 2_000n,
            marketExposure: 0n,
            totalExposure: 0n,
            requiresReconciliation: false,
            initialTargetCompleted: false
          },
          referenceRate: {
            mode: 'static',
            rateBps: 500n,
            observationId: 'static:500'
          },
          targetRateBps: 450n,
          decision: {
            kind: 'publish',
            offer: {
              marketId,
              assets: 500n,
              rateBps: 450n,
              referenceObservationId: 'static:500'
            }
          },
          bootstrapOffer: {
            marketId,
            assets: 500n,
            rateBps: 450n,
            referenceObservationId: 'static:500'
          },
          diagnostics: {
            requestedRateBps: 450n,
            requestedAssets: 500n,
            cappedAssets: 500n,
            cap: 'offer-size'
          },
          durationMs: expect.any(Number),
          submittedTransactions: [{ operation: 'publish', txHash: publicationHash }],
          stateAfterCheck: {
            status: 'observed',
            position: {
              credit: 100n,
              debt: 25n,
              lossFactor: { lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true },
              cashBalance: 1_500n,
              marketExposure: 500n,
              totalExposure: 500n,
              activeOffer: {
                marketId,
                assets: 500n,
                rateBps: 450n,
                referenceObservationId: 'static:500'
              },
              requiresReconciliation: false,
              initialTargetCompleted: false
            }
          }
        }
      }
    ])
    expect(readPosition).toHaveBeenCalledTimes(2)
    expect(submittedEvents).toEqual([
      {
        event: 'bootstrap.transaction-submitted',
        marketId,
        operation: 'publish',
        txHash: publicationHash
      }
    ])
    expect(transactionOrder).toEqual(['submitted', 'confirmed'])
  })

  test('retains a confirmed ratification hash when publication later fails', async () => {
    const { service, make } = setup()
    make.reconcile = vi.fn(async () => {
      throw new BootstrapAdapterError(
        'publication-transaction-reverted-after-ratification'
      ).recordConfirmedTransactions([{ operation: 'ratify', txHash: ratificationHash }])
    })

    expect(await service.runOnce({ verbose: true })).toMatchObject([
      {
        status: 'failed',
        stage: 'make',
        verbose: {
          submittedTransactions: [{ operation: 'ratify', txHash: ratificationHash }]
        }
      }
    ])
  })

  test('keeps non-verbose cycles compact and avoids the diagnostic after-state read', async () => {
    const { service, readPosition } = setup()

    expect(await service.runOnce()).toEqual([{ marketId, status: 'applied', action: 'publish' }])
    expect(readPosition).toHaveBeenCalledTimes(1)
  })

  test('reports canonical protocol no-ops as observed resting offers', async () => {
    const { service, make } = setup()
    make.reconcile = vi.fn(async () => 'unchanged' as const)

    const result = await service.runOnce()

    expect(result).toEqual([{ marketId, status: 'observed', action: 'rest' }])
  })

  test('keeps an applied result when only its verbose after-state read fails', async () => {
    const { service, positions } = setup()
    let read = 0
    positions.readPosition = vi.fn(async () => {
      read += 1
      if (read === 2) throw new TypeError('after-state provider unavailable')
      return {
        credit: 0n,
        debt: 0n,
        lossFactor: { lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true },
        cashBalance: 2_000n,
        marketExposure: 0n,
        totalExposure: 0n,
        activeOffer: undefined
      }
    })

    const result = await service.runOnce({ verbose: true })

    expect(result).toMatchObject([
      {
        status: 'applied',
        action: 'publish',
        verbose: {
          stateAfterCheck: { status: 'failed', errorName: 'TypeError' }
        }
      }
    ])
  })

  test('reports verbose monitor cycles and confirmed shutdown cancellation hashes', async () => {
    const controller = new AbortController()
    const { service, make } = setup({ credit: 900n })
    make.cleanup = vi.fn(async parameters => {
      await parameters?.onTransactionSubmitted?.({
        operation: 'cancel',
        txHash: cancellationHash
      })
      return {
        submittedTransactions: [{ operation: 'cancel' as const, txHash: cancellationHash }]
      }
    })
    const cycles: unknown[] = []
    const submittedEvents: unknown[] = []

    const report = await service.runContinuously({
      signal: controller.signal,
      intervalMs: 1,
      verbose: true,
      onCycle: results => {
        cycles.push(results)
        controller.abort()
      },
      onTransactionSubmitted: event => {
        submittedEvents.push(event)
      }
    })

    expect(cycles).toHaveLength(1)
    expect(cycles).toMatchObject([
      [
        {
          action: 'target-reached',
          verbose: {
            config: { marketId },
            currentState: { status: 'observed', position: { credit: 900n } },
            decision: { kind: 'target-reached' },
            stateAfterCheck: {
              status: 'observed',
              position: { credit: 900n, initialTargetCompleted: true }
            }
          }
        }
      ]
    ])
    expect(report).toEqual({
      status: 'stopped',
      reason: 'signal',
      cycles: 1,
      cleanup: {
        status: 'applied',
        submittedTransactions: [{ operation: 'cancel', txHash: cancellationHash }]
      }
    })
    expect(submittedEvents).toEqual([
      {
        event: 'bootstrap.transaction-submitted',
        operation: 'cancel',
        txHash: cancellationHash
      }
    ])
  })
  test('reserves planned exposure before deciding a later under-target market', async () => {
    const capped = {
      ...config(),
      maximumMarketExposure: 600n,
      maximumTotalExposure: 600n
    }
    const { service, reconcile } = setup({
      configs: [capped, { ...capped, marketId: secondMarketId }]
    })

    expect(await service.runOnce()).toEqual([
      { marketId, status: 'applied', action: 'publish' },
      { marketId: secondMarketId, status: 'applied', action: 'publish' }
    ])
    expect(reconcile).toHaveBeenNthCalledWith(1, {
      marketId,
      desiredOffer: {
        marketId,
        assets: 500n,
        rateBps: 450n,
        referenceObservationId: 'static:500'
      },
      reason: 'publish'
    })
    expect(reconcile).toHaveBeenNthCalledWith(2, {
      marketId: secondMarketId,
      desiredOffer: {
        marketId: secondMarketId,
        assets: 100n,
        rateBps: 450n,
        referenceObservationId: 'static:500'
      },
      reason: 'publish'
    })
  })

  test('does not reserve a bootstrap offer fully covered by ladder liquidity', async () => {
    const capped = {
      ...config(),
      maximumMarketExposure: 600n,
      maximumTotalExposure: 600n
    }
    const { service, make, reconcile } = setup({
      configs: [capped, { ...capped, marketId: secondMarketId }]
    })
    const preview = vi.fn(async parameters =>
      parameters.marketId === marketId ? undefined : parameters.desiredOffer
    )
    make.preview = preview

    expect(await service.runOnce()).toEqual([
      { marketId, status: 'applied', action: 'publish' },
      { marketId: secondMarketId, status: 'applied', action: 'publish' }
    ])
    expect(preview).toHaveBeenCalledTimes(2)
    expect(reconcile).toHaveBeenNthCalledWith(2, {
      marketId: secondMarketId,
      desiredOffer: {
        marketId: secondMarketId,
        assets: 500n,
        rateBps: 450n,
        referenceObservationId: 'static:500'
      },
      reason: 'publish'
    })
  })

  test('passes the original offer with the size reserved by the live preview as a cap', async () => {
    const capped = {
      ...config(),
      maximumMarketExposure: 600n,
      maximumTotalExposure: 600n
    }
    const { service, make, reconcile } = setup({
      configs: [capped, { ...capped, marketId: secondMarketId }]
    })
    make.preview = vi.fn(async parameters =>
      parameters.marketId === marketId
        ? { ...parameters.desiredOffer, assets: 200n }
        : parameters.desiredOffer
    )

    await service.runOnce()

    expect(reconcile).toHaveBeenNthCalledWith(1, {
      marketId,
      desiredOffer: {
        marketId,
        assets: 500n,
        rateBps: 450n,
        referenceObservationId: 'static:500'
      },
      maximumAssets: 200n,
      onTransactionSubmitted: undefined,
      reason: 'publish'
    })
    expect(reconcile).toHaveBeenNthCalledWith(2, {
      marketId: secondMarketId,
      desiredOffer: {
        marketId: secondMarketId,
        assets: 400n,
        rateBps: 450n,
        referenceObservationId: 'static:500'
      },
      reason: 'publish'
    })
  })

  test('reserves only the net replacement delta before deciding a later market', async () => {
    const capped = {
      ...config(),
      maximumMarketExposure: 600n,
      maximumTotalExposure: 600n
    }
    const { service, positions, reconcile } = setup({
      configs: [capped, { ...capped, marketId: secondMarketId }]
    })
    positions.readPosition = vi.fn(async id => ({
      credit: 0n,
      debt: 0n,
      lossFactor: { lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true },
      cashBalance: id === marketId ? 1_000n : 500n,
      marketExposure: 0n,
      totalExposure: id === marketId ? 0n : 500n,
      activeOffer:
        id === marketId
          ? {
              marketId,
              assets: 500n,
              rateBps: 400n,
              referenceObservationId: 'static:old'
            }
          : undefined
    }))

    expect(await service.runOnce()).toEqual([
      { marketId, status: 'applied', action: 'replace' },
      { marketId: secondMarketId, status: 'applied', action: 'publish' }
    ])
    expect(reconcile).toHaveBeenNthCalledWith(2, {
      marketId: secondMarketId,
      desiredOffer: {
        marketId: secondMarketId,
        assets: 100n,
        rateBps: 450n,
        referenceObservationId: 'static:500'
      },
      reason: 'publish'
    })
  })

  test('credits planned invalidation capacity before deciding a later market', async () => {
    const capped = {
      ...config(),
      maximumMarketExposure: 600n,
      maximumTotalExposure: 600n
    }
    const { service, positions, reconcile } = setup({
      configs: [capped, { ...capped, marketId: secondMarketId }]
    })
    positions.readPosition = vi.fn(async id => ({
      credit: id === marketId ? 900n : 0n,
      debt: 0n,
      lossFactor: { lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true },
      cashBalance: id === marketId ? 1_000n : 500n,
      marketExposure: 0n,
      totalExposure: id === marketId ? 0n : 500n,
      activeOffer:
        id === marketId
          ? {
              marketId,
              assets: 500n,
              rateBps: 450n,
              referenceObservationId: 'static:500'
            }
          : undefined
    }))

    expect(await service.runOnce()).toEqual([
      { marketId, status: 'applied', action: 'invalidate' },
      { marketId: secondMarketId, status: 'applied', action: 'publish' }
    ])
    expect(reconcile).toHaveBeenNthCalledWith(2, {
      marketId: secondMarketId,
      desiredOffer: {
        marketId: secondMarketId,
        assets: 500n,
        rateBps: 450n,
        referenceObservationId: 'static:500'
      },
      reason: 'publish'
    })
  })

  test('invalidates at target and stays observational after completion when auto-refill is off', async () => {
    const { service, positions, reconcile } = setup()
    let cycle = 0
    positions.readPosition = vi.fn(async () => {
      cycle += 1
      return {
        credit: cycle === 1 ? 900n : 500n,
        debt: 0n,
        lossFactor: { lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true },
        cashBalance: 2_000n,
        marketExposure: 0n,
        totalExposure: 0n,
        activeOffer:
          cycle === 1
            ? {
                marketId,
                assets: 100n,
                rateBps: 450n,
                referenceObservationId: 'static:500'
              }
            : undefined
      }
    })

    const targetResult = await service.runOnce()
    const deficitResult = await service.runOnce()

    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(reconcile).toHaveBeenCalledWith({
      marketId,
      desiredOffer: undefined,
      reason: 'target-reached'
    })
    expect(targetResult).toEqual([{ marketId, status: 'applied', action: 'invalidate' }])
    expect(deficitResult).toEqual([
      { marketId, status: 'observed', action: 'auto-refill-disabled' }
    ])
  })

  test.each([
    {
      reason: 'target-reached' as const,
      position: { credit: 900n, cashBalance: 2_000n },
      warmup: false
    },
    {
      reason: 'no-capacity' as const,
      position: { credit: 0n, cashBalance: 0n },
      warmup: false
    },
    {
      reason: 'auto-refill-disabled' as const,
      position: { credit: 500n, cashBalance: 2_000n },
      warmup: true
    }
  ])(
    'hard-halts immediately when a $reason decision invalidation fails',
    async ({ reason, position, warmup }) => {
      const { service, positions, make, reconcile, hardHalt } = setup({
        configs: [config(), config(secondMarketId, true)]
      })
      let preparingCompletion = warmup
      positions.readPosition = vi.fn(async id => {
        if (preparingCompletion) {
          return {
            credit: 900n,
            debt: 0n,
            lossFactor: { lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true },
            cashBalance: 2_000n,
            marketExposure: 0n,
            totalExposure: 0n,
            activeOffer: undefined
          }
        }
        return {
          credit: id === marketId ? position.credit : 0n,
          debt: 0n,
          lossFactor: { lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true },
          cashBalance: id === marketId ? position.cashBalance : 2_000n,
          marketExposure: 0n,
          totalExposure: 0n,
          activeOffer:
            id === marketId
              ? {
                  marketId,
                  assets: 100n,
                  rateBps: 450n,
                  referenceObservationId: 'static:500'
                }
              : undefined
        }
      })
      if (warmup) {
        await service.runOnce()
        preparingCompletion = false
        reconcile.mockClear()
        hardHalt.mockClear()
      }
      const failedReconcile = vi.fn(async request => {
        if (request.marketId === marketId && request.desiredOffer === undefined) {
          throw new RangeError('market invalidation reverted')
        }
      })
      make.reconcile = failedReconcile

      expect(await service.runOnce()).toEqual([
        {
          marketId,
          status: 'halted',
          stage: 'make',
          action: 'invalidate',
          reason,
          strategyInvalidated: true,
          invalidationErrorName: 'RangeError'
        }
      ])
      expect(failedReconcile).toHaveBeenCalledTimes(1)
      expect(hardHalt).toHaveBeenCalledTimes(1)
      expect(hardHalt).toHaveBeenCalledWith({ reason: 'market-invalidation-failed' })
    }
  )

  test('preserves decision invalidation and hard-halt failure classifications', async () => {
    const { service, positions, make } = setup({
      configs: [config(), config(secondMarketId)]
    })
    positions.readPosition = vi.fn(async id => ({
      credit: id === marketId ? 900n : 0n,
      debt: 0n,
      lossFactor: { lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true },
      cashBalance: 2_000n,
      marketExposure: 0n,
      totalExposure: 0n,
      activeOffer:
        id === marketId
          ? {
              marketId,
              assets: 100n,
              rateBps: 450n,
              referenceObservationId: 'static:500'
            }
          : undefined
    }))
    const failedReconcile = vi.fn(async request => {
      if (request.marketId === marketId) {
        const hostileInvalidation = new Error('market invalidation reverted')
        hostileInvalidation.name = 'https://invalidator.example/?token=secret-invalidation'
        throw hostileInvalidation
      }
    })
    make.reconcile = failedReconcile
    const hardHalt = vi.fn(async () => {
      const hostileCleanup = new Error('hard halt reverted')
      hostileCleanup.name = 'https://cleanup.example/?token=secret-cleanup'
      throw hostileCleanup
    })
    make.hardHalt = hardHalt

    const result = await service.runOnce()

    expect(result).toEqual([
      {
        marketId,
        status: 'halted',
        stage: 'make',
        action: 'invalidate',
        reason: 'target-reached',
        strategyInvalidated: false,
        invalidationErrorName: 'UnknownError',
        hardHaltErrorName: 'UnknownError'
      }
    ])
    expect(failedReconcile).toHaveBeenCalledTimes(1)
    expect(hardHalt).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(result)).not.toContain('secret-invalidation')
    expect(JSON.stringify(result)).not.toContain('secret-cleanup')
  })

  test('continues to a later publishable market after a successful decision invalidation', async () => {
    const { service, positions, reconcile, hardHalt } = setup({
      configs: [config(), config(secondMarketId)]
    })
    positions.readPosition = vi.fn(async id => ({
      credit: id === marketId ? 900n : 0n,
      debt: 0n,
      lossFactor: { lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true },
      cashBalance: 2_000n,
      marketExposure: 0n,
      totalExposure: 0n,
      activeOffer:
        id === marketId
          ? {
              marketId,
              assets: 100n,
              rateBps: 450n,
              referenceObservationId: 'static:500'
            }
          : undefined
    }))

    expect(await service.runOnce()).toEqual([
      { marketId, status: 'applied', action: 'invalidate' },
      { marketId: secondMarketId, status: 'applied', action: 'publish' }
    ])
    expect(reconcile).toHaveBeenCalledTimes(2)
    expect(hardHalt).not.toHaveBeenCalled()
  })

  test('invalidates a failed market read and continues bootstrapping other markets', async () => {
    const { service, positions, reconcile } = setup({
      configs: [config(), config(secondMarketId)]
    })
    positions.readPosition = vi.fn(async id => {
      if (id === marketId) throw new Error('provider unavailable')
      return {
        credit: 0n,
        debt: 0n,
        lossFactor: { lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true },
        cashBalance: 2_000n,
        marketExposure: 0n,
        totalExposure: 0n,
        activeOffer: undefined
      }
    })

    const result = await service.runOnce()

    expect(reconcile).toHaveBeenNthCalledWith(1, {
      marketId,
      desiredOffer: undefined,
      reason: 'market-read-failed'
    })
    expect(reconcile).toHaveBeenNthCalledWith(2, {
      marketId: secondMarketId,
      desiredOffer: {
        marketId: secondMarketId,
        assets: 500n,
        rateBps: 450n,
        referenceObservationId: 'static:500'
      },
      reason: 'publish'
    })
    expect(result).toEqual([
      {
        marketId,
        status: 'failed',
        stage: 'position-read',
        invalidated: true,
        errorName: 'UnknownError'
      },
      { marketId: secondMarketId, status: 'applied', action: 'publish' }
    ])
  })

  test('halts after market invalidation fails while preserving the read failure', async () => {
    const { service, positions, make, hardHalt } = setup()
    positions.readPosition = vi.fn(async () => {
      throw new TypeError('position unavailable')
    })
    make.reconcile = vi.fn(async () => {
      throw new RangeError('invalidation reverted')
    })

    expect(await service.runOnce()).toEqual([
      {
        marketId,
        status: 'halted',
        stage: 'position-read',
        strategyInvalidated: true,
        errorName: 'TypeError',
        invalidationErrorName: 'RangeError'
      }
    ])
    expect(hardHalt).toHaveBeenCalledWith({ reason: 'market-invalidation-failed' })
  })

  test('stops later publication when market invalidation fails', async () => {
    const { service, positions, make } = setup({
      configs: [config(), config(secondMarketId)]
    })
    positions.readPosition = vi.fn(async id => {
      if (id === marketId) throw new TypeError('position unavailable')
      return {
        credit: 0n,
        debt: 0n,
        lossFactor: { lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true },
        cashBalance: 2_000n,
        marketExposure: 0n,
        totalExposure: 0n,
        activeOffer: undefined
      }
    })
    const failedReconcile = vi.fn(async request => {
      if (request.marketId === marketId) throw new RangeError('invalidation reverted')
    })
    make.reconcile = failedReconcile

    expect(await service.runOnce()).toEqual([
      {
        marketId,
        status: 'halted',
        stage: 'position-read',
        strategyInvalidated: true,
        errorName: 'TypeError',
        invalidationErrorName: 'RangeError'
      }
    ])
    expect(failedReconcile).toHaveBeenCalledTimes(1)
  })

  test('preserves market invalidation and hard-halt failure classifications', async () => {
    const { service, positions, make } = setup()
    positions.readPosition = vi.fn(async () => {
      throw new TypeError('position unavailable')
    })
    make.reconcile = vi.fn(async () => {
      throw new RangeError('invalidation reverted')
    })
    make.hardHalt = vi.fn(async () => {
      throw new URIError('hard halt reverted')
    })

    expect(await service.runOnce()).toEqual([
      {
        marketId,
        status: 'halted',
        stage: 'position-read',
        strategyInvalidated: false,
        errorName: 'TypeError',
        invalidationErrorName: 'RangeError',
        hardHaltErrorName: 'URIError'
      }
    ])
  })

  test('does not expose hostile injected error names', async () => {
    const { service, positions } = setup()
    const hostile = new Error('provider failed')
    hostile.name = 'https://rpc.example/?token=secret-token'
    positions.readPosition = vi.fn(async () => {
      throw hostile
    })

    const result = await service.runOnce()
    expect(result).toEqual([
      {
        marketId,
        status: 'failed',
        stage: 'position-read',
        invalidated: true,
        errorName: 'UnknownError'
      }
    ])
    expect(JSON.stringify(result)).not.toContain('secret-token')
  })

  test.each([100n, 900n])(
    'observes an out-of-bounds rate without publishing, even at zero capacity (%s BPS)',
    async rateBps => {
      const { service, positions, rates, reconcile, hardHalt } = setup()
      positions.readPosition = vi.fn(async () => ({
        credit: 0n,
        debt: 0n,
        lossFactor: { lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true },
        cashBalance: 0n,
        marketExposure: 0n,
        totalExposure: 0n,
        activeOffer: undefined
      }))
      rates.readRate = vi.fn(async () => ({
        mode: 'static' as const,
        rateBps,
        observationId: `static:${rateBps}`
      }))

      expect(await service.runOnce()).toEqual([
        {
          marketId,
          status: 'observed',
          action: 'rate-out-of-range'
        }
      ])
      expect(hardHalt).not.toHaveBeenCalled()
      expect(reconcile).not.toHaveBeenCalled()
    }
  )

  test('halts the strategy on a reference failure and prevents later market publication', async () => {
    const { service, rates, reconcile, hardHalt } = setup({
      configs: [config(), config(secondMarketId)]
    })
    rates.readRate = vi.fn(async () => {
      throw new TypeError('stale reference')
    })

    const result = await service.runOnce()

    expect(hardHalt).toHaveBeenCalledWith({
      reason: 'reference-read-failed'
    })
    expect(reconcile).not.toHaveBeenCalled()
    expect(result).toEqual([
      {
        marketId,
        status: 'halted',
        stage: 'reference-read',
        strategyInvalidated: true,
        errorName: 'TypeError'
      }
    ])
  })

  test('preflights every reference decision before publishing an earlier market', async () => {
    const { service, rates, reconcile, hardHalt } = setup({
      configs: [config(), config(secondMarketId)]
    })
    rates.readRate = vi.fn(async id => {
      if (id === secondMarketId) throw new TypeError('stale reference')
      return { mode: 'static' as const, rateBps: 500n, observationId: 'static:500' }
    })

    expect(await service.runOnce()).toEqual([
      {
        marketId: secondMarketId,
        status: 'halted',
        stage: 'reference-read',
        strategyInvalidated: true,
        errorName: 'TypeError'
      }
    ])
    expect(hardHalt).toHaveBeenCalledWith({ reason: 'reference-read-failed' })
    expect(reconcile).not.toHaveBeenCalled()
  })

  test('preserves the reference failure classification when strategy cleanup also fails', async () => {
    const { service, rates, make } = setup()
    rates.readRate = vi.fn(async () => {
      throw new TypeError('stale reference')
    })
    make.hardHalt = vi.fn(async () => {
      throw new RangeError('cleanup reverted')
    })

    expect(await service.runOnce()).toEqual([
      {
        marketId,
        status: 'halted',
        stage: 'reference-read',
        strategyInvalidated: false,
        errorName: 'TypeError',
        invalidationErrorName: 'RangeError'
      }
    ])
  })

  test('invalidates an active offer rather than clamping it when the reference collapses', async () => {
    const { service, positions, rates, reconcile, hardHalt } = setup()
    positions.readPosition = vi.fn(async () => ({
      credit: 0n,
      debt: 0n,
      lossFactor: { lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true },
      cashBalance: 2_000n,
      marketExposure: 0n,
      totalExposure: 0n,
      activeOffer: {
        marketId,
        assets: 500n,
        rateBps: 450n,
        referenceObservationId: 'static:500'
      }
    }))
    rates.readRate = vi.fn(async () => ({
      mode: 'static' as const,
      rateBps: 100n,
      observationId: 'static:100'
    }))

    expect(await service.runOnce()).toEqual([
      {
        marketId,
        status: 'applied',
        action: 'invalidate'
      }
    ])
    expect(hardHalt).not.toHaveBeenCalled()
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        marketId,
        desiredOffer: undefined,
        reason: 'rate-out-of-range'
      })
    )
  })

  test('completes before a failed reference read and stays stopped with auto-refill disabled', async () => {
    const { service, positions, rates, reconcile } = setup()
    let cycle = 0
    positions.readPosition = vi.fn(async () => {
      cycle += 1
      return {
        credit: cycle === 1 ? 900n : 500n,
        debt: 0n,
        lossFactor: { lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true },
        cashBalance: 2_000n,
        marketExposure: 0n,
        totalExposure: 0n,
        activeOffer:
          cycle === 1
            ? {
                marketId,
                assets: 100n,
                rateBps: 450n,
                referenceObservationId: 'static:500'
              }
            : undefined
      }
    })
    const failedReadRate = vi.fn(async () => {
      throw new TypeError('reference unavailable')
    })
    rates.readRate = failedReadRate

    expect(await service.runOnce()).toEqual([{ marketId, status: 'applied', action: 'invalidate' }])
    expect(await service.runOnce()).toEqual([
      { marketId, status: 'observed', action: 'auto-refill-disabled' }
    ])
    expect(failedReadRate).not.toHaveBeenCalled()
    expect(reconcile).toHaveBeenCalledTimes(1)
  })

  test('service recreation intentionally resets the auto-refill false one-shot gate', async () => {
    const first = setup({ credit: 900n })
    expect(await first.service.runOnce()).toEqual([
      { marketId, status: 'observed', action: 'target-reached' }
    ])

    const restarted = setup({ credit: 500n })
    expect(await restarted.service.runOnce()).toEqual([
      { marketId, status: 'applied', action: 'publish' }
    ])
  })

  test('stops dependent plans after a make failure', async () => {
    const { service, make } = setup({ configs: [config(), config(secondMarketId)] })
    const failedReconcile = vi.fn(async request => {
      if (request.marketId === marketId) throw new RangeError('publish rejected')
    })
    make.reconcile = failedReconcile

    const result = await service.runOnce()

    expect(result).toEqual([
      {
        marketId,
        status: 'failed',
        stage: 'make',
        invalidated: false,
        errorName: 'RangeError'
      }
    ])
    expect(failedReconcile).toHaveBeenCalledTimes(1)
  })

  test('reports a sanitized Mempool asset floor after publication validation fails', async () => {
    const { service, make } = setup()
    make.reconcile = vi.fn(async () => {
      throw new BootstrapMempoolValidationError([
        { rule: 'min_offer_assets_usd', minimumAssets: 100_000_000n }
      ])
    })

    expect(await service.runOnce()).toEqual([
      {
        marketId,
        status: 'failed',
        stage: 'make',
        invalidated: false,
        errorName: 'BootstrapMempoolValidationError',
        minimumAssets: '100000000'
      }
    ])
  })

  describe('a buy capped below the Router minimum', () => {
    const belowMinimum = () =>
      new BootstrapMempoolValidationError([
        { rule: 'min_offer_assets_usd', minimumAssets: 100_000_000n }
      ])
    const drained = (
      service: ReturnType<typeof setup>,
      activeOffer?: {
        marketId: Hex
        assets: bigint
        rateBps: bigint
        referenceObservationId: string
      }
    ) => {
      service.positions.readPosition = vi.fn(async () => ({
        credit: 0n,
        debt: 0n,
        lossFactor: { lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true },
        cashBalance: 3n,
        marketExposure: activeOffer?.assets ?? 0n,
        totalExposure: activeOffer?.assets ?? 0n,
        activeOffer
      }))
    }

    test('keeps monitoring with the target unfinished once the allowance drains to dust', async () => {
      const controller = new AbortController()
      const bootstrap = setup()
      drained(bootstrap)
      const reasons: string[] = []
      bootstrap.make.reconcile = vi.fn<BootstrapMakeService['reconcile']>(async parameters => {
        reasons.push(parameters.reason)
        if (parameters.desiredOffer) throw belowMinimum()
        return { submittedTransactions: [] }
      })
      const cycles: (readonly Record<string, unknown>[])[] = []
      const cyclesToRun = MARKET_FAILURE_BUDGET_CYCLES + 2

      const report = await bootstrap.service.runContinuously({
        signal: controller.signal,
        intervalMs: 1,
        onCycle: results => {
          cycles.push(results)
          if (cycles.length === cyclesToRun) controller.abort()
        }
      })

      expect(report).toMatchObject({ status: 'stopped', reason: 'signal', cycles: cyclesToRun })
      expect(cycles.at(-1)).toEqual([
        {
          marketId,
          status: 'observed',
          action: 'publication-withheld',
          reason: 'below-minimum-offer',
          minimumAssets: '100000000'
        }
      ])
      expect(reasons.slice(0, 2)).toEqual(['publish', 'no-capacity'])
      expect(
        bootstrapMonitoringEvents(cycles.at(-1) as never).filter(
          event => event.event === 'guardrail.publication-withheld'
        )
      ).toEqual([
        {
          event: 'guardrail.publication-withheld',
          workflow: 'bootstrap',
          marketId,
          reason: 'below-minimum-offer',
          minimumAssets: '100000000'
        }
      ])
    })

    test('cancels a resting offer it can no longer replace', async () => {
      const bootstrap = setup()
      drained(bootstrap, {
        marketId,
        assets: 400n,
        rateBps: 999n,
        referenceObservationId: 'static:999'
      })
      bootstrap.make.reconcile = vi.fn<BootstrapMakeService['reconcile']>(async parameters => {
        if (parameters.desiredOffer) throw belowMinimum()
        return { submittedTransactions: [{ operation: 'cancel', txHash: cancellationHash }] }
      })

      expect(await bootstrap.service.runOnce()).toEqual([
        {
          marketId,
          status: 'applied',
          action: 'publication-withheld',
          reason: 'below-minimum-offer',
          minimumAssets: '100000000'
        }
      ])
    })

    test('withholds when the read-only preview is the step the Router rejects', async () => {
      const bootstrap = setup()
      drained(bootstrap)
      bootstrap.make.preview = vi.fn(async () => {
        throw belowMinimum()
      })
      const reconcile = vi.fn<BootstrapMakeService['reconcile']>(async () => 'logged' as const)
      bootstrap.make.reconcile = reconcile

      expect(await bootstrap.service.runOnce()).toEqual([
        {
          marketId,
          status: 'logged',
          action: 'publication-withheld',
          reason: 'below-minimum-offer',
          minimumAssets: '100000000'
        }
      ])
      expect(reconcile).toHaveBeenCalledTimes(1)
      expect(reconcile.mock.calls[0]?.[0]).toMatchObject({
        desiredOffer: undefined,
        reason: 'no-capacity'
      })
    })

    test('clears an earlier publication failure instead of charging it every cycle', async () => {
      const controller = new AbortController()
      const bootstrap = setup()
      drained(bootstrap)
      let attempt = 0
      bootstrap.make.reconcile = vi.fn<BootstrapMakeService['reconcile']>(async parameters => {
        if (!parameters.desiredOffer) return { submittedTransactions: [] }
        attempt += 1
        throw attempt === 1 ? new Error('publication unavailable') : belowMinimum()
      })
      const cyclesToRun = MARKET_FAILURE_BUDGET_CYCLES + 2
      let cycles = 0

      const report = await bootstrap.service.runContinuously({
        signal: controller.signal,
        intervalMs: 1,
        onCycle: () => {
          cycles += 1
          if (cycles === cyclesToRun) controller.abort()
        }
      })

      expect(report).toMatchObject({ status: 'stopped', reason: 'signal', cycles: cyclesToRun })
    })

    test('still fails a minimum-size rule that reports no Router floor', async () => {
      const bootstrap = setup()
      drained(bootstrap)
      bootstrap.make.reconcile = vi.fn(async () => {
        throw new BootstrapMempoolValidationError([{ rule: 'min_offer_assets_usd' }])
      })

      expect(await bootstrap.service.runOnce()).toMatchObject([
        { marketId, status: 'failed', stage: 'make', errorName: 'BootstrapMempoolValidationError' }
      ])
    })

    test('keeps monitoring when capacity drops to zero after a failed make', async () => {
      const controller = new AbortController()
      const bootstrap = setup()
      let cycle = 0
      bootstrap.positions.readPosition = vi.fn(async () => ({
        credit: 0n,
        debt: 0n,
        lossFactor: { lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true },
        cashBalance: cycle === 0 ? 2_000n : 0n,
        marketExposure: 0n,
        totalExposure: 0n,
        activeOffer: undefined
      }))
      bootstrap.make.reconcile = vi.fn(async () => {
        throw new Error('publication unavailable')
      })
      const cyclesToRun = MARKET_FAILURE_BUDGET_CYCLES + 2
      const actions: unknown[] = []

      const report = await bootstrap.service.runContinuously({
        signal: controller.signal,
        intervalMs: 1,
        onCycle: results => {
          actions.push(results[0]?.status === 'failed' ? 'failed' : results[0]?.action)
          cycle += 1
          if (cycle === cyclesToRun) controller.abort()
        }
      })

      expect(report).toMatchObject({ status: 'stopped', reason: 'signal', cycles: cyclesToRun })
      expect(actions.slice(0, 2)).toEqual(['failed', 'no-capacity'])
    })

    test('still charges the failure budget for any other rejection', async () => {
      const bootstrap = setup()
      drained(bootstrap)
      bootstrap.make.reconcile = vi.fn(async () => {
        throw new BootstrapMempoolValidationError([{ rule: 'unknown' }])
      })

      const report = await bootstrap.service.runContinuously({
        signal: new AbortController().signal,
        intervalMs: 1
      })

      expect(report).toMatchObject({
        status: 'halted',
        reason: 'cycle-failed',
        cycles: MARKET_FAILURE_BUDGET_CYCLES
      })
    })
  })

  describe('when the hard range holds no aligned tick', () => {
    const activeOffer = {
      marketId,
      assets: 500n,
      rateBps: 450n,
      referenceObservationId: 'static:500'
    }
    const emptyWindowAt = (bootstrap: ReturnType<typeof setup>, withActiveOffer: boolean) => {
      bootstrap.positions.readPosition = vi.fn(async () => ({
        credit: 0n,
        debt: 0n,
        lossFactor: { lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true },
        cashBalance: 2_000n,
        marketExposure: 0n,
        totalExposure: 0n,
        rateWindowEmpty: true,
        activeOffer: withActiveOffer ? activeOffer : undefined
      }))
    }
    const runPastFailureBudget = async (bootstrap: ReturnType<typeof setup>) => {
      const controller = new AbortController()
      const cyclesToRun = MARKET_FAILURE_BUDGET_CYCLES + 2
      let cycles = 0
      return bootstrap.service.runContinuously({
        signal: controller.signal,
        intervalMs: 1,
        onCycle: () => {
          cycles += 1
          if (cycles === cyclesToRun) controller.abort()
        }
      })
    }

    test('invalidates the live buy at the snapshot as rate-out-of-range', async () => {
      const bootstrap = setup()
      emptyWindowAt(bootstrap, true)

      const [result] = await bootstrap.service.runOnce({ verbose: true })

      expect(result).toMatchObject({ marketId, status: 'applied', action: 'invalidate' })
      expect(bootstrap.reconcile).toHaveBeenCalledWith(
        expect.objectContaining({ desiredOffer: undefined, reason: 'rate-out-of-range' })
      )
      expect(bootstrap.hardHalt).not.toHaveBeenCalled()
      const events = bootstrapMonitoringEvents([result!])
      expect(events).toContainEqual({
        event: 'guardrail.side-withdrawn',
        workflow: 'bootstrap',
        marketId,
        side: 'higher'
      })
      expect(events.map(event => event.event)).not.toContain('guardrail.rate-omitted')
    })

    test('observes without mutating when no buy is resting', async () => {
      const bootstrap = setup()
      emptyWindowAt(bootstrap, false)

      expect(await bootstrap.service.runOnce()).toEqual([
        { marketId, status: 'observed', action: 'rate-out-of-range' }
      ])
      expect(bootstrap.reconcile).not.toHaveBeenCalled()
    })

    test('keeps monitoring past the failure budget while the snapshot window stays empty', async () => {
      const bootstrap = setup()
      emptyWindowAt(bootstrap, false)

      expect(await runPastFailureBudget(bootstrap)).toMatchObject({
        status: 'stopped',
        reason: 'signal',
        cycles: MARKET_FAILURE_BUDGET_CYCLES + 2
      })
    })

    const withheld = {
      marketId,
      status: 'applied',
      action: 'publication-withheld',
      reason: 'rate-out-of-range'
    }

    test('cancels instead of halting when the preview finds the window empty', async () => {
      const bootstrap = setup()
      bootstrap.make.preview = vi.fn(async () => {
        throw new BootstrapAdapterError('rate-window-empty')
      })
      const reconcile = vi.fn<BootstrapMakeService['reconcile']>(async () => ({
        submittedTransactions: [{ operation: 'cancel', txHash: cancellationHash }]
      }))
      bootstrap.make.reconcile = reconcile

      const [result] = await bootstrap.service.runOnce()

      expect(result).toEqual(withheld)
      expect(reconcile).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ desiredOffer: undefined, reason: 'rate-out-of-range' })
      )
      expect(bootstrap.hardHalt).not.toHaveBeenCalled()
      expect(bootstrapMonitoringEvents([result!])).toContainEqual({
        event: 'guardrail.publication-withheld',
        workflow: 'bootstrap',
        marketId,
        reason: 'rate-out-of-range'
      })
    })

    test('halts the whole plan when the cancellation after an empty window fails', async () => {
      const bootstrap = setup({ configs: [config(), config(secondMarketId)] })
      const reconcile = vi.fn<BootstrapMakeService['reconcile']>(async parameters => {
        if (parameters.marketId !== marketId) return undefined
        if (parameters.desiredOffer) throw new BootstrapAdapterError('rate-window-empty')
        throw new Error('cancel failed')
      })
      bootstrap.make.reconcile = reconcile

      const results = await bootstrap.service.runOnce()

      expect(results).toHaveLength(1)
      expect(reconcile).not.toHaveBeenCalledWith(
        expect.objectContaining({ marketId: secondMarketId })
      )
      expect(results[0]).toMatchObject({
        marketId,
        status: 'halted',
        stage: 'make',
        action: 'invalidate',
        reason: 'rate-out-of-range'
      })
      expect(bootstrap.hardHalt).toHaveBeenCalledOnce()
    })

    test('withholds without charging the failure budget when the window empties at reconcile', async () => {
      const bootstrap = setup()
      bootstrap.make.reconcile = vi.fn<BootstrapMakeService['reconcile']>(async parameters => {
        if (parameters.desiredOffer) throw new BootstrapAdapterError('rate-window-empty')
        return { submittedTransactions: [{ operation: 'cancel', txHash: cancellationHash }] }
      })

      expect(await bootstrap.service.runOnce()).toEqual([withheld])
      expect(await runPastFailureBudget(bootstrap)).toMatchObject({
        status: 'stopped',
        reason: 'signal'
      })
    })
  })

  test('resumes after initial completion when auto-refill is enabled', async () => {
    const { service, positions, reconcile } = setup({ configs: [config(marketId, true)] })
    let cycle = 0
    positions.readPosition = vi.fn(async () => {
      cycle += 1
      return {
        credit: cycle === 1 ? 900n : 500n,
        debt: 0n,
        lossFactor: { lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true },
        cashBalance: 2_000n,
        marketExposure: 0n,
        totalExposure: 0n,
        activeOffer: undefined
      }
    })

    expect(await service.runOnce()).toEqual([
      { marketId, status: 'observed', action: 'target-reached' }
    ])
    expect(await service.runOnce()).toEqual([{ marketId, status: 'applied', action: 'publish' }])
    expect(reconcile).toHaveBeenCalledTimes(1)
  })
  test('observes a matured market as matured and keeps bootstrapping every other market', async () => {
    const { service, positions, readRate, reconcile } = setup({
      configs: [config(), config(secondMarketId)]
    })
    positions.readPosition = vi.fn(async id => ({
      credit: 0n,
      debt: 0n,
      lossFactor: { lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true },
      cashBalance: 2_000n,
      marketExposure: 0n,
      totalExposure: 0n,
      activeOffer: undefined,
      ...(id === marketId
        ? { maturityTimestamp: 1_000n, observedTimestamp: 1_000n }
        : { maturityTimestamp: 2_000n, observedTimestamp: 1_000n })
    }))

    expect(await service.runOnce()).toEqual([
      { marketId, status: 'observed', action: 'matured' },
      { marketId: secondMarketId, status: 'applied', action: 'publish' }
    ])
    expect(readRate).toHaveBeenCalledTimes(1)
    expect(readRate).toHaveBeenCalledWith(secondMarketId)
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ marketId: secondMarketId }))
  })

  test('keeps monitoring later cycles when a configured market has matured', async () => {
    const controller = new AbortController()
    const { service, positions } = setup()
    positions.readPosition = vi.fn(async () => ({
      credit: 0n,
      debt: 0n,
      lossFactor: { lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true },
      cashBalance: 2_000n,
      marketExposure: 0n,
      totalExposure: 0n,
      activeOffer: undefined,
      maturityTimestamp: 1_000n,
      observedTimestamp: 1_500n
    }))
    const cycles: Record<string, unknown>[][] = []

    const report = await service.runContinuously({
      signal: controller.signal,
      intervalMs: 1,
      onCycle: results => {
        cycles.push([...results])
        if (cycles.length === 2) controller.abort()
      }
    })

    expect(report).toMatchObject({ status: 'stopped', reason: 'signal', cycles: 2 })
    expect(cycles).toEqual([
      [{ marketId, status: 'observed', action: 'matured' }],
      [{ marketId, status: 'observed', action: 'matured' }]
    ])
  })
})

describe('PositionBootstrapService withheld publications', () => {
  const cancellation = { operation: 'cancel' as const, txHash: cancellationHash }

  test('reports a capacity-changed withholding as applied without completing the market', async () => {
    const { service, make } = setup()
    const reconcile = vi.fn<BootstrapMakeService['reconcile']>(async () => ({
      submittedTransactions: [cancellation],
      publicationWithheld: { reason: 'capacity-changed' }
    }))
    make.reconcile = reconcile

    const [first] = await service.runOnce({ verbose: true })
    const [second] = await service.runOnce({ verbose: true })

    expect(first).toMatchObject({
      marketId,
      status: 'applied',
      action: 'publication-withheld',
      reason: 'capacity-changed'
    })
    expect(first?.verbose?.submittedTransactions).toEqual([cancellation])
    expect(bootstrapMonitoringEvents([first!])).toContainEqual({
      event: 'guardrail.publication-withheld',
      workflow: 'bootstrap',
      marketId,
      reason: 'capacity-changed'
    })
    expect(second?.verbose?.currentState).toMatchObject({
      position: { initialTargetCompleted: false }
    })
    expect(reconcile).toHaveBeenCalledTimes(2)
  })

  test('reports a loss-factor withholding as applied with its direction', async () => {
    const { service, make } = setup()
    make.reconcile = async () => ({
      submittedTransactions: [cancellation],
      publicationWithheld: {
        reason: 'loss-factor-mismatch',
        lossFactor: 6n,
        acceptedLossFactor: 5n,
        defaulted: false,
        direction: 'above'
      }
    })

    const [result] = await service.runOnce()

    expect(result).toEqual({
      marketId,
      status: 'applied',
      action: 'publication-withheld',
      reason: 'loss-factor-mismatch',
      lossFactor: 6n,
      acceptedLossFactor: 5n,
      defaulted: false,
      direction: 'above'
    })
    const events = createMonitoringProjection().bootstrap([result!])
    expect(events).toContainEqual({
      event: 'guardrail.publication-withheld',
      workflow: 'bootstrap',
      marketId,
      reason: 'loss-factor-mismatch'
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'guardrail.lend-halted',
        workflow: 'bootstrap',
        lossFactor: 6n,
        acceptedLossFactor: 5n,
        direction: 'above'
      })
    )
  })

  test('reports an unavailable snapshot after cancelling as a failed invalidated make', async () => {
    const { service, make } = setup({
      configs: [config(), config(secondMarketId)]
    })
    const reconcile = vi.fn<BootstrapMakeService['reconcile']>(async () => ({
      submittedTransactions: [cancellation],
      publicationWithheld: { reason: 'snapshot-unavailable', errorName: 'BootstrapAdapterError' }
    }))
    make.reconcile = reconcile

    const results = await service.runOnce()

    expect(results).toEqual([
      {
        marketId,
        status: 'failed',
        stage: 'make',
        invalidated: true,
        errorName: 'BootstrapAdapterError',
        adapterOperation: 'snapshot-unavailable'
      }
    ])
    expect(reconcile).toHaveBeenCalledTimes(1)
  })

  test('reports an unavailable snapshot without cancellations as not invalidated', async () => {
    const { service, make } = setup()
    const reconcile = vi.fn<BootstrapMakeService['reconcile']>(async () => ({
      submittedTransactions: [],
      publicationWithheld: { reason: 'snapshot-unavailable', errorName: 'RpcRequestError' }
    }))
    make.reconcile = reconcile

    const [result] = await service.runOnce()

    expect(result).toMatchObject({ status: 'failed', stage: 'make', invalidated: false })
  })

  test('reports a failed release of a withheld reservation with its cancellations', async () => {
    const { service, make } = setup()
    make.reconcile = vi.fn(async () => {
      throw new BootstrapAdapterError('publication-reservation-cleanup')
        .recordReservationCleanupFailure('TypeError')
        .recordConfirmedTransactions([cancellation])
    })

    const [result] = await service.runOnce({ verbose: true })

    expect(result).toMatchObject({
      status: 'failed',
      stage: 'make',
      invalidated: true,
      errorName: 'BootstrapAdapterError',
      adapterOperation: 'publication-reservation-cleanup',
      reservationCleanupErrorName: 'TypeError'
    })
    expect(result?.verbose?.submittedTransactions).toEqual([cancellation])
  })
})

describe('PositionBootstrapService loss factor', () => {
  const activeOffer = {
    marketId,
    assets: 100n,
    rateBps: 450n,
    referenceObservationId: 'static:500'
  }
  const halted = { lossFactor: 6n, acceptedLossFactor: 5n, defaulted: false }
  const position = (
    parameters: { lossFactor?: typeof halted; credit?: bigint; withOffer?: boolean } = {}
  ) => ({
    credit: parameters.credit ?? 0n,
    debt: 0n,
    lossFactor: parameters.lossFactor ?? halted,
    cashBalance: 2_000n,
    marketExposure: 0n,
    totalExposure: 0n,
    ...(parameters.withOffer === false ? {} : { activeOffer })
  })

  test('cancels the active buy before any rate read and reports it applied', async () => {
    const { service, positions, readRate, make } = setup()
    positions.readPosition = vi.fn(async () => position())
    const reconcile = vi.fn<BootstrapMakeService['reconcile']>(async () => ({
      submittedTransactions: [{ operation: 'cancel', txHash: cancellationHash }]
    }))
    make.reconcile = reconcile

    const results = await service.runOnce()

    expect(results).toEqual([
      {
        marketId,
        status: 'applied',
        action: 'lend-halted',
        reason: 'loss-factor-mismatch',
        ...halted,
        direction: 'above'
      }
    ])
    expect(reconcile.mock.calls[0]?.[0]).toMatchObject({
      marketId,
      desiredOffer: undefined,
      reason: 'loss-factor-mismatch'
    })
    expect(readRate).not.toHaveBeenCalled()
  })

  test('observes a halted market without a live buy and mutates nothing', async () => {
    const { service, positions, readRate, reconcile } = setup()
    positions.readPosition = vi.fn(async () =>
      position({ withOffer: false, lossFactor: { ...halted, lossFactor: 4n } })
    )

    expect(await service.runOnce()).toEqual([
      {
        marketId,
        status: 'observed',
        action: 'lend-halted',
        reason: 'loss-factor-mismatch',
        ...halted,
        lossFactor: 4n,
        direction: 'below'
      }
    ])
    expect(reconcile).not.toHaveBeenCalled()
    expect(readRate).not.toHaveBeenCalled()
  })

  test('logs rather than applies the cancellation in read-only mode', async () => {
    const { service, positions, make } = setup()
    positions.readPosition = vi.fn(async () => position())
    make.reconcile = vi.fn(async () => 'logged' as const)

    expect(await service.runOnce()).toMatchObject([{ status: 'logged', action: 'lend-halted' }])
  })

  test('never completes the initial target while halted', async () => {
    const { service, positions, make } = setup()
    const reads = [
      position({ credit: 1_000n }),
      position({ withOffer: false, lossFactor: { ...halted, lossFactor: 5n } })
    ]
    positions.readPosition = vi.fn(async () => reads.shift()!)
    make.reconcile = vi.fn(async () => ({ submittedTransactions: [] }))

    await service.runOnce()
    const [second] = await service.runOnce()

    expect(second).toMatchObject({ status: 'applied', action: 'publish' })
  })

  test('hard-halts when the targeted cancellation fails', async () => {
    const { service, positions, make, hardHalt } = setup()
    positions.readPosition = vi.fn(async () => position())
    make.reconcile = vi.fn(async () => {
      throw new BootstrapAdapterError('transaction-reverted')
    })

    const results = await service.runOnce()

    expect(results).toMatchObject([
      {
        status: 'halted',
        stage: 'make',
        action: 'invalidate',
        reason: 'loss-factor-mismatch',
        strategyInvalidated: true,
        ...halted,
        direction: 'above'
      }
    ])
    expect(hardHalt).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'market-invalidation-failed' })
    )
    expect(createMonitoringProjection().bootstrap(results)).toContainEqual({
      event: 'guardrail.lend-halted',
      workflow: 'bootstrap',
      marketId,
      lossFactor: 6n,
      acceptedLossFactor: 5n,
      defaulted: false,
      direction: 'above',
      incrementalLossBps: 1n
    })
  })

  test('keeps the halt evidence when a confirmed cancellation cannot be forgotten', async () => {
    const { service, positions, make, hardHalt } = setup()
    positions.readPosition = vi.fn(async () => position())
    make.reconcile = vi.fn(async () => {
      throw new BootstrapOwnershipCleanupError(
        `0x${'dd'.repeat(32)}`,
        [{ operation: 'cancel', txHash: cancellationHash }],
        'TypeError'
      )
    })

    const results = await service.runOnce()

    expect(results).toMatchObject([
      {
        status: 'failed',
        stage: 'make',
        invalidated: true,
        ownershipCleanupErrorName: 'TypeError',
        ...halted,
        direction: 'above'
      }
    ])
    expect(hardHalt).not.toHaveBeenCalled()
    expect(createMonitoringProjection().bootstrap(results)).toContainEqual({
      event: 'guardrail.lend-halted',
      workflow: 'bootstrap',
      marketId,
      lossFactor: 6n,
      acceptedLossFactor: 5n,
      defaulted: false,
      direction: 'above',
      incrementalLossBps: 1n
    })
  })

  test('names the cause of a position-read failure so a blocked cutover is diagnosable', async () => {
    const { service, positions, make } = setup()
    positions.readPosition = vi.fn(async () => {
      throw new BootstrapAdapterError('cash-capped-buy-group')
    })
    make.reconcile = vi.fn<BootstrapMakeService['reconcile']>(async () => undefined)

    expect(await service.runOnce()).toMatchObject([
      { status: 'failed', stage: 'position-read', adapterOperation: 'cash-capped-buy-group' }
    ])
  })

  test.each([
    ['writer', undefined, { invalidated: true }],
    ['read-only', 'logged' as const, { invalidated: false, invalidationLogged: true }]
  ])(
    'cancels buys and fails retryably on a malformed loss factor in %s mode',
    async (_mode, reconciliation, invalidation) => {
      const { service, positions, make } = setup()
      positions.readPosition = vi.fn(async () => {
        throw new BootstrapAdapterError('loss-factor-read')
      })
      const reconcile = vi.fn<BootstrapMakeService['reconcile']>(async () => reconciliation)
      make.reconcile = reconcile

      expect(await service.runOnce()).toEqual([
        {
          marketId,
          status: 'failed',
          stage: 'guard-read',
          ...invalidation,
          errorName: 'BootstrapAdapterError',
          adapterOperation: 'loss-factor-read'
        }
      ])
      expect(reconcile.mock.calls[0]?.[0]).toMatchObject({ reason: 'market-read-failed' })
    }
  )

  test.each([
    ['before', [marketId, secondMarketId]],
    ['after', [secondMarketId, marketId]]
  ] as const)(
    'invalidates a halted buy even when a market %s it fails to publish',
    async (_order, order) => {
      const { service, positions, make } = setup({ configs: order.map(id => config(id)) })
      positions.readPosition = vi.fn(async (id: Hex) =>
        id === secondMarketId
          ? position()
          : position({ lossFactor: { ...halted, lossFactor: 5n }, withOffer: false })
      )
      const reasons: string[] = []
      make.reconcile = vi.fn<BootstrapMakeService['reconcile']>(async parameters => {
        reasons.push(`${parameters.marketId}:${parameters.reason}`)
        if (parameters.reason === 'publish') throw new BootstrapAdapterError('transaction-reverted')
        return { submittedTransactions: [{ operation: 'cancel', txHash: cancellationHash }] }
      })

      const results = await service.runOnce()

      expect(reasons).toEqual([`${secondMarketId}:loss-factor-mismatch`, `${marketId}:publish`])
      expect(results.map(result => [result.marketId, result.status])).toEqual(
        order.map(id => [id, id === secondMarketId ? 'applied' : 'failed'])
      )
    }
  )

  test('clears a pending publication failure once the market is safely lend-halted', async () => {
    const controller = new AbortController()
    const { service, positions, make } = setup()
    let cycle = 0
    positions.readPosition = vi.fn(async () =>
      cycle < MARKET_FAILURE_BUDGET_CYCLES - 1
        ? position({ lossFactor: { ...halted, lossFactor: 5n }, withOffer: false })
        : position({ withOffer: false })
    )
    make.reconcile = vi.fn(async () => {
      throw new Error('publication unavailable')
    })
    make.cleanup = vi.fn(async () => 'logged' as const)

    const report = await service.runContinuously({
      signal: controller.signal,
      intervalMs: 1,
      onCycle: () => {
        cycle += 1
        if (cycle === MARKET_FAILURE_BUDGET_CYCLES + 2) controller.abort()
      }
    })

    expect(report).toMatchObject({ status: 'stopped', cycles: MARKET_FAILURE_BUDGET_CYCLES + 2 })
  })
})
