import { describe, expect, it } from 'vitest'

import { createIntervalGate } from '../src/interval-gate'

const clockAt = (value: { now: number }) => () => value.now

describe('createIntervalGate', () => {
  it('passes on the first call', () => {
    const clock = { now: 0 }
    expect(createIntervalGate(1000, clockAt(clock))()).toBe(true)
  })

  it('blocks a call inside the interval', () => {
    const clock = { now: 0 }
    const gate = createIntervalGate(1000, clockAt(clock))
    expect(gate()).toBe(true)
    clock.now = 999
    expect(gate()).toBe(false)
  })

  it('passes once the interval has elapsed', () => {
    const clock = { now: 0 }
    const gate = createIntervalGate(1000, clockAt(clock))
    expect(gate()).toBe(true)
    clock.now = 1000
    expect(gate()).toBe(true)
  })

  it('measures from the last admitted pass, not from the last call', () => {
    const clock = { now: 0 }
    const gate = createIntervalGate(1000, clockAt(clock))
    expect(gate()).toBe(true)
    clock.now = 900
    expect(gate()).toBe(false)
    clock.now = 1500
    expect(gate()).toBe(true)
    clock.now = 2000
    expect(gate()).toBe(false)
  })
})
