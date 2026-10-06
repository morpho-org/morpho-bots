import type { Hex } from 'viem'

import { TakeAmountsLib, TickLib } from '@morpho-org/midnight-sdk'
import { describe, expect, expectTypeOf, test, vi } from 'vitest'

import type {
  LadderMakeService,
  LadderPositionService
} from '../../../src/application/ladder/ladder-quoter.service'
import type { LadderMakeResult } from '../../../src/application/ladder/ladder-verbose'
import type {
  LadderBookSideCrossing,
  LadderConfig,
  LadderMarketState,
  LadderQuoteSet,
  ValidLadderConfig
} from '../../../src/domain/ladder'
import type { LossFactorObservation } from '../../../src/domain/loss-factor'

import { LadderOwnershipCleanupError } from '../../../src/application/ladder/ladder-ownership-cleanup.error'
import { LadderQuoterService } from '../../../src/application/ladder/ladder-quoter.service'
import { ladderMonitoringEvents } from '../../../src/application/monitoring/ladder-monitoring.utils'
import { createMonitoringProjection } from '../../../src/application/monitoring/monitoring-projection.utils'
import { generateLadder, validateLadderConfig } from '../../../src/domain/ladder'
import { MARKET_FAILURE_BUDGET_CYCLES } from '../../../src/domain/market-failure-budget'
import { alignedRateTick } from '../../../src/domain/tick-window'
import { LadderAdapterError } from '../../../src/infrastructure/ladder/ladder-adapter.error'
import { calculateLadderCapacities } from '../../../src/infrastructure/ladder/ladder-capacity.utils'
import { ReferenceAdapterError } from '../../../src/infrastructure/reference/reference-adapter.error'

const marketId: Hex = `0x${'55'.repeat(32)}`
const secondMarketId: Hex = `0x${'66'.repeat(32)}`
const ratificationHash: Hex = `0x${'dd'.repeat(32)}`
const config = (id = marketId): LadderConfig => ({
  marketId: id,
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
  minimumRateBps: 0n,
  maximumRateBps: 1_000n
})

const state = (capacity = 20n): LadderMarketState => ({
  lowerRateCapacityAssets: capacity,
  higherRateCapacityAssets: capacity,
  targetMarketCapacityAssets: capacity,
  maximumTotalCapacityAssets: capacity
})

const harness = (configs: readonly LadderConfig[] = [config()]) => {
  let rate = 500n
  let observationId = 'static:500:hour:1'
  let maturitySeconds: bigint | undefined
  let marketState = state()
  let readFailure: Hex | undefined
  const maturedMarkets = new Set<Hex>()
  let reconcileFailure: Hex | undefined
  let reconcileResult: LadderMakeResult
  const reads: string[] = []
  const reconciliations: Parameters<LadderMakeService['reconcile']>[0][] = []
  const liveDesired = new Map<Hex, LadderQuoteSet>()
  const halts: string[] = []
  const lossFactors = new Map<Hex, LossFactorObservation>()
  let guardFailure: Hex | undefined
  let cancelBuysFailure: Error | undefined
  let cancelBuysResult: LadderMakeResult = { submittedTransactions: [] }
  const buyCancellations: Parameters<LadderMakeService['cancelBuys']>[0][] = []
  const positions: LadderPositionService = {
    async readLendGuard(id) {
      reads.push(`guard:${id}`)
      if (id === guardFailure) throw new LadderAdapterError('loss-factor-read')
      return lossFactors.get(id) ?? { lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true }
    },
    async readMarket(id) {
      reads.push(`market:${id}`)
      if (id === readFailure) throw new TypeError('private provider detail')
      return maturedMarkets.has(id)
        ? { ...marketState, maturityTimestamp: 1_000n, observedTimestamp: 1_000n }
        : marketState
    }
  }
  const rates = {
    async readRate(id: Hex) {
      reads.push(`rate:${id}`)
      return rate
    },
    async readObservation(id: Hex) {
      reads.push(`observation:${id}`)
      return {
        rateBps: rate,
        observationId,
        ...(maturitySeconds === undefined ? {} : { secondsToMaturity: maturitySeconds })
      }
    }
  }
  const cleanupRemovedMarkets = vi.fn(async () => {})
  const cleanup = vi.fn(async () => {
    liveDesired.clear()
  })
  const make: LadderMakeService = {
    cleanupRemovedMarkets,
    async readActive(id) {
      reads.push(`active:${id}`)
      return liveDesired.get(id)
    },
    async reconcile(parameters) {
      if (parameters.marketId === reconcileFailure)
        throw new RangeError('private publication detail')
      reconciliations.push(parameters)
      if (parameters.desired) liveDesired.set(parameters.marketId, parameters.desired)
      else liveDesired.delete(parameters.marketId)
      return parameters.reason === 'rest' ? undefined : reconcileResult
    },
    async cancelBuys(parameters) {
      buyCancellations.push(parameters)
      if (cancelBuysFailure) throw cancelBuysFailure
      return cancelBuysResult
    },
    async hardHalt(parameters) {
      halts.push(parameters.reason)
    },
    cleanup
  }
  const validConfigs = configs.map(entry => validateLadderConfig(entry))
  let service = new LadderQuoterService(positions, rates, make, validConfigs)
  return {
    get service() {
      return service
    },
    set service(value) {
      service = value
    },
    reads,
    reconciliations,
    liveDesired,
    halts,
    buyCancellations,
    cleanupRemovedMarkets,
    cleanup,
    make,
    setRate: (value: bigint) => (rate = value),
    setObservation: (value: string) => (observationId = value),
    setMaturity: (value: bigint | undefined) => (maturitySeconds = value),
    setCapacity: (value: bigint) => (marketState = state(value)),
    failMarket: (id: Hex) => (readFailure = id),
    matureMarket: (id: Hex) => maturedMarkets.add(id),
    failReconcile: (id: Hex | undefined) => (reconcileFailure = id),
    setReconcileResult: (value: LadderMakeResult) => (reconcileResult = value),
    setMarketState: (value: LadderMarketState) => (marketState = value),
    expireRoots: (id: Hex) => liveDesired.delete(id),
    setLossFactor: (id: Hex, value: LossFactorObservation) => lossFactors.set(id, value),
    failGuard: (id: Hex | undefined) => (guardFailure = id),
    failCancelBuys: (error: Error | undefined) => (cancelBuysFailure = error),
    setCancelBuysResult: (value: LadderMakeResult) => (cancelBuysResult = value),
    recreateService: () => (service = new LadderQuoterService(positions, rates, make, validConfigs))
  }
}

describe('LadderQuoterService', () => {
  test('is constructed only from validated configs', () => {
    expectTypeOf<ConstructorParameters<typeof LadderQuoterService>[3]>().toEqualTypeOf<
      readonly ValidLadderConfig[]
    >()
  })

  test('rejects an empty strategy before cleaning removed markets', async () => {
    const subject = harness([])

    await expect(subject.service.runOnce()).rejects.toMatchObject({
      name: 'LadderConfigurationError',
      field: 'ladder'
    })

    expect(subject.cleanupRemovedMarkets).not.toHaveBeenCalled()
  })

  test('reads the lend guard, then active ownership, before position capacity', async () => {
    const subject = harness()

    await subject.service.runOnce()

    expect(subject.reads.slice(0, 3)).toEqual([
      `guard:${marketId}`,
      `active:${marketId}`,
      `market:${marketId}`
    ])
  })

  test('runs removed-market cleanup inside the monitor operation queue', async () => {
    const subject = harness()
    const controller = new AbortController()
    let insideQueue = false
    subject.make.cleanupRemovedMarkets = vi.fn(async () => {
      expect(insideQueue).toBe(true)
    })

    await subject.service.runContinuously({
      signal: controller.signal,
      intervalMs: 1,
      runOperation: async operation => {
        insideQueue = true
        try {
          return await operation()
        } finally {
          insideQueue = false
        }
      },
      onCycle: () => controller.abort()
    })
  })

  test('monitors sequential cycles and cleans owned groups after shutdown', async () => {
    const subject = harness([{ ...config(), loopIntervalSeconds: 1 }])
    const controller = new AbortController()
    const cycles: unknown[] = []
    const operations: string[] = []

    const report = await subject.service.runContinuously({
      signal: controller.signal,
      intervalMs: 1,
      runOperation: async operation => {
        operations.push('start')
        const result = await operation()
        operations.push('end')
        return result
      },
      onCycle: results => {
        cycles.push(results)
        if (cycles.length === 2) controller.abort()
      }
    })

    expect(report).toEqual({
      status: 'stopped',
      reason: 'signal',
      cycles: 2,
      cleanup: { status: 'applied' }
    })
    expect(cycles).toHaveLength(2)
    expect(operations).toEqual(['start', 'end', 'start', 'end', 'start', 'end'])
    expect(subject.cleanup).toHaveBeenCalledTimes(1)
    expect(subject.liveDesired.size).toBe(0)
  })

  test('counts only cycles successfully delivered to the output callback', async () => {
    const subject = harness()

    const report = await subject.service.runContinuously({
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
    expect(subject.cleanup).toHaveBeenCalledTimes(1)
  })

  test('retries a handled failed cycle instead of cancelling the book', async () => {
    const controller = new AbortController()
    const subject = harness()
    subject.failReconcile(marketId)
    let observed = 0

    const report = await subject.service.runContinuously({
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
      cleanup: { status: 'applied' },
      lastCycle: [{ status: 'failed', stage: 'reconcile' }]
    })
    expect(subject.cleanup).toHaveBeenCalledTimes(1)
  })

  test('halts once one market exhausts its consecutive failure budget', async () => {
    const subject = harness()
    subject.failReconcile(marketId)

    const report = await subject.service.runContinuously({
      signal: new AbortController().signal,
      intervalMs: 1
    })

    expect(report).toMatchObject({
      status: 'halted',
      reason: 'cycle-failed',
      cycles: MARKET_FAILURE_BUDGET_CYCLES,
      lastCycle: [{ status: 'failed', stage: 'reconcile' }]
    })
  })

  test('keeps a rejected publication charged while its reservation is observed as active', async () => {
    const subject = harness()
    let failures = 0
    const reconcile = vi.fn(async parameters => {
      if (failures === 0) {
        failures += 1
        if (parameters.desired) subject.liveDesired.set(parameters.marketId, parameters.desired)
        throw new RangeError('publication confirmation unavailable')
      }
    })
    subject.make.reconcile = reconcile

    const report = await subject.service.runContinuously({
      signal: new AbortController().signal,
      intervalMs: 1
    })

    expect(report).toMatchObject({
      status: 'halted',
      reason: 'cycle-failed',
      cycles: MARKET_FAILURE_BUDGET_CYCLES
    })
    expect(reconcile).toHaveBeenCalledTimes(MARKET_FAILURE_BUDGET_CYCLES)
  })

  test('stops monitoring on a halted cycle and still cleans owned groups', async () => {
    const subject = harness()
    subject.failMarket(marketId)
    subject.failReconcile(marketId)

    const report = await subject.service.runContinuously({
      signal: new AbortController().signal,
      intervalMs: 1
    })

    expect(report).toMatchObject({
      status: 'halted',
      reason: 'cycle-failed',
      cycles: 1,
      cleanup: { status: 'applied' },
      lastCycle: [{ status: 'halted', stage: 'market-invalidation' }]
    })
    expect(subject.cleanup).toHaveBeenCalledTimes(1)
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
      const subject = harness()
      const calls: string[] = []
      subject.make.hardHalt = vi.fn(async () => {
        calls.push('hardHalt')
        throw new RangeError('cancellation reverted')
      })
      subject.make.cleanup = vi.fn(async () => {
        calls.push('cleanup')
        if (cleanupFails) throw new URIError('cancellation reverted again')
      })
      const service = new LadderQuoterService(
        {
          readLendGuard: async () => ({ lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true }),
          readMarket: async () => state()
        },
        {
          async readRate() {
            throw new ReferenceAdapterError('reference-history')
          }
        },
        subject.make,
        [validateLadderConfig(config())]
      )

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
            errorName: 'ReferenceAdapterError',
            adapterOperation: 'reference-history',
            invalidationErrorName: 'RangeError'
          }
        ]
      })
    }
  )

  test('verbose monitoring emits transaction hashes and fresh state before cleanup', async () => {
    const publicationHash: Hex = `0x${'aa'.repeat(32)}`
    const cancellationHash: Hex = `0x${'bb'.repeat(32)}`
    const desired = new Map<Hex, LadderQuoteSet>()
    const controller = new AbortController()
    const readMarket = vi.fn(async () => state())
    const make: LadderMakeService = {
      readActive: async id => desired.get(id),
      reconcile: async parameters => {
        if (parameters.desired) desired.set(parameters.marketId, parameters.desired)
        await parameters.onTransactionSubmitted?.({
          operation: 'publish',
          txHash: publicationHash
        })
        return {
          submittedTransactions: [{ operation: 'publish', txHash: publicationHash }]
        }
      },
      cancelBuys: async () => ({ submittedTransactions: [] }),
      hardHalt: async () => ({ submittedTransactions: [] }),
      cleanup: async parameters => {
        desired.clear()
        await parameters?.onTransactionSubmitted?.({
          operation: 'cancel',
          txHash: cancellationHash
        })
        return {
          submittedTransactions: [{ operation: 'cancel', txHash: cancellationHash }]
        }
      }
    }
    const service = new LadderQuoterService(
      {
        readLendGuard: async () => ({ lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true }),
        readMarket
      },
      { readRate: async () => 500n },
      make,
      [validateLadderConfig(config())]
    )
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

    expect(cycles).toMatchObject([
      [
        {
          status: 'applied',
          action: 'publish',
          verbose: {
            config: { marketId },
            currentState: { status: 'observed', market: state() },
            referenceRateBps: 500n,
            targetRateBps: 500n,
            ladderOffer: { centerRateBps: 500n },
            decision: 'publish',
            submittedTransactions: [{ operation: 'publish', txHash: publicationHash }],
            stateAfterCheck: {
              status: 'observed',
              market: state(),
              activeQuote: { centerRateBps: 500n }
            }
          }
        }
      ]
    ])
    expect(readMarket).toHaveBeenCalledTimes(2)
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
        event: 'ladder.transaction-submitted',
        marketId,
        operation: 'publish',
        txHash: publicationHash
      },
      {
        event: 'ladder.transaction-submitted',
        operation: 'cancel',
        txHash: cancellationHash
      }
    ])
  })

  test('publishes, rests unchanged, recenters, and resizes inside tolerance', async () => {
    const subject = harness()
    expect(await subject.service.runOnce()).toMatchObject([{ action: 'publish' }])
    expect(await subject.service.runOnce()).toMatchObject([{ action: 'rest' }])

    subject.setRate(511n)
    expect(await subject.service.runOnce()).toMatchObject([
      { action: 'replace', reason: 'recenter' }
    ])

    subject.setRate(510n)
    subject.setCapacity(5n)
    expect(await subject.service.runOnce()).toMatchObject([{ action: 'replace', reason: 'resize' }])
    expect(subject.reconciliations).toHaveLength(4)
  })

  test('refreshes unchanged hardcoded ladder quotes when the time-bucket observation advances', async () => {
    const subject = harness()
    expect(await subject.service.runOnce()).toMatchObject([{ action: 'publish' }])
    subject.setObservation('static:500:hour:2')

    expect(await subject.service.runOnce()).toMatchObject([{ action: 'replace', reason: 'resize' }])
  })

  test('publishes around the maturity-premium-adjusted center and reports it verbosely', async () => {
    const halfYearSeconds = 15_768_000n
    const subject = harness([
      { ...config(), maturityPremium: { shape: 'linear', premiumPerYearBps: 200n } }
    ])
    subject.setMaturity(halfYearSeconds)

    const results = await subject.service.runOnce({ verbose: true })

    expect(results).toMatchObject([
      {
        marketId,
        status: 'applied',
        action: 'publish',
        verbose: {
          referenceRateBps: 500n,
          secondsToMaturity: halfYearSeconds,
          maturityPremiumBps: 100n,
          targetRateBps: 600n,
          ladderOffer: { centerRateBps: 600n },
          decision: 'publish'
        }
      }
    ])
    expect(subject.reconciliations[0]?.desired?.centerRateBps).toBe(600n)
  })

  test('rests while maturity decay stays inside tolerance, then recenters once it escapes', async () => {
    const subject = harness([
      { ...config(), maturityPremium: { shape: 'linear', premiumPerYearBps: 200n } }
    ])
    subject.setMaturity(15_768_000n)
    expect(await subject.service.runOnce()).toMatchObject([{ action: 'publish' }])

    subject.setMaturity(14_348_880n)
    expect(await subject.service.runOnce()).toMatchObject([{ action: 'rest' }])

    subject.setMaturity(7_884_000n)
    expect(await subject.service.runOnce()).toMatchObject([
      { action: 'replace', reason: 'recenter' }
    ])
    expect(subject.reconciliations.at(-1)?.desired?.centerRateBps).toBe(550n)
  })

  test('halts the strategy when a configured maturity premium lacks its observation', async () => {
    const subject = harness([
      { ...config(), maturityPremium: { shape: 'linear', premiumPerYearBps: 200n } }
    ])

    expect(await subject.service.runOnce()).toEqual([
      {
        marketId,
        status: 'halted',
        stage: 'decision',
        strategyInvalidated: true,
        errorName: 'LadderConfigurationError'
      }
    ])
    expect(subject.halts).toEqual(['ladder-decision-failed'])
    expect(subject.reconciliations).toEqual([])
  })

  test('invalidates an active ladder when both sides fall below the offer floor', async () => {
    const subject = harness()
    await subject.service.runOnce()
    subject.setCapacity(0n)

    expect(await subject.service.runOnce()).toMatchObject([{ action: 'replace', reason: 'resize' }])
    expect(subject.reconciliations.at(-1)).toMatchObject({
      marketId,
      desired: undefined,
      reason: 'resize'
    })
    expect(subject.liveDesired.has(marketId)).toBe(false)
  })

  test('reloads live roots so externally expired roots are republished', async () => {
    const subject = harness()
    await subject.service.runOnce()
    subject.expireRoots(marketId)

    expect(await subject.service.runOnce()).toMatchObject([{ action: 'publish' }])
    expect(subject.liveDesired.get(marketId)).toEqual(subject.reconciliations[0]?.desired)
    expect(subject.reconciliations).toHaveLength(2)
  })

  test('rebuilds the active center from live roots after service recreation', async () => {
    const subject = harness([{ ...config(), movementToleranceBps: 10n }])
    await subject.service.runOnce()
    subject.setRate(505n)
    subject.recreateService()

    expect(await subject.service.runOnce()).toMatchObject([{ action: 'rest' }])
    expect(subject.reconciliations.at(-1)?.desired?.centerRateBps).toBe(500n)
  })

  test('reports an ordinary reconcile failure and continues other markets', async () => {
    const subject = harness([config(), config(secondMarketId)])
    subject.failReconcile(marketId)

    expect(await subject.service.runOnce()).toMatchObject([
      { marketId, status: 'failed', stage: 'reconcile', invalidated: false },
      { marketId: secondMarketId, action: 'publish' }
    ])
    expect(subject.halts).toEqual([])
  })

  test('invalidates a matured market and keeps quoting every other configured market', async () => {
    const subject = harness([config(), config(secondMarketId)])
    expect(await subject.service.runOnce()).toMatchObject([
      { marketId, action: 'publish' },
      { marketId: secondMarketId, action: 'publish' }
    ])

    subject.matureMarket(marketId)

    expect(await subject.service.runOnce()).toMatchObject([
      { marketId, status: 'observed', action: 'matured' },
      { marketId: secondMarketId, status: 'observed', action: 'rest' }
    ])
    expect(subject.reconciliations.at(-2)).toMatchObject({
      marketId,
      desired: undefined,
      reason: 'market-matured'
    })
    expect(subject.reads).not.toContain(`rate:${marketId}`)
    expect(subject.liveDesired.has(marketId)).toBe(false)
    expect(subject.liveDesired.has(secondMarketId)).toBe(true)
    expect(subject.halts).toEqual([])
  })

  test('keeps monitoring later cycles when a configured market has matured', async () => {
    const subject = harness([{ ...config(), loopIntervalSeconds: 1 }])
    subject.matureMarket(marketId)
    const controller = new AbortController()
    const cycles: unknown[] = []

    const report = await subject.service.runContinuously({
      signal: controller.signal,
      intervalMs: 1,
      onCycle: results => {
        cycles.push(results)
        if (cycles.length === 2) controller.abort()
      }
    })

    expect(report).toMatchObject({ status: 'stopped', reason: 'signal', cycles: 2 })
    expect(cycles).toMatchObject([[{ action: 'matured' }], [{ action: 'matured' }]])
  })

  test('reports a failed reconciliation while invalidating a matured market', async () => {
    const subject = harness()
    subject.matureMarket(marketId)
    subject.failReconcile(marketId)

    expect(await subject.service.runOnce()).toMatchObject([
      { marketId, status: 'failed', stage: 'reconcile', invalidated: false }
    ])
  })

  test('retains a confirmed ratification hash when publication later fails', async () => {
    const subject = harness()
    subject.make.reconcile = vi.fn(async () => {
      throw new LadderAdapterError(
        'publication-transaction-reverted-after-ratification'
      ).recordConfirmedTransactions([{ operation: 'ratify', txHash: ratificationHash }])
    })

    expect(await subject.service.runOnce({ verbose: true })).toMatchObject([
      {
        status: 'failed',
        stage: 'reconcile',
        verbose: {
          submittedTransactions: [{ operation: 'ratify', txHash: ratificationHash }]
        }
      }
    ])
  })

  test('retains a safe active center before generating an out-of-bounds fresh center', async () => {
    const subject = harness([
      {
        ...config(),
        minimumRateBps: 200n,
        maximumRateBps: 800n,
        movementToleranceBps: 600n
      }
    ])
    await subject.service.runOnce()
    subject.setRate(900n)

    expect(await subject.service.runOnce()).toMatchObject([{ action: 'rest' }])
    expect(subject.halts).toEqual([])
  })

  test('invalidates one failed market read and continues other markets', async () => {
    const subject = harness([config(), config(secondMarketId)])
    subject.failMarket(marketId)
    const result = await subject.service.runOnce()
    expect(result).toMatchObject([
      { marketId, status: 'failed', invalidated: true },
      { marketId: secondMarketId, action: 'publish' }
    ])
    expect(subject.reconciliations[0]).toMatchObject({
      marketId,
      desired: undefined,
      reason: 'market-read-failed'
    })
  })

  test('retains failed-market cancellation hashes in verbose output', async () => {
    const cancellationHash: Hex = `0x${'cc'.repeat(32)}`
    const service = new LadderQuoterService(
      {
        readLendGuard: async () => ({ lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true }),
        async readMarket() {
          throw new TypeError('private provider detail')
        }
      },
      { readRate: async () => 500n },
      {
        readActive: async () => undefined,
        reconcile: async () => ({
          submittedTransactions: [{ operation: 'cancel', txHash: cancellationHash }]
        }),
        cancelBuys: async () => ({ submittedTransactions: [] }),
        hardHalt: async () => ({ submittedTransactions: [] }),
        cleanup: async () => ({ submittedTransactions: [] })
      },
      [validateLadderConfig(config())]
    )

    expect(await service.runOnce({ verbose: true })).toMatchObject([
      {
        status: 'failed',
        stage: 'market-read',
        invalidated: true,
        verbose: {
          submittedTransactions: [{ operation: 'cancel', txHash: cancellationHash }]
        }
      }
    ])
  })

  test('names the cause of a market-read failure so a blocked cutover is diagnosable', async () => {
    const service = new LadderQuoterService(
      {
        readLendGuard: async () => ({ lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true }),
        async readMarket() {
          throw new LadderAdapterError('cash-capped-buy-group')
        }
      },
      { readRate: async () => 500n },
      {
        readActive: async () => undefined,
        reconcile: async () => ({ submittedTransactions: [] }),
        cancelBuys: async () => ({ submittedTransactions: [] }),
        hardHalt: async () => ({ submittedTransactions: [] }),
        cleanup: async () => ({ submittedTransactions: [] })
      },
      [validateLadderConfig(config())]
    )

    expect(await service.runOnce()).toMatchObject([
      { status: 'failed', stage: 'market-read', adapterOperation: 'cash-capped-buy-group' }
    ])
  })

  test('preserves the market read and local invalidation failures before hard halt', async () => {
    const subject = harness()
    subject.failMarket(marketId)
    subject.failReconcile(marketId)

    expect(await subject.service.runOnce()).toMatchObject([
      {
        status: 'halted',
        stage: 'market-invalidation',
        strategyInvalidated: true,
        errorName: 'TypeError',
        marketInvalidationErrorName: 'RangeError'
      }
    ])
  })

  test('hard-halts on reference read failure', async () => {
    const subject = harness()
    subject.service = new LadderQuoterService(
      {
        readLendGuard: async () => ({ lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true }),
        async readMarket() {
          return state()
        }
      },
      {
        async readRate() {
          throw new ReferenceAdapterError('reference-history')
        }
      },
      {
        async readActive() {
          return undefined
        },
        async reconcile() {},
        async cancelBuys() {},
        async hardHalt(parameters) {
          subject.halts.push(parameters.reason)
        },
        async cleanup() {
          subject.liveDesired.clear()
        }
      },
      [validateLadderConfig(config())]
    )
    const result = await subject.service.runOnce()
    expect(subject.halts).toEqual(['reference-read-failed'])
    expect(result).toEqual([
      {
        marketId: config().marketId,
        status: 'halted',
        stage: 'reference-read',
        strategyInvalidated: true,
        errorName: 'ReferenceAdapterError',
        adapterOperation: 'reference-history'
      }
    ])
  })

  test('retains strategy-wide hard-halt settlements for verbose monitoring', async () => {
    const cancellationHash: Hex = `0x${'ee'.repeat(32)}`
    const service = new LadderQuoterService(
      {
        readLendGuard: async () => ({ lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true }),
        async readMarket() {
          return state()
        }
      },
      {
        async readRate() {
          throw new RangeError('private')
        }
      },
      {
        async readActive() {
          return undefined
        },
        async reconcile() {},
        async cancelBuys() {},
        async hardHalt() {
          return { submittedTransactions: [{ operation: 'cancel', txHash: cancellationHash }] }
        },
        async cleanup() {}
      },
      [validateLadderConfig(config())]
    )

    const result = await service.runOnce({ verbose: true })
    expect(result).toMatchObject([
      {
        status: 'halted',
        stage: 'reference-read',
        verbose: {
          submittedTransactions: [{ operation: 'cancel', txHash: cancellationHash }]
        }
      }
    ])
    expect(ladderMonitoringEvents(result)).toContainEqual({
      event: 'transaction.settled',
      workflow: 'ladder',
      operation: 'cancel',
      txHash: cancellationHash
    })
  })

  test('omits out-of-range rungs instead of halting on a reference excursion', async () => {
    const subject = harness()
    subject.setRate(801n)
    const result = await subject.service.runOnce()
    expect(subject.halts).toEqual([])
    expect(result).toMatchObject([{ status: 'applied', action: 'publish' }])
    expect(subject.reconciliations[0]?.desired?.higher).toEqual([
      { index: 0, rateBps: 901n, assets: expect.any(BigInt) }
    ])
    expect(subject.reconciliations[0]?.desired?.lower.map(rung => rung.rateBps)).toEqual([
      701n,
      601n,
      501n
    ])
  })
})

const crossedClearable: LadderBookSideCrossing = { crossed: true, clearable: true }
const uncrossed: LadderBookSideCrossing = { crossed: false, clearable: true }

const crossedState = (
  observedTimestamp: bigint,
  lower: LadderBookSideCrossing = crossedClearable
): LadderMarketState => ({
  ...state(),
  bookCrossing: { lower, higher: uncrossed },
  observedTimestamp
})

const recheck = (
  preparedAtTimestamp: bigint,
  options: { applied?: boolean; logged?: true } = {}
): LadderMakeResult => ({
  submittedTransactions: [],
  ...(options.logged ? { logged: options.logged } : {}),
  reconciliation: {
    preparedAtTimestamp,
    bookCrossing: { lower: crossedClearable, higher: uncrossed },
    applied: options.applied ?? true
  }
})

const published = async () => {
  const subject = harness()
  expect(await subject.service.runOnce()).toMatchObject([{ action: 'publish' }])
  return subject
}

describe('LadderQuoterService book-crossed replacement', () => {
  test('upgrades an unchanged quote to a replacement when a clearable cross is reported', async () => {
    const subject = await published()
    subject.setMarketState(crossedState(1_000n))
    subject.setReconcileResult(recheck(1_000n))

    expect(await subject.service.runOnce()).toMatchObject([
      { status: 'applied', action: 'replace', reason: 'book-crossed' }
    ])
    expect(subject.reconciliations.at(-1)?.reason).toBe('book-crossed')
    expect(subject.reconciliations.at(-1)?.bookCrossedSides).toEqual(['lower'])
  })

  test('rests on an unclearable cross and reports it unsuppressed', async () => {
    const subject = await published()
    subject.setMarketState(crossedState(1_000n, { crossed: true, clearable: false }))

    const result = await subject.service.runOnce({ verbose: true })

    expect(result).toMatchObject([{ status: 'observed', action: 'rest' }])
    expect(result[0]?.verbose?.bookCrossing?.lower).toEqual({
      crossed: true,
      clearable: false,
      suppressed: false
    })
    expect(subject.reconciliations.at(-1)?.reason).toBe('rest')
  })

  test('holds the side for one cooldown after an applied replacement, then replaces again', async () => {
    const subject = await published()
    subject.setMarketState(crossedState(1_000n))
    subject.setReconcileResult(recheck(1_000n))
    expect(await subject.service.runOnce()).toMatchObject([{ reason: 'book-crossed' }])

    subject.setMarketState(crossedState(1_179n))
    const held = await subject.service.runOnce({ verbose: true })

    expect(held).toMatchObject([{ status: 'observed', action: 'rest' }])
    expect(held[0]?.verbose?.bookCrossing?.lower.suppressed).toBe(true)

    subject.setMarketState(crossedState(1_180n))
    expect(await subject.service.runOnce()).toMatchObject([
      { status: 'applied', action: 'replace', reason: 'book-crossed' }
    ])
  })

  test('leaves the cooldown untouched when the replacement throws', async () => {
    const subject = await published()
    subject.setMarketState(crossedState(1_000n))
    subject.failReconcile(marketId)
    expect(await subject.service.runOnce()).toMatchObject([
      { status: 'failed', stage: 'reconcile' }
    ])

    subject.failReconcile(undefined)
    subject.setReconcileResult(recheck(1_001n))
    subject.setMarketState(crossedState(1_001n))

    expect(await subject.service.runOnce()).toMatchObject([
      { status: 'applied', action: 'replace', reason: 'book-crossed' }
    ])
  })

  test('holds no cooldown when the book-crossed replacement was withheld', async () => {
    const subject = await published()
    subject.setMarketState(crossedState(1_000n))
    subject.setReconcileResult({
      submittedTransactions: [],
      reconciliation: {
        preparedAtTimestamp: 1_000n,
        bookCrossing: { lower: crossedClearable, higher: uncrossed },
        applied: true
      },
      publicationWithheld: { reason: 'capacity-changed' }
    })
    expect(await subject.service.runOnce()).toMatchObject([
      { status: 'applied', action: 'publication-withheld' }
    ])

    subject.setMarketState(crossedState(1_001n))
    subject.setReconcileResult(recheck(1_001n))
    expect(await subject.service.runOnce()).toMatchObject([
      { status: 'applied', action: 'replace', reason: 'book-crossed' }
    ])
  })

  test('reports rest and holds no cooldown when the recheck found nothing to clear', async () => {
    const subject = await published()
    subject.setMarketState(crossedState(1_000n))
    subject.setReconcileResult(recheck(1_000n, { applied: false }))

    const result = await subject.service.runOnce()

    expect(result).toMatchObject([{ status: 'observed', action: 'rest' }])
    expect(subject.reconciliations.at(-1)?.reason).toBe('book-crossed')

    subject.setMarketState(crossedState(1_001n))
    subject.setReconcileResult(recheck(1_001n))
    expect(await subject.service.runOnce()).toMatchObject([
      { status: 'applied', action: 'replace', reason: 'book-crossed' }
    ])
  })

  test('advances the cooldown on a logged dry-run replacement', async () => {
    const subject = await published()
    subject.setMarketState(crossedState(1_000n))
    subject.setReconcileResult(recheck(1_000n, { logged: true }))

    expect(await subject.service.runOnce()).toMatchObject([
      { status: 'logged', action: 'replace', reason: 'book-crossed' }
    ])

    subject.setMarketState(crossedState(1_100n))
    const held = await subject.service.runOnce({ verbose: true })

    expect(held).toMatchObject([{ status: 'observed', action: 'rest' }])
    expect(held[0]?.verbose?.bookCrossing?.lower.suppressed).toBe(true)
  })

  test('never overwrites a recenter that a crossing coincides with', async () => {
    const subject = await published()
    subject.setMarketState(crossedState(1_000n))
    subject.setRate(511n)

    expect(await subject.service.runOnce()).toMatchObject([
      { status: 'applied', action: 'replace', reason: 'recenter' }
    ])
  })
})

describe('LadderQuoterService withdrawn sides', () => {
  const cancellation = { operation: 'cancel' as const, txHash: `0x${'bb'.repeat(32)}` as const }
  const publication = { operation: 'publish' as const, txHash: `0x${'cc'.repeat(32)}` as const }

  test.each([
    { submittedTransactions: [], status: 'observed' },
    { submittedTransactions: [cancellation], status: 'applied' }
  ] as const)(
    'records a publication with every side withdrawn as $status, never as published',
    async ({ submittedTransactions, status }) => {
      const subject = harness()
      subject.make.reconcile = async () => ({
        submittedTransactions,
        withdrawnSides: ['lower', 'higher']
      })

      const [result] = await subject.service.runOnce({ verbose: true })

      expect(result).toMatchObject({
        marketId,
        status,
        action: 'publication-withdrawn',
        reason: 'publish',
        withdrawnSides: ['lower', 'higher']
      })
      expect(result?.verbose?.withdrawnSides).toEqual(['lower', 'higher'])
      const events = ladderMonitoringEvents([result!])
      expect(events).toContainEqual(
        expect.objectContaining({ event: 'cycle.completed', action: 'publication-withdrawn' })
      )
      for (const side of ['lower', 'higher'] as const) {
        expect(events).toContainEqual({
          event: 'guardrail.side-withdrawn',
          workflow: 'ladder',
          marketId,
          side
        })
      }
    }
  )

  test('records a publication that withdrew only its sells as published with the withdrawal', async () => {
    const subject = harness()
    subject.make.reconcile = async () => ({
      submittedTransactions: [publication],
      withdrawnSides: ['lower']
    })

    const [result] = await subject.service.runOnce()

    expect(result).toMatchObject({
      status: 'applied',
      action: 'publish',
      withdrawnSides: ['lower']
    })
    const withdrawn = ladderMonitoringEvents([result!]).filter(
      event => event.event === 'guardrail.side-withdrawn'
    )
    expect(withdrawn).toEqual([
      { event: 'guardrail.side-withdrawn', workflow: 'ladder', marketId, side: 'lower' }
    ])
  })
})

describe('LadderQuoterService snapshot rate window', () => {
  const cancellation = { operation: 'cancel' as const, txHash: `0x${'bb'.repeat(32)}` as const }
  const tickless = (): LadderMarketState => ({ ...state(), withdrawnSides: ['lower', 'higher'] })

  test('cancels the live ladder when the snapshot range holds no tick', async () => {
    const subject = await published()
    subject.setMarketState(tickless())
    subject.setReconcileResult({ submittedTransactions: [cancellation] })

    const [result] = await subject.service.runOnce()

    expect(result).toEqual({
      marketId,
      status: 'applied',
      action: 'publication-withdrawn',
      reason: 'resize',
      withdrawnSides: ['lower', 'higher']
    })
    expect(subject.reconciliations.at(-1)).toMatchObject({ desired: undefined, reason: 'resize' })
    expect(subject.liveDesired.has(marketId)).toBe(false)
    expect(
      ladderMonitoringEvents([result!]).filter(event => event.event === 'guardrail.side-withdrawn')
    ).toEqual([
      { event: 'guardrail.side-withdrawn', workflow: 'ladder', marketId, side: 'lower' },
      { event: 'guardrail.side-withdrawn', workflow: 'ladder', marketId, side: 'higher' }
    ])
  })

  test('keeps reporting the withdrawal with nothing live, then republishes once ticks return', async () => {
    const subject = harness()
    subject.setMarketState(tickless())

    expect(await subject.service.runOnce()).toEqual([
      {
        marketId,
        status: 'observed',
        action: 'publication-withdrawn',
        reason: 'publish',
        withdrawnSides: ['lower', 'higher']
      }
    ])

    subject.setMarketState(state())
    const [recovered] = await subject.service.runOnce()

    expect(recovered).toEqual({ marketId, status: 'applied', action: 'publish', reason: 'publish' })
    const live = subject.liveDesired.get(marketId)!
    expect(live.lower.length).toBeGreaterThan(0)
    expect(live.higher.length).toBeGreaterThan(0)
  })

  test('withdraws only the sells when only the sell window is empty', async () => {
    const subject = await published()
    subject.setMarketState({ ...state(), withdrawnSides: ['lower'] })

    expect(await subject.service.runOnce()).toMatchObject([
      { status: 'applied', action: 'replace', reason: 'resize', withdrawnSides: ['lower'] }
    ])
    expect(subject.liveDesired.get(marketId)).toMatchObject({ lower: [] })
    expect(subject.liveDesired.get(marketId)!.higher.length).toBeGreaterThan(0)

    const [rested] = await subject.service.runOnce()

    expect(rested).toEqual({
      marketId,
      status: 'observed',
      action: 'rest',
      withdrawnSides: ['lower']
    })
    expect(subject.reconciliations.at(-1)?.reason).toBe('rest')
    expect(ladderMonitoringEvents([rested!])).toContainEqual({
      event: 'guardrail.side-withdrawn',
      workflow: 'ladder',
      marketId,
      side: 'lower'
    })
  })

  test('reports the snapshot withdrawal on a failed reconcile', async () => {
    const subject = await published()
    subject.setMarketState({ ...state(), withdrawnSides: ['lower'] })
    subject.failReconcile(marketId)

    expect(await subject.service.runOnce()).toMatchObject([
      { status: 'failed', stage: 'reconcile', withdrawnSides: ['lower'] }
    ])
  })

  test('reports no withdrawal for a side that had nothing to publish', async () => {
    const subject = await published()
    subject.setMarketState({ ...state(), lowerRateCapacityAssets: 0n, withdrawnSides: ['lower'] })

    const [result] = await subject.service.runOnce()

    expect(result).toMatchObject({ status: 'applied', action: 'replace', reason: 'resize' })
    expect(result).not.toHaveProperty('withdrawnSides')
  })

  test('reports a snapshot sell withdrawal when the surviving buys are withheld', async () => {
    const subject = await published()
    subject.setMarketState({ ...state(), withdrawnSides: ['lower'] })
    subject.setReconcileResult({
      submittedTransactions: [cancellation],
      publicationWithheld: { reason: 'capacity-changed' }
    })

    const [result] = await subject.service.runOnce()

    expect(result).toMatchObject({
      status: 'applied',
      action: 'publication-withheld',
      reason: 'capacity-changed',
      withdrawnSides: ['lower']
    })
    expect(ladderMonitoringEvents([result!])).toContainEqual({
      event: 'guardrail.side-withdrawn',
      workflow: 'ladder',
      marketId,
      side: 'lower'
    })
  })

  test('never charges the failure budget, and clears a pending publication failure', async () => {
    const subject = harness()
    subject.failReconcile(marketId)
    const controller = new AbortController()
    let cycles = 0

    const report = await subject.service.runContinuously({
      signal: controller.signal,
      intervalMs: 1,
      onCycle: () => {
        cycles += 1
        if (cycles === MARKET_FAILURE_BUDGET_CYCLES - 1) {
          subject.failReconcile(undefined)
          subject.setMarketState(tickless())
        }
        if (cycles === 2 * MARKET_FAILURE_BUDGET_CYCLES) controller.abort()
      }
    })

    expect(report).toMatchObject({ status: 'stopped', cycles: 2 * MARKET_FAILURE_BUDGET_CYCLES })
  })
})

describe('LadderQuoterService withheld publications', () => {
  const cancellation = { operation: 'cancel' as const, txHash: `0x${'bb'.repeat(32)}` as const }
  const withholding =
    (result: LadderMakeResult): LadderMakeService['reconcile'] =>
    async () =>
      result

  test.each(['capacity-changed', 'price-changed'] as const)(
    'reports a %s withholding as applied with its cancellations',
    async reason => {
      const subject = harness()
      subject.make.reconcile = withholding({
        submittedTransactions: [cancellation],
        publicationWithheld: { reason }
      })

      const [result] = await subject.service.runOnce({ verbose: true })

      expect(result).toMatchObject({
        marketId,
        status: 'applied',
        action: 'publication-withheld',
        reason
      })
      expect(result?.verbose?.submittedTransactions).toEqual([cancellation])
      expect(result?.verbose?.stateAfterCheck).toMatchObject({ status: 'observed' })
      expect(result?.verbose?.stateAfterCheck).not.toHaveProperty('activeQuote')
      expect(ladderMonitoringEvents([result!])).toContainEqual({
        event: 'guardrail.publication-withheld',
        workflow: 'ladder',
        marketId,
        reason
      })
    }
  )

  test('reports a loss-factor withholding as applied with its direction', async () => {
    const subject = harness()
    subject.make.reconcile = withholding({
      submittedTransactions: [cancellation],
      publicationWithheld: {
        reason: 'loss-factor-mismatch',
        lossFactor: 4n,
        acceptedLossFactor: 5n,
        defaulted: false,
        direction: 'below'
      }
    })

    const [result] = await subject.service.runOnce()

    expect(result).toEqual({
      marketId,
      status: 'applied',
      action: 'publication-withheld',
      reason: 'loss-factor-mismatch',
      lossFactor: 4n,
      acceptedLossFactor: 5n,
      defaulted: false,
      direction: 'below'
    })
    const events = createMonitoringProjection().ladder([result!])
    expect(events).toContainEqual({
      event: 'guardrail.publication-withheld',
      workflow: 'ladder',
      marketId,
      reason: 'loss-factor-mismatch'
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'guardrail.lend-halted',
        workflow: 'ladder',
        lossFactor: 4n,
        acceptedLossFactor: 5n,
        direction: 'below'
      })
    )
  })

  test('reports an unavailable snapshot after cancelling as a failed invalidated reconcile', async () => {
    const subject = harness()
    subject.make.reconcile = withholding({
      submittedTransactions: [cancellation],
      publicationWithheld: {
        reason: 'snapshot-unavailable',
        errorName: 'BootstrapAdapterError',
        snapshotErrorOperation: 'missing-owned-group-intent'
      }
    })

    const [result] = await subject.service.runOnce()

    expect(result).toEqual({
      marketId,
      status: 'failed',
      stage: 'reconcile',
      invalidated: true,
      errorName: 'BootstrapAdapterError',
      adapterOperation: 'snapshot-unavailable',
      snapshotErrorOperation: 'missing-owned-group-intent'
    })
    expect(ladderMonitoringEvents([result!])).toContainEqual({
      event: 'guardrail.publication-withheld',
      workflow: 'ladder',
      marketId,
      reason: 'snapshot-unavailable'
    })
  })

  test('reports an unavailable snapshot without cancellations as not invalidated', async () => {
    const subject = harness()
    subject.make.reconcile = withholding({
      submittedTransactions: [],
      publicationWithheld: { reason: 'snapshot-unavailable', errorName: 'RpcRequestError' }
    })

    const [result] = await subject.service.runOnce()

    expect(result).toMatchObject({ status: 'failed', stage: 'reconcile', invalidated: false })
  })

  test('reports a failed release of a withheld reservation with its cancellations', async () => {
    const subject = harness()
    subject.make.reconcile = async () => {
      throw new LadderAdapterError('publication-reservation-cleanup').recordConfirmedTransactions([
        cancellation
      ])
    }

    const [result] = await subject.service.runOnce({ verbose: true })

    expect(result).toMatchObject({
      status: 'failed',
      stage: 'reconcile',
      invalidated: true,
      errorName: 'LadderAdapterError',
      adapterOperation: 'publication-reservation-cleanup'
    })
    expect(result?.verbose?.submittedTransactions).toEqual([cancellation])
  })

  test('charges repeated unavailable snapshots to the market failure budget', async () => {
    const subject = harness()
    subject.make.reconcile = withholding({
      submittedTransactions: [],
      publicationWithheld: { reason: 'snapshot-unavailable', errorName: 'LadderAdapterError' }
    })

    const report = await subject.service.runContinuously({
      signal: new AbortController().signal,
      intervalMs: 1
    })

    expect(report).toMatchObject({
      status: 'halted',
      reason: 'cycle-failed',
      cycles: MARKET_FAILURE_BUDGET_CYCLES
    })
  })

  test('does not charge a capacity-changed withholding to the failure budget', async () => {
    const subject = harness()
    subject.make.reconcile = withholding({
      submittedTransactions: [],
      publicationWithheld: { reason: 'capacity-changed' }
    })
    const controller = new AbortController()
    let cycles = 0

    const report = await subject.service.runContinuously({
      signal: controller.signal,
      intervalMs: 1,
      onCycle: () => {
        cycles += 1
        if (cycles > MARKET_FAILURE_BUDGET_CYCLES) controller.abort()
      }
    })

    expect(report).toMatchObject({ status: 'stopped', cycles: MARKET_FAILURE_BUDGET_CYCLES + 1 })
  })
})

describe('LadderQuoterService loss factor', () => {
  const cancellationHash: Hex = `0x${'bb'.repeat(32)}`
  const observation = (lossFactor: bigint) => ({
    lossFactor,
    acceptedLossFactor: 5n,
    defaulted: false
  })

  test('lends only when the loss factor equals the accepted value', async () => {
    const subject = harness()
    subject.setLossFactor(marketId, observation(5n))

    expect(await subject.service.runOnce()).toMatchObject([
      { status: 'applied', action: 'publish' }
    ])
    expect(subject.buyCancellations).toEqual([])
  })

  test.each([
    ['above', 6n],
    ['below', 4n]
  ] as const)(
    'cancels buys %s the accepted value before any active, market, rate, or book read',
    async (direction, lossFactor) => {
      const subject = harness()
      subject.setLossFactor(marketId, observation(lossFactor))
      subject.setCancelBuysResult({
        submittedTransactions: [{ operation: 'cancel', txHash: cancellationHash }]
      })

      const results = await subject.service.runOnce()

      expect(results).toEqual([
        {
          marketId,
          status: 'applied',
          action: 'lend-halted',
          reason: 'loss-factor-mismatch',
          ...observation(lossFactor),
          direction
        }
      ])
      expect(subject.buyCancellations).toMatchObject([{ marketId, reason: 'loss-factor-mismatch' }])
      expect(subject.reads).toEqual([`guard:${marketId}`])
      expect(subject.reconciliations).toEqual([])
    }
  )

  test('reports a halted market without live buys as observed and a dry run as logged', async () => {
    const subject = harness()
    subject.setLossFactor(marketId, observation(6n))

    expect(await subject.service.runOnce()).toMatchObject([
      { status: 'observed', action: 'lend-halted' }
    ])
    subject.setCancelBuysResult('logged')
    expect(await subject.service.runOnce()).toMatchObject([
      { status: 'logged', action: 'lend-halted' }
    ])
  })

  test('keeps quoting other markets while one is lend-halted', async () => {
    const subject = harness([config(), config(secondMarketId)])
    subject.setLossFactor(marketId, observation(6n))

    const results = await subject.service.runOnce()

    expect(results).toMatchObject([
      { marketId, action: 'lend-halted' },
      { marketId: secondMarketId, status: 'applied', action: 'publish' }
    ])
  })

  test.each([
    ['writer', { submittedTransactions: [] }, { invalidated: true }],
    ['read-only', 'logged' as const, { invalidated: false, invalidationLogged: true }]
  ] as const)(
    'cancels buys and fails retryably when the guard cannot be read in %s mode',
    async (_mode, cancellation, invalidation) => {
      const subject = harness()
      subject.failGuard(marketId)
      subject.setCancelBuysResult(cancellation)

      expect(await subject.service.runOnce()).toEqual([
        {
          marketId,
          status: 'failed',
          stage: 'guard-read',
          ...invalidation,
          errorName: 'LadderAdapterError',
          adapterOperation: 'loss-factor-read'
        }
      ])
      expect(subject.buyCancellations).toMatchObject([{ reason: 'guard-read-failed' }])
      expect(subject.reads).toEqual([`guard:${marketId}`])
    }
  )

  test.each([
    ['a failed', new LadderAdapterError('transaction-reverted')],
    ['an uncertain', new LadderAdapterError('transaction-pending')]
  ])('hard-halts at once on %s cancellation receipt', async (_name, error) => {
    const subject = harness([config(), config(secondMarketId)])
    subject.setLossFactor(marketId, observation(6n))
    subject.failCancelBuys(error)

    const results = await subject.service.runOnce()

    expect(results).toEqual([
      {
        marketId,
        status: 'halted',
        stage: 'market-invalidation',
        reason: 'loss-factor-mismatch',
        strategyInvalidated: true,
        errorName: 'LadderAdapterError',
        adapterOperation: error.operation,
        marketInvalidationErrorName: 'LadderAdapterError',
        ...observation(6n),
        direction: 'above'
      }
    ])
    expect(subject.halts).toEqual(['market-invalidation-failed'])
    expect(subject.reads).not.toContain(`guard:${secondMarketId}`)
    expect(createMonitoringProjection().ladder(results)).toContainEqual({
      event: 'guardrail.lend-halted',
      workflow: 'ladder',
      marketId,
      lossFactor: 6n,
      acceptedLossFactor: 5n,
      defaulted: false,
      direction: 'above',
      incrementalLossBps: 1n
    })
  })

  test('reports a confirmed cancellation whose ownership cannot be forgotten as invalidated', async () => {
    const subject = harness()
    subject.setLossFactor(marketId, observation(6n))
    subject.failCancelBuys(
      new LadderOwnershipCleanupError(
        `0x${'cc'.repeat(32)}`,
        [{ operation: 'cancel', txHash: cancellationHash }],
        'TypeError'
      )
    )

    const results = await subject.service.runOnce()

    expect(results).toMatchObject([
      {
        status: 'failed',
        stage: 'reconcile',
        invalidated: true,
        ownershipCleanupErrorName: 'TypeError',
        ...observation(6n),
        direction: 'above'
      }
    ])
    expect(subject.halts).toEqual([])
    expect(createMonitoringProjection().ladder(results)).toContainEqual({
      event: 'guardrail.lend-halted',
      workflow: 'ladder',
      marketId,
      lossFactor: 6n,
      acceptedLossFactor: 5n,
      defaulted: false,
      direction: 'above',
      incrementalLossBps: 1n
    })
  })

  test('cancels a halted market before removed-market cleanup can fail the cycle', async () => {
    const subject = harness([config(), config(secondMarketId)])
    subject.setLossFactor(secondMarketId, observation(6n))
    const order: string[] = []
    subject.make.cleanupRemovedMarkets = vi.fn(async () => {
      order.push(`cleanup after ${subject.buyCancellations.length} cancellation`)
      throw new LadderAdapterError('removed-market-cleanup')
    })

    await expect(subject.service.runOnce()).rejects.toMatchObject({
      operation: 'removed-market-cleanup'
    })
    expect(subject.buyCancellations).toMatchObject([
      { marketId: secondMarketId, reason: 'loss-factor-mismatch' }
    ])
    expect(order).toEqual(['cleanup after 1 cancellation'])
  })

  test('still cancels halted buys and shuts down cleanly when removed-market cleanup keeps failing', async () => {
    const subject = harness()
    subject.setLossFactor(marketId, observation(6n))
    subject.make.cleanupRemovedMarkets = vi.fn(async () => {
      throw new LadderAdapterError('removed-market-cleanup')
    })

    const report = await subject.service.runContinuously({
      signal: new AbortController().signal,
      intervalMs: 1
    })

    expect(report).toMatchObject({ status: 'halted', reason: 'cycle-error' })
    expect(subject.buyCancellations).toMatchObject([{ marketId, reason: 'loss-factor-mismatch' }])
    expect(subject.cleanup).toHaveBeenCalledTimes(1)
  })

  test('clears a pending publication failure once the market is safely lend-halted', async () => {
    const subject = harness()
    const controller = new AbortController()
    let cycle = 0
    subject.failReconcile(marketId)

    const report = await subject.service.runContinuously({
      signal: controller.signal,
      intervalMs: 1,
      onCycle: () => {
        cycle += 1
        if (cycle === MARKET_FAILURE_BUDGET_CYCLES - 1)
          subject.setLossFactor(marketId, observation(6n))
        if (cycle === MARKET_FAILURE_BUDGET_CYCLES + 2) controller.abort()
      }
    })

    expect(report).toMatchObject({ status: 'stopped', cycles: MARKET_FAILURE_BUDGET_CYCLES + 2 })
  })
})

describe('LadderQuoterService lend-only ladder', () => {
  const lendOnly = (): LadderConfig => ({ ...config(), lowerRateBudgetAssets: 0n })

  test('publishes buys alone at every held credit and reports no sell side', async () => {
    const subject = harness([lendOnly()])
    for (const creditAssets of [0n, 7n, 20n, 10n ** 24n]) {
      subject.setMarketState({
        ...state(),
        lowerRateCapacityAssets: creditAssets,
        creditAssets,
        withdrawnSides: ['lower']
      })

      const results = await subject.service.runOnce({ verbose: true })

      expect(results[0]).toMatchObject({
        marketId,
        status: expect.stringMatching(/applied|observed/)
      })
      expect(results[0]).not.toHaveProperty('withdrawnSides')
      expect(subject.liveDesired.get(marketId)?.lower).toEqual([])
      expect(subject.liveDesired.get(marketId)?.higher.length).toBeGreaterThan(0)
      const lowerEvents = ladderMonitoringEvents(results).filter(
        event => 'side' in event && event.side === 'lower'
      )
      expect(lowerEvents).toEqual([
        expect.objectContaining({ event: 'book.observed', state: 'empty', rungs: 0 })
      ])
    }
    expect(subject.reconciliations.every(entry => entry.desired?.lower.length === 0)).toBe(true)
  })

  test('holds credit through maturity and cancels on the unchanged matured path', async () => {
    const subject = harness([lendOnly()])
    subject.setMarketState({ ...state(), lowerRateCapacityAssets: 20n, creditAssets: 20n })
    expect(await subject.service.runOnce()).toMatchObject([{ action: 'publish' }])

    subject.matureMarket(marketId)

    expect(await subject.service.runOnce()).toMatchObject([
      { marketId, status: 'observed', action: 'matured' }
    ])
    expect(subject.reconciliations.at(-1)).toMatchObject({
      marketId,
      desired: undefined,
      reason: 'market-matured'
    })
  })
})

describe('LadderQuoterService inventory skew', () => {
  const skewConfig = (unitsPerStep = 5n): LadderConfig => ({
    ...config(),
    inventorySkew: { unitsPerStep }
  })

  test('cancels buys before any active, market, rate, or book read with a skew enabled', async () => {
    const subject = harness([skewConfig()])
    subject.setLossFactor(marketId, { lossFactor: 6n, acceptedLossFactor: 5n, defaulted: false })

    expect(await subject.service.runOnce()).toMatchObject([
      { status: 'observed', action: 'lend-halted', reason: 'loss-factor-mismatch' }
    ])
    expect(subject.buyCancellations).toMatchObject([{ marketId, reason: 'loss-factor-mismatch' }])
    expect(subject.reads).toEqual([`guard:${marketId}`])
    expect(subject.reconciliations).toEqual([])
  })

  test('halts the strategy when a configured skew lacks its credit observation', async () => {
    const subject = harness([skewConfig()])

    expect(await subject.service.runOnce()).toEqual([
      {
        marketId,
        status: 'halted',
        stage: 'decision',
        strategyInvalidated: true,
        errorName: 'LadderConfigurationError'
      }
    ])
    expect(subject.halts).toEqual(['ladder-decision-failed'])
    expect(subject.reconciliations).toEqual([])
  })

  test('resizes only the buys when held credit raises the skew under a retained center', async () => {
    const subject = harness([skewConfig()])
    subject.setMarketState({ ...state(), creditAssets: 0n })
    await subject.service.runOnce()
    const published = subject.liveDesired.get(marketId)!

    subject.setMarketState({ ...state(), creditAssets: 5n })
    expect(await subject.service.runOnce()).toMatchObject([
      { status: 'applied', action: 'replace', reason: 'resize' }
    ])
    const resized = subject.liveDesired.get(marketId)!

    expect(resized.centerRateBps).toBe(published.centerRateBps)
    expect(resized.lower).toEqual(published.lower)
    expect(resized.higher.map(rung => rung.rateBps)).toEqual(
      published.higher.map(rung => rung.rateBps + 100n)
    )
    expect(resized.higherSkewBps).toBe(100n)
  })

  test('withdraws a buy a skew change pushes past the maximum instead of resting', async () => {
    const subject = harness([{ ...skewConfig(), maximumRateBps: 800n }])
    subject.setMarketState({ ...state(), creditAssets: 5n })
    await subject.service.runOnce()
    expect(subject.liveDesired.get(marketId)?.higher.map(rung => rung.rateBps)).toEqual([
      700n,
      800n
    ])

    subject.setMarketState({ ...state(), creditAssets: 10n })
    expect(await subject.service.runOnce()).not.toMatchObject([
      { status: 'observed', action: 'rest' }
    ])
    expect(subject.liveDesired.get(marketId)?.higher.map(rung => rung.rateBps)).toEqual([800n])
  })

  test('emits the skew on its monitoring event', async () => {
    const subject = harness([skewConfig()])
    subject.setMarketState({ ...state(), creditAssets: 7n })

    const results = await subject.service.runOnce({ verbose: true })

    expect(results[0]?.verbose?.diagnostics?.inventorySkew).toEqual({
      inventorySkewBps: 140n,
      skewClamped: false,
      creditAssets: 7n,
      neutralCredit: 0n
    })
    expect(ladderMonitoringEvents(results)).toContainEqual({
      event: 'inventory-skew.observed',
      workflow: 'ladder',
      marketId,
      inventorySkewBps: 140n,
      skewClamped: false,
      creditAssets: 7n,
      neutralCredit: 0n
    })
  })

  describe('multi-cycle drain of the nearest buy', () => {
    const TARGET_EXPOSURE = 500_000_000_000n
    const RUNG_ASSETS = 20_000_000_000n
    const YEAR_SECONDS = 31_536_000n
    const BPS_WAD = 10n ** 14n
    const tickOf = (rateBps: bigint) => alignedRateTick(rateBps, YEAR_SECONDS, 1n)
    const faceUnits = (assets: bigint, rateBps: bigint) =>
      TakeAmountsLib.buyerAssetsToUnits({
        offer: { buy: true, tick: tickOf(rateBps) },
        targetBuyerAssets: assets,
        settlementFee: 0n
      })
    const executableRateWad = (rateBps: bigint) => TickLib.tickToApr(tickOf(rateBps), YEAR_SECONDS)
    const spendWeightedBps = (fills: readonly { rateBps: bigint; assets: bigint }[]) => {
      const spent = fills.reduce((sum, fill) => sum + fill.assets, 0n)
      const weighted = fills.reduce(
        (sum, fill) => sum + executableRateWad(fill.rateBps) * fill.assets,
        0n
      )
      return Number(weighted / spent) / Number(BPS_WAD)
    }
    const drainConfig = (overrides: Partial<LadderConfig> = {}): LadderConfig => ({
      ...config(),
      spreadBps: 20n,
      stepBps: 10n,
      rungCount: 5,
      lowerRateBudgetAssets: 5n * RUNG_ASSETS,
      higherRateBudgetAssets: 5n * RUNG_ASSETS,
      targetMarketExposureAssets: TARGET_EXPOSURE,
      maximumTotalExposureAssets: TARGET_EXPOSURE,
      minimumOfferAssets: 1_000_000n,
      maximumRateBps: 10_000n,
      ...overrides
    })

    const drain = async (ladderConfig: LadderConfig) => {
      let cash = TARGET_EXPOSURE
      let credit = 0n
      let live: LadderQuoteSet | undefined
      const fills: { rateBps: bigint; assets: bigint }[] = []
      const readMarket = async () =>
        calculateLadderCapacities({
          marketId,
          balance: cash,
          currentCredit: credit,
          otherMarketCredit: 0n,
          creditSaleCapacityAssets: credit,
          targetMarketExposureAssets: ladderConfig.targetMarketExposureAssets,
          maximumTotalExposureAssets: ladderConfig.maximumTotalExposureAssets,
          reservations: []
        })
      const service = new LadderQuoterService(
        {
          readLendGuard: async () => ({ lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true }),
          readMarket
        },
        { readRate: async () => 500n },
        {
          readActive: async () => live,
          reconcile: async parameters => {
            live = parameters.desired
            return { submittedTransactions: [] }
          },
          cancelBuys: async () => ({ submittedTransactions: [] }),
          hardHalt: async () => {},
          cleanup: async () => {}
        },
        [validateLadderConfig(ladderConfig)]
      )
      for (let cycle = 0; cycle < 200; cycle += 1) {
        const [result] = await service.runOnce({ verbose: true })
        expect(result?.status).not.toMatch(/failed|halted/)
        expect(result?.verbose?.diagnostics?.higher.omittedAboveMaximumRungs ?? 0).toBe(0)
        expect(result?.verbose?.diagnostics?.inventorySkew?.skewClamped ?? false).toBe(false)
        const nearest = live?.higher[0]
        if (!nearest) break
        cash -= nearest.assets
        credit += faceUnits(nearest.assets, nearest.rateBps)
        fills.push({ rateBps: nearest.rateBps, assets: nearest.assets })
      }
      const spent = fills.reduce((sum, fill) => sum + fill.assets, 0n)
      return { fills, spent, weightedRateBps: spendWeightedBps(fills) }
    }

    const sweepRateBps = (size: bigint) => {
      const depth = generateLadder({
        config: validateLadderConfig(
          drainConfig({
            rungCount: 40,
            lowerRateBudgetAssets: 40n * RUNG_ASSETS,
            higherRateBudgetAssets: 40n * RUNG_ASSETS,
            targetMarketExposureAssets: 40n * RUNG_ASSETS,
            maximumTotalExposureAssets: 40n * RUNG_ASSETS
          })
        ),
        referenceRateBps: 500n
      })
      let remaining = size
      const swept: { rateBps: bigint; assets: bigint }[] = []
      for (const rung of depth.higher) {
        const assets = remaining < rung.assets ? remaining : rung.assets
        if (assets > 0n) swept.push({ rateBps: rung.rateBps, assets })
        remaining -= assets
      }
      expect(remaining).toBe(0n)
      return spendWeightedBps(swept)
    }

    test('without skew, lends everything it spends at the nearest rung', async () => {
      const { fills, spent } = await drain(drainConfig())

      expect(spent).toBeGreaterThan((TARGET_EXPOSURE * 9n) / 10n)
      expect(new Set(fills.map(fill => fill.rateBps))).toEqual(new Set([510n]))
      expect(fills[0]?.assets).toBe(RUNG_ASSETS)
    })

    test('with one rung of face per step, prices the drain within one step of a sweep', async () => {
      const skewed = drainConfig({
        inventorySkew: { unitsPerStep: faceUnits(RUNG_ASSETS, 510n) }
      })
      const { fills, spent, weightedRateBps } = await drain(skewed)

      expect(spent).toBeGreaterThan((TARGET_EXPOSURE * 9n) / 10n)
      expect(fills.at(-1)!.rateBps).toBeLessThan(10_000n)
      expect(weightedRateBps).toBeGreaterThan(510 + Number(skewed.stepBps))
      expect(Math.abs(weightedRateBps - sweepRateBps(spent))).toBeLessThanOrEqual(
        Number(skewed.stepBps)
      )
    })
  })
})
