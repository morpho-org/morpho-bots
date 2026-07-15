import { describe, expect, it } from 'bun:test'

import { createCooldownStore } from '../src/cooldown'

describe('createCooldownStore', () => {
  it('does not skip a position that has never been attempted', () => {
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

  it('is disabled when cooldownMs <= 0: never skips, mark is a no-op, dump is empty', () => {
    const store = createCooldownStore({ cooldownMs: 0, now: () => 1_000, initial: [['a', 999]] })
    store.mark('a')
    expect(store.shouldSkip('a')).toBe(false)
    expect(store.dump()).toEqual([])
  })

  it('dump prunes expired entries and keeps active ones', () => {
    const now = () => 1_000_000
    const store = createCooldownStore({
      cooldownMs: 60_000,
      now,
      initial: [
        ['fresh', 1_000_000 - 10_000], // active (10s ago)
        ['stale', 1_000_000 - 90_000] // expired (90s ago)
      ]
    })
    const ids = store.dump().map(([id]) => id)
    expect(ids).toEqual(['fresh'])
  })

  it('dump output round-trips through initial (restores active cooldowns)', () => {
    const now = () => 1_000_000
    const first = createCooldownStore({ cooldownMs: 60_000, now })
    first.mark('a')
    const dumped = first.dump()

    const restored = createCooldownStore({ cooldownMs: 60_000, now, initial: dumped })
    expect(restored.shouldSkip('a')).toBe(true)
  })
})
