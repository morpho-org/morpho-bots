import { describe, expect, it } from 'vitest'

import { createCooldownStore } from '../../src/queue/cooldown'

describe('createCooldownStore', () => {
  it('does not skip a position that has never been marked', () => {
    const store = createCooldownStore({ cooldownMs: 60_000, now: () => 1_000 })
    expect(store.shouldSkip('a')).toBe(false)
  })

  it('skips a marked position until the window elapses, then re-allows it', () => {
    let t = 1_000_000
    const store = createCooldownStore({ cooldownMs: 60_000, now: () => t })
    store.mark('a')
    expect(store.shouldSkip('a')).toBe(true) // same instant
    t += 59_999
    expect(store.shouldSkip('a')).toBe(true) // just inside the window
    t += 1
    expect(store.shouldSkip('a')).toBe(false) // exactly at the window boundary is expired
  })

  it('re-marking refreshes the window from the new attempt time', () => {
    let t = 1_000_000
    const store = createCooldownStore({ cooldownMs: 60_000, now: () => t })
    store.mark('a')
    t += 40_000
    store.mark('a') // re-attempted
    t += 30_000 // 30s since the re-mark (< 60s), 70s since the first
    expect(store.shouldSkip('a')).toBe(true)
  })

  it('tracks each position independently', () => {
    let t = 1_000_000
    const store = createCooldownStore({ cooldownMs: 60_000, now: () => t })
    store.mark('a')
    t += 30_000
    store.mark('b')
    t += 40_000 // a: 70s (expired), b: 40s (active)
    expect(store.shouldSkip('a')).toBe(false)
    expect(store.shouldSkip('b')).toBe(true)
  })

  it('is disabled when cooldownMs <= 0: never skips and mark is a no-op', () => {
    const store = createCooldownStore({ cooldownMs: 0, now: () => 1_000 })
    store.mark('a')
    expect(store.shouldSkip('a')).toBe(false)
  })
})
