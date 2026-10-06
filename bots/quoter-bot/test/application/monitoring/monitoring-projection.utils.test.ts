import { describe, expect, test } from 'vitest'

import type { BootstrapRunResult } from '../../../src/application/bootstrap/position-bootstrap.service'
import type { LadderRunResult } from '../../../src/application/ladder/ladder-quoter.service'
import type { SetupCheckReport } from '../../../src/application/setup/setup-check.service'

import { LEND_HALTED_REPEAT_CYCLES } from '../../../src/application/monitoring/monitoring-event'
import { createMonitoringProjection } from '../../../src/application/monitoring/monitoring-projection.utils'

const marketId = `0x${'11'.repeat(32)}` as const
const groupId = `0x${'22'.repeat(32)}` as const

const readyReport: SetupCheckReport = {
  ready: false,
  checks: [
    { name: 'native-balance', status: 'failed', observed: 1n, required: 10n },
    { name: 'chain', status: 'passed', observed: 8453, required: 8453 }
  ]
}

const consumingResult = (consumed: bigint): LadderRunResult =>
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

describe('createMonitoringProjection', () => {
  test('reports each failed readiness check without leaking its unknown-typed observation', () => {
    const events = createMonitoringProjection().setup(readyReport)

    expect(events).toContainEqual({
      event: 'setup.check-failed',
      check: 'native-balance',
      status: 'failed'
    })
    expect(events).toContainEqual({
      event: 'cycle.completed',
      workflow: 'setup-check',
      status: 'failed'
    })
    expect(events.filter(event => event.event === 'setup.check-failed')).toHaveLength(1)
    expect(JSON.stringify(events)).not.toContain('required')
  })

  test('keeps a non-blocking warning off the failure discriminator', () => {
    const warningReport: SetupCheckReport = {
      ready: true,
      checks: [
        { name: 'offers', status: 'warning', observed: {}, required: {} },
        { name: 'chain', status: 'passed', observed: 8453, required: 8453 }
      ]
    }

    const events = createMonitoringProjection().setup(warningReport)

    expect(events).toContainEqual({
      event: 'setup.check-warning',
      check: 'offers',
      status: 'warning'
    })
    expect(events.filter(event => event.event === 'setup.check-failed')).toHaveLength(0)
    expect(events).toContainEqual({
      event: 'cycle.completed',
      workflow: 'setup-check',
      status: 'ready'
    })
  })

  test('reports a spread rejection only for an actual cross-book rejection', () => {
    const failure = (adapterOperation?: string) => [
      {
        marketId,
        status: 'failed',
        stage: 'make',
        invalidated: false,
        errorName: 'BootstrapAdapterError',
        ...(adapterOperation === undefined ? {} : { adapterOperation })
      }
    ]
    const spreadRejections = (adapterOperation?: string) =>
      createMonitoringProjection()
        .bootstrap(failure(adapterOperation) as readonly { status: string }[])
        .filter(event => event.event === 'guardrail.spread-rejected')

    expect(spreadRejections('negative-spread')).toEqual([
      { event: 'guardrail.spread-rejected', marketId }
    ])
    expect(spreadRejections('transaction-policy')).toEqual([])
    expect(spreadRejections()).toEqual([])
  })

  test('ships the bootstrap halt adapter operation on both halt records', () => {
    const events = createMonitoringProjection().bootstrap([
      {
        marketId,
        status: 'halted',
        stage: 'reference-read',
        strategyInvalidated: true,
        errorName: 'BootstrapAdapterError',
        adapterOperation: 'reference-checkpoint'
      }
    ] as unknown as readonly BootstrapRunResult[])

    expect(events).toEqual([
      expect.objectContaining({
        event: 'cycle.completed',
        status: 'halted',
        adapterOperation: 'reference-checkpoint'
      }),
      expect.objectContaining({
        event: 'guardrail.halted',
        adapterOperation: 'reference-checkpoint'
      })
    ])
  })

  test('omits market attribution for halted bootstrap settlements', () => {
    const transaction = { operation: 'cancel' as const, txHash: `0x${'33'.repeat(32)}` as const }
    const events = createMonitoringProjection().bootstrap([
      {
        marketId,
        status: 'halted',
        stage: 'reference-read',
        strategyInvalidated: true,
        errorName: 'ProviderError',
        verbose: {
          config: { marketId },
          currentState: { status: 'observed', position: {} },
          stateAfterCheck: { status: 'observed', position: {} },
          submittedTransactions: [transaction]
        }
      },
      {
        marketId,
        status: 'applied',
        action: 'publish',
        verbose: {
          config: { marketId },
          currentState: { status: 'observed', position: {} },
          stateAfterCheck: { status: 'observed', position: {} },
          submittedTransactions: [transaction]
        }
      }
    ] as unknown as readonly BootstrapRunResult[])

    expect(events.filter(event => event.event === 'transaction.settled')).toEqual([
      {
        event: 'transaction.settled',
        workflow: 'bootstrap',
        operation: 'cancel',
        txHash: transaction.txHash
      },
      {
        event: 'transaction.settled',
        workflow: 'bootstrap',
        marketId,
        operation: 'cancel',
        txHash: transaction.txHash
      }
    ])
  })

  test('signals an empty book positively when no quote is active at all', () => {
    const observed = [
      {
        marketId,
        status: 'observed',
        action: 'rest',
        verbose: {
          config: { marketId },
          currentState: { status: 'observed', market: {} },
          stateAfterCheck: { status: 'observed', market: {} }
        }
      }
    ]

    expect(
      createMonitoringProjection()
        .ladder(observed as readonly { status: string }[])
        .filter(event => event.event === 'book.observed')
    ).toEqual([
      {
        event: 'book.observed',
        marketId,
        side: 'lower',
        state: 'empty',
        rungs: 0,
        totalUnits: 0n
      },
      {
        event: 'book.observed',
        marketId,
        side: 'higher',
        state: 'empty',
        rungs: 0,
        totalUnits: 0n
      }
    ])
  })

  test('reports the book as reconciled left it, not as it was before publishing', () => {
    const published = {
      marketId,
      status: 'applied',
      action: 'publish',
      verbose: {
        config: { marketId },
        currentState: { status: 'observed', market: {} },
        stateAfterCheck: {
          status: 'observed',
          market: {},
          activeQuote: {
            marketId,
            centerRateBps: 500n,
            groupMode: 'shared-rung',
            lower: [{ index: 0, rateBps: 450n, assets: 100n }],
            higher: []
          }
        }
      }
    }

    expect(
      createMonitoringProjection()
        .ladder([published] as readonly { status: string }[])
        .filter(event => event.event === 'book.observed' && event.side === 'lower')
    ).toEqual([
      {
        event: 'book.observed',
        marketId,
        side: 'lower',
        state: 'quoting',
        rungs: 1,
        totalUnits: 100n,
        bestRateBps: 450n,
        worstRateBps: 450n,
        centerRateBps: 500n
      }
    ])
  })

  test('projects position observations from the successful post-check snapshot', () => {
    const observed = {
      marketId,
      status: 'applied',
      action: 'publish',
      verbose: {
        config: { marketId },
        currentState: {
          status: 'observed',
          market: {
            cashBalanceAssets: 10n,
            reservedAssets: 20n,
            lowerRateCapacityAssets: 30n,
            higherRateCapacityAssets: 40n
          }
        },
        stateAfterCheck: {
          status: 'observed',
          market: {
            cashBalanceAssets: 100n,
            reservedAssets: 200n,
            lowerRateCapacityAssets: 300n,
            higherRateCapacityAssets: 400n
          }
        }
      }
    }

    expect(
      createMonitoringProjection()
        .ladder([observed] as readonly { status: string }[])
        .filter(event => event.event === 'position.observed')
    ).toEqual([
      {
        event: 'position.observed',
        marketId,
        cashBalanceAssets: 100n,
        reservedAssets: 200n,
        lowerRateCapacityAssets: 300n,
        higherRateCapacityAssets: 400n
      }
    ])
  })

  test('falls back to the pre-decision position observation when the post-check read fails', () => {
    const observed = {
      marketId,
      status: 'applied',
      action: 'publish',
      verbose: {
        config: { marketId },
        currentState: {
          status: 'observed',
          market: {
            cashBalanceAssets: 10n,
            reservedAssets: 20n,
            lowerRateCapacityAssets: 30n,
            higherRateCapacityAssets: 40n
          }
        },
        stateAfterCheck: { status: 'failed', errorName: 'ProviderError' }
      }
    }

    expect(
      createMonitoringProjection()
        .ladder([observed] as readonly { status: string }[])
        .filter(event => event.event === 'position.observed')
    ).toEqual([
      {
        event: 'position.observed',
        marketId,
        cashBalanceAssets: 10n,
        reservedAssets: 20n,
        lowerRateCapacityAssets: 30n,
        higherRateCapacityAssets: 40n
      }
    ])
  })

  test('orients best and worst rate toward the center on each side', () => {
    const quoted = {
      marketId,
      status: 'observed',
      action: 'rest',
      verbose: {
        config: { marketId },
        currentState: { status: 'observed', market: {} },
        stateAfterCheck: {
          status: 'observed',
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
        }
      }
    }
    const books = createMonitoringProjection()
      .ladder([quoted] as readonly { status: string }[])
      .filter(event => event.event === 'book.observed')

    expect(books).toContainEqual(
      expect.objectContaining({ side: 'lower', bestRateBps: 450n, worstRateBps: 350n })
    )
    expect(books).toContainEqual(
      expect.objectContaining({ side: 'higher', bestRateBps: 550n, worstRateBps: 650n })
    )
  })

  test('never re-counts a fill when the indexer replays an older consumption value', () => {
    const projection = createMonitoringProjection()
    projection.ladder([consumingResult(100n)])
    expect(projection.ladder([consumingResult(80n)])).not.toContainEqual(
      expect.objectContaining({ event: 'offer.consumed' })
    )

    expect(projection.ladder([consumingResult(120n)])).toContainEqual(
      expect.objectContaining({ event: 'offer.consumed', consumedDeltaUnits: 20n })
    )
  })

  test('emits no fill on the first sighting of a group and the delta thereafter', () => {
    const projection = createMonitoringProjection()

    expect(projection.ladder([consumingResult(100n)])).not.toContainEqual(
      expect.objectContaining({ event: 'offer.consumed' })
    )
    expect(projection.ladder([consumingResult(250n)])).toContainEqual({
      event: 'offer.consumed',
      marketId,
      side: 'higher',
      groupRateBps: 500n,
      groupId,
      consumedDeltaUnits: 150n,
      remainingUnits: 750n
    })
  })

  test('ignores a group that briefly disappears from the indexer instead of re-baselining it', () => {
    const projection = createMonitoringProjection()
    projection.ladder([consumingResult(100n)])
    projection.ladder([{ marketId, status: 'observed', action: 'rest' } as LadderRunResult])

    expect(projection.ladder([consumingResult(180n)])).toContainEqual(
      expect.objectContaining({ event: 'offer.consumed', consumedDeltaUnits: 80n })
    )
  })
})

describe('createMonitoringProjection lend halts', () => {
  const halted = (lossFactor: bigint) => ({
    marketId,
    status: 'applied' as const,
    action: 'lend-halted' as const,
    reason: 'loss-factor-mismatch' as const,
    lossFactor,
    acceptedLossFactor: 5n,
    defaulted: false,
    direction: lossFactor > 5n ? ('above' as const) : ('below' as const)
  })
  const lendHaltedRecords = (events: readonly { event: string }[]) =>
    events.filter(event => event.event === 'guardrail.lend-halted')

  test.each(['bootstrap', 'ladder'] as const)(
    'projects a %s lend halt into its cycle and guardrail records',
    workflow => {
      const events = createMonitoringProjection()[workflow]([halted(6n)])

      expect(events).toContainEqual(
        expect.objectContaining({
          event: 'cycle.completed',
          workflow,
          status: 'applied',
          action: 'lend-halted',
          reason: 'loss-factor-mismatch'
        })
      )
      expect(lendHaltedRecords(events)).toEqual([
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
    }
  )

  test('omits the incremental loss below the accepted value', () => {
    const [record] = lendHaltedRecords(createMonitoringProjection().ladder([halted(4n)]))

    expect(record).toMatchObject({ direction: 'below' })
    expect(record).not.toHaveProperty('incrementalLossBps')
  })

  test('emits on each transition and at a low rate while a halt continues unchanged', () => {
    const projection = createMonitoringProjection()
    const counts = [
      ...Array.from({ length: LEND_HALTED_REPEAT_CYCLES + 1 }, () => halted(6n)),
      halted(7n),
      { marketId, status: 'observed' as const, action: 'rest' as const },
      halted(7n)
    ].map(result => lendHaltedRecords(projection.ladder([result])).length)

    expect(counts).toEqual([
      1,
      ...Array.from({ length: LEND_HALTED_REPEAT_CYCLES - 1 }, () => 0),
      1,
      1,
      0,
      1
    ])
  })

  test('tracks each workflow halt separately', () => {
    const projection = createMonitoringProjection()

    expect(lendHaltedRecords(projection.ladder([halted(6n)]))).toHaveLength(1)
    expect(lendHaltedRecords(projection.bootstrap([halted(6n)]))).toHaveLength(1)
    expect(lendHaltedRecords(projection.ladder([halted(6n)]))).toHaveLength(0)
  })
})
