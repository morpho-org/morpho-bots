import type { Hex } from 'viem'

import { MAX_OFFER_CAP } from '@morpho-org/midnight-sdk'
import { describe, expect, test } from 'vitest'

import type { LadderRunResult } from '../../../src/application/ladder/ladder-quoter.service'
import type { LadderBookSideCrossing } from '../../../src/domain/ladder'

import {
  createLadderConsumptionBaselines,
  ladderConsumptionEvents,
  ladderMonitoringEvents
} from '../../../src/application/monitoring/ladder-monitoring.utils'
import {
  generateLadderWithDiagnostics,
  validateLadderConfig,
  withBootstrapSellCeiling
} from '../../../src/domain/ladder'

const marketId = `0x${'11'.repeat(32)}` as const

const sighting = (groupId: Hex, consumed: bigint): LadderRunResult =>
  ({
    marketId,
    status: 'observed',
    action: 'rest',
    verbose: {
      config: { marketId },
      currentState: { status: 'observed', market: {} },
      stateAfterCheck: { status: 'observed', market: {} },
      groupConsumption: [
        {
          groupId,
          marketId,
          side: 'higher',
          groupRateBps: 500n,
          maxUnits: 1_000n,
          consumed,
          remainingUnits: 1_000n - consumed
        }
      ]
    }
  }) as unknown as LadderRunResult

const groupId = (index: number): Hex => `0x${index.toString(16).padStart(64, '0')}`

describe('ladderConsumptionEvents baselines', () => {
  test('evicts a baseline only long after the group stops appearing', () => {
    const baselines = createLadderConsumptionBaselines()
    ladderConsumptionEvents([sighting(groupId(1), 100n)], baselines)

    for (let cycle = 0; cycle < 400; cycle += 1) ladderConsumptionEvents([], baselines)

    expect(baselines.groups.has(groupId(1))).toBe(true)
    expect(ladderConsumptionEvents([sighting(groupId(1), 160n)], baselines)).toContainEqual(
      expect.objectContaining({ consumedDeltaUnits: 60n })
    )
  })

  test('reports fills and remaining capacity in credit units', () => {
    const baselines = createLadderConsumptionBaselines()
    ladderConsumptionEvents([sighting(groupId(1), 100n)], baselines)

    expect(ladderConsumptionEvents([sighting(groupId(1), 160n)], baselines)).toEqual([
      expect.objectContaining({ consumedDeltaUnits: 60n, remainingUnits: 840n })
    ])
  })

  test('never reports a cancellation as a fill', () => {
    const baselines = createLadderConsumptionBaselines()
    ladderConsumptionEvents([sighting(groupId(1), 100n)], baselines)

    expect(ladderConsumptionEvents([sighting(groupId(1), MAX_OFFER_CAP)], baselines)).toEqual([])
  })

  test('bounds memory when reconciliation keeps reserving fresh group ids', () => {
    const baselines = createLadderConsumptionBaselines()
    for (let cycle = 1; cycle <= 2_000; cycle += 1) {
      ladderConsumptionEvents([sighting(groupId(cycle), 10n)], baselines)
    }

    expect(baselines.groups.size).toBeLessThanOrEqual(501)
  })
})

const crossingResult = (
  before: Record<'lower' | 'higher', LadderBookSideCrossing>,
  after: Record<'lower' | 'higher', LadderBookSideCrossing>
): LadderRunResult =>
  ({
    marketId,
    status: 'observed',
    action: 'rest',
    verbose: {
      config: { marketId },
      currentState: { status: 'observed', market: { bookCrossing: before } },
      stateAfterCheck: { status: 'observed', market: { bookCrossing: after } }
    }
  }) as unknown as LadderRunResult

const uncrossed: Record<'lower' | 'higher', LadderBookSideCrossing> = {
  lower: { crossed: false, clearable: true },
  higher: { crossed: false, clearable: true }
}

describe('guardrail.book-crossed', () => {
  test('reports the pre-decision cross a completed replacement already cleared', () => {
    const events = ladderMonitoringEvents([
      crossingResult(
        { lower: { crossed: true, clearable: true }, higher: uncrossed.higher },
        uncrossed
      )
    ])

    expect(events.filter(event => event.event === 'guardrail.book-crossed')).toEqual([
      {
        event: 'guardrail.book-crossed',
        workflow: 'ladder',
        marketId,
        side: 'lower',
        clearable: true,
        suppressed: false
      }
    ])
  })

  test('reports every crossed side and its feasibility separately', () => {
    const events = ladderMonitoringEvents([
      crossingResult(
        {
          lower: { crossed: true, clearable: false },
          higher: { crossed: true, clearable: true }
        },
        uncrossed
      )
    ])

    expect(events.filter(event => event.event === 'guardrail.book-crossed')).toEqual([
      expect.objectContaining({ side: 'lower', clearable: false }),
      expect.objectContaining({ side: 'higher', clearable: true })
    ])
  })

  test('stays silent when no side is crossed', () => {
    const events = ladderMonitoringEvents([crossingResult(uncrossed, uncrossed)])

    expect(events.some(event => event.event === 'guardrail.book-crossed')).toBe(false)
  })

  test('reports the cooldown suppression the decision recorded', () => {
    const result = {
      marketId,
      status: 'observed',
      action: 'rest',
      verbose: {
        config: { marketId },
        currentState: { status: 'observed', market: { bookCrossing: uncrossed } },
        stateAfterCheck: { status: 'observed', market: { bookCrossing: uncrossed } },
        bookCrossing: {
          lower: { crossed: true, clearable: true, suppressed: true },
          higher: { crossed: false, clearable: true, suppressed: false }
        }
      }
    } as unknown as LadderRunResult

    expect(
      ladderMonitoringEvents([result]).filter(event => event.event === 'guardrail.book-crossed')
    ).toEqual([
      {
        event: 'guardrail.book-crossed',
        workflow: 'ladder',
        marketId,
        side: 'lower',
        clearable: true,
        suppressed: true
      }
    ])
  })

  test('carries the new book-crossed reason onto the completed cycle', () => {
    const events = ladderMonitoringEvents([
      { marketId, status: 'applied', action: 'replace', reason: 'book-crossed' }
    ])

    expect(events).toContainEqual({
      event: 'cycle.completed',
      workflow: 'ladder',
      marketId,
      status: 'applied',
      action: 'replace',
      reason: 'book-crossed'
    })
  })
})

describe('cycle.completed snapshot failures', () => {
  test('ships the allowlisted snapshot cause beside the snapshot-unavailable operation', () => {
    const [cycle] = ladderMonitoringEvents([
      {
        marketId,
        status: 'failed',
        stage: 'reconcile',
        invalidated: true,
        errorName: 'LadderAdapterError',
        adapterOperation: 'snapshot-unavailable',
        snapshotErrorOperation: 'missing-owned-group-intent'
      }
    ])

    expect(cycle).toMatchObject({
      event: 'cycle.completed',
      adapterOperation: 'snapshot-unavailable',
      snapshotErrorOperation: 'missing-owned-group-intent'
    })
  })

  test('omits the cause when the snapshot failure carried none', () => {
    const [cycle] = ladderMonitoringEvents([
      {
        marketId,
        status: 'failed',
        stage: 'reconcile',
        invalidated: false,
        errorName: 'HttpRequestError',
        adapterOperation: 'snapshot-unavailable'
      }
    ])

    expect(cycle).not.toHaveProperty('snapshotErrorOperation')
  })
})

describe('guardrail.halted', () => {
  test('ships the allowlisted adapter operation beside the collapsed error name', () => {
    const events = ladderMonitoringEvents([
      {
        marketId,
        status: 'halted',
        stage: 'reference-read',
        strategyInvalidated: true,
        errorName: 'ReferenceAdapterError',
        adapterOperation: 'reference-history'
      }
    ])

    expect(events).toEqual([
      {
        event: 'cycle.completed',
        workflow: 'ladder',
        marketId,
        status: 'halted',
        stage: 'reference-read',
        errorName: 'ReferenceAdapterError',
        adapterOperation: 'reference-history'
      },
      {
        event: 'guardrail.halted',
        workflow: 'ladder',
        marketId,
        stage: 'reference-read',
        reason: 'ReferenceAdapterError',
        strategyInvalidated: true,
        adapterOperation: 'reference-history'
      }
    ])
  })

  test('omits the field when the failure carried no allowlisted operation', () => {
    const events = ladderMonitoringEvents([
      {
        marketId,
        status: 'halted',
        stage: 'reference-read',
        strategyInvalidated: false,
        errorName: 'HttpRequestError'
      }
    ])

    expect(events.every(event => !('adapterOperation' in event))).toBe(true)
  })
})

describe('guardrail.rate-omitted', () => {
  const omissionResult = (
    referenceRateBps: bigint,
    bootstrapMinimumRateBps?: bigint
  ): LadderRunResult => {
    const shape = validateLadderConfig({
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
      loopIntervalSeconds: 60,
      bookCrossedCooldownSeconds: 60,
      movementToleranceBps: 0n,
      minimumRateBps: 200n,
      maximumRateBps: 800n
    })
    const config =
      bootstrapMinimumRateBps === undefined
        ? shape
        : withBootstrapSellCeiling(shape, bootstrapMinimumRateBps)
    const { diagnostics } = generateLadderWithDiagnostics({ config, referenceRateBps })
    return {
      marketId,
      status: 'observed',
      action: 'rest',
      verbose: {
        config,
        currentState: { status: 'observed', market: {} },
        stateAfterCheck: { status: 'observed', market: {} },
        referenceRateBps,
        diagnostics
      }
    } as unknown as LadderRunResult
  }
  const omitted = (result: LadderRunResult) =>
    ladderMonitoringEvents([result]).filter(event => event.event === 'guardrail.rate-omitted')

  test('reports each side and bound with the omitted rungs, assets, and outermost rate', () => {
    expect(omitted(omissionResult(350n))).toEqual([
      {
        event: 'guardrail.rate-omitted',
        workflow: 'ladder',
        marketId,
        side: 'lower',
        omittedRungs: 2,
        omittedAssets: 7n,
        bound: 'minimum',
        outermostRateBps: 50n,
        referenceRateBps: 350n,
        minimumRateBps: 200n,
        maximumRateBps: 800n
      }
    ])
    expect(omitted(omissionResult(650n))).toEqual([
      expect.objectContaining({
        side: 'higher',
        omittedRungs: 2,
        omittedAssets: 7n,
        bound: 'maximum',
        outermostRateBps: 950n
      })
    ])
  })

  test('stays silent while every rung is admissible', () => {
    expect(omitted(omissionResult(500n))).toEqual([])
  })

  test('names the bootstrap sell ceiling apart from the range maximum', () => {
    expect(omitted(omissionResult(500n, 360n))).toEqual([
      {
        event: 'guardrail.rate-omitted',
        workflow: 'ladder',
        marketId,
        side: 'lower',
        omittedRungs: 1,
        omittedAssets: 3n,
        bound: 'sell-ceiling',
        outermostRateBps: 400n,
        referenceRateBps: 500n,
        minimumRateBps: 200n,
        maximumRateBps: 800n,
        maximumSellRateBps: 350n
      }
    ])
  })
})
