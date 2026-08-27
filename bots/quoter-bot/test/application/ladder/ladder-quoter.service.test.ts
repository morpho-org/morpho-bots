import type { Hex } from 'viem'

import { describe, expect, test, vi } from 'vitest'

import type {
  LadderMakeService,
  LadderPositionService
} from '../../../src/application/ladder/ladder-quoter.service'
import type {
  LadderConfig,
  LadderMarketState,
  LadderQuoteSet
} from '../../../src/domain/ladder/ladder'

import { LadderQuoterService } from '../../../src/application/ladder/ladder-quoter.service'
import { ladderMonitoringEvents } from '../../../src/application/monitoring/ladder-monitoring.utils'
import { LadderAdapterError } from '../../../src/infrastructure/ladder/ladder-adapter.error'

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
  let reconcileFailure: Hex | undefined
  const reads: string[] = []
  const reconciliations: Array<{
    marketId: Hex
    desired?: LadderQuoteSet
    reason: string
  }> = []
  const liveDesired = new Map<Hex, LadderQuoteSet>()
  const halts: string[] = []
  const positions: LadderPositionService = {
    async readMarket(id) {
      reads.push(`market:${id}`)
      if (id === readFailure) throw new TypeError('private provider detail')
      return marketState
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
    },
    async hardHalt(parameters) {
      halts.push(parameters.reason)
    },
    cleanup
  }
  let service = new LadderQuoterService(positions, rates, make, configs)
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
    cleanupRemovedMarkets,
    cleanup,
    make,
    setRate: (value: bigint) => (rate = value),
    setObservation: (value: string) => (observationId = value),
    setMaturity: (value: bigint | undefined) => (maturitySeconds = value),
    setCapacity: (value: bigint) => (marketState = state(value)),
    failMarket: (id: Hex) => (readFailure = id),
    failReconcile: (id: Hex) => (reconcileFailure = id),
    expireRoots: (id: Hex) => liveDesired.delete(id),
    recreateService: () => (service = new LadderQuoterService(positions, rates, make, configs))
  }
}

describe('LadderQuoterService', () => {
  test('rejects an empty strategy before cleaning removed markets', async () => {
    const subject = harness([])

    await expect(subject.service.runOnce()).rejects.toMatchObject({
      name: 'LadderConfigurationError',
      field: 'ladder'
    })

    expect(subject.cleanupRemovedMarkets).not.toHaveBeenCalled()
  })

  test('reads active ownership before position capacity', async () => {
    const subject = harness()

    await subject.service.runOnce()

    expect(subject.reads.slice(0, 2)).toEqual([`active:${marketId}`, `market:${marketId}`])
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
    expect(operations).toEqual(['start', 'end', 'start', 'end', 'start', 'end', 'start', 'end'])
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

  test('stops monitoring on a handled failed cycle and still cleans owned groups', async () => {
    const subject = harness()
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
      lastCycle: [{ status: 'failed', stage: 'reconcile' }]
    })
    expect(subject.cleanup).toHaveBeenCalledTimes(1)
  })

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
    const service = new LadderQuoterService({ readMarket }, { readRate: async () => 500n }, make, [
      config()
    ])
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

  test('preflights every config before reading and hard-halts invalid configuration', async () => {
    const invalid = { ...config(secondMarketId), spreadBps: 201n }
    const subject = harness([config(), invalid])
    const result = await subject.service.runOnce()
    expect(subject.reads).toEqual([])
    expect(subject.halts).toEqual(['ladder-configuration-failed'])
    expect(result.at(-1)).toMatchObject({ status: 'halted', stage: 'configuration' })
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
        hardHalt: async () => ({ submittedTransactions: [] }),
        cleanup: async () => ({ submittedTransactions: [] })
      },
      [config()]
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
        async hardHalt(parameters) {
          subject.halts.push(parameters.reason)
        },
        async cleanup() {
          subject.liveDesired.clear()
        }
      },
      [config()]
    )
    const result = await subject.service.runOnce()
    expect(subject.halts).toEqual(['reference-read-failed'])
    expect(result).toMatchObject([{ status: 'halted' }])
  })

  test('retains strategy-wide hard-halt settlements for verbose monitoring', async () => {
    const cancellationHash: Hex = `0x${'ee'.repeat(32)}`
    const service = new LadderQuoterService(
      {
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
        async hardHalt() {
          return { submittedTransactions: [{ operation: 'cancel', txHash: cancellationHash }] }
        },
        async cleanup() {}
      },
      [config()]
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

  test('publishes bound-clamped rungs instead of halting on a reference excursion', async () => {
    const subject = harness()
    subject.setRate(801n)
    const result = await subject.service.runOnce()
    expect(subject.halts).toEqual([])
    expect(result).toMatchObject([{ status: 'applied', action: 'publish' }])
    expect(subject.reconciliations[0]?.desired?.higher.map(rung => rung.rateBps)).toEqual([
      901n,
      1_000n,
      1_000n
    ])
    expect(subject.reconciliations[0]?.desired?.lower.map(rung => rung.rateBps)).toEqual([
      701n,
      601n,
      501n
    ])
  })
})
