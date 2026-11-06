import type { Hex } from 'viem'

import { describe, expect, test } from 'vitest'

import type { FailureCounts } from '../../src/domain/market-failure-budget'

import { countFailures, exhausted } from '../../src/domain/market-failure-budget'

const first: Hex = `0x${'11'.repeat(32)}`
const second: Hex = `0x${'22'.repeat(32)}`

/** Folds cycles in order, reporting after each whether the budget is exhausted at `limit`. */
const run = (
  limit: number,
  cycles: readonly (readonly { marketId: Hex; status: string }[])[],
  unresolved?: ReadonlySet<string>
) => {
  let counts: FailureCounts = {}
  return cycles.map(cycle => {
    counts = countFailures(counts, cycle, unresolved)
    return exhausted(counts, limit)
  })
}

describe('countFailures', () => {
  test('exhausts only after one market fails on consecutive cycles', () => {
    const failed = [{ marketId: first, status: 'failed' }]
    expect(run(3, [failed, failed, failed])).toEqual([false, false, true])
  })

  test('clears a market count on any successful cycle', () => {
    expect(
      run(2, [
        [{ marketId: first, status: 'failed' }],
        [{ marketId: first, status: 'observed' }],
        [{ marketId: first, status: 'failed' }]
      ])
    ).toEqual([false, false, false])
  })

  test('retains a count while a failed publication remains unresolved', () => {
    expect(
      run(
        2,
        [[{ marketId: first, status: 'failed' }], [{ marketId: first, status: 'observed' }]],
        new Set([first])
      )
    ).toEqual([false, true])
  })

  test('counts each market separately', () => {
    expect(
      run(2, [
        [
          { marketId: first, status: 'failed' },
          { marketId: second, status: 'observed' }
        ],
        [
          { marketId: first, status: 'observed' },
          { marketId: second, status: 'failed' }
        ]
      ])
    ).toEqual([false, false])
  })

  test('retains a running count for a market missing from a cycle', () => {
    expect(
      run(2, [
        [{ marketId: first, status: 'failed' }],
        [{ marketId: second, status: 'observed' }],
        [{ marketId: first, status: 'failed' }]
      ])
    ).toEqual([false, false, true])
  })

  test('leaves the counts it was given unchanged', () => {
    const counts = { [first]: 1 }
    countFailures(counts, [{ marketId: first, status: 'failed' }])
    expect(counts).toEqual({ [first]: 1 })
  })
})
