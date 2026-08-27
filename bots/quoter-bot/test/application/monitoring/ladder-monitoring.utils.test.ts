import { describe, expect, test } from 'vitest'

import type { LadderRunResult } from '../../../src/application/ladder/ladder-quoter.service'

import {
  createLadderConsumptionBaselines,
  ladderConsumptionEvents
} from '../../../src/application/monitoring/ladder-monitoring.utils'

const marketId = `0x${'11'.repeat(32)}` as const

const sighting = (groupId: `0x${string}`, consumed: bigint): LadderRunResult =>
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

const groupId = (index: number): `0x${string}` => `0x${index.toString(16).padStart(64, '0')}`

describe('ladderConsumptionEvents baselines', () => {
  test('evicts a baseline only long after the group stops appearing', () => {
    const baselines = createLadderConsumptionBaselines()
    ladderConsumptionEvents([sighting(groupId(1), 100n)], baselines)

    for (let cycle = 0; cycle < 400; cycle += 1) ladderConsumptionEvents([], baselines)

    expect(baselines.groups.has(groupId(1))).toBe(true)
    expect(ladderConsumptionEvents([sighting(groupId(1), 160n)], baselines)).toContainEqual(
      expect.objectContaining({ consumedDeltaAssets: 60n })
    )
  })

  test('bounds memory when reconciliation keeps reserving fresh group ids', () => {
    const baselines = createLadderConsumptionBaselines()
    for (let cycle = 1; cycle <= 2_000; cycle += 1) {
      ladderConsumptionEvents([sighting(groupId(cycle), 10n)], baselines)
    }

    expect(baselines.groups.size).toBeLessThanOrEqual(501)
  })
})
