import type { KernelActivity, KernelHead, Notice, RefusalCode } from '@repo/kernel'

import { createGraph, createRunner } from '@repo/engine'
import { describe, expect, it } from 'vitest'

import type { BackoffPolicy, ExemptEnd } from '../src'
import type { PrepareResult, TaskEvent } from '../src/tasks'

import { declareBackoff, intentIdOf, isBackedOff, parseIntentId } from '../src'

const backoff = (policy: BackoffPolicy) => {
  const g = createGraph('backoff')
  const prepared = g.occurrences<PrepareResult>('prepared')
  const activity = g.occurrences<readonly KernelActivity[]>('activity')
  const heads = g.occurrences<KernelHead>('heads')
  const submitted = g.occurrences<TaskEvent>('submitted')
  const { state } = declareBackoff(g, 'backoff', {
    runId: 'run',
    prepared,
    submitted,
    activity,
    heads,
    policy
  })
  const runner = createRunner(g.build())
  const fail = (key: string, task = 't') =>
    runner.push(prepared, {
      id: key,
      key,
      task,
      version: 'v',
      ok: false,
      reason: 'no_route',
      backoff: true
    })
  const head = (number: number) => runner.push(heads, { number, hash: `0x${number}` })
  const notice = (intentId: string, notice: Exclude<Notice, 'refused'>, reason?: string) =>
    runner.push(activity, [{ type: 'notice', intentId, notice, ...(reason && { reason }) }])
  const refused = (intentId: string, code: RefusalCode, reason: string) =>
    runner.push(activity, [{ type: 'notice', intentId, notice: 'refused', code, reason }])
  const settle = (intentId: string) => notice(intentId, 'settled')
  const submit = (intentId: string, exempt?: readonly ExemptEnd[]) =>
    runner.push(submitted, {
      type: 'submitted',
      key: parseIntentId(intentId)!.key,
      intentId,
      priority: 1n,
      block: 1,
      ...(exempt && { exemptFromBackoff: exempt })
    })
  const reverted = (intentId: string) =>
    runner.push(activity, [
      {
        type: 'notice',
        intentId,
        notice: 'abandoned',
        code: 'reverted',
        reason: 'simulation failed',
        included: []
      }
    ])
  const report = (one: KernelActivity) => runner.push(activity, [one])
  return { runner, state, fail, head, settle, notice, refused, report, submit, reverted }
}

describe('per-key backoff', () => {
  it('is refused at build with a bound that is not a whole number of blocks', () => {
    for (const bound of [0, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() => backoff({ baseBlocks: bound, maxBlocks: 4 })).toThrow(
        'backoff needs baseBlocks and maxBlocks, whole numbers from 1'
      )
      expect(() => backoff({ baseBlocks: 1, maxBlocks: bound })).toThrow(
        'backoff needs baseBlocks and maxBlocks, whole numbers from 1'
      )
    }
  })

  it('doubles the wait on each consecutive failure, up to the maximum', async () => {
    const { runner, state, fail, head } = backoff({ baseBlocks: 2, maxBlocks: 5 })
    head(10)
    const waits = []
    for (let i = 0; i < 4; i++) {
      fail('a')
      const entry = runner.read(state)!.keys.a!.t!
      waits.push([entry.failures, entry.until - 10])
    }
    expect(waits).toStrictEqual([
      [1, 2],
      [2, 4],
      [3, 5],
      [4, 5]
    ])
    expect(isBackedOff(runner.read(state), 'a')).toBe(true)
    head(15)
    expect(isBackedOff(runner.read(state), 'a')).toBe(false)
    await runner.abandon()
  })

  it('never holds a key past its wait, and forgets it, however many times it failed', async () => {
    const { runner, state, fail, head } = backoff({ baseBlocks: 1, maxBlocks: 2 })
    head(1)
    for (let i = 0; i < 10; i++) fail('a')
    head(1_000)
    expect(isBackedOff(runner.read(state), 'a')).toBe(false)
    expect(runner.read(state)!.keys).toStrictEqual({})
    await runner.abandon()
  })

  it('keeps each task of a key on its own backoff, and a settlement clears only its own', async () => {
    const { runner, state, fail, head, settle } = backoff({ baseBlocks: 2, maxBlocks: 64 })
    head(10)
    fail('a', 'liquidate')
    fail('a', 'liquidate')
    fail('a', 'liquidate')
    fail('a', 'writeoff')
    const { liquidate, writeoff } = runner.read(state)!.keys.a!
    expect([liquidate?.failures, writeoff?.failures]).toStrictEqual([3, 1])
    head(12)
    expect(isBackedOff(runner.read(state), 'a', 'writeoff')).toBe(false)
    expect(isBackedOff(runner.read(state), 'a', 'liquidate')).toBe(true)
    expect(isBackedOff(runner.read(state), 'a')).toBe(true)
    settle(intentIdOf('a', 'run', 0, 'writeoff'))
    expect(Object.keys(runner.read(state)!.keys.a!)).toStrictEqual(['liquidate'])
    await runner.abandon()
  })

  it('backs off only the task whose act the kernel ended unsettled', async () => {
    const { runner, state, head, notice, refused } = backoff({ baseBlocks: 2, maxBlocks: 64 })
    head(10)
    notice(intentIdOf('a', 'run', 0, 'writeoff'), 'failed')
    refused(intentIdOf('b', 'run', 1, 'liquidate'), 'conflict', 'conflicts with b#run.0.liquidate')
    expect(isBackedOff(runner.read(state), 'a', 'writeoff')).toBe(true)
    expect(isBackedOff(runner.read(state), 'a', 'liquidate')).toBe(false)
    expect(isBackedOff(runner.read(state), 'b', 'liquidate')).toBe(true)
    expect(isBackedOff(runner.read(state), 'b', 'writeoff')).toBe(false)
    notice(intentIdOf('c', 'run', 2), 'failed')
    expect(isBackedOff(runner.read(state), 'c', 'liquidate')).toBe(true)
    await runner.abandon()
  })

  it('waits out no backoff for an act refused on stale evidence', async () => {
    const { runner, state, head, refused } = backoff({ baseBlocks: 2, maxBlocks: 64 })
    head(10)
    refused(intentIdOf('a', 'run', 0, 't'), 'evidence_expired', 'evidence expired')
    refused(
      intentIdOf('a', 'run', 3, 't'),
      'decision_predates_own_effect',
      'decision predates our own final effect on a'
    )
    refused(
      intentIdOf('a', 'run', 1, 't'),
      'evidence_predates_own_effect',
      'evidence f/a predates our own effect on a'
    )
    expect(runner.read(state)!.keys).toStrictEqual({})
    refused(intentIdOf('a', 'run', 2, 't'), 'unauthorized', 'policy now refuses: evidence expired')
    expect(isBackedOff(runner.read(state), 'a', 't')).toBe(true)
    await runner.abandon()
  })

  it("backs off an earlier run's act that failed, but not one it abandoned or a restart withdrew", async () => {
    const { runner, state, head, notice } = backoff({ baseBlocks: 2, maxBlocks: 64 })
    head(10)
    notice(intentIdOf('a', 'earlier', 0, 't'), 'abandoned', 'intent expired')
    expect(isBackedOff(runner.read(state), 'a', 't')).toBe(false)
    notice(
      intentIdOf('b', 'earlier', 0, 't'),
      'compensating',
      'restart withdraws e: policy now refuses: x'
    )
    notice(intentIdOf('c', 'earlier', 0, 't'), 'failed', 'compensation could not complete')
    expect(isBackedOff(runner.read(state), 'b', 't')).toBe(false)
    expect(isBackedOff(runner.read(state), 'c', 't')).toBe(true)
    notice(intentIdOf('d', 'run', 0, 't'), 'abandoned', 'intent expired')
    notice(intentIdOf('e', 'run', 1, 't'), 'compensating', 'intent expired')
    expect(isBackedOff(runner.read(state), 'd', 't')).toBe(true)
    expect(isBackedOff(runner.read(state), 'e', 't')).toBe(false)
    notice(intentIdOf('e', 'run', 1, 't'), 'compensated', 'intent expired')
    expect(isBackedOff(runner.read(state), 'e', 't')).toBe(true)
    await runner.abandon()
  })

  it('backs off no act cancelled before anything of it ran, but one whose original won after a cancel', async () => {
    const { runner, state, head, report } = backoff({ baseBlocks: 2, maxBlocks: 64 })
    head(10)
    const end = (key: string, notice: Partial<KernelActivity>) =>
      report({
        type: 'notice',
        intentId: intentIdOf(key, 'run', 0, 't'),
        ...notice
      } as KernelActivity)
    end('a', { notice: 'compensating', reason: 'evidence expired' })
    end('a', { notice: 'compensated', code: 'cancelled', reason: 'evidence expired', included: [] })
    end('b', { notice: 'abandoned', code: 'cancelled', reason: 'evidence expired', included: [] })
    end('c', {
      notice: 'compensated',
      reason: 'evidence expired',
      included: [{ step: 0, hash: '0xc', block: 9, success: true }]
    })
    expect(['a', 'b', 'c'].map(key => isBackedOff(runner.read(state), key, 't'))).toStrictEqual([
      false,
      false,
      true
    ])
    await runner.abandon()
  })
})

describe('an act exempt from backoff', () => {
  const act = (key: string, seq: number, task = 'liquidate') => intentIdOf(key, 'run', seq, task)

  it('holds an act submitted exempt from its end code only until the next head, counting no failure', async () => {
    const { runner, state, head, fail, submit, reverted } = backoff({
      baseBlocks: 4,
      maxBlocks: 64
    })
    head(10)
    fail('a', 'liquidate')
    head(20)
    submit(act('a', 0), ['reverted'])
    reverted(act('a', 0))
    expect(runner.read(state)!.keys.a!.liquidate).toStrictEqual({ failures: 1, until: 21 })
    expect(isBackedOff(runner.read(state), 'a', 'liquidate')).toBe(true)
    head(21)
    expect(isBackedOff(runner.read(state), 'a', 'liquidate')).toBe(false)
    await runner.abandon()
  })

  it('backs off the same end for an act submitted with no exemption', async () => {
    const { runner, state, head, submit, reverted } = backoff({ baseBlocks: 4, maxBlocks: 64 })
    head(10)
    reverted(act('a', 0))
    submit(act('b', 1))
    reverted(act('b', 1))
    for (const key of ['a', 'b'])
      expect(runner.read(state)!.keys[key]!.liquidate).toStrictEqual({ failures: 1, until: 14 })
    await runner.abandon()
  })

  it("exempts only its own act, and spends the exemption on that act's end", async () => {
    const { runner, state, head, submit, reverted, notice, settle } = backoff({
      baseBlocks: 4,
      maxBlocks: 64
    })
    head(10)
    submit(act('a', 0), ['reverted'])
    reverted(act('a', 1))
    submit(act('b', 2), ['reverted'])
    notice(act('b', 2), 'failed')
    reverted(act('b', 2))
    submit(act('c', 3), ['reverted'])
    reverted(act('c', 3))
    expect(runner.read(state)!.keys).toStrictEqual({
      a: { liquidate: { failures: 1, until: 14 } },
      b: { liquidate: { failures: 2, until: 18 } },
      c: { liquidate: { failures: 0, until: 11 } }
    })
    expect({ ...runner.read(state)!.exempt }).toStrictEqual({ [act('a', 0)]: ['reverted'] })
    settle(act('c', 4))
    expect(runner.read(state)!.keys).not.toHaveProperty('c')
    await runner.abandon()
  })
})
