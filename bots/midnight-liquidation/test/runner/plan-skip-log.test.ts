import { describe, expect, it } from 'vitest'

import type { PlanSkipReason } from '../../src/sizing/plan'

import { createPlanSkipLog } from '../../src/runner/plan-skip-log'

const LABEL = 'market:borrower'

const skip = (
  reason: PlanSkipReason,
  overrides: { label?: string; collateralIndex?: number; postMaturityMode?: boolean } = {}
) => ({
  label: LABEL,
  collateralIndex: 0,
  postMaturityMode: undefined,
  reason,
  ...overrides
})

const clock = (start = 1_000_000) => {
  let at = start
  return { now: () => at, advance: (ms: number) => (at += ms) }
}

describe('createPlanSkipLog', () => {
  it('suppresses a repeat within the relog interval and re-emits once it elapses', () => {
    const time = clock()
    const log = createPlanSkipLog({ relogMs: 1000, now: time.now })
    expect(log.shouldLog(skip('seize_rounds_to_zero'))).toBe(true)
    log.sweep()
    time.advance(999)
    expect(log.shouldLog(skip('seize_rounds_to_zero'))).toBe(false)
    log.sweep()
    time.advance(1)
    expect(log.shouldLog(skip('seize_rounds_to_zero'))).toBe(true)
  })

  it('keys by position, slot, mode and reason, so any change logs at once', () => {
    const log = createPlanSkipLog({ now: () => 0 })
    expect(log.shouldLog(skip('seize_rounds_to_zero'))).toBe(true)
    expect(log.shouldLog(skip('nothing_to_seize'))).toBe(true)
    expect(log.shouldLog(skip('seize_rounds_to_zero', { collateralIndex: 1 }))).toBe(true)
    expect(log.shouldLog(skip('seize_rounds_to_zero', { label: 'market:other' }))).toBe(true)
    expect(log.shouldLog(skip('seize_rounds_to_zero', { postMaturityMode: false }))).toBe(true)
    expect(log.shouldLog(skip('seize_rounds_to_zero', { postMaturityMode: true }))).toBe(true)
  })

  it('forgets a key that went unreported for a whole tick', () => {
    const log = createPlanSkipLog({ now: () => 0 })
    expect(log.shouldLog(skip('seize_rounds_to_zero'))).toBe(true)
    log.sweep()
    log.sweep()
    expect(log.shouldLog(skip('seize_rounds_to_zero'))).toBe(true)
  })

  it('keeps a key that was reported but suppressed during the tick', () => {
    const log = createPlanSkipLog({ now: () => 0 })
    log.shouldLog(skip('seize_rounds_to_zero'))
    log.sweep()
    log.shouldLog(skip('seize_rounds_to_zero'))
    log.sweep()
    expect(log.shouldLog(skip('seize_rounds_to_zero'))).toBe(false)
  })
})
