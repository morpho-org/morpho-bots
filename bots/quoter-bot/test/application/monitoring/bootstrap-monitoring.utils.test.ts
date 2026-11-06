import { describe, expect, test } from 'vitest'

import { bootstrapFactEvents } from '../../../src/application/monitoring/bootstrap-monitoring.utils'

const marketId = `0x${'11'.repeat(32)}` as const
const bounds = { minimumRateBps: 200n, maximumRateBps: 800n }

describe('bootstrapFactEvents', () => {
  test('reports the out-of-range requested rate, the offer size it withheld, and the cap', () => {
    const events = bootstrapFactEvents(marketId, {
      bounds,
      creditTargetAssets: 1_000n,
      referenceRateBps: 900n,
      diagnostics: {
        requestedRateBps: 850n,
        outOfRangeBound: 'maximum',
        requestedAssets: 600n,
        cappedAssets: 500n,
        cap: 'offer-size'
      }
    })

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
    expect(events).toContainEqual({
      event: 'guardrail.exposure-capped',
      workflow: 'bootstrap',
      marketId,
      requestedAssets: 600n,
      cappedAssets: 500n,
      cap: 'offer-size'
    })
  })

  test('reports progress toward the credit target only once the position was read', () => {
    expect(
      bootstrapFactEvents(marketId, { bounds, creditTargetAssets: 1_000n, creditAssets: 250n })
    ).toEqual([
      { event: 'bootstrap.progress', marketId, creditAssets: 250n, creditTargetAssets: 1_000n }
    ])
    expect(bootstrapFactEvents(marketId, { bounds, creditTargetAssets: 1_000n })).toEqual([])
  })
})
