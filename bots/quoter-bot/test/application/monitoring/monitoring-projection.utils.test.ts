import { describe, expect, test } from 'vitest'

import type { BootstrapRunResult } from '../../../src/application/bootstrap/position-bootstrap.service'
import type { LadderRunResult } from '../../../src/application/ladder/ladder-quoter.service'
import type { SetupCheckReport } from '../../../src/application/setup/setup-check.service'

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
      currentState: { status: 'not-read', reason: 'configuration-invalid' },
      stateAfterCheck: { status: 'not-read', reason: 'configuration-invalid' },
      groupConsumption: [
        {
          groupId,
          marketId,
          side: 'higher',
          groupRateBps: 500n,
          maxAssets: 1_000n,
          consumed,
          remainingAssets: 1_000n - consumed
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
          currentState: { status: 'not-read', reason: 'configuration-invalid' },
          stateAfterCheck: { status: 'not-read', reason: 'configuration-invalid' },
          submittedTransactions: [transaction]
        }
      },
      {
        marketId,
        status: 'applied',
        action: 'publish',
        verbose: {
          config: { marketId },
          currentState: { status: 'not-read', reason: 'configuration-invalid' },
          stateAfterCheck: { status: 'not-read', reason: 'configuration-invalid' },
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
        totalAssets: 0n
      },
      {
        event: 'book.observed',
        marketId,
        side: 'higher',
        state: 'empty',
        rungs: 0,
        totalAssets: 0n
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
        totalAssets: 100n,
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
      expect.objectContaining({ event: 'offer.consumed', consumedDeltaAssets: 20n })
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
      consumedDeltaAssets: 150n,
      groupRateBps: 500n,
      remainingAssets: 750n,
      groupId
    })
  })

  test('ignores a group that briefly disappears from the indexer instead of re-baselining it', () => {
    const projection = createMonitoringProjection()
    projection.ladder([consumingResult(100n)])
    projection.ladder([{ marketId, status: 'observed', action: 'rest' } as LadderRunResult])

    expect(projection.ladder([consumingResult(180n)])).toContainEqual(
      expect.objectContaining({ event: 'offer.consumed', consumedDeltaAssets: 80n })
    )
  })
})
