import type { Hex } from 'viem'

import { describe, expect, test } from 'vitest'

import { createMarketFailureBudget } from '../../src/application/market-failure-budget.utils'

const first: Hex = `0x${'11'.repeat(32)}`
const second: Hex = `0x${'22'.repeat(32)}`

describe('createMarketFailureBudget', () => {
  test('exhausts only after one market fails on consecutive cycles', () => {
    const budget = createMarketFailureBudget(3)

    expect(budget([{ marketId: first, status: 'failed' }])).toBe(false)
    expect(budget([{ marketId: first, status: 'failed' }])).toBe(false)
    expect(budget([{ marketId: first, status: 'failed' }])).toBe(true)
  })

  test('clears a market count on any successful cycle', () => {
    const budget = createMarketFailureBudget(2)

    expect(budget([{ marketId: first, status: 'failed' }])).toBe(false)
    expect(budget([{ marketId: first, status: 'observed' }])).toBe(false)
    expect(budget([{ marketId: first, status: 'failed' }])).toBe(false)
  })

  test('counts each market separately', () => {
    const budget = createMarketFailureBudget(2)

    expect(
      budget([
        { marketId: first, status: 'failed' },
        { marketId: second, status: 'observed' }
      ])
    ).toBe(false)
    expect(
      budget([
        { marketId: first, status: 'observed' },
        { marketId: second, status: 'failed' }
      ])
    ).toBe(false)
  })

  test('retains a running count for a market missing from a cycle', () => {
    const budget = createMarketFailureBudget(2)

    expect(budget([{ marketId: first, status: 'failed' }])).toBe(false)
    expect(budget([{ marketId: second, status: 'observed' }])).toBe(false)
    expect(budget([{ marketId: first, status: 'failed' }])).toBe(true)
  })
})
