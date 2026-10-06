import { describe, expect, test } from 'vitest'

import { bootstrapMonitoringEvents } from '../../../src/application/monitoring/bootstrap-monitoring.utils'

const marketId = `0x${'11'.repeat(32)}` as const

describe('cycle.completed snapshot failures', () => {
  test('ships the allowlisted snapshot cause beside the snapshot-unavailable operation', () => {
    const [cycle] = bootstrapMonitoringEvents([
      {
        marketId,
        status: 'failed',
        stage: 'make',
        invalidated: true,
        errorName: 'BootstrapAdapterError',
        adapterOperation: 'snapshot-unavailable',
        snapshotErrorOperation: 'missing-owned-group-intent'
      }
    ])

    expect(cycle).toMatchObject({
      event: 'cycle.completed',
      workflow: 'bootstrap',
      adapterOperation: 'snapshot-unavailable',
      snapshotErrorOperation: 'missing-owned-group-intent'
    })
  })

  test('omits the cause when the snapshot failure carried none', () => {
    const [cycle] = bootstrapMonitoringEvents([
      {
        marketId,
        status: 'failed',
        stage: 'make',
        invalidated: false,
        errorName: 'HttpRequestError',
        adapterOperation: 'snapshot-unavailable'
      }
    ])

    expect(cycle).not.toHaveProperty('snapshotErrorOperation')
  })
})

describe('guardrail.rate-omitted', () => {
  test('reports the out-of-range requested rate and the offer size it withheld', () => {
    const events = bootstrapMonitoringEvents([
      {
        marketId,
        status: 'observed',
        action: 'rate-out-of-range',
        verbose: {
          config: { marketId, creditTarget: 1_000n, minimumRateBps: 200n, maximumRateBps: 800n },
          currentState: { status: 'unavailable' },
          referenceRate: { mode: 'static', rateBps: 900n, observationId: 'static:900' },
          diagnostics: {
            requestedRateBps: 850n,
            outOfRangeBound: 'maximum',
            requestedAssets: 500n,
            cappedAssets: 500n,
            cap: 'offer-size'
          }
        }
      } as unknown as Parameters<typeof bootstrapMonitoringEvents>[0][number]
    ])

    expect(events.filter(event => event.event === 'guardrail.rate-omitted')).toEqual([
      {
        event: 'guardrail.rate-omitted',
        workflow: 'bootstrap',
        marketId,
        omittedRungs: 1,
        omittedAssets: 500n,
        bound: 'maximum',
        outermostRateBps: 850n,
        referenceRateBps: 900n,
        minimumRateBps: 200n,
        maximumRateBps: 800n
      }
    ])
  })
})
