import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'

import type { JournalEntry } from '../src'

import { createGraph, createRunner, emitTo, every } from '../src'
import { replay } from '../src/replay'
import { ledgerGraph } from './fixtures'

describe('replay', () => {
  it('replays a finite feedback graph at the fixed cycle bound', async () => {
    const entries: JournalEntry[] = []
    const feedbackGraph = () => {
      const g = createGraph('feedback')
      const kicks = g.occurrences<number>('kicks')
      const pong = g.node<number>('pong')
      const ping = g.node<number>('ping')
      g.fold('left', {
        reads: { kick: every(kicks), pong: every(pong) },
        emits: [ping],
        initial: 0,
        applyInput: (count, { value }) => ({
          state: count + 1,
          emit: [emitTo(ping, value + 1)]
        })
      })
      g.fold('right', {
        reads: { ping: every(ping) },
        emits: [pong],
        initial: 0,
        applyInput: (count, { value }) => ({
          state: count + 1,
          ...(value < 65 && { emit: [emitTo(pong, value)] })
        })
      })
      return { graph: g.build(), kicks }
    }
    const live = feedbackGraph()
    const runner = createRunner(live.graph, {
      journal: {
        sink: { append: async entry => void entries.push(entry), finalize: async () => undefined },
        capacityBytes: 1_000_000
      }
    })
    runner.push(live.kicks, 0)
    await sleep(0)
    await runner.abandon()

    expect(replay(feedbackGraph().graph, entries)).toStrictEqual({ ok: true, steps: 1 })
  })

  it("replays a journal's stamped steps without running an effect, and finds a step that differs", async () => {
    const entries: JournalEntry[] = []
    const { g, amounts, orders } = ledgerGraph()
    const live = vi.fn()
    g.effect('send', { requests: { order: every(orders) }, handle: live })
    const graph = g.build()
    const runner = createRunner(graph, {
      journal: {
        sink: { append: async e => void entries.push(e), finalize: async () => undefined },
        capacityBytes: 16_000
      }
    })
    for (const amount of [1, 2, 3]) runner.push(amounts, amount)
    await sleep(0)
    await runner.abandon()
    expect(live).toHaveBeenCalledTimes(3)

    const replayed = ledgerGraph()
    const forbidden = vi.fn(() => {
      throw new Error('an effect ran during replay')
    })
    replayed.g.effect('send', { requests: { order: every(replayed.orders) }, handle: forbidden })
    expect(replay(replayed.g.build(), entries)).toStrictEqual({ ok: true, steps: 3 })
    expect(forbidden).not.toHaveBeenCalled()

    const tampered = entries.map((entry, i) =>
      i === 1 ? { ...entry, writes: [{ node: 'amounts', value: 9 }] } : entry
    )
    expect(replay(ledgerGraph().g.build(), tampered)).toStrictEqual({
      ok: false,
      step: 2,
      reason: 'derived writes differ'
    })
  })

  it('replays a keyed delta whose entries contain an own __proto__ key', async () => {
    const entries: JournalEntry[] = []
    const g = createGraph('proto-key')
    const writes = g.occurrences('writes')
    const runner = createRunner(g.build(), {
      journal: {
        sink: { append: async entry => void entries.push(entry), finalize: async () => undefined },
        capacityBytes: 16_000
      }
    })
    const keyed = (debt: number) => ({
      coverage: 'complete',
      entries: Object.fromEntries([['__proto__', { debt }]])
    })
    runner.push(writes, keyed(1))
    runner.push(writes, keyed(2))
    await runner.abandon()

    const delta = entries
      .filter(entry => entry.kind === 'step')
      .flatMap(entry => entry.writes)
      .find(write => 'delta' in write)
    expect(delta && 'delta' in delta && Object.hasOwn(delta.delta.entries, '__proto__')).toBe(true)
    const replayed = createGraph('proto-key')
    replayed.occurrences('writes')
    expect(replay(replayed.build(), entries)).toStrictEqual({ ok: true, steps: 2 })
  })
})
