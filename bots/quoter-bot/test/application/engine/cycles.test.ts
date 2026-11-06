import type { Hex } from 'viem'

import { describe, expect, test } from 'vitest'

import type { Cycle, FailureBudget } from '../../../src/application/engine/cycles'

import { EMPTY_BUDGET, budgetVerdict, foldBudget } from '../../../src/application/engine/cycles'

const marketId: Hex = `0x${'11'.repeat(32)}`
const failed: Cycle = {
  counted: [{ workflow: 'ladder', marketId, status: 'failed', stage: 'decision' }],
  completed: []
}

const verdictAfter = (budget: FailureBudget, cycle: Cycle) =>
  budgetVerdict(foldBudget(budget, cycle))

describe('budgetVerdict', () => {
  test('halts on the cycle that exhausts the budget, before the reducer has folded it', () => {
    let budget: FailureBudget = EMPTY_BUDGET
    for (let poll = 1; poll < 5; poll += 1) {
      expect(verdictAfter(budget, failed)).toEqual({ ok: true })
      budget = foldBudget(budget, failed)
    }
    expect(verdictAfter(budget, failed)).toEqual({ ok: false, halt: 'ladder' })
  })

  test('charges a failed cancellation, as a rate-out-of-range withholding sends, to the budget instead of halting at once', () => {
    const cancelFailed: Cycle = {
      counted: [
        {
          workflow: 'bootstrap',
          marketId,
          status: 'failed',
          stage: 'act'
        }
      ],
      completed: []
    }
    let budget: FailureBudget = EMPTY_BUDGET
    for (let poll = 1; poll < 5; poll += 1) {
      expect(verdictAfter(budget, cancelFailed)).toEqual({ ok: true })
      budget = foldBudget(budget, cancelFailed)
    }
    expect(verdictAfter(budget, cancelFailed)).toEqual({ ok: false, halt: 'bootstrap' })
  })

  test('never charges a below-minimum withholding, and clears the failure before it', () => {
    const withheld: Cycle = {
      counted: [
        {
          workflow: 'bootstrap',
          marketId,
          status: 'applied',
          action: 'publication-withheld'
        }
      ],
      completed: []
    }
    let budget: FailureBudget = foldBudget(EMPTY_BUDGET, {
      counted: [{ workflow: 'bootstrap', marketId, status: 'failed', stage: 'act' }],
      completed: []
    })
    expect(budget.bootstrap.unresolved).toEqual([marketId])
    for (let poll = 0; poll < 10; poll += 1) {
      expect(verdictAfter(budget, withheld)).toEqual({ ok: true })
      budget = foldBudget(budget, withheld)
    }
    expect(budget.bootstrap).toEqual({ counts: { [marketId]: 0 }, unresolved: [] })
  })
})
