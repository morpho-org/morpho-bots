import { describe, expect, test } from 'vitest'

import type { MarketReport } from '../../../src/application/engine/market-report'

import {
  createMarketProjection,
  LEND_HALTED_REPEAT_POLLS
} from '../../../src/application/monitoring/market-monitoring.utils'

const marketId = `0x${'11'.repeat(32)}` as const
const groupId = `0x${'22'.repeat(32)}` as const
const bounds = { minimumRateBps: 0n, maximumRateBps: 1_000n }

const consuming = (consumed: bigint): MarketReport => ({
  workflow: 'ladder',
  marketId,
  status: 'observed',
  action: 'rest',
  facts: {
    bounds,
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
})
const resting: MarketReport = { workflow: 'ladder', marketId, status: 'observed', action: 'rest' }

const named = (events: readonly { event: string }[], name: string) =>
  events.filter(event => event.event === name)

describe('createMarketProjection', () => {
  test('ships the liveness record with only the classification the report carries', () => {
    expect(
      createMarketProjection()([
        {
          workflow: 'ladder',
          marketId,
          status: 'applied',
          action: 'replace',
          reason: 'book-crossed',
          facts: { bounds }
        }
      ])
    ).toEqual([
      {
        event: 'cycle.completed',
        workflow: 'ladder',
        marketId,
        status: 'applied',
        action: 'replace',
        reason: 'book-crossed'
      }
    ])
  })

  test('ships a halt with its allowlisted adapter operation on both records', () => {
    const events = createMarketProjection()([
      {
        workflow: 'ladder',
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

  test('reports a spread rejection only for an actual bootstrap cross-book rejection', () => {
    const rejections = (adapterOperation?: 'negative-spread' | 'preflight') =>
      named(
        createMarketProjection()([
          {
            workflow: 'bootstrap',
            marketId,
            status: 'halted',
            stage: 'decision',
            errorName: 'BootstrapAdapterError',
            ...(adapterOperation ? { adapterOperation } : {})
          }
        ]),
        'guardrail.spread-rejected'
      )

    expect(rejections('negative-spread')).toEqual([
      { event: 'guardrail.spread-rejected', marketId }
    ])
    expect(rejections('preflight')).toEqual([])
    expect(rejections()).toEqual([])
  })

  test('reports a withheld publication and each withdrawn ladder side', () => {
    const events = createMarketProjection()([
      {
        workflow: 'bootstrap',
        marketId,
        status: 'applied',
        action: 'publication-withheld',
        reason: 'rate-out-of-range'
      },
      {
        workflow: 'ladder',
        marketId,
        status: 'applied',
        action: 'publication-withdrawn',
        reason: 'resize',
        withdrawnSides: ['higher']
      }
    ])

    expect(named(events, 'guardrail.publication-withheld')).toEqual([
      {
        event: 'guardrail.publication-withheld',
        workflow: 'bootstrap',
        marketId,
        reason: 'rate-out-of-range'
      }
    ])
    expect(named(events, 'guardrail.side-withdrawn')).toEqual([
      { event: 'guardrail.side-withdrawn', workflow: 'ladder', marketId, side: 'higher' }
    ])
  })

  test('carries the Router floor on a below-minimum withholding', () => {
    const events = createMarketProjection()([
      {
        workflow: 'bootstrap',
        marketId,
        status: 'applied',
        action: 'publication-withheld',
        reason: 'below-minimum-offer',
        minimumAssets: '100'
      }
    ])

    expect(named(events, 'guardrail.publication-withheld')).toEqual([
      {
        event: 'guardrail.publication-withheld',
        workflow: 'bootstrap',
        marketId,
        reason: 'below-minimum-offer',
        minimumAssets: '100'
      }
    ])
  })

  test('settles each transaction an act included, attributed to its market', () => {
    const txHash = `0x${'33'.repeat(32)}` as const
    const events = createMarketProjection()([
      {
        workflow: 'bootstrap',
        marketId,
        status: 'applied',
        action: 'publish',
        transactions: [
          { operation: 'ratify', txHash },
          { operation: 'publish', txHash }
        ]
      }
    ])

    expect(named(events, 'transaction.settled')).toEqual([
      {
        event: 'transaction.settled',
        workflow: 'bootstrap',
        marketId,
        operation: 'ratify',
        txHash
      },
      {
        event: 'transaction.settled',
        workflow: 'bootstrap',
        marketId,
        operation: 'publish',
        txHash
      }
    ])
  })
})

describe('createMarketProjection fills', () => {
  test('emits no fill on the first sighting of a group and the delta thereafter', () => {
    const project = createMarketProjection()

    expect(named(project([consuming(100n)]), 'offer.consumed')).toEqual([])
    expect(named(project([consuming(250n)]), 'offer.consumed')).toEqual([
      {
        event: 'offer.consumed',
        marketId,
        side: 'higher',
        groupRateBps: 500n,
        groupId,
        consumedDeltaUnits: 150n,
        remainingUnits: 750n
      }
    ])
  })

  test('never re-counts a fill when the indexer replays an older consumption value', () => {
    const project = createMarketProjection()
    project([consuming(100n)])

    expect(named(project([consuming(80n)]), 'offer.consumed')).toEqual([])
    expect(named(project([consuming(120n)]), 'offer.consumed')).toEqual([
      expect.objectContaining({ consumedDeltaUnits: 20n })
    ])
  })

  test('keeps a baseline across polls its group or market is missing from', () => {
    const project = createMarketProjection()
    project([consuming(100n)])
    project([resting])
    project([])

    expect(named(project([consuming(180n)]), 'offer.consumed')).toEqual([
      expect.objectContaining({ consumedDeltaUnits: 80n })
    ])
  })
})

describe('createMarketProjection lend halts', () => {
  const halted = (
    lossFactor: bigint,
    workflow: MarketReport['workflow'] = 'ladder'
  ): MarketReport => ({
    workflow,
    marketId,
    status: 'applied',
    action: 'lend-halted',
    reason: 'loss-factor-mismatch',
    lossFactor,
    acceptedLossFactor: 5n,
    defaulted: false,
    direction: lossFactor > 5n ? 'above' : 'below'
  })
  const lendHalted = (events: readonly { event: string }[]) =>
    named(events, 'guardrail.lend-halted')

  test.each(['bootstrap', 'ladder'] as const)('projects a %s lend halt', workflow => {
    expect(lendHalted(createMarketProjection()([halted(6n, workflow)]))).toEqual([
      {
        event: 'guardrail.lend-halted',
        workflow,
        marketId,
        lossFactor: 6n,
        acceptedLossFactor: 5n,
        defaulted: false,
        direction: 'above',
        incrementalLossBps: 1n
      }
    ])
  })

  test('omits the incremental loss below the accepted value', () => {
    const [record] = lendHalted(createMarketProjection()([halted(4n)]))

    expect(record).toMatchObject({ direction: 'below' })
    expect(record).not.toHaveProperty('incrementalLossBps')
  })

  test('emits on each transition and at a low rate while a halt continues unchanged', () => {
    const project = createMarketProjection()
    const counts = [
      ...Array.from({ length: LEND_HALTED_REPEAT_POLLS + 1 }, () => [halted(6n)]),
      [halted(7n)],
      [],
      [halted(7n)],
      [resting],
      [halted(7n)]
    ].map(reports => lendHalted(project(reports)).length)

    expect(counts).toEqual([
      1,
      ...Array.from({ length: LEND_HALTED_REPEAT_POLLS - 1 }, () => 0),
      1,
      1,
      0,
      0,
      0,
      1
    ])
  })

  test('tracks each workflow halt separately', () => {
    const project = createMarketProjection()

    expect(lendHalted(project([halted(6n)]))).toHaveLength(1)
    expect(lendHalted(project([halted(6n, 'bootstrap')]))).toHaveLength(1)
    expect(lendHalted(project([halted(6n)]))).toHaveLength(0)
  })
})
