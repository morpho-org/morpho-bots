import { parse, stringify } from '@repo/utils'
import { describe, expect, it } from 'bun:test'

import type { BackoffState } from '../../src/queue/backoff'

import { createBackoff } from '../../src/queue/backoff'

const LABEL = '0xmarket:0xborrower'

describe('createBackoff', () => {
  it('does not skip an unrecorded label', () => {
    const b = createBackoff({ baseBlocks: 2n, maxBlocks: 64n })
    expect(b.shouldSkip(LABEL, 100n)).toBe(false)
    expect(b.size).toBe(0)
  })

  it('skips during the cooldown after a failure and resumes after it', () => {
    const b = createBackoff({ baseBlocks: 2n, maxBlocks: 64n })
    b.record(LABEL, 100n) // first failure → cooldown until 102
    expect(b.shouldSkip(LABEL, 100n)).toBe(true)
    expect(b.shouldSkip(LABEL, 101n)).toBe(true)
    expect(b.shouldSkip(LABEL, 102n)).toBe(false)
    expect(b.size).toBe(1)
  })

  it('grows the cooldown exponentially with repeated failures', () => {
    const b = createBackoff({ baseBlocks: 2n, maxBlocks: 64n })
    b.record(LABEL, 100n) // attempt 1 → +2 → until 102
    b.record(LABEL, 102n) // attempt 2 → +4 → until 106
    expect(b.shouldSkip(LABEL, 105n)).toBe(true)
    expect(b.shouldSkip(LABEL, 106n)).toBe(false)
    b.record(LABEL, 106n) // attempt 3 → +8 → until 114
    expect(b.shouldSkip(LABEL, 113n)).toBe(true)
    expect(b.shouldSkip(LABEL, 114n)).toBe(false)
  })

  it('keeps attempt history after expiry so the next production-path failure grows', () => {
    const b = createBackoff({ baseBlocks: 2n, maxBlocks: 64n })
    b.record(LABEL, 100n) // attempt 1 → +2 → until 102

    // Mirrors runTick: once shouldSkip says "not suppressed", the tick tries quote/sim again.
    expect(b.shouldSkip(LABEL, 102n)).toBe(false)

    b.record(LABEL, 102n) // attempt 2 → +4 → until 106
    expect(b.shouldSkip(LABEL, 105n)).toBe(true)
    expect(b.shouldSkip(LABEL, 106n)).toBe(false)
  })

  it('caps the cooldown at maxBlocks', () => {
    const b = createBackoff({ baseBlocks: 10n, maxBlocks: 15n })
    b.record(LABEL, 0n) // +min(15, 10) = 10 → until 10
    b.record(LABEL, 10n) // attempt 2 → +min(15, 20) = 15 → until 25
    expect(b.shouldSkip(LABEL, 24n)).toBe(true)
    expect(b.shouldSkip(LABEL, 25n)).toBe(false)
  })

  it('clears a label', () => {
    const b = createBackoff({ baseBlocks: 2n, maxBlocks: 64n })
    b.record(LABEL, 100n)
    b.clear(LABEL)
    expect(b.shouldSkip(LABEL, 100n)).toBe(false)
    expect(b.size).toBe(0)
  })

  it('round-trips state and keeps escalating from the restored attempt count', () => {
    const a = createBackoff({ baseBlocks: 2n, maxBlocks: 64n })
    a.record(LABEL, 100n) // attempt 1 → +2 → until 102
    a.record(LABEL, 102n) // attempt 2 → +4 → until 106

    const state = parse<BackoffState>(stringify(a.dump()), 'throw')
    expect(state).toEqual(a.dump()) // bigint `until` survives the JSON round trip

    const b = createBackoff({ baseBlocks: 2n, maxBlocks: 64n, initialState: state })
    expect(b.shouldSkip(LABEL, 105n)).toBe(true)
    expect(b.shouldSkip(LABEL, 106n)).toBe(false)
    // Attempt count survived: the next failure escalates to +8, not back to +2.
    b.record(LABEL, 106n) // attempt 3 → until 114
    expect(b.shouldSkip(LABEL, 113n)).toBe(true)
    expect(b.shouldSkip(LABEL, 114n)).toBe(false)
  })

  it('copies restored entries so the caller-held state cannot alias live mutations', () => {
    const a = createBackoff({ baseBlocks: 2n, maxBlocks: 64n })
    a.record(LABEL, 100n)
    const state = a.dump()
    const b = createBackoff({ baseBlocks: 2n, maxBlocks: 64n, initialState: state })
    b.record(LABEL, 102n) // mutates the live entry
    expect(state[0]?.[1].attempts).toBe(1) // the dumped state is untouched
  })
})
