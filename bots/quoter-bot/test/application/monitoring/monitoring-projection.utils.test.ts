import { describe, expect, test } from 'vitest'

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
  test('names every projected record so no payload falls back to the catch-all event', () => {
    const projection = createMonitoringProjection()
    const events = [
      ...projection.setup(readyReport),
      ...projection.combined({
        event: 'quoter-bot.cycle',
        workflow: 'ladder',
        results: [{ marketId, status: 'observed', action: 'rest' } as unknown as LadderRunResult]
      })
    ]

    expect(events.length).toBeGreaterThan(0)
    expect(events.every(event => typeof event.event === 'string' && event.event.length > 0)).toBe(
      true
    )
  })

  test('reports each failed readiness check without leaking its unknown-typed observation', () => {
    const events = createMonitoringProjection().setup(readyReport)

    expect(events).toContainEqual({ event: 'setup.ready', ready: false })
    expect(events).toContainEqual({ event: 'setup.check-failed', check: 'native-balance' })
    expect(events.filter(event => event.event === 'setup.check-failed')).toHaveLength(1)
    expect(JSON.stringify(events)).not.toContain('required')
  })

  test('leaves an already-named transaction event to ship unchanged', () => {
    expect(
      createMonitoringProjection().combined({
        event: 'ladder.transaction-submitted',
        operation: 'publish',
        txHash: `0x${'ab'.repeat(32)}`
      })
    ).toEqual([])
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

  test('keeps separate baselines per projection so one bot cannot see another bot fills', () => {
    createMonitoringProjection().ladder([consumingResult(100n)])

    expect(createMonitoringProjection().ladder([consumingResult(250n)])).not.toContainEqual(
      expect.objectContaining({ event: 'offer.consumed' })
    )
  })
})
