import type { Hex } from 'viem'

import { describe, expect, mock, test } from 'bun:test'

import type {
  BootstrapMakeService,
  BootstrapPositionService,
  BootstrapReferenceRateService
} from '../../../src/application/bootstrap/position-bootstrap.service'
import type { BootstrapConfig } from '../../../src/domain/bootstrap/position-bootstrap'

import { PositionBootstrapService } from '../../../src/application/bootstrap/position-bootstrap.service'
import { BootstrapConfigurationError } from '../../../src/domain/bootstrap/bootstrap-configuration.error'
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
  const readPosition = mock(async () => ({
    credit,
    debt: 0n,
    cashBalance: 2_000n,
    marketExposure: 0n,
    totalExposure: 0n,
    activeOffer: undefined
  }))
  const readRate = mock(async () => ({
    mode: 'static' as const,
    rateBps: 500n,
    observationId: 'static:500'
  }))
  const reconcile = mock(async () => undefined)
  const hardHalt = mock(async () => undefined)
  const cleanup = mock(async () => undefined)
  const positions: BootstrapPositionService = { readPosition }
  const rates: BootstrapReferenceRateService = { readRate }
  const make: BootstrapMakeService = { reconcile, hardHalt, cleanup }
  const service = new PositionBootstrapService(positions, rates, make, configs)

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
  test('monitors sequential cycles and cleans owned groups after shutdown', async () => {
    const events: string[] = []
    const controller = new AbortController()
    const { service, make } = setup()
    make.reconcile = mock(async () => {
      events.push('reconcile')
    })
    const cleanup = mock(async () => {
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

  test('stops monitoring on a handled failed cycle and still cleans owned groups', async () => {
    const controller = new AbortController()
    const { service, make } = setup()
    make.reconcile = mock(async () => {
      throw new Error('publication unavailable')
    })
    const cleanup = mock(async () => 'logged' as const)
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
      lastCycle: [{ status: 'failed', stage: 'make', errorName: 'UnknownError' }]
    })
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  test('reports a sanitized cleanup failure after a stop signal', async () => {
    const controller = new AbortController()
    const { service, make } = setup()
    make.cleanup = mock(async () => {
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

  test('preflights a positive premium before a target-reached position or reference read', async () => {
    const { service, readPosition, readRate, reconcile, hardHalt } = setup({
      configs: [{ ...config(), premiumBps: 1n }],
      credit: 900n
    })

    expect(await service.runOnce()).toEqual([
      {
        marketId,
        status: 'halted',
        stage: 'configuration',
        strategyInvalidated: true,
        errorName: 'BootstrapConfigurationError'
      }
    ])
    expect(hardHalt).toHaveBeenCalledWith({ reason: 'bootstrap-configuration-failed' })
    expect(readPosition).not.toHaveBeenCalled()
    expect(readRate).not.toHaveBeenCalled()
    expect(reconcile).not.toHaveBeenCalled()
  })

  test('preflights a positive premium after auto-refill false completion', async () => {
    const mutableConfig = config()
    const { service, readPosition, readRate, reconcile, hardHalt } = setup({
      configs: [mutableConfig],
      credit: 900n
    })
    expect(await service.runOnce()).toEqual([
      { marketId, status: 'observed', action: 'target-reached' }
    ])
    mutableConfig.premiumBps = 1n
    readPosition.mockClear()

    expect(await service.runOnce()).toEqual([
      {
        marketId,
        status: 'halted',
        stage: 'configuration',
        strategyInvalidated: true,
        errorName: 'BootstrapConfigurationError'
      }
    ])
    expect(hardHalt).toHaveBeenCalledWith({ reason: 'bootstrap-configuration-failed' })
    expect(readPosition).not.toHaveBeenCalled()
    expect(readRate).not.toHaveBeenCalled()
    expect(reconcile).not.toHaveBeenCalled()
  })

  test('preflights every market before an earlier valid market can publish', async () => {
    const { service, readPosition, readRate, reconcile, hardHalt } = setup({
      configs: [config(), { ...config(secondMarketId), offerSize: 0n }]
    })

    expect(await service.runOnce()).toEqual([
      {
        marketId: secondMarketId,
        status: 'halted',
        stage: 'configuration',
        strategyInvalidated: true,
        errorName: 'BootstrapConfigurationError'
      }
    ])
    expect(hardHalt).toHaveBeenCalledWith({ reason: 'bootstrap-configuration-failed' })
    expect(readPosition).not.toHaveBeenCalled()
    expect(readRate).not.toHaveBeenCalled()
    expect(reconcile).not.toHaveBeenCalled()
  })

  test('preserves configuration and cleanup failure evidence during preflight', async () => {
    const { service, make, readPosition, readRate, reconcile } = setup({
      configs: [{ ...config(), maximumTotalExposure: 0n }]
    })
    const hardHalt = mock(async () => {
      throw new RangeError('cleanup reverted')
    })
    make.hardHalt = hardHalt

    expect(await service.runOnce()).toEqual([
      {
        marketId,
        status: 'halted',
        stage: 'configuration',
        strategyInvalidated: false,
        errorName: 'BootstrapConfigurationError',
        invalidationErrorName: 'RangeError'
      }
    ])
    expect(hardHalt).toHaveBeenCalledWith({ reason: 'bootstrap-configuration-failed' })
    expect(readPosition).not.toHaveBeenCalled()
    expect(readRate).not.toHaveBeenCalled()
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
    const readPosition = mock(async () => {
      read += 1
      return {
        credit: read === 1 ? 0n : 100n,
        debt: 25n,
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
    make.reconcile = mock(async parameters => {
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
          submittedTransactions: [{ operation: 'publish', txHash: publicationHash }],
          stateAfterCheck: {
            status: 'observed',
            position: {
              credit: 100n,
              debt: 25n,
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
    make.reconcile = mock(async () => {
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
    make.reconcile = mock(async () => 'unchanged' as const)

    const result = await service.runOnce()

    expect(result).toEqual([{ marketId, status: 'observed', action: 'rest' }])
  })

  test('keeps an applied result when only its verbose after-state read fails', async () => {
    const { service, positions } = setup()
    let read = 0
    positions.readPosition = mock(async () => {
      read += 1
      if (read === 2) throw new TypeError('after-state provider unavailable')
      return {
        credit: 0n,
        debt: 0n,
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
    make.cleanup = mock(async parameters => {
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
    const preview = mock(async parameters =>
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

  test('reserves only the net replacement delta before deciding a later market', async () => {
    const capped = {
      ...config(),
      maximumMarketExposure: 600n,
      maximumTotalExposure: 600n
    }
    const { service, positions, reconcile } = setup({
      configs: [capped, { ...capped, marketId: secondMarketId }]
    })
    positions.readPosition = mock(async id => ({
      credit: 0n,
      debt: 0n,
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
    positions.readPosition = mock(async id => ({
      credit: id === marketId ? 900n : 0n,
      debt: 0n,
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
    positions.readPosition = mock(async () => {
      cycle += 1
      return {
        credit: cycle === 1 ? 900n : 500n,
        debt: 0n,
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
      positions.readPosition = mock(async id => {
        if (preparingCompletion) {
          return {
            credit: 900n,
            debt: 0n,
            cashBalance: 2_000n,
            marketExposure: 0n,
            totalExposure: 0n,
            activeOffer: undefined
          }
        }
        return {
          credit: id === marketId ? position.credit : 0n,
          debt: 0n,
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
      const failedReconcile = mock(async request => {
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
    positions.readPosition = mock(async id => ({
      credit: id === marketId ? 900n : 0n,
      debt: 0n,
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
    const failedReconcile = mock(async request => {
      if (request.marketId === marketId) {
        const hostileInvalidation = new Error('market invalidation reverted')
        hostileInvalidation.name = 'https://invalidator.example/?token=secret-invalidation'
        throw hostileInvalidation
      }
    })
    make.reconcile = failedReconcile
    const hardHalt = mock(async () => {
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
    positions.readPosition = mock(async id => ({
      credit: id === marketId ? 900n : 0n,
      debt: 0n,
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
    positions.readPosition = mock(async id => {
      if (id === marketId) throw new Error('provider unavailable')
      return {
        credit: 0n,
        debt: 0n,
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
    positions.readPosition = mock(async () => {
      throw new TypeError('position unavailable')
    })
    make.reconcile = mock(async () => {
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
    positions.readPosition = mock(async id => {
      if (id === marketId) throw new TypeError('position unavailable')
      return {
        credit: 0n,
        debt: 0n,
        cashBalance: 2_000n,
        marketExposure: 0n,
        totalExposure: 0n,
        activeOffer: undefined
      }
    })
    const failedReconcile = mock(async request => {
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
    positions.readPosition = mock(async () => {
      throw new TypeError('position unavailable')
    })
    make.reconcile = mock(async () => {
      throw new RangeError('invalidation reverted')
    })
    make.hardHalt = mock(async () => {
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
    positions.readPosition = mock(async () => {
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
    'hard-halts an out-of-bounds rate with zero capacity (%s BPS)',
    async rateBps => {
      const { service, positions, rates, reconcile, hardHalt } = setup()
      positions.readPosition = mock(async () => ({
        credit: 0n,
        debt: 0n,
        cashBalance: 0n,
        marketExposure: 0n,
        totalExposure: 0n,
        activeOffer: undefined
      }))
      rates.readRate = mock(async () => ({
        mode: 'static' as const,
        rateBps,
        observationId: `static:${rateBps}`
      }))

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
    }
  )

  test('halts the strategy on a reference failure and prevents later market publication', async () => {
    const { service, rates, reconcile, hardHalt } = setup({
      configs: [config(), config(secondMarketId)]
    })
    rates.readRate = mock(async () => {
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
    rates.readRate = mock(async id => {
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
    rates.readRate = mock(async () => {
      throw new TypeError('stale reference')
    })
    make.hardHalt = mock(async () => {
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

  test('halts and invalidates the strategy when the bootstrap decision rejects active offers', async () => {
    const { service, positions, rates, hardHalt } = setup()
    positions.readPosition = mock(async () => ({
      credit: 0n,
      debt: 0n,
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
    rates.readRate = mock(async () => ({
      mode: 'static' as const,
      rateBps: 100n,
      observationId: 'static:100'
    }))

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
  })

  test('preflights a negative acceptance threshold before reading a live offer', async () => {
    const { service, positions, readRate, reconcile, hardHalt } = setup({
      configs: [{ ...config(), acceptanceAssets: -1n }, config(secondMarketId)]
    })
    const readPosition = mock(async (id: Hex) => ({
      credit: 0n,
      debt: 0n,
      cashBalance: 2_000n,
      marketExposure: 0n,
      totalExposure: 0n,
      activeOffer: {
        marketId: id,
        assets: 500n,
        rateBps: 450n,
        referenceObservationId: 'static:500'
      }
    }))
    positions.readPosition = readPosition

    expect(await service.runOnce()).toEqual([
      {
        marketId,
        status: 'halted',
        stage: 'configuration',
        strategyInvalidated: true,
        errorName: 'BootstrapConfigurationError'
      }
    ])
    expect(hardHalt).toHaveBeenCalledTimes(1)
    expect(hardHalt).toHaveBeenCalledWith({ reason: 'bootstrap-configuration-failed' })
    expect(readPosition).not.toHaveBeenCalled()
    expect(readRate).not.toHaveBeenCalled()
    expect(reconcile).not.toHaveBeenCalled()
  })

  test('preserves cleanup evidence when an excessive acceptance threshold fails preflight', async () => {
    const { service, positions, make, readRate, reconcile } = setup({
      configs: [{ ...config(), acceptanceAssets: 1_001n }, config(secondMarketId)]
    })
    const readPosition = mock(async (id: Hex) => ({
      credit: 0n,
      debt: 0n,
      cashBalance: 2_000n,
      marketExposure: 0n,
      totalExposure: 0n,
      activeOffer: {
        marketId: id,
        assets: 500n,
        rateBps: 450n,
        referenceObservationId: 'static:500'
      }
    }))
    positions.readPosition = readPosition
    const hardHalt = mock(async () => {
      throw new RangeError('cleanup reverted')
    })
    make.hardHalt = hardHalt

    expect(await service.runOnce()).toEqual([
      {
        marketId,
        status: 'halted',
        stage: 'configuration',
        strategyInvalidated: false,
        errorName: 'BootstrapConfigurationError',
        invalidationErrorName: 'RangeError'
      }
    ])
    expect(hardHalt).toHaveBeenCalledTimes(1)
    expect(hardHalt).toHaveBeenCalledWith({ reason: 'bootstrap-configuration-failed' })
    expect(readPosition).not.toHaveBeenCalled()
    expect(readRate).not.toHaveBeenCalled()
    expect(reconcile).not.toHaveBeenCalled()
  })

  test('completes before a failed reference read and stays stopped with auto-refill disabled', async () => {
    const { service, positions, rates, reconcile } = setup()
    let cycle = 0
    positions.readPosition = mock(async () => {
      cycle += 1
      return {
        credit: cycle === 1 ? 900n : 500n,
        debt: 0n,
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
    const failedReadRate = mock(async () => {
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
    const failedReconcile = mock(async request => {
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
    make.reconcile = mock(async () => {
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

  test('resumes after initial completion when auto-refill is enabled', async () => {
    const { service, positions, reconcile } = setup({ configs: [config(marketId, true)] })
    let cycle = 0
    positions.readPosition = mock(async () => {
      cycle += 1
      return {
        credit: cycle === 1 ? 900n : 500n,
        debt: 0n,
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
})
