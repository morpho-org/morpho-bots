import type { Hex } from 'viem'

import { describe, expect, test } from 'vitest'

import type { BootstrapPrepareAnswer } from '../../../src/application/engine/bootstrap-decision'
import type { LiveView, Observed, Prepared } from '../../../src/application/engine/decision'
import type { BootstrapReading, ReferenceReading } from '../../../src/application/engine/readings'
import type { BootstrapConfig, BootstrapOffer } from '../../../src/domain/position-bootstrap'

import {
  bootstrapIdentity,
  bootstrapPrepareRequest,
  decideBootstrap
} from '../../../src/application/engine/bootstrap-decision'
import { validateBootstrapConfig } from '../../../src/domain/position-bootstrap'

const marketId: Hex = `0x${'11'.repeat(32)}`
const config = (overrides: Partial<BootstrapConfig> = {}) =>
  validateBootstrapConfig({
    marketId,
    creditTarget: 1_000n,
    acceptanceAssets: 100n,
    offerSize: 500n,
    premiumBps: -50n,
    maximumMarketExposure: 2_000n,
    maximumTotalExposure: 4_000n,
    minimumRateBps: 200n,
    maximumRateBps: 800n,
    autoRefill: false,
    ...overrides
  })

const position = (
  overrides: Partial<{
    credit: bigint
    activeOffer: BootstrapOffer
    lossFactor: bigint
    cashBalance: bigint
  }> = {}
): BootstrapReading['position'] => ({
  ok: true,
  value: {
    credit: overrides.credit ?? 0n,
    debt: 0n,
    lossFactor: { lossFactor: overrides.lossFactor ?? 0n, acceptedLossFactor: 0n, defaulted: true },
    cashBalance: overrides.cashBalance ?? 2_000n,
    marketExposure: 0n,
    totalExposure: 0n,
    ...(overrides.activeOffer ? { activeOffer: overrides.activeOffer } : {})
  }
})

const reading = (
  overrides: Partial<{ position: BootstrapReading['position']; completed: boolean }> = {}
): BootstrapReading => ({
  strategy: 'bootstrap',
  marketId,
  block: 50,
  position: overrides.position ?? position(),
  initialTargetCompleted: overrides.completed ?? false
})

const reference: Observed<ReferenceReading> = {
  status: 'ready',
  value: { ok: true, value: { mode: 'static', rateBps: 500n, observationId: 'static:500' } }
}

const view = (ids: readonly string[] = []): LiveView => ({
  live: ids.map(id => ({ id, state: 'live', detail: { groupId: id, buy: true } }))
})

const offer = { marketId, assets: 500n, rateBps: 450n, referenceObservationId: 'static:500' }

const decide = (input: Partial<Parameters<typeof decideBootstrap>[0]> = {}) =>
  decideBootstrap({
    config: config(),
    reading: reading(),
    reference,
    view: view(),
    prepare: { status: 'pending' },
    ...input
  })

const ready = (value: BootstrapPrepareAnswer): Prepared<BootstrapPrepareAnswer> => ({
  status: 'ready',
  value
})

describe('a bootstrap market decision', () => {
  test('publishes the sized offer once it is prepared, cancelling nothing first', () => {
    expect(
      bootstrapPrepareRequest({ config: config(), reading: reading(), reference })
    ).toMatchObject({ desiredOffer: offer, block: 50 })
    const publishing = decide({
      prepare: ready({
        ok: true,
        value: {
          offer,
          publication: { groupId: `0x${'aa'.repeat(32)}`, tick: 10n, witness: [] as never }
        }
      })
    })
    expect(publishing.act).toMatchObject({ kind: 'replace', identity: bootstrapIdentity(offer) })
    expect(publishing.act?.payload).toMatchObject({
      cancel: [],
      report: { status: 'applied', action: 'publish' }
    })
    expect(publishing.detail).toMatchObject({
      workflow: 'bootstrap',
      marketId,
      status: 'observed',
      action: 'queued'
    })
    expect(publishing.detail.facts).toStrictEqual({
      bounds: { minimumRateBps: 200n, maximumRateBps: 800n },
      creditTargetAssets: 1_000n,
      creditAssets: 0n,
      referenceRateBps: 500n,
      targetRateBps: 450n,
      diagnostics: expect.objectContaining({ cappedAssets: 500n })
    })
  })

  test('asks again for each world block, so no answer prepared earlier reaches a later decision', () => {
    const at = (block: number) =>
      bootstrapPrepareRequest({
        config: config(),
        reading: { ...reading(), block },
        reference
      })

    expect(at(51)).toEqual({ ...at(50), block: 51 })
  })

  test('reports a publication waiting on its preparation as preparing', () => {
    const preparing = decide()
    expect(preparing.act).toBeUndefined()
    expect(preparing.detail).toMatchObject({ status: 'observed', action: 'preparing' })
  })

  test('keeps a live group whose remaining cap and tick already match', () => {
    const kept = decide({
      reading: reading({ position: position({ activeOffer: { ...offer, rateBps: 440n } }) }),
      view: view(['kept', 'stale']),
      prepare: ready({ ok: true, value: { offer, retainedGroupId: 'kept' as Hex } })
    })
    expect(kept.keep).toStrictEqual(['kept'])
    expect(kept.act?.payload).toMatchObject({ cancel: ['stale'] })
  })

  test('rests on an active offer that still matches the sized offer', () => {
    const rest = decide({
      reading: reading({ position: position({ activeOffer: offer }) }),
      view: view(['live'])
    })
    expect(rest).toMatchObject({ keep: ['live'], steady: true, desire: bootstrapIdentity(offer) })
  })

  test('cancels its offer when the target is reached, and records the target as completed', () => {
    const reached = decide({
      reading: reading({ position: position({ credit: 950n, activeOffer: offer }) }),
      view: view(['live'])
    })
    expect(reached.act?.payload).toMatchObject({
      cancel: ['live'],
      report: { status: 'applied', action: 'invalidate', reason: 'target-reached' }
    })
    expect(reached.detail).toMatchObject({ status: 'observed', action: 'queued' })
  })

  test('stops refilling after the initial target without auto-refill', () => {
    const idle = decide({ reading: reading({ completed: true }) })
    expect(idle.act).toBeUndefined()
    expect(idle.detail).toMatchObject({ status: 'observed', action: 'auto-refill-disabled' })
  })

  test("cancels a lend-halted market's offer and reports the halt", () => {
    const halted = decide({
      reading: reading({ position: position({ lossFactor: 9n, activeOffer: offer }) }),
      view: view(['live'])
    })
    expect(halted.act?.payload).toMatchObject({
      cancel: ['live'],
      report: { action: 'lend-halted', reason: 'loss-factor-mismatch' }
    })
    expect(halted.detail).toMatchObject({
      action: 'queued',
      reason: 'loss-factor-mismatch',
      lossFactor: 9n
    })
  })

  test('cancels a market whose position read failed, naming a guard failure as such', () => {
    const failed = decide({
      reading: reading({
        position: {
          ok: false,
          errorName: 'BootstrapAdapterError',
          adapterOperation: 'loss-factor-read'
        }
      }),
      view: view(['live'])
    })
    expect(failed.act?.payload).toMatchObject({ cancel: ['live'] })
    expect(failed.detail).toMatchObject({ status: 'failed', stage: 'guard-read' })
    const nothingLive = decide({
      reading: reading({ position: { ok: false, errorName: 'BootstrapAdapterError' } })
    })
    expect(nothingLive.act).toBeUndefined()
    expect(nothingLive.detail).toMatchObject({ status: 'failed', stage: 'position-read' })
  })

  test("keeps a matured market's groups, observed, as before", () => {
    const matured = decide({
      reading: reading({
        position: {
          ok: true,
          value: {
            ...(position() as Extract<BootstrapReading['position'], { ok: true }>).value,
            maturityTimestamp: 10n,
            observedTimestamp: 10n
          }
        }
      }),
      view: view(['live'])
    })
    expect(matured).toMatchObject({ keep: ['live'], steady: true })
    expect(matured.detail).toMatchObject({ action: 'matured' })
  })

  test('waits for a reference it needs and has not read, and halts when one fails', () => {
    expect(decide({ reference: { status: 'unobserved' } }).halt).toBeUndefined()
    expect(
      decide({ reference: { status: 'ready', value: { ok: false, errorName: 'UnknownError' } } })
        .halt
    ).toBe('reference-read-failed')
    // A transition decides without the reference, so its failure cannot halt it.
    expect(
      decide({
        reading: reading({ completed: true }),
        reference: { status: 'ready', value: { ok: false, errorName: 'UnknownError' } }
      }).halt
    ).toBeUndefined()
  })

  test('withholds an offer whose rate window is empty, cancelling what is live', () => {
    const withheld = decide({
      view: view(['live']),
      prepare: ready({
        ok: false,
        errorName: 'BootstrapAdapterError',
        adapterOperation: 'rate-window-empty'
      })
    })
    expect(withheld.act?.payload).toMatchObject({
      cancel: ['live'],
      report: { action: 'publication-withheld', reason: 'rate-out-of-range' }
    })
    expect(withheld.detail).toMatchObject({ action: 'queued', reason: 'rate-out-of-range' })
  })

  describe('a buy the Router refuses as below its minimum offer size', () => {
    const belowMinimum = ready({
      ok: false,
      errorName: 'BootstrapMempoolValidationError',
      minimumAssets: 1_000n
    })
    const cashBound = reading({ position: position({ cashBalance: 300n }) })

    test('is withheld when wallet cash or allowance capped it, cancelling what is live', () => {
      const withheld = decide({ reading: cashBound, view: view(['live']), prepare: belowMinimum })

      expect(withheld.halt).toBeUndefined()
      expect(withheld.keep).toEqual([])
      expect(withheld.act).toMatchObject({ kind: 'cancel', condition: 'no-capacity' })
      expect(withheld.act?.payload).toStrictEqual({
        cancel: ['live'],
        report: {
          status: 'applied',
          action: 'publication-withheld',
          reason: 'below-minimum-offer',
          minimumAssets: '1000'
        }
      })
      expect(withheld.detail.facts?.diagnostics).toMatchObject({
        cap: 'cash-balance',
        cappedAssets: 300n
      })
    })

    test('is withheld with nothing to cancel when nothing is live', () => {
      const withheld = decide({ reading: cashBound, prepare: belowMinimum })

      expect(withheld).toMatchObject({ keep: [], steady: true })
      expect(withheld.act).toBeUndefined()
      expect(withheld.detail).toMatchObject({
        status: 'observed',
        action: 'publication-withheld',
        reason: 'below-minimum-offer',
        minimumAssets: '1000'
      })
    })

    test('halts under any other binding cap', () => {
      const capped = (overrides: Partial<BootstrapConfig>, cashBalance = 2_000n) =>
        decide({
          config: config(overrides),
          reading: reading({ position: position({ cashBalance }) }),
          view: view(['live']),
          prepare: belowMinimum
        })

      for (const halted of [
        capped({}),
        capped({ creditTarget: 300n }),
        capped({ maximumMarketExposure: 300n }),
        capped({}, 500n)
      ]) {
        expect(halted.halt).toBe('bootstrap-decision-failed')
        expect(halted.act).toBeUndefined()
        expect(halted.keep).toEqual(['live'])
        expect(halted.detail).toMatchObject({
          status: 'halted',
          errorName: 'BootstrapMempoolValidationError'
        })
      }
    })

    test('halts on a cash-bound buy refused for any other reason', () => {
      const halted = decide({
        reading: cashBound,
        view: view(['live']),
        prepare: ready({ ok: false, errorName: 'BootstrapMempoolValidationError' })
      })

      expect(halted.halt).toBe('bootstrap-decision-failed')
      expect(halted.act).toBeUndefined()
    })
  })

  test('keeps what is live and waits for the next poll when preparation read behind the world', () => {
    const behind = decide({
      view: view(['live']),
      prepare: ready({
        ok: false,
        errorName: 'BootstrapAdapterError',
        adapterOperation: 'head-behind-world'
      })
    })

    expect(behind.halt).toBeUndefined()
    expect(behind.act).toBeUndefined()
    expect(behind.keep).toEqual(['live'])
    expect(behind.detail).toMatchObject({
      status: 'failed',
      errorName: 'BootstrapAdapterError',
      adapterOperation: 'head-behind-world'
    })
  })

  test('halts the bot when a publication cannot be proven safe', () => {
    expect(
      decide({
        prepare: ready({
          ok: false,
          errorName: 'BootstrapAdapterError',
          adapterOperation: 'negative-spread'
        })
      }).halt
    ).toBe('bootstrap-decision-failed')
  })
})
