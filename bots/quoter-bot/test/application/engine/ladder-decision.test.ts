import type { Hex } from 'viem'

import { describe, expect, test } from 'vitest'

import type { LiveView, Observed, Prepared } from '../../../src/application/engine/decision'
import type {
  LadderActPayload,
  LadderPrepareAnswer
} from '../../../src/application/engine/ladder-decision'
import type { LadderReading, ReferenceReading } from '../../../src/application/engine/readings'
import type { LadderConfig, LadderMarketState, LadderQuoteSet } from '../../../src/domain/ladder'

import {
  advanceCrossings,
  decideLadder,
  ladderIdentity,
  ladderPrepareRequest
} from '../../../src/application/engine/ladder-decision'
import { generateLadder, validateLadderConfig } from '../../../src/domain/ladder'

const marketId: Hex = `0x${'55'.repeat(32)}`
const config = (overrides: Partial<LadderConfig> = {}) =>
  validateLadderConfig({
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
    loopIntervalSeconds: 3600,
    bookCrossedCooldownSeconds: 180,
    movementToleranceBps: 10n,
    minimumRateBps: 0n,
    maximumRateBps: 1_000n,
    ...overrides
  })

const capacities = (capacity = 20n): LadderMarketState => ({
  lowerRateCapacityAssets: capacity,
  higherRateCapacityAssets: capacity,
  targetMarketCapacityAssets: capacity,
  maximumTotalCapacityAssets: capacity
})

const reading = (
  overrides: Partial<{
    guard: LadderReading['guard']
    active?: LadderQuoteSet
    activeRead: LadderReading['active']
    market: LadderReading['market']
  }> = {}
): LadderReading => ({
  strategy: 'ladder',
  marketId,
  block: 100,
  guard: overrides.guard ?? {
    ok: true,
    value: { lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true }
  },
  active: overrides.activeRead ?? {
    ok: true,
    value: { ...(overrides.active ? { quote: overrides.active } : {}), consumption: [] }
  },
  market: overrides.market ?? { ok: true, value: capacities() }
})

const reference = (
  rateBps = 500n,
  observationId = 'static:500:hour:1'
): Observed<ReferenceReading> => ({
  status: 'ready',
  value: { ok: true, value: { mode: 'static', rateBps, observationId } }
})

const view = (live: readonly { id: string; buy: boolean }[] = []): LiveView => ({
  live: live.map(group => ({
    id: group.id,
    state: 'live',
    detail: { groupId: group.id, buy: group.buy }
  }))
})

const quoteAt = (rateBps: bigint, observationId = 'static:500:hour:1') => ({
  ...generateLadder({ config: config(), referenceRateBps: rateBps, capacities: capacities() }),
  referenceObservationId: observationId
})

const pending: Prepared<LadderPrepareAnswer> = { status: 'pending' }
const prepared = (quote: LadderQuoteSet, applied = true): Prepared<LadderPrepareAnswer> => ({
  status: 'ready',
  value: {
    ok: true,
    value: {
      reconciliation: {
        applied,
        preparedAtTimestamp: 1_000n,
        bookCrossing: {
          lower: { crossed: false, clearable: false },
          higher: { crossed: true, clearable: true }
        }
      },
      publication: { quote, groups: [], witness: [] as never }
    }
  }
})

const decide = (
  input: Partial<Parameters<typeof decideLadder>[0]> & { reading?: LadderReading } = {}
) =>
  decideLadder({
    config: config(),
    reading: reading(),
    reference: reference(),
    view: view(),
    crossings: {},
    prepare: pending,
    ...input
  })

const live = [
  { id: 'sell', buy: false },
  { id: 'buy', buy: true }
]

describe('a ladder market decision', () => {
  test('cancels only its buys while lending is halted, and keeps its sells live', () => {
    const halted = decide({
      reading: reading({
        guard: { ok: true, value: { lossFactor: 7n, acceptedLossFactor: 0n, defaulted: true } }
      }),
      view: view(live)
    })
    expect(halted.keep).toStrictEqual(['sell'])
    expect(halted.act?.kind).toBe('cancel')
    expect(halted.act?.payload).toMatchObject({
      cancel: ['buy'],
      report: { status: 'applied', action: 'lend-halted', reason: 'loss-factor-mismatch' }
    })
    expect(halted.detail).toMatchObject({
      workflow: 'ladder',
      marketId,
      status: 'observed',
      action: 'queued',
      reason: 'loss-factor-mismatch',
      lossFactor: 7n
    })
  })

  test('cancels its buys when the guard cannot be read, and rests once none is left', () => {
    const guard = {
      ok: false as const,
      errorName: 'LadderAdapterError',
      adapterOperation: 'loss-factor-read' as const
    }
    expect(decide({ reading: reading({ guard }), view: view(live) }).act?.payload).toMatchObject({
      cancel: ['buy']
    })
    const rested = decide({ reading: reading({ guard }), view: view([live[0]!]) })
    expect(rested.act).toBeUndefined()
    expect(rested.detail).toMatchObject({ status: 'failed', stage: 'guard-read' })
  })

  test('cancels every live group, sells too, when the guard failed with its position read', () => {
    const failure = {
      ok: false as const,
      errorName: 'LadderAdapterError',
      adapterOperation: 'position-unavailable' as const
    }
    const decision = decide({
      reading: reading({ guard: failure, market: failure }),
      view: view(live)
    })
    expect(decision.act?.payload).toMatchObject({ cancel: ['sell', 'buy'] })
    expect(decision.detail).toMatchObject({ status: 'failed', stage: 'market-read' })
  })

  test('halts the bot when the active quote cannot be reconstructed', () => {
    const decision = decide({
      reading: reading({ activeRead: { ok: false, errorName: 'LadderAdapterError' } })
    })
    expect(decision.halt).toBe('ladder-decision-failed')
  })

  test('cancels every live group of a market whose read failed, or that matured', () => {
    const failed = decide({
      reading: reading({ market: { ok: false, errorName: 'UnknownError' } }),
      view: view(live)
    })
    expect(failed.act?.payload).toMatchObject({ cancel: ['sell', 'buy'] })
    expect(failed.detail).toMatchObject({ status: 'failed', stage: 'market-read' })
    const matured = decide({
      reading: reading({
        market: {
          ok: true,
          value: { ...capacities(), maturityTimestamp: 10n, observedTimestamp: 10n }
        }
      }),
      view: view(live)
    })
    expect(matured.act?.payload).toMatchObject({
      cancel: ['sell', 'buy'],
      report: { action: 'matured' }
    })
    expect(matured.detail).toMatchObject({ status: 'observed', action: 'queued' })
  })

  test('waits for a reference not yet read, and halts the bot when one fails', () => {
    const waiting = decide({ reference: { status: 'unobserved' }, view: view(live) })
    expect(waiting).toMatchObject({ keep: ['sell', 'buy'], steady: false })
    expect(waiting.halt).toBeUndefined()
    const failed = decide({
      reference: { status: 'ready', value: { ok: false, errorName: 'ReferenceAdapterError' } }
    })
    expect(failed.halt).toBe('reference-read-failed')
  })

  test('halts the bot when a maturity premium has no observation to price it', () => {
    expect(
      decide({
        config: config({ maturityPremium: { kind: 'linear', bpsPerYear: 100n } as never })
      }).halt
    ).toBe('ladder-decision-failed')
  })

  test('publishes a first quote only once it is prepared, and desires it throughout', () => {
    const preparing = decide()
    expect(preparing.act).toBeUndefined()
    expect(preparing.detail).toMatchObject({ status: 'observed', action: 'preparing' })
    const desired = ladderIdentity(quoteAt(500n))
    expect(preparing.desire).toBe(desired)
    const publishing = decide({ prepare: prepared(quoteAt(500n)) })
    expect(publishing.act).toMatchObject({ kind: 'replace', identity: desired })
    expect(publishing.act?.payload).toMatchObject({
      cancel: [],
      report: { status: 'applied', action: 'publish', reason: 'publish' }
    })
    expect(publishing.detail).toMatchObject({
      status: 'observed',
      action: 'queued',
      reason: 'publish'
    })
  })

  test('rests an unchanged quote, and keeps every live group affirmed', () => {
    const rest = decide({ reading: reading({ active: quoteAt(500n) }), view: view(live) })
    expect(rest).toMatchObject({ keep: ['sell', 'buy'], steady: true })
    expect(rest.act).toBeUndefined()
    expect(rest.detail).toMatchObject({ status: 'observed', action: 'rest' })
  })

  test('reports what it read and derived as facts, whatever it decides', () => {
    const rest = decide({ reading: reading({ active: quoteAt(500n) }), view: view(live) })
    expect(rest.detail.facts).toMatchObject({
      bounds: { minimumRateBps: 0n, maximumRateBps: 1_000n },
      referenceRateBps: 500n,
      targetRateBps: 500n,
      market: capacities(),
      activeQuote: quoteAt(500n),
      groupConsumption: []
    })
    const failed = decide({
      reading: reading({ market: { ok: false, errorName: 'UnknownError' } })
    })
    expect(failed.detail.facts).not.toHaveProperty('market')
    expect(failed.detail.facts).not.toHaveProperty('targetRateBps')
  })

  test('never reports an act as applied before the kernel settles it', () => {
    const decisions = [
      decide({ prepare: prepared(quoteAt(500n)) }),
      decide({ reading: reading({ market: { ok: false, errorName: 'X' } }), view: view(live) }),
      decide({
        reading: reading({ active: quoteAt(500n), market: { ok: true, value: capacities(0n) } }),
        view: view(live)
      })
    ]
    for (const decision of decisions) {
      expect(decision.act).toBeDefined()
      expect(decision.detail.status).not.toBe('applied')
    }
    expect(decisions[1]!.detail).toMatchObject({ status: 'failed', stage: 'market-read' })
  })

  test('republishes when the reference observation rolls, even at an unchanged rate', () => {
    const rolled = decide({
      reading: reading({ active: quoteAt(500n, 'static:500:hour:0') }),
      view: view(live),
      prepare: prepared(quoteAt(500n))
    })
    expect(rolled.act?.payload).toMatchObject({
      cancel: ['sell', 'buy'],
      report: { reason: 'resize' }
    })
    expect(rolled.detail).toMatchObject({ reason: 'resize' })
  })

  test('recenters past the tolerance, and resizes at the retained center inside it', () => {
    const recenter = decide({
      reading: reading({ active: quoteAt(500n) }),
      reference: reference(520n),
      view: view(live),
      prepare: prepared(quoteAt(520n))
    })
    expect(recenter.detail).toMatchObject({ reason: 'recenter' })
    const inside = decide({
      reading: reading({ active: quoteAt(500n), market: { ok: true, value: capacities(6n) } }),
      reference: reference(505n),
      view: view(live),
      prepare: prepared(quoteAt(500n))
    })
    expect(inside.detail).toMatchObject({ reason: 'resize' })
    expect(inside.desire).toContain(`|${quoteAt(500n).centerRateBps}|`)
  })

  test('upgrades a resting ladder to a replacement for a clearable crossing, outside its cooldown', () => {
    const crossed = {
      ...capacities(),
      observedTimestamp: 2_000n,
      bookCrossing: {
        lower: { crossed: false, clearable: false },
        higher: { crossed: true, clearable: true }
      }
    }
    const input = {
      config: config(),
      reading: reading({ active: quoteAt(500n), market: { ok: true, value: crossed } }),
      reference: reference(),
      view: view(live)
    }
    expect(ladderPrepareRequest({ ...input, crossings: {} })).toMatchObject({
      reason: 'book-crossed',
      bookCrossedSides: ['higher'],
      block: 100
    })
    expect(
      ladderPrepareRequest({
        ...input,
        reading: { ...input.reading, block: 101 },
        crossings: {}
      })
    ).toMatchObject({ block: 101 })
    expect(ladderPrepareRequest({ ...input, crossings: { higher: 1_900n } })).toBeUndefined()
    const cleared = decide({ ...input, prepare: prepared(quoteAt(500n), false) })
    expect(cleared).toMatchObject({ steady: true, keep: ['sell', 'buy'] })
    expect(cleared.act).toBeUndefined()
  })

  test('keeps the live ladder when its replacement cannot be prepared', () => {
    const failed = decide({
      reading: reading({ active: quoteAt(500n) }),
      reference: reference(520n),
      view: view(live),
      prepare: {
        status: 'ready',
        value: { ok: false, errorName: 'LadderAdapterError', adapterOperation: 'negative-spread' }
      }
    })
    expect(failed.act).toBeUndefined()
    expect(failed.keep).toStrictEqual(['sell', 'buy'])
    expect(failed.detail).toMatchObject({
      status: 'failed',
      stage: 'reconcile',
      adapterOperation: 'negative-spread'
    })
  })

  test('cancels a live ladder whose sides both fell below the offer floor', () => {
    const empty = decide({
      reading: reading({ active: quoteAt(500n), market: { ok: true, value: capacities(0n) } }),
      view: view(live)
    })
    expect(empty.act?.payload).toMatchObject({ cancel: ['sell', 'buy'] })
  })

  test('asks for no preparation while the ladder rests', () => {
    expect(
      ladderPrepareRequest({
        config: config(),
        reading: reading({ active: quoteAt(500n) }),
        reference: reference(),
        view: view(live),
        crossings: {}
      })
    ).toBeUndefined()
  })
})

describe('the cooldown history', () => {
  test('records only the sides a settled replacement saw crossed and clearable', () => {
    const payload = {
      cancel: [],
      publication: { quote: quoteAt(500n), groups: [], witness: [] },
      reconciliation: {
        applied: true,
        preparedAtTimestamp: 1_000n,
        bookCrossing: {
          lower: { crossed: true, clearable: false },
          higher: { crossed: true, clearable: true }
        }
      },
      report: { status: 'applied' }
    } as unknown as LadderActPayload
    expect(advanceCrossings({ lower: 5n }, payload)).toStrictEqual({ lower: 5n, higher: 1_000n })
    expect(
      advanceCrossings({ lower: 5n }, { cancel: [], report: { status: 'applied' } })
    ).toStrictEqual({
      lower: 5n
    })
  })
})

const identityQuote = (overrides: Partial<LadderQuoteSet> = {}): LadderQuoteSet => ({
  marketId,
  centerRateBps: 500n,
  groupMode: 'shared-rung',
  lower: [{ index: 0, rateBps: 400n, assets: 10n }],
  higher: [{ index: 0, rateBps: 600n, assets: 10n }],
  ...overrides
})

const same = (left: LadderQuoteSet, right: LadderQuoteSet) =>
  ladderIdentity(left) === ladderIdentity(right)

describe('ladderIdentity', () => {
  test('rests an unchanged quote', () => {
    expect(same(identityQuote(), identityQuote())).toBe(true)
    expect(
      same(
        identityQuote({ referenceObservationId: 'blue:19000000' }),
        identityQuote({ referenceObservationId: 'blue:19000000' })
      )
    ).toBe(true)
  })

  test('reconciles when the center moves', () => {
    expect(same(identityQuote(), identityQuote({ centerRateBps: 501n }))).toBe(false)
  })

  test('reconciles when the reference observation moves', () => {
    expect(
      same(
        identityQuote({ referenceObservationId: 'blue:19000000' }),
        identityQuote({ referenceObservationId: 'blue:19000001' })
      )
    ).toBe(false)
    expect(same(identityQuote({ referenceObservationId: 'blue:19000000' }), identityQuote())).toBe(
      false
    )
  })

  test('reconciles when a rung rate, size, or count changes', () => {
    expect(
      same(identityQuote(), identityQuote({ higher: [{ index: 0, rateBps: 601n, assets: 10n }] }))
    ).toBe(false)
    expect(
      same(identityQuote(), identityQuote({ lower: [{ index: 0, rateBps: 400n, assets: 11n }] }))
    ).toBe(false)
    expect(
      same(
        identityQuote(),
        identityQuote({
          lower: [
            { index: 0, rateBps: 400n, assets: 10n },
            { index: 1, rateBps: 300n, assets: 10n }
          ]
        })
      )
    ).toBe(false)
  })

  test('reconciles when the group mode changes', () => {
    expect(same(identityQuote(), identityQuote({ groupMode: 'per-book' }))).toBe(false)
  })
})

const debtConfig = config({
  debt: { maximumDebtUnits: 20n, stopBorrowingBeforeMaturitySeconds: 100 }
})
const atTime = (observedTimestamp?: bigint): LadderReading['market'] => ({
  ok: true,
  value: {
    ...capacities(),
    maturityTimestamp: 1_000n,
    ...(observedTimestamp === undefined ? {} : { observedTimestamp })
  }
})

test('debt mode changes quote equality and the framework authorization identity', () => {
  const legacy = quoteAt(500n)
  const borrowing = { ...legacy, debtCapable: true as const }
  expect(ladderIdentity(legacy)).not.toBe(ladderIdentity(borrowing))
  const next = decideLadder({
    config: debtConfig,
    reading: reading({ active: legacy, market: atTime(0n) }),
    reference: reference(),
    view: view([{ id: 'old', buy: false }]),
    crossings: {},
    prepare: prepared(borrowing)
  })
  expect(next.act).toMatchObject({
    kind: 'replace',
    payload: { cancel: ['old'], publication: { quote: { debtCapable: true } } }
  })
})

describe('the borrowing cutoff', () => {
  const borrowing = { ...quoteAt(500n), debtCapable: true as const }
  const closed = quoteAt(500n)
  const at = (observedTimestamp: bigint | undefined, active: LadderQuoteSet) =>
    decideLadder({
      config: debtConfig,
      reading: reading({ active, market: atTime(observedTimestamp) }),
      reference: reference(),
      view: view(live),
      crossings: {},
      prepare: pending
    })

  test('rests on a borrowing ladder before the cutoff', () => {
    expect(at(899n, borrowing).act).toBeUndefined()
    expect(ladderPrepareRequest({ ...inputs(899n, borrowing) })).toBeUndefined()
  })

  test('republishes once without borrowing at and after the cutoff', () => {
    for (const time of [900n, 950n]) {
      const request = ladderPrepareRequest(inputs(time, borrowing))
      expect(request?.reason).toBe('resize')
      expect(request?.desired).not.toHaveProperty('debtCapable')
      expect(at(time, borrowing).detail).toMatchObject({ action: 'preparing' })
    }
    expect(at(950n, closed).act).toBeUndefined()
    expect(ladderPrepareRequest(inputs(950n, closed))).toBeUndefined()
  })

  test('treats an unknown block time as closed', () => {
    expect(ladderPrepareRequest(inputs(undefined, borrowing))?.desired).not.toHaveProperty(
      'debtCapable'
    )
    expect(ladderPrepareRequest(inputs(undefined, closed))).toBeUndefined()
  })

  test('signs nothing when preparation finds borrowing closed at its own block', () => {
    const next = decideLadder({
      ...inputs(0n, closed),
      prepare: {
        status: 'ready',
        value: { ok: false, errorName: 'LadderAdapterError', adapterOperation: 'borrowing-closed' }
      }
    })

    expect(next.act).toBeUndefined()
    expect(next.keep).toStrictEqual(['sell', 'buy'])
    expect(next.detail).toMatchObject({ adapterOperation: 'borrowing-closed' })
  })

  const inputs = (observedTimestamp: bigint | undefined, active: LadderQuoteSet) => ({
    config: debtConfig,
    reading: reading({ active, market: atTime(observedTimestamp) }),
    reference: reference(),
    view: view(live),
    crossings: {}
  })
})
