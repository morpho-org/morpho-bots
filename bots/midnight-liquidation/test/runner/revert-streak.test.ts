import { describe, expect, it } from 'vitest'

import { createRevertStreakStore, REVERT_STREAK_ESCALATE_MS } from '../../src/runner/revert-streak'

const LABEL = 'market:borrower'
const OTHER = 'market:other'
const SHORTFALL = '0x08c379a0' as const
const PANIC = '0x4e487b71' as const

// A controllable clock, since the threshold is a duration — the whole point of the store.
const clock = (start = 1_000_000) => {
  let at = start
  return { now: () => at, advance: (ms: number) => (at += ms) }
}

describe('createRevertStreakStore', () => {
  it('accumulates consecutive reverts and reports the streak duration', async () => {
    const time = clock()
    const store = createRevertStreakStore({ now: time.now })
    expect(store.record(LABEL, SHORTFALL)).toMatchObject({ count: 1, durationMs: 0 })
    time.advance(30_000)
    expect(store.record(LABEL, SHORTFALL)).toMatchObject({ count: 2, durationMs: 30_000 })
    time.advance(45_000)
    // Measured from the FIRST revert in the streak, not from the previous one.
    expect(store.record(LABEL, SHORTFALL)).toMatchObject({ count: 3, durationMs: 75_000 })
  })

  it('escalates only once the streak has run past the threshold', async () => {
    const time = clock()
    const store = createRevertStreakStore({ escalateAfterMs: 1000, now: time.now })
    expect(store.record(LABEL).escalate).toBe(false)
    time.advance(1000)
    // Strictly past, so a streak exactly at the threshold is not yet escalated.
    expect(store.record(LABEL).escalate).toBe(false)
    time.advance(1)
    expect(store.record(LABEL).escalate).toBe(true)
  })

  it('defaults to a 15-minute threshold', async () => {
    const time = clock()
    const store = createRevertStreakStore({ now: time.now })
    store.record(LABEL)
    time.advance(REVERT_STREAK_ESCALATE_MS)
    expect(store.record(LABEL).escalate).toBe(false)
    time.advance(1)
    expect(store.record(LABEL).escalate).toBe(true)
  })

  it('starts a fresh streak after a reset', async () => {
    const time = clock()
    const store = createRevertStreakStore({ escalateAfterMs: 1000, now: time.now })
    store.record(LABEL)
    time.advance(5000)
    store.record(LABEL)
    store.reset(LABEL)
    // A broadcast, or a send failure the chain did not decline, ends the streak: the next revert is
    // attempt one at zero duration, so it cannot inherit an escalation from before the reset.
    expect(store.record(LABEL)).toMatchObject({ count: 1, durationMs: 0, escalate: false })
  })

  it('reports a constant selector, and stops once one differs', async () => {
    const store = createRevertStreakStore({ now: clock().now })
    expect(store.record(LABEL, SHORTFALL).selectorConstant).toBe(true)
    expect(store.record(LABEL, SHORTFALL)).toMatchObject({
      selector: SHORTFALL,
      selectorConstant: true
    })
    // A mixed streak reads as ordinary min-out shortfalls against different pools; once mixed it stays
    // mixed, so a later repeat cannot re-assert a structural fault.
    expect(store.record(LABEL, PANIC)).toMatchObject({ selector: PANIC, selectorConstant: false })
    expect(store.record(LABEL, PANIC).selectorConstant).toBe(false)
  })

  it('treats a missing selector as its own value', async () => {
    const store = createRevertStreakStore({ now: clock().now })
    expect(store.record(LABEL)).toMatchObject({ selector: undefined, selectorConstant: true })
    expect(store.record(LABEL).selectorConstant).toBe(true)
    expect(store.record(LABEL, SHORTFALL).selectorConstant).toBe(false)
  })

  it('keeps streaks independent per position', async () => {
    const time = clock()
    const store = createRevertStreakStore({ escalateAfterMs: 1000, now: time.now })
    store.record(LABEL)
    time.advance(2000)
    store.record(OTHER)
    expect(store.record(LABEL).escalate).toBe(true)
    expect(store.record(OTHER).escalate).toBe(false)
    store.reset(LABEL)
    expect(store.record(OTHER).count).toBe(3)
  })
})
