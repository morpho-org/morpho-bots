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
  it('accumulates consecutive reverts and reports the streak duration', () => {
    const time = clock()
    const store = createRevertStreakStore({ now: time.now })
    expect(store.record(LABEL, SHORTFALL)).toStrictEqual({
      count: 1,
      durationMs: 0,
      selector: SHORTFALL,
      selectorConstant: true,
      escalate: 'below'
    })
    time.advance(30_000)
    expect(store.record(LABEL, SHORTFALL)).toStrictEqual({
      count: 2,
      durationMs: 30_000,
      selector: SHORTFALL,
      selectorConstant: true,
      escalate: 'below'
    })
    time.advance(45_000)
    // Measured from the FIRST revert in the streak, not from the previous one.
    expect(store.record(LABEL, SHORTFALL)).toStrictEqual({
      count: 3,
      durationMs: 75_000,
      selector: SHORTFALL,
      selectorConstant: true,
      escalate: 'below'
    })
  })

  it('escalates only once the streak has run past the threshold', () => {
    const time = clock()
    const store = createRevertStreakStore({ escalateAfterMs: 1000, now: time.now })
    expect(store.record(LABEL).escalate).toBe('below')
    time.advance(1000)
    // Strictly past, so a streak exactly at the threshold is not yet escalated.
    expect(store.record(LABEL).escalate).toBe('below')
    time.advance(1)
    expect(store.record(LABEL).escalate).toBe('crossed')
  })

  it('reports the crossing once, then ongoing, so a stuck position is one warn', () => {
    const time = clock()
    const store = createRevertStreakStore({ escalateAfterMs: 1000, now: time.now })
    store.record(LABEL)
    time.advance(1001)
    expect(store.record(LABEL).escalate).toBe('crossed')
    // Same tick, second sibling: the crossing is already spent.
    expect(store.record(LABEL).escalate).toBe('ongoing')
    time.advance(60_000)
    expect(store.record(LABEL).escalate).toBe('ongoing')
  })

  it('defaults to a 15-minute threshold', () => {
    const time = clock()
    const store = createRevertStreakStore({ now: time.now })
    store.record(LABEL)
    time.advance(REVERT_STREAK_ESCALATE_MS)
    expect(store.record(LABEL).escalate).toBe('below')
    time.advance(1)
    expect(store.record(LABEL).escalate).toBe('crossed')
  })

  it('starts a fresh streak after a reset', () => {
    const time = clock()
    const store = createRevertStreakStore({ escalateAfterMs: 1000, now: time.now })
    store.record(LABEL)
    time.advance(5000)
    store.record(LABEL)
    store.reset(LABEL)
    // A broadcast, or a send failure the chain did not decline, ends the streak: the next revert is
    // attempt one at zero duration, so it cannot inherit an escalation from before the reset.
    expect(store.record(LABEL)).toStrictEqual({
      count: 1,
      durationMs: 0,
      selector: undefined,
      selectorConstant: true,
      escalate: 'below'
    })
    // And the fresh streak can cross again, rather than the spent crossing latching forever.
    time.advance(1001)
    expect(store.record(LABEL).escalate).toBe('crossed')
  })

  it('reports a constant selector, and stops once one differs', () => {
    const store = createRevertStreakStore({ now: clock().now })
    expect(store.record(LABEL, SHORTFALL).selectorConstant).toBe(true)
    expect(store.record(LABEL, SHORTFALL)).toStrictEqual({
      count: 2,
      durationMs: 0,
      selector: SHORTFALL,
      selectorConstant: true,
      escalate: 'below'
    })
    // A mixed streak reads as ordinary min-out shortfalls against different pools; once mixed it stays
    // mixed, so a later repeat cannot re-assert a structural fault.
    expect(store.record(LABEL, PANIC)).toStrictEqual({
      count: 3,
      durationMs: 0,
      selector: PANIC,
      selectorConstant: false,
      escalate: 'below'
    })
    expect(store.record(LABEL, PANIC).selectorConstant).toBe(false)
  })

  it('treats a missing selector as its own value', () => {
    const store = createRevertStreakStore({ now: clock().now })
    expect(store.record(LABEL)).toStrictEqual({
      count: 1,
      durationMs: 0,
      selector: undefined,
      selectorConstant: true,
      escalate: 'below'
    })
    expect(store.record(LABEL).selectorConstant).toBe(true)
    expect(store.record(LABEL, SHORTFALL).selectorConstant).toBe(false)
  })

  it('keeps streaks independent per position', () => {
    const time = clock()
    const store = createRevertStreakStore({ escalateAfterMs: 1000, now: time.now })
    store.record(LABEL)
    time.advance(2000)
    store.record(OTHER)
    expect(store.record(LABEL).escalate).toBe('crossed')
    expect(store.record(OTHER).escalate).toBe('below')
    store.reset(LABEL)
    expect(store.record(OTHER).count).toBe(3)
  })
})
