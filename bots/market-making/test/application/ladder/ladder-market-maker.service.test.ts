import type { Hex } from 'viem'

import { describe, expect, mock, test } from 'bun:test'

import type {
  LadderMakeService,
  LadderPositionService,
  LadderReferenceRateService
} from '../../../src/application/ladder/ladder-market-maker.service'
import type {
  LadderConfig,
  LadderMarketState,
  LadderQuoteSet
} from '../../../src/domain/ladder/ladder'

import { LadderMarketMakerService } from '../../../src/application/ladder/ladder-market-maker.service'

const marketId: Hex = `0x${'55'.repeat(32)}`
const secondMarketId: Hex = `0x${'66'.repeat(32)}`
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
  const rates: LadderReferenceRateService = {
    async readRate(id) {
      reads.push(`rate:${id}`)
      return rate
    }
  }
  const cleanup = mock(async () => {
    liveDesired.clear()
  })
  const make: LadderMakeService = {
    async readActive(id) {
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
  let service = new LadderMarketMakerService(positions, rates, make, configs)
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
    cleanup,
    setRate: (value: bigint) => (rate = value),
    setCapacity: (value: bigint) => (marketState = state(value)),
    failMarket: (id: Hex) => (readFailure = id),
    failReconcile: (id: Hex) => (reconcileFailure = id),
    expireRoots: (id: Hex) => liveDesired.delete(id),
    recreateService: () => (service = new LadderMarketMakerService(positions, rates, make, configs))
  }
}

describe('LadderMarketMakerService', () => {
  test('monitors sequential cycles and cleans owned groups after shutdown', async () => {
    const subject = harness([{ ...config(), loopIntervalSeconds: 1 }])
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

    expect(report).toEqual({
      status: 'stopped',
      reason: 'signal',
      cycles: 2,
      cleanup: { status: 'applied' }
    })
    expect(cycles).toHaveLength(2)
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
    const readMarket = mock(async () => state())
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
    const service = new LadderMarketMakerService(
      { readMarket },
      { readRate: async () => 500n },
      make,
      [config()]
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

  test('hard-halts when a fresh effective center is unsafe inside a wide tolerance', async () => {
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

    expect(await subject.service.runOnce()).toMatchObject([
      { status: 'halted', stage: 'decision', strategyInvalidated: true }
    ])
    expect(subject.halts).toEqual(['ladder-decision-failed'])
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

  test.each([
    ['reference read', 'reference-read-failed'],
    ['runtime bounds', 'ladder-decision-failed']
  ])('hard-halts on %s', async (failure, reason) => {
    const subject = harness()
    if (failure === 'reference read') {
      subject.service = new LadderMarketMakerService(
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
    } else subject.setRate(801n)
    const result = await subject.service.runOnce()
    expect(subject.halts).toEqual([reason])
    expect(result).toMatchObject([{ status: 'halted' }])
  })
})
