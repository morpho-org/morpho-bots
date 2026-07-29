import type { Logger } from '@repo/bot-kit'
import type { Hex } from 'viem'

import { HttpRetryExhaustedError } from '@repo/utils'
import { describe, expect, it } from 'bun:test'
import { getAddress } from 'viem'

import type { BorrowerCandidate } from '../../src/discovery/borrowers'

import { withDiscoveryCooldown } from '../../src/discovery/cooldown'

const MARKET: Hex = `0x${'a'.repeat(64)}`
const CANDIDATE: BorrowerCandidate = {
  marketId: MARKET,
  borrower: getAddress('0x1111111111111111111111111111111111111111')
}

function spyLogger() {
  const events: { level: string; event: string; fields?: Record<string, unknown> }[] = []
  const make = (level: string) => (event: string, fields?: Record<string, unknown>) =>
    events.push({ level, event, fields })
  const logger: Logger = {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error')
  }
  return { logger, events }
}

// A controllable discovery fake: each call pops the next scripted outcome ('ok' or an error).
function scriptedDiscover(script: ('ok' | Error)[]) {
  let calls = 0
  const discover = async () => {
    const step = script.shift()
    if (step === undefined) throw new Error('scripted discover exhausted')
    calls += 1
    if (step === 'ok') return [CANDIDATE]
    throw step
  }
  return { discover, calls: () => calls }
}

describe('withDiscoveryCooldown', () => {
  const BASE_MS = 60_000
  const MAX_MS = 600_000

  it('passes through a successful discovery untouched', async () => {
    const { logger, events } = spyLogger()
    const { discover } = scriptedDiscover(['ok'])
    const wrapped = withDiscoveryCooldown(discover, { logger, baseMs: BASE_MS, maxMs: MAX_MS })
    expect(await wrapped()).toEqual([CANDIDATE])
    expect(events).toHaveLength(0)
  })

  it('latches after a failure: skips discovery within the window, resumes after it', async () => {
    const { logger, events } = spyLogger()
    const { discover, calls } = scriptedDiscover([new Error('candidates HTTP 500'), 'ok'])
    let clock = 0
    const wrapped = withDiscoveryCooldown(discover, {
      logger,
      baseMs: BASE_MS,
      maxMs: MAX_MS,
      now: () => clock
    })

    // Tick 1: the failure propagates (the tick logs discover.error) and latches the cooldown.
    await expect(wrapped()).rejects.toThrow('candidates HTTP 500')
    expect(events.some(e => e.level === 'warn' && e.event === 'discover.cooldown_start')).toBe(true)

    // Tick 2 (within the window): discovery is skipped — zero candidates, no underlying call.
    clock = BASE_MS - 1
    expect(await wrapped()).toEqual([])
    expect(calls()).toBe(1)
    expect(events.some(e => e.event === 'discover.cooldown')).toBe(true)

    // Tick 3 (window expired): discovery runs again and the latch resets.
    clock = BASE_MS
    expect(await wrapped()).toEqual([CANDIDATE])
    expect(calls()).toBe(2)
    expect(events.some(e => e.event === 'discover.cooldown_reset')).toBe(true)
  })

  it('grows the window exponentially across consecutive failures, capped at maxMs', async () => {
    const { logger, events } = spyLogger()
    const failures = Array.from({ length: 6 }, () => new Error('boom'))
    const { discover } = scriptedDiscover(failures)
    let clock = 0
    const wrapped = withDiscoveryCooldown(discover, {
      logger,
      baseMs: BASE_MS,
      maxMs: MAX_MS,
      now: () => clock
    })

    const windows: number[] = []
    for (let i = 0; i < 6; i++) {
      await expect(wrapped()).rejects.toThrow('boom')
      const latch = events.filter(e => e.event === 'discover.cooldown_start').at(-1)
      const windowMs = latch?.fields?.cooldownMs
      // Fail here, pointedly, if the latch log ever drops the field — not via a NaN clock downstream.
      if (typeof windowMs !== 'number') throw new Error('cooldown_start missing cooldownMs')
      windows.push(windowMs)
      clock += windowMs // jump past the window so the next call reaches discover again
    }
    // 60s, 120s, 240s, 480s, then capped at 600s.
    expect(windows).toEqual([60_000, 120_000, 240_000, 480_000, 600_000, 600_000])
  })

  it('seeds the window from the server Retry-After when the failure surfaced one', async () => {
    const { logger, events } = spyLogger()
    const { discover } = scriptedDiscover([
      new HttpRetryExhaustedError('liquidation-candidates', 429, 300_000)
    ])
    const wrapped = withDiscoveryCooldown(discover, {
      logger,
      baseMs: BASE_MS,
      maxMs: MAX_MS,
      now: () => 0
    })
    await expect(wrapped()).rejects.toThrow('liquidation-candidates HTTP 429')
    const latch = events.find(e => e.event === 'discover.cooldown_start')
    // Retry-After (300s) > first-failure exponential (60s) → the server value wins.
    expect(latch?.fields?.cooldownMs).toBe(300_000)
    expect(latch?.fields?.retryAfterMs).toBe(300_000)
  })

  it('keeps the exponential ramp as a floor under a degenerate short Retry-After', async () => {
    const { logger, events } = spyLogger()
    const { discover } = scriptedDiscover([
      new HttpRetryExhaustedError('liquidation-candidates', 429, 0)
    ])
    const wrapped = withDiscoveryCooldown(discover, {
      logger,
      baseMs: BASE_MS,
      maxMs: MAX_MS,
      now: () => 0
    })
    await expect(wrapped()).rejects.toThrow('liquidation-candidates HTTP 429')
    const latch = events.find(e => e.event === 'discover.cooldown_start')
    expect(latch?.fields?.cooldownMs).toBe(BASE_MS)
  })

  it('resets the failure count on success so a later failure restarts at the base window', async () => {
    const { logger, events } = spyLogger()
    const { discover } = scriptedDiscover([new Error('boom'), 'ok', new Error('boom')])
    let clock = 0
    const wrapped = withDiscoveryCooldown(discover, {
      logger,
      baseMs: BASE_MS,
      maxMs: MAX_MS,
      now: () => clock
    })

    await expect(wrapped()).rejects.toThrow('boom')
    clock = BASE_MS
    expect(await wrapped()).toEqual([CANDIDATE])
    await expect(wrapped()).rejects.toThrow('boom')
    const latch = events.filter(e => e.event === 'discover.cooldown_start').at(-1)
    expect(latch?.fields?.failures).toBe(1)
    expect(latch?.fields?.cooldownMs).toBe(BASE_MS)
  })
})
