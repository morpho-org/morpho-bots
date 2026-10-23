import type { KeyedWrite } from '@repo/engine'
import type { KernelActivity, KernelHead, KernelNodes, KernelRequest } from '@repo/kernel'

import { createRunner, keyedLevel, keyedMap, lane } from '@repo/engine'
import { layoutOf } from '@repo/engine/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { KernelHandle, KernelView, LogSink } from '../src'
import type { PrepareOutcome, Task } from '../src/tasks'

import { defineBot, intentIdOf, kernelDomain, logTasks, tasks, task } from '../src'

const STEPS = [
  { kind: 'tx' as const, payload: { kind: 'tx' as const, to: '0xx', data: '0x', value: 0n } }
]

type Answer = 'ok' | 'decline' | PrepareOutcome | Error

/** Acts at each key's bid, writing only that key. */
const PER_KEY = (bid: bigint, key: string) =>
  task('act', { priority: bid, conflicts: { writes: [key] } })

/** A position as read: only `bid` reaches its candidate and fact, so `read` moves its input alone. */
type Position = { bid: bigint; read?: number }

/**
 * A task family on stand-in kernel nodes the test writes itself: `view` says whether the kernel
 * acts, and every preparation waits until the test answers it. `policy` decides each candidate.
 */
const family = (
  policy: (bid: bigint, key: string) => Task,
  factValue = (_bid: bigint): unknown => true,
  timeoutMs = 60_000,
  maxReservations = 4,
  runId = 'run',
  concurrency = 2
) => {
  const asked: {
    id: string
    key: string
    signal: AbortSignal
    answer: (answer: Answer) => void
  }[] = []
  const submits: KernelRequest[] = []
  const logged: [string, Record<string, unknown> | undefined][] = []
  const logger: LogSink = {
    info: (event, fields) => void logged.push([event, fields]),
    warn: (event, fields) => void logged.push([event, fields])
  }
  const { graph, ...nodes } = defineBot('tasks', b => {
    const raw = b.raw(g => {
      const writes = g.occurrences<KeyedWrite<Position>>('positions.writes')
      const positions = keyedLevel(g, 'positions', writes)
      const candidates = keyedMap(g, 'candidates', positions, ({ bid }) => ({ bid }))
      const domain = kernelDomain('tasks')
      const facts = domain.fact(keyedMap(g, 'facts', positions, ({ bid }) => factValue(bid)))
      const activity = g.occurrences<readonly KernelActivity[]>('kernel.activity')
      const heads = g.occurrences<KernelHead>('kernel.heads')
      const stand = {
        requests: g.occurrences<KernelRequest>('kernel.requests'),
        state: g.level('kernel.state'),
        commands: g.occurrences('kernel.commands'),
        activity,
        heads
      } as unknown as KernelNodes
      const view = g.level<KernelView>('kernel.view')
      const kernel: KernelHandle = {
        domain,
        nodes: stand,
        view,
        start: async () => {},
        requestsFrom: () => {}
      }
      return { writes, positions, candidates, facts, kernel, view, activity, heads }
    })
    const acts = tasks.each(b, 'acts', {
      kernel: raw.kernel,
      candidates: raw.candidates,
      facts: raw.facts,
      inputs: raw.positions,
      runId,
      maxReservations,
      backoff: { baseBlocks: 1, maxBlocks: 4 },
      policy: ({ bid }, key) => policy(bid, key),
      prepare: {
        lane: lane('venue', { concurrency, queue: 8 }),
        timeoutMs,
        handle: (request, { signal }) =>
          new Promise((resolve, reject) =>
            asked.push({
              id: request.id,
              key: request.key,
              signal,
              answer: answer => {
                if (answer instanceof Error) return reject(answer)
                if (typeof answer === 'object') return resolve(answer)
                resolve(
                  answer === 'ok'
                    ? { ok: true, validUntil: 60_000, steps: STEPS }
                    : { ok: false, reason: 'no_route', backoff: false }
                )
              }
            })
          )
      }
    })
    b.sink('record.submits', {
      on: { request: acts.requests },
      handle: ({ value }) => void submits.push(value)
    })
    b.sink('record.log', {
      on: { event: acts.events },
      handle: ({ value }) => logTasks(logger, value)
    })
    return { ...raw, acts }
  })(undefined)
  const clock = { now: 0 }
  const runner = createRunner(graph, { now: () => clock.now })
  const write = (entries: Record<string, Position>, expiry: number | null = 60_000, block = 0) =>
    runner.push(nodes.writes, {
      coverage: 'complete',
      entries,
      basis: { block, blockHash: `0x${block}` },
      ...(expiry !== null && { expiry }),
      ...(Object.keys(entries).length === 0 && { empty: true })
    })
  const fail = () => runner.push(nodes.writes, { coverage: 'failed', reason: 'read' })
  const acceptingNewWork = (on: boolean) =>
    runner.push(nodes.view, {
      value: { busy: [], numReservations: 0, acceptingNewWork: on, conflictMarks: {} },
      basis: 'test'
    })
  const settle = () => new Promise(resolve => setImmediate(resolve))
  const answer = async (key: string, answered: Answer = 'ok') => {
    const at = asked.findIndex(entry => entry.key === key)
    asked.splice(at, 1)[0]!.answer(answered)
    await settle()
    await settle()
  }
  const preparedOf = () =>
    submits.flatMap(request => (request.type === 'Submit' ? [request.plan.decision?.prepared] : []))
  const events = (event: string) => logged.filter(([name]) => name === event).map(([, f]) => f)
  return {
    graph,
    runner,
    nodes,
    asked,
    submits,
    preparedOf,
    events,
    clock,
    write,
    fail,
    acceptingNewWork,
    answer,
    settle
  }
}

describe('a task family', () => {
  it('prepares and submits by priority, resting each act on its key', async () => {
    const bot = family(PER_KEY)
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n }, b: { bid: 3n }, c: { bid: 2n } })
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['b', 'c'])
    await bot.answer('c')
    await bot.answer('b')
    expect(bot.events('act.submitted').map(fields => fields?.id)).toStrictEqual(['c', 'b'])
    const [first] = bot.submits
    expect(first?.type === 'Submit' && first.plan.evidence?.[0]?.id).toBe('facts/c')
    await bot.answer('a')
    await bot.runner.abandon()
  })
})

describe('a declined preparation', () => {
  it('is prepared again when only its input changes, and not when nothing does', async () => {
    const bot = family(PER_KEY)
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n, read: 1 } })
    await bot.answer('a', 'decline')
    bot.write({ a: { bid: 1n, read: 1 } })
    expect(bot.asked).toStrictEqual([])
    bot.write({ a: { bid: 1n, read: 2 } })
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['a'])
    await bot.answer('a')
    expect(bot.events('act.submitted').map(fields => fields?.id)).toStrictEqual(['a'])
    await bot.runner.abandon()
  })
})

describe('an act the kernel refuses on stale evidence', () => {
  it('is prepared again on the next read of its fact, not before, and backs nothing off', async () => {
    const bot = family(PER_KEY)
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n } })
    await bot.answer('a')
    const [submitted] = bot.submits
    const intentId = submitted?.type === 'Submit' ? submitted.plan.intentId : ''
    bot.runner.push(bot.nodes.activity, [
      {
        type: 'notice',
        intentId,
        notice: 'refused',
        code: 'evidence_predates_own_effect',
        reason: 'evidence facts/a predates our own effect on a'
      }
    ])
    expect(bot.asked).toStrictEqual([])
    expect(bot.runner.read(bot.nodes.acts.backoff.state)!.keys).toStrictEqual({})
    bot.write({ a: { bid: 1n } }, 61_000)
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['a'])
    await bot.answer('a')
    await bot.runner.abandon()
  })
})

describe('a key after our own effect on what it writes', () => {
  it('is not prepared until its fact is read at or after that effect', async () => {
    const bot = family(PER_KEY)
    bot.runner.push(bot.nodes.view, {
      value: { busy: [], numReservations: 0, acceptingNewWork: true, conflictMarks: { a: 5 } },
      basis: 'test'
    })
    bot.write({ a: { bid: 1n }, b: { bid: 1n } }, 60_000, 4)
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['b'])
    bot.write({ a: { bid: 1n }, b: { bid: 1n } }, 60_000, 5)
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['b', 'a'])
    await bot.answer('a')
    await bot.answer('b')
    await bot.runner.abandon()
  })
})

describe('a key that fails closed', () => {
  it('never submits what was prepared before, only a preparation asked after it reopens', async () => {
    let throws = false
    const bot = family((bid, key) => {
      if (throws) throw new Error('the policy broke')
      return PER_KEY(bid, key)
    })
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n } })
    const [voided] = bot.asked
    throws = true
    bot.acceptingNewWork(true)
    expect(bot.events('act.rejected')).toStrictEqual([{ id: 'a', reason: 'policy_threw' }])
    await bot.answer('a')
    throws = false
    bot.acceptingNewWork(true)
    expect(bot.submits).toStrictEqual([])
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['a'])
    await bot.answer('a')
    expect(bot.preparedOf()).toHaveLength(1)
    expect(bot.preparedOf()).not.toContain(voided!.id)
    await bot.runner.abandon()
  })

  it('keeps a voided ticket in its lane after the policy recovers', async () => {
    let invalid = false
    const bot = family((bid, key) =>
      invalid && key === 'a' ? (undefined as unknown as Task) : PER_KEY(bid, key)
    )
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 3n }, b: { bid: 2n }, c: { bid: 1n } })
    const [voided] = bot.asked
    invalid = true
    bot.acceptingNewWork(true)
    invalid = false
    bot.acceptingNewWork(true)
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['a', 'b'])
    await bot.answer('a')
    expect(bot.submits).toStrictEqual([])
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['b', 'a'])
    await bot.answer('a')
    expect(bot.preparedOf()).toHaveLength(1)
    expect(bot.preparedOf()).not.toContain(voided!.id)
    await bot.answer('b')
    await bot.answer('c')
    await bot.runner.abandon()
  })

  it("backoff is independent of whether the answer's ticket is still current", async () => {
    let invalid = false
    const bot = family(
      (bid, key) => (invalid && key === 'a' ? (undefined as unknown as Task) : PER_KEY(bid, key)),
      undefined,
      60_000,
      4,
      'run',
      1
    )
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 2n } })
    const [voided] = bot.asked
    invalid = true
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 2n }, b: { bid: 1n } })
    invalid = false
    bot.acceptingNewWork(true)
    expect(bot.runner.read(bot.nodes.acts.state)!.preparing.a).toMatchObject({
      id: voided!.id,
      void: true
    })

    await bot.answer('a', new Error('preparation failed'))
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['b'])
    expect(bot.events('act.prepare_failed')).toStrictEqual([
      {
        id: 'a',
        task: 'act',
        ticket: voided!.id,
        reason: 'prepare_threw',
        error: 'Error'
      }
    ])
    expect(bot.runner.read(bot.nodes.acts.backoff.state)!.keys.a?.act?.failures).toBe(1)
    expect(bot.submits).toStrictEqual([])

    await bot.answer('b', 'decline')
    bot.runner.push(bot.nodes.heads, { number: 1, hash: '0x1' })
    const [fresh] = bot.asked
    expect(fresh?.key).toBe('a')
    expect(fresh?.id).not.toBe(voided?.id)
    await bot.answer('a')
    expect(bot.preparedOf()).toStrictEqual([fresh!.id])
    expect(bot.preparedOf()).not.toContain(voided!.id)
    await bot.runner.abandon()
  })

  it('drops a prepared act it was holding, and submits only a fresh one', async () => {
    let throws = false
    const bot = family((bid, key) => {
      if (throws) throw new Error('the policy broke')
      return PER_KEY(bid, key)
    })
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n } })
    const [held] = bot.asked
    bot.acceptingNewWork(false)
    await bot.answer('a')
    throws = true
    bot.acceptingNewWork(false)
    expect(bot.events('act.dropped')).toStrictEqual([
      { id: 'a', task: 'act', reason: 'policy_rejected' }
    ])
    throws = false
    bot.acceptingNewWork(true)
    expect(bot.submits).toStrictEqual([])
    await bot.answer('a')
    expect(bot.preparedOf()).toHaveLength(1)
    expect(bot.preparedOf()).not.toContain(held!.id)
    await bot.runner.abandon()
  })
})

describe('a policy return the runtime refuses', () => {
  it('fails only its key, with a named rejection, and the bot runs on', async () => {
    const malformed: Readonly<Record<string, () => Task>> = {
      handBuilt: () => ({ kind: 'task', name: 'act', priority: 1n, conflicts: {} }),
      number: () => task('act', { priority: 1 as unknown as bigint, conflicts: {} }),
      hole: () => task('act', { priority: 1n, conflicts: { writes: Array.from({ length: 1 }) } }),
      dotted: () => task('a.ct', { priority: 1n, conflicts: {} })
    }
    const bot = family((bid, key) => malformed[key]?.() ?? PER_KEY(bid, key))
    const entries = {
      good: { bid: 1n },
      ...Object.fromEntries(Object.keys(malformed).map(key => [key, { bid: 9n }]))
    }
    bot.acceptingNewWork(true)
    bot.write(entries)
    expect(bot.events('act.rejected')).toStrictEqual(
      Object.keys(malformed).map(id => ({ id, reason: 'policy_invalid' }))
    )
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['good'])
    await bot.answer('good')
    expect(bot.events('act.submitted').map(fields => fields?.id)).toStrictEqual(['good'])
    bot.acceptingNewWork(true)
    expect(bot.events('act.rejected')).toHaveLength(Object.keys(malformed).length)
    await bot.runner.abandon()
  })
})

describe('a task whose fields change after it was built', () => {
  it('acts on the task as it was read, never reading its spec again', async () => {
    const bot = family((bid, key) => {
      let reads = 0
      return task('act', {
        get priority() {
          reads++
          if (reads > 1) throw new Error('read twice')
          return bid
        },
        conflicts: { writes: [key] }
      })
    })
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n } })
    await bot.answer('a')
    expect(bot.events('act.rejected')).toStrictEqual([])
    expect(bot.events('act.submitted').map(fields => fields?.id)).toStrictEqual(['a'])
    await bot.runner.abandon()
  })
})

describe('a policy whose task changes', () => {
  it('drops the old ready act and submits only a preparation of the new task', async () => {
    let name = 'one'
    const bot = family((bid, key) => task(name, { priority: bid, conflicts: { writes: [key] } }))
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n } })
    const [old] = bot.asked
    bot.acceptingNewWork(false)
    await bot.answer('a')
    name = 'two'
    bot.acceptingNewWork(true)
    expect(bot.events('act.dropped')).toStrictEqual([
      { id: 'a', task: 'one', reason: 'task_changed' }
    ])
    expect(bot.submits).toStrictEqual([])
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['a'])
    const [fresh] = bot.asked
    await bot.answer('a')
    expect(bot.preparedOf()).toStrictEqual([fresh!.id])
    expect(bot.preparedOf()).not.toContain(old!.id)
    await bot.runner.abandon()
  })

  it('drops a ready act whose task keeps its name but changes its conflicts', async () => {
    let writes = ['A']
    const bot = family(bid => task('one', { priority: bid, conflicts: { writes } }))
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n } })
    bot.acceptingNewWork(false)
    await bot.answer('a')
    writes = ['B']
    bot.acceptingNewWork(true)
    expect(bot.events('act.dropped')).toStrictEqual([
      { id: 'a', task: 'one', reason: 'task_changed' }
    ])
    expect(bot.submits).toStrictEqual([])
    await bot.answer('a')
    const [submitted] = bot.submits
    expect(submitted?.type === 'Submit' && submitted.plan.conflicts).toStrictEqual({
      writes: ['B']
    })
    await bot.runner.abandon()
  })
})

describe('two tasks of one key', () => {
  it('keep independent backoff: a task backed off never holds the other', async () => {
    let name = 'swap'
    const bot = family((bid, key) => task(name, { priority: bid, conflicts: { writes: [key] } }))
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n } })
    await bot.answer('a', { ok: false, reason: 'no_route', backoff: true })
    expect(bot.asked).toStrictEqual([])

    name = 'writeoff'
    bot.write({ a: { bid: 2n } })
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['a'])
    await bot.answer('a')
    const [submitted] = bot.submits
    expect(submitted?.type === 'Submit' && submitted.plan.intentId).toBe('a#run.2.writeoff')
    expect(Object.keys(bot.runner.read(bot.nodes.acts.backoff.state)!.keys.a!)).toStrictEqual([
      'swap'
    ])
    await bot.runner.abandon()
  })
})

describe('a prepared act whose key backs off after an act the bot wrote raw', () => {
  it('is held, not submitted, until the backoff ends, and then submitted as prepared', async () => {
    const bot = family(PER_KEY)
    const { activity, heads } = bot.nodes
    const raw = 'a#raw.0'
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n } })
    const [prepared] = bot.asked
    bot.runner.push(bot.nodes.view, {
      value: { busy: ['a'], numReservations: 1, acceptingNewWork: true, conflictMarks: {} },
      basis: 'test'
    })
    await bot.answer('a')
    expect(bot.submits).toStrictEqual([])
    bot.runner.pushAll([
      {
        node: activity,
        value: [
          { type: 'notice', intentId: raw, notice: 'failed' }
        ] as unknown as readonly KernelActivity[]
      },
      {
        node: bot.nodes.view,
        value: {
          value: { busy: [], numReservations: 0, acceptingNewWork: true, conflictMarks: {} },
          basis: 'test'
        }
      }
    ])
    expect(bot.submits).toStrictEqual([])
    bot.runner.push(heads, { number: 2, hash: '0x2' })
    expect(bot.preparedOf()).toStrictEqual([prepared!.id])
    await bot.runner.abandon()
  })
})

describe('an owned preparation', () => {
  it('ignores stale tickets, foreign keys and wrong versions without releasing the lane', async () => {
    const bot = family(PER_KEY)
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 2n }, b: { bid: 1n } })
    const state = bot.runner.read(bot.nodes.acts.state)!
    const asked = state.preparing.a!
    const answer = {
      id: asked.id,
      key: 'a',
      version: asked.reading.fact.version,
      ok: true,
      validUntil: 60_000,
      steps: STEPS
    }
    const fold = layoutOf(bot.graph).operators.find(op => op.kind === 'fold' && op.id === 'acts')!
    if (fold.kind !== 'fold') throw new Error('missing family fold')
    for (const foreign of [
      { ...answer, id: 'old-ticket' },
      { ...answer, key: 'b' },
      { ...answer, version: 'wrong-version' }
    ]) {
      expect(
        fold.applyInput(state, { from: 'prepared', value: foreign, stamp: { seq: 0, at: 0 } }).state
      ).toBe(state)
    }
    await bot.answer('a')
    await bot.answer('b')
    expect(bot.events('act.submitted').map(fields => fields?.id)).toStrictEqual(['a', 'b'])
    await bot.runner.abandon()
  })

  it('stamps the adapter outcome itself and keeps evidence from its own captured reading', async () => {
    const bot = family(PER_KEY)
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n } })
    const captured = bot.runner.read(bot.nodes.acts.state)!.preparing.a!
    const forged = {
      id: 'foreign-ticket',
      key: 'foreign-key',
      task: 'foreign-task',
      version: 'foreign-version',
      evidence: { fact: { id: 'foreign-fact', version: 'foreign-version' } },
      block: 99,
      ok: true as const,
      validUntil: 60_000,
      steps: STEPS
    }
    await bot.answer('a', forged)
    expect(bot.runner.read(bot.nodes.acts.prepared)).toStrictEqual({
      ...forged,
      id: captured.id,
      key: 'a',
      task: 'act',
      version: captured.reading.fact.version
    })
    const [submitted] = bot.submits
    expect(submitted?.type).toBe('Submit')
    if (submitted?.type === 'Submit') {
      expect(submitted.plan.evidence).toStrictEqual([captured.reading.fact])
      expect(submitted.plan.basisBlock).toBe(0)
      expect(submitted.plan.decision).toStrictEqual({
        key: 'a',
        priority: '1',
        prepared: captured.id
      })
    }
    await bot.runner.abandon()
  })

  it('drops an answer whose captured version no longer matches the current fact', async () => {
    const bot = family(PER_KEY, bid => bid)
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n } })
    const [stale] = bot.asked
    bot.write({ a: { bid: 2n } })
    await bot.answer('a')
    expect(bot.events('act.dropped')).toStrictEqual([
      { id: 'a', task: 'act', reason: 'fact_changed' }
    ])
    expect(bot.submits).toStrictEqual([])
    const [fresh] = bot.asked
    await bot.answer('a')
    expect(bot.preparedOf()).toStrictEqual([fresh!.id])
    expect(bot.preparedOf()).not.toContain(stale!.id)
    await bot.runner.abandon()
  })
})

describe('keys named like the fields every object inherits', () => {
  it('are prepared and submitted like any other', async () => {
    const bot = family(PER_KEY)
    const keys = ['constructor', 'toString', '__proto__']
    bot.acceptingNewWork(true)
    expect(bot.asked).toStrictEqual([])
    bot.write(Object.fromEntries(keys.map((key, i) => [key, { bid: BigInt(i + 1) }])))
    expect(bot.asked.map(entry => entry.key)).toContain('__proto__')
    while (bot.asked.length > 0) await bot.answer(bot.asked[0]!.key)
    expect(bot.events('act.submitted').map(fields => fields?.id)).toStrictEqual([
      '__proto__',
      'toString',
      'constructor'
    ])
    expect(bot.submits).toHaveLength(keys.length)
    await bot.runner.abandon()
  })
})

describe('a fact that bounds no act', () => {
  it('drops an act on a fact with no expiry, naming it, until its inputs change', async () => {
    const bot = family(PER_KEY)
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n } }, null)
    await bot.answer('a')
    expect(bot.events('act.dropped')).toStrictEqual([
      { id: 'a', task: 'act', reason: 'fact_unbounded', fact: 'facts/a' }
    ])
    bot.acceptingNewWork(true)
    expect(bot.asked).toStrictEqual([])
    bot.write({ a: { bid: 2n } }, null)
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['a'])
    await bot.answer('a')
    expect(bot.submits).toStrictEqual([])
    await bot.runner.abandon()
  })

  it('drops an act whose fact expired, and prepares none on it after a failed read', async () => {
    const bot = family(PER_KEY)
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n } }, 100)
    bot.clock.now = 100
    bot.fail()
    await bot.answer('a')
    expect(bot.events('act.dropped')).toStrictEqual([
      { id: 'a', task: 'act', reason: 'fact_expired' }
    ])
    bot.acceptingNewWork(true)
    expect(bot.asked).toStrictEqual([])
    bot.write({ a: { bid: 1n } }, 200)
    await bot.answer('a')
    expect(bot.events('act.submitted').map(fields => fields?.id)).toStrictEqual(['a'])
    await bot.runner.abandon()
  })
})

describe('a preparation the runtime answers itself', () => {
  afterEach(() => void vi.useRealTimers())

  it('times out a handler that ignores its signal, freeing its slot and backing its key off', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const bot = family(PER_KEY, undefined, 20)
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 3n }, b: { bid: 2n }, c: { bid: 1n } })
    const [a, b] = bot.asked
    expect([a?.key, b?.key]).toStrictEqual(['a', 'b'])
    vi.advanceTimersByTime(20)
    await bot.settle()
    await bot.settle()
    expect([a?.signal.aborted, b?.signal.aborted]).toStrictEqual([true, true])
    expect(bot.events('act.prepare_failed')).toStrictEqual([
      { id: 'a', task: 'act', ticket: a!.id, reason: 'prepare_timed_out' },
      { id: 'b', task: 'act', ticket: b!.id, reason: 'prepare_timed_out' }
    ])
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['a', 'b', 'c'])
    await bot.answer('a')
    await bot.answer('b')
    expect(bot.submits).toStrictEqual([])
    bot.runner.push(bot.nodes.heads, { number: 1, hash: '0x1' })
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['c', 'a'])
    await bot.answer('a')
    await bot.answer('c')
    expect(bot.events('act.submitted').map(fields => fields?.id)).toStrictEqual(['a', 'c'])
    await bot.runner.abandon()
  })

  it('backs off a key whose handler throws, naming only the error, and runs on', async () => {
    const bot = family(PER_KEY)
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 2n }, b: { bid: 1n } })
    const [a] = bot.asked
    const thrown = new TypeError('fetch https://rpc.example/secret failed')
    thrown.name = 'https://rpc.example/secret'
    await bot.answer('a', thrown)
    expect(bot.events('act.prepare_failed')).toStrictEqual([
      { id: 'a', task: 'act', ticket: a!.id, reason: 'prepare_threw', error: 'TypeError' }
    ])
    expect(bot.runner.read(bot.nodes.acts.backoff.state)!.keys.a?.act?.failures).toBe(1)
    const opaque = new Error('opaque')
    Object.defineProperty(opaque, 'constructor', {
      get: () => {
        throw new Error('no constructor')
      }
    })
    bot.write({ a: { bid: 2n }, b: { bid: 1n }, c: { bid: 3n } })
    await bot.answer('c', opaque)
    expect(bot.events('act.prepare_failed').at(-1)).toMatchObject({ id: 'c', error: 'Error' })
    await bot.answer('b')
    expect(bot.events('act.submitted').map(fields => fields?.id)).toStrictEqual(['b'])
    expect(bot.asked).toStrictEqual([])
    await bot.runner.abandon()
  })

  it('lets a clean stop settle with a hung preparation in flight', async () => {
    const bot = family(PER_KEY)
    bot.acceptingNewWork(true)
    bot.write({ a: { bid: 1n } })
    const [a] = bot.asked
    await bot.runner.abandon()
    expect(a?.signal.aborted).toBe(true)
    expect(bot.events('act.prepare_failed')).toStrictEqual([])
  })

  it('is refused at build without a timeout it can arm', () => {
    for (const timeoutMs of [0, 1.5, 2 ** 31, Number.NaN])
      expect(() => family(PER_KEY, undefined, timeoutMs)).toThrow(
        'acts needs prepare.timeoutMs, a whole number of milliseconds from 1 to 2147483647'
      )
  })

  it('is refused at build without a reservation cap it can reach', () => {
    for (const maxReservations of [-1, 1.5, Number.POSITIVE_INFINITY, Number.NaN])
      expect(() => family(PER_KEY, undefined, 60_000, maxReservations)).toThrow(
        'acts needs maxReservations, a whole number from 0'
      )
  })

  it('is refused at build with a runId its intent ids cannot be parsed back to', () => {
    for (const runId of ['v1.2', 'a#b'])
      expect(() => family(PER_KEY, undefined, 60_000, 4, runId)).toThrow(
        "acts needs a runId that holds neither '.' nor '#'"
      )
  })
})

describe('a key whose act an earlier run left behind', () => {
  it('backs off after a restart when that act fails, though nothing was carried over', async () => {
    const bot = family(PER_KEY)
    bot.acceptingNewWork(true)
    bot.runner.push(bot.nodes.heads, { number: 1, hash: '0x1' })
    bot.runner.push(bot.nodes.activity, [
      { type: 'notice', intentId: intentIdOf('a', 'earlier', 0, 'act'), notice: 'failed' },
      {
        type: 'notice',
        intentId: intentIdOf('b', 'earlier', 1, 'act'),
        notice: 'compensating',
        reason: 'restart withdraws b: policy now refuses: x'
      }
    ] as unknown as readonly KernelActivity[])
    bot.write({ a: { bid: 2n }, b: { bid: 1n } })
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['b'])
    bot.runner.push(bot.nodes.heads, { number: 2, hash: '0x2' })
    expect(bot.asked.map(entry => entry.key)).toStrictEqual(['b', 'a'])
    await bot.answer('a')
    await bot.answer('b')
    expect(bot.events('act.submitted').map(fields => fields?.id)).toStrictEqual(['a', 'b'])
    await bot.runner.abandon()
  })
})
