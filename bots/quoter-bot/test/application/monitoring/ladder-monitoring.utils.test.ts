import type { Hex } from 'viem'

import { MAX_OFFER_CAP } from '@morpho-org/midnight-sdk'
import { describe, expect, test } from 'vitest'

import type { LadderFacts } from '../../../src/application/engine/market-report'
import type { LadderConsumptionBaselines } from '../../../src/application/monitoring/ladder-monitoring.utils'

import {
  ladderConsumptionEvents,
  ladderFactEvents
} from '../../../src/application/monitoring/ladder-monitoring.utils'
import { generateLadderWithDiagnostics, validateLadderConfig } from '../../../src/domain/ladder'

const marketId = `0x${'11'.repeat(32)}` as const
const bounds = { minimumRateBps: 200n, maximumRateBps: 800n }

const sighting = (groupId: Hex, consumed: bigint) => [
  {
    groupId,
    marketId,
    side: 'higher' as const,
    groupRateBps: 500n,
    maxUnits: 1_000n,
    consumed,
    remainingUnits: 1_000n - consumed
  }
]

const groupId = (index: number): Hex => `0x${index.toString(16).padStart(64, '0')}`
const baselines = (): LadderConsumptionBaselines => ({ groups: new Map(), poll: 0 })

describe('ladderConsumptionEvents baselines', () => {
  test('evicts a baseline only long after the group stops appearing', () => {
    const state = baselines()
    ladderConsumptionEvents(sighting(groupId(1), 100n), state)

    for (let poll = 0; poll < 400; poll += 1) ladderConsumptionEvents([], state)

    expect(state.groups.has(groupId(1))).toBe(true)
    expect(ladderConsumptionEvents(sighting(groupId(1), 160n), state)).toContainEqual(
      expect.objectContaining({ consumedDeltaUnits: 60n })
    )
  })

  test('reports fills and remaining capacity in credit units', () => {
    const state = baselines()
    ladderConsumptionEvents(sighting(groupId(1), 100n), state)

    expect(ladderConsumptionEvents(sighting(groupId(1), 160n), state)).toEqual([
      expect.objectContaining({ consumedDeltaUnits: 60n, remainingUnits: 840n })
    ])
  })

  test('never reports a cancellation as a fill', () => {
    const state = baselines()
    ladderConsumptionEvents(sighting(groupId(1), 100n), state)

    expect(ladderConsumptionEvents(sighting(groupId(1), MAX_OFFER_CAP), state)).toEqual([])
  })

  test('bounds memory when reconciliation keeps reserving fresh group ids', () => {
    const state = baselines()
    for (let poll = 1; poll <= 2_000; poll += 1)
      ladderConsumptionEvents(sighting(groupId(poll), 10n), state)

    expect(state.groups.size).toBeLessThanOrEqual(501)
  })
})

const uncrossed = { crossed: false, clearable: true, suppressed: false }

describe('guardrail.book-crossed', () => {
  test('reports every crossed side, its feasibility, and its cooldown suppression', () => {
    const events = ladderFactEvents(marketId, {
      bounds,
      bookCrossing: {
        lower: { crossed: true, clearable: false, suppressed: false },
        higher: { crossed: true, clearable: true, suppressed: true }
      }
    })

    expect(events.filter(event => event.event === 'guardrail.book-crossed')).toEqual([
      {
        event: 'guardrail.book-crossed',
        workflow: 'ladder',
        marketId,
        side: 'lower',
        clearable: false,
        suppressed: false
      },
      expect.objectContaining({ side: 'higher', clearable: true, suppressed: true })
    ])
  })

  test('stays silent when no side is crossed', () => {
    const events = ladderFactEvents(marketId, {
      bounds,
      bookCrossing: { lower: uncrossed, higher: uncrossed }
    })

    expect(events.some(event => event.event === 'guardrail.book-crossed')).toBe(false)
  })
})

describe('book and position records', () => {
  test('signal an empty book positively when the market was read with no quote active', () => {
    const books = ladderFactEvents(marketId, { bounds, market: {} }).filter(
      event => event.event === 'book.observed'
    )

    expect(books).toEqual([
      { event: 'book.observed', marketId, side: 'lower', state: 'empty', rungs: 0, totalUnits: 0n },
      { event: 'book.observed', marketId, side: 'higher', state: 'empty', rungs: 0, totalUnits: 0n }
    ])
  })

  test('orient best and worst rate toward the center on each side', () => {
    const books = ladderFactEvents(marketId, {
      bounds,
      market: {},
      activeQuote: {
        marketId,
        centerRateBps: 500n,
        groupMode: 'shared-rung',
        lower: [
          { index: 0, rateBps: 450n, assets: 10n },
          { index: 1, rateBps: 350n, assets: 10n }
        ],
        higher: [
          { index: 0, rateBps: 550n, assets: 10n },
          { index: 1, rateBps: 650n, assets: 10n }
        ]
      }
    }).filter(event => event.event === 'book.observed')

    expect(books).toContainEqual(
      expect.objectContaining({ side: 'lower', bestRateBps: 450n, worstRateBps: 350n })
    )
    expect(books).toContainEqual(
      expect.objectContaining({ side: 'higher', bestRateBps: 550n, worstRateBps: 650n })
    )
  })

  test('report the position read beside its capacities, and nothing without a read', () => {
    const market = { cashBalanceAssets: 10n, reservedAssets: 20n, lowerRateCapacityAssets: 30n }

    expect(
      ladderFactEvents(marketId, { bounds, market }).filter(
        event => event.event === 'position.observed'
      )
    ).toEqual([{ event: 'position.observed', marketId, ...market }])
    expect(ladderFactEvents(marketId, { bounds })).toEqual([])
  })

  test('report the reference beside the target it derived', () => {
    expect(
      ladderFactEvents(marketId, { bounds, referenceRateBps: 500n, targetRateBps: 520n })
    ).toEqual([
      {
        event: 'reference.observed',
        workflow: 'ladder',
        marketId,
        referenceRateBps: 500n,
        targetRateBps: 520n
      }
    ])
  })
})

describe('guardrail.rate-omitted', () => {
  const omissionFacts = (referenceRateBps: bigint) => {
    const config = validateLadderConfig({
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
    const { diagnostics } = generateLadderWithDiagnostics({ config, referenceRateBps })
    return {
      bounds,
      referenceRateBps,
      diagnostics
    } satisfies LadderFacts
  }
  const omitted = (facts: LadderFacts) =>
    ladderFactEvents(marketId, facts).filter(event => event.event === 'guardrail.rate-omitted')

  test('reports each side and bound with the omitted rungs, assets, and outermost rate', () => {
    expect(omitted(omissionFacts(350n))).toEqual([
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
    expect(omitted(omissionFacts(650n))).toEqual([
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
    expect(omitted(omissionFacts(500n))).toEqual([])
  })
})
