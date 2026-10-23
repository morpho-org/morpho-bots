import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import type {
  Data,
  EffectContext,
  GraphBuilder,
  JOURNAL_FORMAT,
  JournalEntry,
  Node,
  Runner,
  RunnerOptions,
  Source,
  Stream
} from '../src'

import {
  createGraph,
  createRunner,
  CycleBoundError,
  emitTo,
  every,
  GraphDefinitionError,
  GraphFailedError,
  JournalFailedError,
  JournalIoTimeoutError,
  JournalOverflowError,
  encode,
  lane,
  LaneOverflowError,
  latest,
  NotDataError,
  PolicyReentryError,
  ReentrantPushError,
  RequestRefusedError,
  RunnerFinalizationError,
  sample,
  sourceWrite,
  watch,
  WriteRefusedError
} from '../src'
import { replay } from '../src/replay'
import { layoutOf } from '../src/testing'
import { ledgerGraph } from './fixtures'

const gate = () => {
  let open = () => {}
  const opened = new Promise<void>(resolve => {
    open = resolve
  })
  return { opened, open }
}

describe('the runner', () => {
  it('exposes whether it has a journal', async () => {
    const graph = createGraph('journal-capability').build()
    const plain = createRunner(graph)
    const journaled = createRunner(graph, {
      journal: {
        sink: { append: async () => undefined, finalize: async () => undefined },
        capacityBytes: 1_000
      }
    })

    expect(plain.hasJournal).toBe(false)
    expect(journaled.hasJournal).toBe(true)
    await Promise.all([plain.abandon(), journaled.abandon()])
  })

  it('lands every derived write and emit of a step before any effect starts', async () => {
    const { g, amounts, orders, total, doubled } = ledgerGraph()
    const seen: { order: number; total?: number; doubled?: number }[] = []
    g.effect('send', {
      requests: { order: every(orders) },
      samples: { total, doubled },
      handle: ({ value: order }, context) => {
        seen.push({ order, total: context.samples.total(), doubled: context.samples.doubled() })
      }
    })
    const runner = createRunner(g.build())
    runner.pushAll([sourceWrite(amounts, 1), sourceWrite(amounts, 2)])
    expect(runner.read(total)).toBe(3)
    expect(runner.read(doubled)).toBe(6)
    expect(seen).toStrictEqual([
      { order: 1, total: 3, doubled: 6 },
      { order: 3, total: 3, doubled: 6 }
    ])
    await runner.abandon()
  })

  it('hands out frozen values, so a reader cannot change what other readers see', async () => {
    const g = createGraph('frozen')
    const books = g.occurrences<{ offers: string[] }>('books')
    const runner = createRunner(g.build())
    runner.push(books, { offers: ['a'] })
    expect(() => runner.read(books)!.offers.push('b')).toThrow(TypeError)
    expect(runner.read(books)).toStrictEqual({ offers: ['a'] })
    await runner.abandon()
  })

  it('stops with nothing applied when an operator pushes from inside a step', async () => {
    const g = createGraph('reentrant')
    const amounts = g.occurrences<number>('amounts')
    let runner: ReturnType<typeof createRunner> | undefined
    const echoed = g.map('echo', {
      reads: { amount: latest(amounts) },
      compute: ({ amount }) => {
        if (amount === 2) runner?.push(amounts, 3)
        return amount
      }
    })
    runner = createRunner(g.build())
    runner.push(amounts, 1)
    runner.push(amounts, 2)
    await expect(runner.stopped).rejects.toBeInstanceOf(ReentrantPushError)
    expect(runner.read(echoed)).toBe(1)
    expect(runner.read(amounts)).toBe(1)
  })

  it('runs a push an effect makes while starting only after the step that started it', async () => {
    const { g, amounts, orders, total } = ledgerGraph()
    const totals: (number | undefined)[] = []
    g.effect('refill', {
      requests: { order: every(orders) },
      samples: { total },
      handle: ({ value: order }, context) => {
        if (order === 1) runner.push(amounts, 10)
        totals.push(context.samples.total())
      }
    })
    const runner = createRunner(g.build())
    runner.push(amounts, 1)
    expect(totals).toStrictEqual([1, 11])
    await runner.abandon()
  })

  it('fails closed when a step re-enters evaluated operators past the cycle bound', async () => {
    const g = createGraph('cycle')
    const kicks = g.occurrences<number>('kicks')
    const pong = g.node<number>('pong')
    const ping = g.node<number>('ping')
    const left = g.fold('left', {
      reads: { kick: every(kicks), pong: every(pong) },
      emits: [ping],
      initial: 0,
      applyInput: (n, { value }) => ({ state: n + 1, emit: [emitTo(ping, value + 1)] })
    })
    g.fold('right', {
      reads: { ping: every(ping) },
      emits: [pong],
      initial: 0,
      applyInput: (n, { value }) => ({ state: n + 1, emit: [emitTo(pong, value)] })
    })
    const started = vi.fn()
    g.effect('send', { requests: { ping: every(ping) }, handle: started })
    const runner = createRunner(g.build())
    runner.push(kicks, 0)
    await expect(runner.stopped).rejects.toBeInstanceOf(CycleBoundError)
    expect(started).not.toHaveBeenCalled()
    expect(runner.read(left)).toBe(0)
  })

  it('takes a burst of hundreds of keys in one push without touching the cycle bound', async () => {
    const g = createGraph('burst')
    const positions = g.occurrences<{ key: string }>('positions')
    const acts = g.node<string>('acts')
    const known = g.fold('known', {
      reads: { position: every(positions) },
      emits: [acts],
      initial: [] as string[],
      applyInput: (keys, { value }) => ({
        state: [...keys, value.key],
        emit: [emitTo(acts, value.key)]
      })
    })
    const started: string[] = []
    g.effect('act', {
      requests: { act: every(acts) },
      handle: ({ value }) => void started.push(value)
    })
    const runner = createRunner(g.build())
    const burst = Array.from({ length: 500 }, (_, i) => sourceWrite(positions, { key: `k${i}` }))
    runner.pushAll(burst)
    expect(runner.read(known)).toHaveLength(500)
    expect(started).toHaveLength(500)
    expect(started[499]).toBe('k499')
    await runner.abandon()
  })

  it('refuses a level write without its basis, and refreshes evidence on an equal write', async () => {
    const g = createGraph('levels')
    const price = g.level<number>('price')
    const runner = createRunner(g.build())
    expect(() => runner.push(price, { value: 1 } as never)).toThrow(WriteRefusedError)
    runner.push(price, { value: 1, basis: { block: 10 } })
    runner.push(price, { value: 1, basis: { block: 11 } })
    expect(runner.record(price)).toMatchObject({ value: 1, basis: { block: 11 } })
    runner.push(price, { value: 2, basis: { block: 12 } })
    expect(runner.record(price)).toMatchObject({ value: 2, basis: { block: 12 } })
    await runner.abandon()
  })

  it('refuses a push into a node only its producer writes, and changes nothing', async () => {
    const { g, amounts, orders, total, doubled } = ledgerGraph()
    const runner = createRunner(g.build())
    runner.push(amounts, 2)
    for (const node of [total, doubled, orders] as Node<number>[]) {
      expect(() => runner.push(node as never, 7)).toThrow(
        new WriteRefusedError(node.id, 'only its producer writes it')
      )
    }
    expect(runner.read(total)).toBe(2)
    expect(runner.read(doubled)).toBe(4)
    await runner.abandon()
  })

  it('refuses a push by a handle another graph created, though the ids match', async () => {
    const { g, amounts } = ledgerGraph()
    const runner = createRunner(g.build())
    expect(() => runner.push(ledgerGraph().amounts, 2)).toThrow(
      new WriteRefusedError(amounts.id, `its handle is not from ${g.build().id}`)
    )
    await runner.abandon()
  })

  it('stops when an operator emits to a node it does not own', async () => {
    const g = createGraph('stray')
    const amounts = g.occurrences<number>('amounts')
    const owned = g.node<number>('owned')
    const stray = g.node<number>('stray')
    g.fold('total', {
      reads: { amount: every(amounts) },
      emits: [owned],
      initial: 0,
      applyInput: (sum, { value }) => ({ state: sum + value, emit: [emitTo(stray, value)] })
    })
    g.fold('owner', {
      reads: { amount: every(amounts) },
      emits: [stray],
      initial: 0,
      applyInput: count => ({ state: count + 1 })
    })
    const runner = createRunner(g.build())
    runner.push(amounts, 1)
    await expect(runner.stopped).rejects.toStrictEqual(
      new GraphDefinitionError('total emitted to stray, which it does not own')
    )
    expect(runner.read(stray)).toBeUndefined()
  })

  it('reads a sample when it is called, so a read after an await sees later steps', async () => {
    const { g, amounts, orders, total } = ledgerGraph()
    const held = gate()
    const reads: number[] = []
    g.effect('send', {
      requests: { order: every(orders) },
      samples: { total },
      handle: async ({ value }, context) => {
        if (value !== 1) return
        reads.push(context.samples.total())
        await held.opened
        reads.push(context.samples.total())
        // @ts-expect-error an effect reads only the samples it names
        void context.samples.amounts
      }
    })
    const runner = createRunner(g.build())
    runner.push(amounts, 1)
    runner.push(amounts, 2)
    held.open()
    await sleep(0)
    expect(reads).toStrictEqual([1, 3])
    await runner.abandon()
  })

  it('types a sample with an initial value as present, and any other as possibly unwritten', () => {
    const { g, amounts, orders, total, doubled } = ledgerGraph()
    const price = g.level<number>('price')
    const priced = g.map('priced', {
      reads: { total: latest(total), price: latest(price) },
      compute: ({ total, price }) => total * price
    })
    g.effect('send', {
      requests: { order: every(orders) },
      samples: { total, doubled, priced, orders, amounts },
      handle: (_, context) => {
        expectTypeOf(context.samples.total).returns.toEqualTypeOf<number>()
        expectTypeOf(context.samples.doubled).returns.toEqualTypeOf<number>()
        expectTypeOf(context.samples.priced).returns.toEqualTypeOf<number | undefined>()
        expectTypeOf(context.samples.orders).returns.toEqualTypeOf<number | undefined>()
        expectTypeOf(context.samples.amounts).returns.toEqualTypeOf<number | undefined>()
      }
    })
  })

  it('tells an effect with several inputs which one each request came in on, in delivery order', async () => {
    const g = createGraph('inputs')
    const words = g.occurrences<string>('words')
    const counts = g.occurrences<number>('counts')
    const seen: string[] = []
    g.effect('log', {
      requests: { word: every(words), count: every(counts) },
      handle: request => {
        if (request.from === 'word') {
          expectTypeOf(request.value).toEqualTypeOf<string>()
          seen.push(`word ${request.value}`)
        } else seen.push(`count ${request.value.toFixed(0)}`)
      }
    })
    const runner = createRunner(g.build())
    runner.pushAll([sourceWrite(counts, 1), sourceWrite(words, 'a'), sourceWrite(counts, 2)])
    expect(seen).toStrictEqual(['count 1', 'word a', 'count 2'])
    await runner.abandon()
  })

  it('carries a failed read to its readers as failed, never as a value', async () => {
    const g = createGraph('failed')
    const price = g.level<number>('price')
    const doubled = g.map('doubled', {
      reads: { price: latest(price) },
      compute: ({ price }) => price * 2
    })
    const runner = createRunner(g.build())
    runner.push(price, { value: 1, basis: 1 })
    runner.push(price, { status: 'failed', reason: 'rpc down' })
    expect(runner.record(doubled)).toStrictEqual({ status: 'failed' })
    expect(runner.read(doubled)).toBeUndefined()
    await runner.abandon()
  })

  it('runs a reader once its sample is first present, and not again when the sample changes', async () => {
    const g = createGraph('samples')
    const ticks = g.occurrences<number>('ticks')
    const config = g.level<string>('config')
    const runs = vi.fn()
    g.map('joined', {
      reads: { tick: latest(ticks), config: sample(config) },
      compute: ({ tick, config }) => {
        runs()
        return `${config}@${tick}`
      }
    })
    const runner = createRunner(g.build())
    runner.push(ticks, 1)
    expect(runs).not.toHaveBeenCalled()
    runner.push(config, { value: 'a', basis: 0 })
    expect(runs).toHaveBeenCalledOnce()
    runner.push(config, { value: 'b', basis: 1 })
    expect(runs).toHaveBeenCalledOnce()
    await runner.abandon()
  })

  it('freezes an accepted write, so its evidence cannot change after it is read', async () => {
    const g = createGraph('evidence')
    const price = g.level<number>('price')
    const runner = createRunner(g.build())
    const basis = { block: 10 }
    runner.push(price, Object.freeze({ value: 1, basis }))
    expect(() => {
      basis.block = 11
    }).toThrow(TypeError)
    expect(runner.record(price).basis).toStrictEqual({ block: 10 })
    await runner.abandon()
  })

  it('keeps every write for a reader that waits on a sample, and hands them over once it runs', async () => {
    const g = createGraph('waiting')
    const requests = g.occurrences<string>('requests')
    const config = g.level<string>('config')
    const joined = g.map('joined', {
      reads: { requests: every(requests), config: sample(config) },
      compute: ({ requests, config }) => requests.map(r => `${r.value}@${config}`)
    })
    const runner = createRunner(g.build())
    runner.push(requests, 'a')
    expect(runner.record(joined).status).toBe('unknown')
    runner.push(config, { value: 'c', basis: 0 })
    expect(runner.read(joined)).toStrictEqual(['a@c'])
    await runner.abandon()
  })

  it('evaluates a sampled node before its readers, so breadth over a sample is no cycle', async () => {
    const g = createGraph('breadth')
    const ticks = g.occurrences<number>('ticks')
    const configs = g.node<string>('configs')
    const joins = Array.from({ length: 100 }, (_, i) =>
      g.map(`join${i}`, {
        reads: { tick: latest(ticks), config: sample(configs) },
        compute: ({ tick, config }) => `${config}@${tick}`
      })
    )
    g.fold('configure', {
      reads: { tick: every(ticks) },
      emits: [configs],
      initial: 0,
      applyInput: (n, { value }) => ({ state: n + 1, emit: [emitTo(configs, `v${value}`)] })
    })
    const runner = createRunner(g.build())
    runner.push(ticks, 1)
    expect(runner.read(joins[99]!)).toBe('v1@1')
    await runner.abandon()
  })

  it('stops rather than run a request whose identity is still waiting or running', async () => {
    const g = createGraph('identity')
    const requests = g.occurrences<string>('requests')
    const started: string[] = []
    g.effect('quote', {
      requests: { request: every(requests) },
      identify: ({ value }) => value,
      handle: ({ value }, context) => {
        started.push(value)
        return new Promise<void>(resolve =>
          context.signal.addEventListener('abort', () => resolve())
        )
      }
    })
    const runner = createRunner(g.build())
    runner.push(requests, 'q1')
    runner.push(requests, 'q1')
    await expect(runner.stopped).rejects.toBeInstanceOf(RequestRefusedError)
    expect(started).toStrictEqual(['q1'])
  })

  it('stops rather than run a completed request redelivered below its sequence', async () => {
    const g = createGraph('sequence')
    const requests = g.occurrences<number>('requests')
    const started: number[] = []
    g.effect('send', {
      requests: { request: every(requests) },
      sequence: ({ value }) => value,
      handle: ({ value }) => void started.push(value)
    })
    const runner = createRunner(g.build())
    runner.push(requests, 1)
    runner.push(requests, 2)
    await sleep(0)
    runner.push(requests, 1)
    await expect(runner.stopped).rejects.toBeInstanceOf(RequestRefusedError)
    expect(started).toStrictEqual([1, 2])
  })

  it('propagates a push queued during a step before starting any effect of that step', async () => {
    const g = createGraph('halting')
    const amounts = g.occurrences<number>('amounts')
    const seen: (boolean | undefined)[] = []
    g.scope(
      '',
      s => {
        const halts = s.occurrences<boolean>('halts')
        const halted = s.fold('halted', {
          reads: { halt: every(halts) },
          initial: false,
          applyInput: (_, { value }) => ({ state: value })
        })
        s.effect('send', {
          requests: { amount: every(amounts) },
          samples: { halted },
          handle: (_amount, context) => void seen.push(context.samples.halted())
        })
        return halts
      },
      { recovery: halts => () => [sourceWrite(halts, true)] }
    )
    const runner = createRunner(g.build(), {
      journal: {
        sink: { append: async () => undefined, finalize: async () => undefined },
        capacityBytes: 0
      }
    })
    runner.push(amounts, 1)
    expect(seen).toStrictEqual([true])
    await expect(runner.abandon()).rejects.toBeInstanceOf(JournalOverflowError)
  })

  it('holds work past a lane bound and starts recovery work first', async () => {
    const g = createGraph('lanes')
    const requests = g.occurrences<{ name: string; recovery: boolean }>('requests')
    const venue = lane('venue', { concurrency: 1, queue: 4 })
    const held = gate()
    const started: string[] = []
    g.effect('quote', {
      requests: { request: every(requests) },
      lane: venue,
      recovery: ({ value }) => value.recovery,
      handle: async ({ value: { name } }) => {
        started.push(name)
        await held.opened
      }
    })
    const runner = createRunner(g.build())
    runner.push(requests, { name: 'first', recovery: false })
    runner.push(requests, { name: 'normal', recovery: false })
    runner.push(requests, { name: 'cancel', recovery: true })
    expect(started).toStrictEqual(['first'])
    held.open()
    await sleep(0)
    expect(started).toStrictEqual(['first', 'cancel', 'normal'])
    await runner.abandon()
  })

  it('admits recovery work into a lane whose normal queue is full', async () => {
    const g = createGraph('reserve')
    const requests = g.occurrences<{ name: string; recovery: boolean }>('requests')
    const started: string[] = []
    const held = gate()
    g.effect('send', {
      requests: { request: every(requests) },
      lane: lane('sends', { concurrency: 1, queue: 1 }),
      recovery: ({ value }) => value.recovery,
      handle: async ({ value: { name } }) => {
        started.push(name)
        await held.opened
      }
    })
    const runner = createRunner(g.build())
    runner.push(requests, { name: 'first', recovery: false })
    runner.pushAll(
      [
        { name: 'normal', recovery: false },
        { name: 'withdraw', recovery: true }
      ].map(request => sourceWrite(requests, request))
    )
    held.open()
    await sleep(0)
    expect(started).toStrictEqual(['first', 'withdraw', 'normal'])
    await runner.abandon()
  })

  it('bounds every waiting request of a lane without a concurrency bound', async () => {
    const g = createGraph('unbounded')
    const requests = g.occurrences<number>('requests')
    g.effect('quote', {
      requests: { request: every(requests) },
      lane: lane('venue', { concurrency: Number.POSITIVE_INFINITY, queue: 2 }),
      ready: () => false,
      handle: () => undefined
    })
    const runner = createRunner(g.build())
    runner.pushAll([1, 2, 3].map(n => sourceWrite(requests, n)))
    await expect(runner.stopped).rejects.toBeInstanceOf(LaneOverflowError)
  })

  it('takes a burst up to its free slots plus its queue, and stops rather than skip work past it', async () => {
    const g = createGraph('overflow')
    const requests = g.occurrences<number>('requests')
    const started: number[] = []
    g.effect('quote', {
      requests: { request: every(requests) },
      lane: lane('venue', { concurrency: 2, queue: 1 }),
      handle: ({ value }, { signal }) => {
        started.push(value)
        return new Promise<void>(resolve => signal.addEventListener('abort', () => resolve()))
      }
    })
    const runner = createRunner(g.build())
    let failure: unknown
    runner.stopped.catch((error: unknown) => (failure = error))
    runner.pushAll([1, 2, 3].map(n => sourceWrite(requests, n)))
    await sleep(0)
    expect(started).toStrictEqual([1, 2])
    expect(failure).toBeUndefined()
    runner.push(requests, 4)
    await expect(runner.stopped).rejects.toBeInstanceOf(LaneOverflowError)
  })

  it('resolves its stop with the value an effect stops it with, after work that must land', async () => {
    const g = createGraph('stop')
    const requests = g.occurrences<string>('requests')
    const writing = gate()
    let landed = false
    g.effect('store', {
      requests: { request: every(requests) },
      handle: async ({ value }) => {
        if (value !== 'write') return
        await writing.opened
        landed = true
      }
    })
    g.effect('report', {
      requests: { request: every(requests) },
      handle: ({ value }, context) => {
        if (value === 'stop') context.stop('clean')
      }
    })
    const runner = createRunner(g.build())
    runner.push(requests, 'write')
    runner.push(requests, 'stop')
    setTimeout(writing.open, 20)
    await expect(runner.stopped).resolves.toBe('clean')
    expect(landed).toBe(true)
  })
})

describe('an effect that finishes on stop', () => {
  /** A reporter and an unflagged effect on one-at-a-time lanes, each holding its first request. */
  const reporting = () => {
    const g = createGraph('reporting')
    const stops = g.occurrences<string>('stops')
    const reports = g.occurrences<number>('reports')
    const reads = g.occurrences<number>('reads')
    const held = gate()
    const reported: number[] = []
    const sent: number[] = []
    g.effect('stopper', {
      requests: { stop: every(stops) },
      handle: ({ value }, context) => context.stop(value)
    })
    g.fold('bot', {
      reads: { read: every(reads) },
      initial: 0,
      applyInput: (n, { value }) => {
        if (value < 0) throw new Error('bot failed')
        return { state: n + 1 }
      }
    })
    const holding =
      (into: number[]) =>
      async ({ value }: { value: number }) => {
        if (value === 1) await held.opened
        into.push(value)
      }
    g.effect('report', {
      requests: { report: every(reports) },
      lane: lane('reports', { concurrency: 1, queue: 8 }),
      finishOnStop: true,
      handle: holding(reported)
    })
    g.effect('send', {
      requests: { report: every(reports) },
      lane: lane('sends', { concurrency: 1, queue: 8 }),
      handle: holding(sent)
    })
    const runner = createRunner(g.build())
    runner.pushAll([1, 2, 3].map(n => sourceWrite(reports, n)))
    return { runner, stops, reads, held, reported, sent }
  }

  it('runs its queued requests after a clean stop, before the stop settles, and drops the rest', async () => {
    const { runner, stops, held, reported, sent } = reporting()
    runner.push(stops, 'done')
    let settled = false
    void runner.stopped.then(() => (settled = true))
    await sleep(0)
    expect(settled).toBe(false)
    held.open()
    await expect(runner.stopped).resolves.toBe('done')
    expect(reported).toStrictEqual([1, 2, 3])
    expect(sent).toStrictEqual([1])
  })

  it('drops its queued requests when a failure stops the runner', async () => {
    const { runner, reads, held, reported } = reporting()
    runner.push(reads, -1)
    held.open()
    await expect(runner.stopped).rejects.toThrow('bot failed')
    expect(reported).toStrictEqual([1])
  })

  it('drops its queued requests when the runner is abandoned', async () => {
    const { runner, held, reported } = reporting()
    const abandoned = runner.abandon()
    held.open()
    await abandoned
    expect(reported).toStrictEqual([1])
  })

  it('drops the rest and rejects the stop with the error when one of them fails', async () => {
    const g = createGraph('failing report')
    const stops = g.occurrences<string>('stops')
    const reports = g.occurrences<number>('reports')
    const held = gate()
    const reported: number[] = []
    g.effect('stopper', {
      requests: { stop: every(stops) },
      handle: ({ value }, context) => context.stop(value)
    })
    g.effect('report', {
      requests: { report: every(reports) },
      lane: lane('reports', { concurrency: 1, queue: 8 }),
      finishOnStop: true,
      handle: async ({ value }) => {
        if (value === 1) await held.opened
        if (value === 2) throw new Error('report failed')
        reported.push(value)
      }
    })
    const runner = createRunner(g.build())
    runner.pushAll([1, 2, 3].map(n => sourceWrite(reports, n)))
    runner.push(stops, 'done')
    held.open()
    await expect(runner.stopped).rejects.toThrow('report failed')
    expect(reported).toStrictEqual([1])
  })

  it('settles the stop only after the work that stopped it, though that work goes on after', async () => {
    const g = createGraph('stopping')
    const stops = g.occurrences<string>('stops')
    const held = gate()
    let landed = false
    g.effect('stopper', {
      requests: { stop: every(stops) },
      handle: async ({ value }, context) => {
        context.stop(value)
        await held.opened
        landed = true
      }
    })
    const runner = createRunner(g.build())
    runner.push(stops, 'done')
    setTimeout(held.open, 10)
    await expect(runner.stopped).resolves.toBe('done')
    expect(landed).toBe(true)
  })

  it('refuses to wait to be ready, which nothing could change after a stop', () => {
    const g = createGraph('ready')
    const reports = g.occurrences<number>('reports')
    expect(() =>
      g.effect('report', {
        requests: { report: every(reports) },
        finishOnStop: true,
        ready: () => true,
        handle: () => {}
      })
    ).toThrow(new GraphDefinitionError('report finishes on stop, so it cannot wait to be ready'))
  })
})

describe('the journal', () => {
  const journaled = (sink: (entry: JournalEntry) => Promise<void>, capacityBytes = 16_000) => {
    const { g, amounts, total } = ledgerGraph()
    const runner = createRunner(g.build(), {
      now: () => 7,
      journal: { sink: { append: sink, finalize: async () => undefined }, capacityBytes }
    })
    return { runner, amounts, total }
  }

  it.each([null, false, 0, ''])('refuses a journal option that is not an object: %j', journal => {
    const g = createGraph('malformed-journal')
    g.occurrences<string>('values')
    expect(() => createRunner(g.build(), { journal: journal as never })).toThrow(
      'a journal option must be an object'
    )
  })

  it('bounds the journal queue in encoded bytes, queued plus in flight', async () => {
    const held = gate()
    const finalize = vi.fn(async () => undefined)
    const g = createGraph('bytes')
    const values = g.occurrences<string>('values')
    const value = 'é'.repeat(100)
    const first: JournalEntry = {
      kind: 'step',
      stamp: { seq: 1, at: 7 },
      writes: [{ node: 'values', value }],
      derived: []
    }
    const capacityBytes = Buffer.byteLength(encode(first))
    const runner = createRunner(g.build(), {
      now: () => 7,
      journal: {
        sink: { append: () => held.opened, finalize },
        capacityBytes
      }
    })
    runner.push(values, value)
    runner.push(values, 'second')
    expect(runner.read(values)).toBe('second')
    held.open()
    await expect(runner.stopped).rejects.toStrictEqual(new JournalOverflowError(capacityBytes))
    expect(finalize).toHaveBeenCalledWith(expect.any(AbortSignal), { clean: false })
    runner.push(values, 'third')
    expect(runner.read(values)).toBe('second')
  })

  it('preserves the first failure and runs recovery once when failure journaling overflows', async () => {
    const writing = gate()
    const boom = new Error('bot failed')
    const g = createGraph('failure-arbitration')
    const requests = g.occurrences<number>('requests')
    let recoveries = 0
    g.scope('kernel', s => s.occurrences<string>('halts'), {
      recovery: () => () => {
        recoveries++
        return undefined
      }
    })
    g.effect('work', {
      requests: { request: every(requests) },
      handle: () => Promise.reject(boom)
    })
    const step: JournalEntry = {
      kind: 'step',
      stamp: { seq: 1, at: 7 },
      writes: [{ node: 'requests', value: 1 }],
      derived: []
    }
    const failed: JournalEntry = { kind: 'failed', origin: 'work', at: 7 }
    const capacityBytes = Buffer.byteLength(encode(step)) + Buffer.byteLength(encode(failed)) - 1
    const runner = createRunner(g.build(), {
      now: () => 7,
      journal: {
        sink: { append: () => writing.opened, finalize: async () => undefined },
        capacityBytes
      }
    })

    runner.push(requests, 1)
    await sleep(0)
    writing.open()
    const error = await runner.stopped.catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(RunnerFinalizationError)
    expect((error as RunnerFinalizationError).runnerError).toMatchObject({ cause: boom })
    expect((error as RunnerFinalizationError).journalError).toStrictEqual(
      new JournalOverflowError(capacityBytes)
    )
    expect(recoveries).toBe(1)
  })

  it('starts nothing the step that overflowed it delivered, though an effect was running', async () => {
    const g = createGraph('overflowing')
    const requests = g.occurrences<number>('requests')
    const held = gate()
    const started: number[] = []
    g.effect('send', {
      requests: { request: every(requests) },
      lane: lane('sends', { concurrency: 1, queue: 8 }),
      handle: async ({ value }) => {
        started.push(value)
        if (value === 1) await held.opened
      }
    })
    const writing = gate()
    const runner = createRunner(g.build(), {
      journal: {
        sink: { append: () => writing.opened, finalize: async () => undefined },
        capacityBytes: 256
      }
    })
    for (const request of [1, 2, 3]) runner.push(requests, request)
    held.open()
    writing.open()
    await expect(runner.stopped).rejects.toStrictEqual(new JournalOverflowError(256))
    expect(started).toStrictEqual([1])
  })

  describe('a lane policy that calls the runner', () => {
    type Call = (stashed: EffectContext<number>, runner: Runner) => unknown
    const calls: Record<string, Call> = {
      note: stashed => stashed.note('reentry'),
      write: stashed => stashed.write(1),
      stop: stashed => stashed.stop('reentry'),
      push: (_, runner) => runner.push(pushes!, 1),
      abandon: (_, runner) => void runner.abandon(),
      start: (_, runner) => runner.start()
    }
    let pushes: Source<number, 'occurrence'> | undefined
    const policies = {
      identify: (call: () => void) => ({ identify: () => (call(), '1') }),
      sequence: (call: () => void) => ({ sequence: () => (call(), 1) }),
      recovery: (call: () => void) => ({ recovery: () => (call(), false) }),
      ready: (call: () => void) => ({ ready: () => (call(), true) })
    }
    const policyNames = Object.keys(policies) as (keyof typeof policies)[]
    const cases = Object.keys(calls).flatMap(call =>
      policyNames.map(policy => [call, policy] as const)
    )

    /** A held effect whose context the policy of `send` reaches for, beside an optional recovery. */
    const reentering = (
      call: Call,
      policy: keyof typeof policies,
      recovering = false,
      after: () => void = () => undefined
    ) => {
      const g = createGraph('reentry')
      const holds = g.occurrences<number>('holds')
      const requests = g.occurrences<number>('requests')
      pushes = requests
      const results = g.node<number>('results')
      let stashed: EffectContext<number> | undefined
      let runner: Runner | undefined
      const sent: number[] = []
      const declareHold = (s: GraphBuilder) =>
        s.effect('hold', {
          requests: { hold: every(holds) },
          results,
          handle: (_, context) => {
            stashed = context as unknown as EffectContext<number>
            return new Promise<void>(resolve =>
              context.signal.addEventListener('abort', () => resolve())
            )
          }
        })
      if (recovering) g.scope('recovering', declareHold, { recovery: () => () => undefined })
      else declareHold(g)
      g.effect('send', {
        requests: { request: every(requests) },
        ...policies[policy](() => {
          let caught: unknown
          try {
            call(stashed!, runner!)
          } catch (error) {
            caught = error
          }
          expect(caught).toBeInstanceOf(PolicyReentryError)
          after()
        }),
        handle: ({ value }) => void sent.push(value)
      })
      runner = createRunner(g.build())
      runner.push(holds, 1)
      return { runner, holds, requests, sent }
    }

    it.each(cases)(
      'fails the graph from the effect, though the policy caught it: %s from %s',
      async (call, policy) => {
        const { runner, requests, sent } = reentering(calls[call]!, policy)
        runner.push(requests, 7)
        await expect(runner.stopped).rejects.toStrictEqual(new PolicyReentryError('send'))
        expect(sent).toStrictEqual([])
      }
    )

    it('keeps the refusal as the failure when the policy throws after catching it', async () => {
      const { runner, requests } = reentering(calls.note!, 'identify', false, () => {
        throw new Error('policy failed')
      })
      runner.push(requests, 7)
      await expect(runner.stopped).rejects.toStrictEqual(new PolicyReentryError('send'))
    })

    it('hands out records no caller can change', async () => {
      const { runner, holds, requests } = reentering(() => undefined, 'identify')
      expect(runner.record(holds).status).toBe('present')
      expect(Object.isFrozen(runner.record(holds))).toBe(true)
      expect(Object.isFrozen(runner.record(requests))).toBe(true)
      await runner.abandon()
    })

    it.each(policyNames)(
      'never starts the effect outside a recovery scope it degraded: %s',
      async policy => {
        const { runner, requests, sent } = reentering(calls.note!, policy, true)
        runner.push(requests, 7)
        const error = await runner.stopped.catch((value: unknown) => value)
        expect(error).toBeInstanceOf(GraphFailedError)
        expect((error as Error).cause).toStrictEqual(new PolicyReentryError('send'))
        expect(sent).toStrictEqual([])
      }
    )
  })

  it('fails the graph on a failed append, keeping the sink error as its cause', async () => {
    const full = new Error('disk full')
    const { runner, amounts } = journaled(() => Promise.reject(full))
    runner.push(amounts, 1)
    const error = await runner.stopped.catch((value: unknown) => value)
    expect(error).toBeInstanceOf(JournalFailedError)
    expect((error as Error).cause).toBe(full)
  })

  it('discards every queued append after a failed append', async () => {
    const first = Promise.withResolvers<void>()
    const append = vi.fn(() => (append.mock.calls.length === 1 ? first.promise : Promise.resolve()))
    const { runner, amounts } = journaled(append)
    for (const amount of [1, 2, 3]) runner.push(amounts, amount)
    await sleep(0)
    expect(append).toHaveBeenCalledOnce()
    first.reject(new Error('disk full'))
    await expect(runner.stopped).rejects.toBeInstanceOf(JournalFailedError)
    expect(append).toHaveBeenCalledOnce()
  })

  it('advances the keyed delta baseline only after an append is acknowledged', async () => {
    const durable = Promise.withResolvers<void>()
    const appended: JournalEntry[] = []
    let attempts = 0
    const g = createGraph('durable-delta')
    const books = g.occurrences('books')
    const runner = createRunner(g.build(), {
      journal: {
        sink: {
          append: async entry => {
            attempts++
            if (attempts === 1) await durable.promise
            appended.push(entry)
          },
          finalize: async () => undefined
        },
        capacityBytes: 16_000
      }
    })
    runner.push(books, { coverage: 'complete', entries: { one: { debt: 1 } } })
    runner.push(books, { coverage: 'complete', entries: { one: { debt: 2 } } })

    await sleep(0)
    expect(appended).toStrictEqual([])
    durable.resolve()
    await runner.abandon()
    expect(appended).toHaveLength(2)
    expect(appended[1]).toMatchObject({
      kind: 'step',
      writes: [
        {
          node: 'books',
          delta: {
            kind: 'keyed-complete',
            entries: { one: { debt: 2 } },
            removed: []
          }
        }
      ]
    })
  })

  it('treats a sink that throws instead of rejecting as a failed append', async () => {
    const { runner, amounts } = journaled(() => {
      throw new Error('disk full')
    })
    runner.push(amounts, 1)
    await expect(runner.stopped).rejects.toBeInstanceOf(JournalFailedError)
  })

  it('refuses a note that is not data at note time', async () => {
    const entries: JournalEntry[] = []
    const g = createGraph('notes')
    const requests = g.occurrences<number>('requests')
    let frozen = false
    g.effect('guard', {
      requests: { request: every(requests) },
      handle: (_request, context) => {
        const accepted = { verdict: 'act' }
        context.note(accepted)
        frozen = Object.isFrozen(accepted)
        context.note(new Date() as never)
      }
    })
    const runner = createRunner(g.build(), {
      journal: {
        sink: {
          append: async entry => void entries.push(entry),
          finalize: async () => undefined
        },
        capacityBytes: 16_000
      }
    })
    runner.push(requests, 1)
    await expect(runner.stopped).rejects.toBeInstanceOf(NotDataError)
    expect(frozen).toBe(true)
    expect(entries.filter(entry => entry.kind === 'note')).toMatchObject([
      { note: { verdict: 'act' } }
    ])
  })

  it('waits for a late append rejection after stop and surfaces it', async () => {
    const append = Promise.withResolvers<void>()
    const finalized = vi.fn(async () => undefined)
    const g = createGraph('late-journal')
    const stops = g.occurrences<string>('stops')
    g.effect('stop', {
      requests: { stop: every(stops) },
      handle: ({ value }, context) => context.stop(value)
    })
    const runner = createRunner(g.build(), {
      journal: {
        sink: { append: () => append.promise, finalize: finalized },
        capacityBytes: 16_000
      }
    })
    runner.push(stops, 'done')
    let settled = false
    void runner.stopped.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await sleep(0)
    expect(settled).toBe(false)
    append.reject(new Error('late disk failure'))
    await expect(runner.stopped).rejects.toBeInstanceOf(JournalFailedError)
    expect(finalized).toHaveBeenCalledOnce()
  })

  it('reaches a terminal clean-stop outcome when an append never settles', async () => {
    const g = createGraph('append-deadline')
    const stops = g.occurrences<string>('stops')
    g.effect('stop', {
      requests: { stop: every(stops) },
      handle: ({ value }, context) => context.stop(value)
    })
    const finalize = vi.fn(async () => undefined)
    const runner = createRunner(g.build(), {
      journal: {
        sink: { append: () => new Promise(() => {}), finalize },
        capacityBytes: 16_000,
        ioTimeoutMs: 5
      }
    })
    runner.push(stops, 'done')

    const error = await runner.stopped.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(JournalFailedError)
    expect((error as Error).cause).toBeInstanceOf(JournalIoTimeoutError)
    expect(finalize).not.toHaveBeenCalled()
  })

  it('does not overlap finalization with a timed-out append during direct abandon', async () => {
    const g = createGraph('abandon-append-deadline')
    const values = g.occurrences<number>('values')
    const finalize = vi.fn(async () => undefined)
    const runner = createRunner(g.build(), {
      journal: {
        sink: { append: () => new Promise(() => {}), finalize },
        capacityBytes: 16_000,
        ioTimeoutMs: 5
      }
    })
    runner.push(values, 1)

    const error = await runner.abandon().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(JournalFailedError)
    expect((error as Error).cause).toBeInstanceOf(JournalIoTimeoutError)
    expect(finalize).not.toHaveBeenCalled()
  })

  it('reaches a terminal abandon outcome when finalization never settles', async () => {
    const g = createGraph('finalize-deadline')
    const runner = createRunner(g.build(), {
      journal: {
        sink: { append: async () => undefined, finalize: () => new Promise(() => {}) },
        capacityBytes: 16_000,
        ioTimeoutMs: 5
      }
    })

    const error = await runner.abandon().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(JournalFailedError)
    expect((error as Error).cause).toBeInstanceOf(JournalIoTimeoutError)
  })

  it('runs recovery without waiting for a never-settling journal append', async () => {
    const g = createGraph('recovery-deadline')
    const requests = g.occurrences<number>('requests')
    const boom = new Error('bot failed')
    let recoveries = 0
    let withdrawals = 0
    g.scope(
      'kernel',
      s => {
        const halts = s.occurrences<string>('halts')
        s.effect('withdraw', {
          requests: { halt: every(halts) },
          handle: (_request, context) => {
            withdrawals++
            context.stop('safe')
          }
        })
        return halts
      },
      {
        recovery: halts => () => {
          recoveries++
          return [sourceWrite(halts, 'withdraw')]
        }
      }
    )
    g.effect('work', {
      requests: { request: every(requests) },
      handle: () => {
        throw boom
      }
    })
    const runner = createRunner(g.build(), {
      journal: {
        sink: { append: () => new Promise(() => {}), finalize: async () => undefined },
        capacityBytes: 16_000,
        ioTimeoutMs: 5
      }
    })
    runner.push(requests, 1)

    await sleep(0)
    expect(recoveries).toBe(1)
    expect(withdrawals).toBe(1)
    const error = await runner.stopped.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RunnerFinalizationError)
    expect((error as RunnerFinalizationError).runnerError).toMatchObject({ cause: boom })
  })

  it('reaches a terminal recovery outcome when finalization never settles', async () => {
    const g = createGraph('recovery-finalize-deadline')
    const requests = g.occurrences<number>('requests')
    const boom = new Error('bot failed')
    g.scope(
      'kernel',
      s => {
        const halts = s.occurrences<string>('halts')
        s.effect('withdraw', {
          requests: { halt: every(halts) },
          handle: (_request, context) => context.stop('safe')
        })
        return halts
      },
      { recovery: halts => () => [sourceWrite(halts, 'withdraw')] }
    )
    g.effect('work', {
      requests: { request: every(requests) },
      handle: () => {
        throw boom
      }
    })
    const runner = createRunner(g.build(), {
      journal: {
        sink: { append: async () => undefined, finalize: () => new Promise(() => {}) },
        capacityBytes: 16_000,
        ioTimeoutMs: 5
      }
    })
    runner.push(requests, 1)

    const error = await runner.stopped.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RunnerFinalizationError)
    expect((error as RunnerFinalizationError).runnerError).toMatchObject({ cause: boom })
    expect((error as RunnerFinalizationError).journalError).toMatchObject({
      cause: expect.any(JournalIoTimeoutError)
    })
  })

  it('keeps the graph error when finalization also fails', async () => {
    const graphError = new Error('graph failed')
    const finalError = new Error('close failed')
    const g = createGraph('two-failures')
    const requests = g.occurrences<number>('requests')
    g.effect('fail', {
      requests: { request: every(requests) },
      handle: () => {
        throw graphError
      }
    })
    const runner = createRunner(g.build(), {
      journal: {
        sink: {
          append: async () => undefined,
          finalize: () => Promise.reject(finalError)
        },
        capacityBytes: 16_000
      }
    })
    runner.push(requests, 1)
    const error = await runner.stopped.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RunnerFinalizationError)
    expect(error).toMatchObject({ runnerError: graphError })
    expect((error as RunnerFinalizationError).journalError).toBeInstanceOf(JournalFailedError)
    expect(((error as RunnerFinalizationError).journalError as Error).cause).toBe(finalError)
  })

  it('owns finalization once when finishing work and finalization both fail', async () => {
    const finishing = new Error('finishing failed')
    const finalization = new Error('finalization failed')
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown) => void unhandled.push(error)
    process.on('unhandledRejection', onUnhandled)
    try {
      const g = createGraph('single-finalization-owner')
      const stops = g.occurrences<string>('stops')
      const reports = g.occurrences<string>('reports')
      g.effect('stop', {
        requests: { stop: every(stops) },
        handle: ({ value }, context) => context.stop(value)
      })
      g.effect('report', {
        requests: { report: every(reports) },
        finishOnStop: true,
        handle: () => Promise.reject(finishing)
      })
      const finalize = vi.fn(() => Promise.reject(finalization))
      const runner = createRunner(g.build(), {
        journal: {
          sink: { append: async () => undefined, finalize },
          capacityBytes: 16_000
        }
      })
      runner.pushAll([sourceWrite(stops, 'done'), sourceWrite(reports, 'report')])

      const error = await runner.stopped.catch((caught: unknown) => caught)
      await sleep(0)
      expect(error).toBeInstanceOf(RunnerFinalizationError)
      expect(error).toMatchObject({ runnerError: finishing })
      expect((error as RunnerFinalizationError).journalError).toMatchObject({ cause: finalization })
      expect(finalize).toHaveBeenCalledOnce()
      expect(unhandled).toStrictEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  /** A recovery scope that records its halts, beside a bot fold and effect outside it. */
  const recoveringJournal = (
    sink: (entry: JournalEntry) => Promise<void>,
    capacityBytes: number
  ) => {
    const g = createGraph('journaled')
    const reads = g.occurrences<number>('reads')
    const recovering = g.scope(
      'recovering',
      s => {
        const halts = s.occurrences<string>('halts')
        const seen = s.fold('seen', {
          reads: { halt: every(halts) },
          initial: [] as string[],
          applyInput: (origins, { value }) => ({ state: [...origins, value] })
        })
        return { halts, seen }
      },
      {
        recovery:
          ({ halts }) =>
          (error, origin) => [
            sourceWrite(halts, `${origin}: ${error instanceof Error ? error.name : 'unknown'}`)
          ]
      }
    )
    const bot = g.fold('bot', {
      reads: { read: every(reads) },
      initial: 0,
      applyInput: n => ({ state: n + 1 })
    })
    const started: number[] = []
    g.effect('work', {
      requests: { read: every(reads) },
      handle: ({ value }) => void started.push(value)
    })
    const runner = createRunner(g.build(), {
      journal: { sink: { append: sink, finalize: async () => undefined }, capacityBytes }
    })
    return { runner, reads, recovering, bot, started }
  }

  it('winds the recovery scope down on an overflow, and runs nothing outside it after', async () => {
    const writing = gate()
    const { runner, reads, recovering, bot, started } = recoveringJournal(() => writing.opened, 768)
    for (const read of [1, 2, 3]) runner.push(reads, read)
    expect(runner.read(recovering.seen)).toStrictEqual([])
    runner.push(reads, 4)
    expect(runner.read(recovering.seen)).toStrictEqual(['journal: JournalOverflowError'])
    runner.push(reads, 5)
    expect(runner.read(bot)).toBe(4)
    expect(started).toStrictEqual([1, 2, 3])
    writing.open()
    await expect(runner.abandon()).rejects.toStrictEqual(new JournalOverflowError(768))
  })

  it('winds the recovery scope down on a failed append, and runs nothing outside it after', async () => {
    const { runner, reads, recovering, bot, started } = recoveringJournal(
      () => Promise.reject(new Error('disk full')),
      16_000
    )
    runner.push(reads, 1)
    await sleep(0)
    expect(runner.read(recovering.seen)).toStrictEqual(['journal: JournalFailedError'])
    runner.push(reads, 2)
    expect(runner.read(bot)).toBe(1)
    expect(started).toStrictEqual([1])
    await expect(runner.abandon()).rejects.toBeInstanceOf(JournalFailedError)
  })
})

describe('initial values', () => {
  /** A fold over pushes, a map over it, a watcher of the fold, and an effect on its emits. */
  const initialGraph = () => {
    const g = createGraph('initials')
    const amounts = g.occurrences<number>('amounts')
    const unrelated = g.occurrences<string>('unrelated')
    const sums = g.node<number>('sums')
    const steps = vi.fn()
    const total = g.fold('total', {
      reads: { amount: every(amounts) },
      emits: [sums],
      initial: 0,
      applyInput: (sum, { value }) => {
        steps()
        return { state: sum + value, emit: [emitTo(sums, sum + value)] }
      }
    })
    const computes = vi.fn()
    const doubled = g.map('doubled', {
      reads: { total: latest(total) },
      compute: ({ total }) => {
        computes()
        return total * 2
      }
    })
    const seen: unknown[] = []
    g.fold('watcher', {
      reads: { total: watch(total) },
      initial: 0,
      applyInput: (n, { value }) => {
        seen.push({ status: value.status, value: value.value })
        return { state: n + 1 }
      }
    })
    const sent = vi.fn()
    g.effect('send', { requests: { sum: every(sums) }, handle: sent })
    return { g, amounts, unrelated, total, doubled, steps, computes, seen, sent }
  }

  it('reads a map over folds at boot, from values computed once at build', async () => {
    const { g, total, doubled, computes } = initialGraph()
    const graph = g.build()
    expect(computes).toHaveBeenCalledOnce()
    const runner = createRunner(graph)
    expect(runner.read(total)).toBe(0)
    expect(runner.read(doubled)).toBe(0)
    expect(runner.record(doubled)).toMatchObject({ status: 'unwritten', value: 0 })
    await runner.abandon()
  })

  it('runs nothing at boot: no fold steps, no map computes again, no effect starts', async () => {
    const { g, unrelated, steps, computes, seen, sent } = initialGraph()
    const runner = createRunner(g.build())
    runner.start()
    runner.push(unrelated, 'first step')
    expect(steps).not.toHaveBeenCalled()
    expect(computes).toHaveBeenCalledOnce()
    expect(seen).toStrictEqual([])
    expect(sent).not.toHaveBeenCalled()
    await runner.abandon()
  })

  it('writes the first real evaluation though it equals the initial value, and coalesces after', async () => {
    const entries: JournalEntry[] = []
    const { g, amounts, total, doubled, seen } = initialGraph()
    const graph = g.build()
    const runner = createRunner(graph, {
      journal: {
        sink: {
          append: async entry => void entries.push(entry),
          finalize: async () => undefined
        },
        capacityBytes: 16_000
      }
    })
    runner.push(amounts, 0)
    expect(runner.record(total)).toMatchObject({ status: 'present', value: 0 })
    expect(runner.record(doubled)).toMatchObject({ status: 'present', value: 0 })
    expect(seen).toStrictEqual([{ status: 'present', value: 0 }])
    runner.push(amounts, 0)
    expect(seen).toHaveLength(1)
    await sleep(0)
    await runner.abandon()
    expect(replay(graph, entries)).toStrictEqual({ ok: true, steps: 2 })
  })

  it('refuses to build a map that fails on its initial inputs', () => {
    const g = createGraph('failing')
    const amounts = g.occurrences<number>('amounts')
    const total = g.fold('total', {
      reads: { amount: every(amounts) },
      initial: 0,
      applyInput: (sum, { value }) => ({ state: sum + value })
    })
    g.map('ratio', {
      reads: { total: latest(total) },
      compute: ({ total }) => {
        if (total === 0) throw new Error('no total yet')
        return 1 / total
      }
    })
    expect(() => g.build()).toThrow(
      new GraphDefinitionError('map ratio fails on its initial inputs')
    )
  })
})

describe('a clock', () => {
  it.each([
    [
      'clock failed',
      () => {
        throw new Error('clock failed')
      }
    ],
    ['is not a finite number', () => Number.POSITIVE_INFINITY]
  ])('stops the graph with its failure: %s', async (message, value) => {
    const g = createGraph('clock')
    g.clock('tick', { everyMs: 5, value })
    vi.useFakeTimers()
    try {
      const runner = createRunner(g.build())
      runner.start()
      const stopped = expect(runner.stopped).rejects.toThrow(message)
      await vi.advanceTimersByTimeAsync(5)
      await stopped
    } finally {
      vi.useRealTimers()
    }
  })

  it('writes its node on its period once started, and never after the runner stops', async () => {
    const g = createGraph('clock')
    const ticks: Stream<number> = g.clock('tick', { everyMs: 5, value: now => now })
    const count = g.fold('count', {
      reads: { tick: every(ticks) },
      initial: 0,
      applyInput: n => ({ state: n + 1 })
    })
    vi.useFakeTimers()
    try {
      const runner = createRunner(g.build(), { now: () => 42 })
      await vi.advanceTimersByTimeAsync(20)
      expect(runner.read(count)).toBe(0)
      runner.start()
      await vi.advanceTimersByTimeAsync(30)
      expect(runner.read(count)).toBe(6)
      expect(runner.read(ticks)).toBe(42)
      const abandoned = runner.abandon()
      await vi.runOnlyPendingTimersAsync()
      await abandoned
      await vi.advanceTimersByTimeAsync(20)
      expect(runner.read(count)).toBe(6)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('an expiry a watched node carries', () => {
  it('wakes the watchers of a value never written yet', async () => {
    let at = 0
    const g = createGraph('initial')
    const never = g.occurrences<number>('never')
    const lease = g.fold(
      'lease',
      {
        reads: { never: every(never) },
        initial: { until: 10 },
        applyInput: state => ({ state })
      },
      { expiries: ({ until }) => [until] }
    )
    const seen = g.fold('seen', {
      reads: { lease: watch(lease) },
      initial: [] as number[],
      applyInput: (log, { stamp }) => ({ state: [...log, stamp.at] })
    })
    const runner = createRunner(g.build(), { now: () => at })
    runner.start()
    at = 10
    await sleep(15)
    expect(runner.read(seen)).toStrictEqual([10])
    await runner.abandon()
  })

  it('that passes while effects start wakes its watchers before the next one starts', async () => {
    let at = 0
    const g = createGraph('crossing')
    const fact = g.level<number>('fact')
    const requests = g.occurrences<string>('requests')
    const expired = g.fold('expired', {
      reads: { fact: watch(fact) },
      initial: false,
      applyInput: (_, { value, stamp }) => ({
        state: value.expiry !== undefined && value.expiry <= stamp.at
      })
    })
    const sampled: boolean[] = []
    g.effect('first', {
      requests: { request: every(requests) },
      handle: () => {
        at = 100
      }
    })
    g.effect('second', {
      requests: { request: every(requests) },
      samples: { expired },
      handle: (_, context) => void sampled.push(context.samples.expired())
    })
    const runner = createRunner(g.build(), { now: () => at })
    runner.start()
    runner.push(fact, { value: 1, basis: 0, expiry: 10 })
    runner.push(requests, 'go')
    expect(sampled).toStrictEqual([true])
    await runner.abandon()
  })

  it('refuses a level write whose own expiry is not a safe integer', async () => {
    const g = createGraph('level')
    const fact = g.level<number>('fact')
    const runner = createRunner(g.build())
    for (const write of [
      { value: 1, basis: 0, expiry: 1.5 },
      { value: 1, basis: 0, expiry: Number.NaN },
      { status: 'unknown', expiry: 1.5 }
    ] as const)
      expect(() => runner.push(fact, write)).toThrow(
        new WriteRefusedError('fact', 'an expiry is not a safe integer')
      )
    runner.push(fact, { value: 1, basis: 0, expiry: -1 })
    expect(runner.record(fact).expiry).toBe(-1)
    await runner.abandon()
  })

  it.each([true, false])(
    'refuses a write whose expiries hold one that is not a safe integer (watched: %s)',
    async watched => {
      const g = createGraph('derived')
      const source = g.occurrences<number>('source')
      const last = g.fold('last', {
        reads: { source: every(source) },
        initial: 0,
        applyInput: (_, { value }) => ({ state: value })
      })
      const later = g.map(
        'later',
        { reads: { last: latest(last) }, compute: ({ last: n }) => n },
        { expiries: n => [n] }
      )
      if (watched)
        g.fold('seen', {
          reads: { later: watch(later) },
          initial: 0,
          applyInput: n => ({ state: n })
        })
      const runner = createRunner(g.build())
      runner.push(source, 2)
      runner.push(source, 1.5)
      await expect(runner.stopped).rejects.toStrictEqual(
        new WriteRefusedError('later', 'an expiry is not a safe integer')
      )
    }
  )

  it('refuses a write whose expiries are malformed even when it coalesces with the last', async () => {
    const g = createGraph('coalesced')
    const source = g.occurrences<number>('source')
    const last = g.fold('last', {
      reads: { source: every(source) },
      initial: 0,
      applyInput: (_, { value }) => ({ state: value })
    })
    g.map(
      'shape',
      {
        reads: { last: latest(last) },
        compute: ({ last: n }): { x?: undefined } => (n === 2 ? { x: undefined } : {})
      },
      { expiries: shape => ['x' in shape ? 1.5 : 1] }
    )
    const runner = createRunner(g.build())
    runner.push(source, 1)
    runner.push(source, 2)
    await expect(runner.stopped).rejects.toStrictEqual(
      new WriteRefusedError('shape', 'an expiry is not a safe integer')
    )
  })

  it('hands expiries a frozen value, so they cannot change what is stored', async () => {
    const g = createGraph('frozen')
    const source = g.occurrences<number>('source')
    const last = g.fold('last', {
      reads: { source: every(source) },
      initial: 0,
      applyInput: (_, { value }) => ({ state: value })
    })
    g.map(
      'boxed',
      { reads: { last: latest(last) }, compute: ({ last: n }) => ({ n }) },
      {
        expiries: boxed => {
          if (boxed.n === 1) (boxed as { n: number }).n = 0
          return []
        }
      }
    )
    const runner = createRunner(g.build())
    runner.push(source, 1)
    await expect(runner.stopped).rejects.toThrow(TypeError)
  })

  it('refuses a graph whose initial value holds an expiry that is not a safe integer', () => {
    const g = createGraph('initial')
    const source = g.occurrences<number>('source')
    g.fold(
      'lease',
      { reads: { source: every(source) }, initial: 0.5, applyInput: state => ({ state }) },
      { expiries: n => [n] }
    )
    expect(() => createRunner(g.build())).toThrow(
      new WriteRefusedError('lease', 'an expiry is not a safe integer')
    )
  })

  it('that passed before its timer fired wakes its watchers before any effect starts', async () => {
    let at = 0
    const g = createGraph('overdue')
    const fact = g.level<number>('fact')
    const requests = g.occurrences<string>('requests')
    const expired = g.fold('expired', {
      reads: { fact: watch(fact) },
      initial: false,
      applyInput: (_, { value, stamp }) => ({
        state: value.expiry !== undefined && value.expiry <= stamp.at
      })
    })
    const sampled: boolean[] = []
    g.effect('act', {
      requests: { request: every(requests) },
      samples: { expired },
      handle: (_, context) => void sampled.push(context.samples.expired())
    })
    const runner = createRunner(g.build(), { now: () => at })
    runner.start()
    runner.push(fact, { value: 1, basis: 0, expiry: 10 })
    at = 100
    runner.push(requests, 'go')
    expect(sampled).toStrictEqual([true])
    await runner.abandon()
  })
})

describe('a watching fold', () => {
  it('sees a level once per step it was written, with its status and basis, merged in order', () => {
    const g = createGraph('watch')
    const price = g.level<number>('price')
    const orders = g.occurrences<string>('orders')
    const seen = g.fold('seen', {
      reads: { price: watch(price), order: every(orders) },
      initial: [] as string[],
      applyInput: (log, input) => ({
        state: [
          ...log,
          input.from === 'price'
            ? `price ${input.value.status} ${String(input.value.value)} @${JSON.stringify(input.value.basis)}`
            : `order ${input.value}`
        ]
      })
    })
    const runner = createRunner(g.build())
    runner.push(orders, 'a')
    runner.pushAll([
      sourceWrite(price, { value: 1, basis: 10 }),
      sourceWrite(orders, 'b'),
      sourceWrite(price, { value: 2, basis: 11 })
    ])
    runner.push(price, { value: 2, basis: 12 })
    runner.push(price, { status: 'failed' })
    expect(runner.read(seen)).toStrictEqual([
      'order a',
      'order b',
      'price present 2 @11',
      'price present 2 @12',
      'price failed undefined @undefined'
    ])
  })
})

describe('a fold with afterInputs', () => {
  it('decides once per evaluation, after every input that arrived in the step', async () => {
    const g = createGraph('afterInputs')
    const orders = g.occurrences<number>('orders')
    const decisions = g.node<number>('decisions')
    g.fold('batch', {
      reads: { order: every(orders) },
      emits: [decisions],
      initial: 0,
      applyInput: (sum, { value }) => ({ state: sum + value }),
      afterInputs: sum => ({ state: 0, emit: [emitTo(decisions, sum)] })
    })
    const seen: number[] = []
    g.effect('decide', {
      requests: { decision: every(decisions) },
      handle: ({ value }) => void seen.push(value)
    })
    const runner = createRunner(g.build())
    runner.pushAll([1, 2, 3].map(n => sourceWrite(orders, n)))
    runner.push(orders, 4)
    expect(seen).toStrictEqual([6, 4])
    await runner.abandon()
  })
})

describe('a lane with a call budget', () => {
  it('starts no more than its budget allows in any window, its first burst included', async () => {
    const g = createGraph('budget')
    const quotes = g.occurrences<number>('quotes')
    const started: number[] = []
    g.effect('quote', {
      requests: { quote: every(quotes) },
      lane: lane('venue', { concurrency: 10, queue: 10, budget: { calls: 2, perMs: 60 } }),
      handle: ({ value }) => {
        started.push(value)
      }
    })
    vi.useFakeTimers()
    try {
      const runner = createRunner(g.build())
      runner.pushAll([1, 2, 3].map(n => sourceWrite(quotes, n)))
      expect(started).toStrictEqual([1, 2])
      await vi.advanceTimersByTimeAsync(30)
      runner.push(quotes, 4)
      await vi.advanceTimersByTimeAsync(29)
      expect(started).toStrictEqual([1, 2])
      await vi.advanceTimersByTimeAsync(1)
      expect(started).toStrictEqual([1, 2, 3, 4])
      runner.push(quotes, 5)
      await vi.advanceTimersByTimeAsync(59)
      expect(started).toStrictEqual([1, 2, 3, 4])
      await vi.advanceTimersByTimeAsync(1)
      expect(started).toStrictEqual([1, 2, 3, 4, 5])
      const abandoned = runner.abandon()
      await vi.runOnlyPendingTimersAsync()
      await abandoned
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts recovery work whatever the budget has left', async () => {
    const g = createGraph('budget')
    const quotes = g.occurrences<{ n: number; recovery: boolean }>('quotes')
    const started: number[] = []
    g.effect('quote', {
      requests: { quote: every(quotes) },
      lane: lane('venue', { concurrency: 10, queue: 10, budget: { calls: 1, perMs: 60_000 } }),
      recovery: ({ value }) => value.recovery,
      handle: ({ value }) => {
        started.push(value.n)
      }
    })
    const runner = createRunner(g.build())
    runner.pushAll([1, 2, 3].map(n => sourceWrite(quotes, { n, recovery: n === 3 })))
    expect(started).toStrictEqual([3, 1])
    await runner.abandon()
  })

  it('refuses a budget that could never start anything', () => {
    expect(() =>
      lane('venue', { concurrency: 1, queue: 1, budget: { calls: 0, perMs: 1_000 } })
    ).toThrow('positive call budget')
  })

  it.each([
    [{ concurrency: 0, queue: 1 }, 'positive concurrency'],
    [{ concurrency: Number.NaN, queue: 1 }, 'positive concurrency'],
    [{ concurrency: 1, queue: 0 }, 'positive queue bound']
  ])('refuses bounds that could never start or hold anything: %j', (bounds, message) => {
    expect(() => lane('venue', bounds)).toThrow(message)
  })
})

/**
 * A recovery of `seen`, `winder` and `ticks` beside a bot fold that throws on a negative read and a
 * bot effect that throws on 13. A failure pushes its origin to `halts`; the winder stops the runner
 * three recovery ticks after it is asked to.
 */
const recoveringGraph = (
  windDown: boolean | readonly [] = true,
  options: { journal?: NonNullable<Parameters<typeof createRunner>[1]>['journal'] } = {}
) => {
  const g = createGraph('recovering')
  const halts = g.occurrences<string>('halts')
  const reads = g.occurrences<number>('reads')
  const atFailure: unknown[] = []
  const seen = g.scope(
    '',
    s => {
      const ticks = s.clock('ticks', { everyMs: 5, value: now => now })
      const recovering = s.fold('seen', {
        reads: { read: every(reads), halt: every(halts), tick: every(ticks) },
        initial: { reads: 0, halts: [] as string[], ticks: 0 },
        applyInput: (state, input) => {
          if (input.value === 'member') throw new Error('member failed')
          if (input.from === 'read') return { state: { ...state, reads: state.reads + 1 } }
          if (input.from === 'halt')
            return { state: { ...state, halts: [...state.halts, input.value] } }
          return { state: { ...state, ticks: state.ticks + 1 } }
        }
      })
      s.effect('winder', {
        requests: { halt: every(halts) },
        samples: { seen: recovering },
        handle: async ({ value: origin }, context) => {
          const from = context.samples.seen().ticks
          while (context.samples.seen().ticks < from + 3) await sleep(5)
          context.stop(`wound down after ${origin}`)
        }
      })
      return recovering
    },
    {
      recovery: recovering => (_, origin, read) => {
        atFailure.push(read(recovering))
        return windDown === true ? [sourceWrite(halts, origin)] : windDown || undefined
      }
    }
  )
  const botTicks = g.clock('bot.ticks', { everyMs: 5, value: now => now })
  const bot = g.fold('bot', {
    reads: { read: every(reads), tick: every(botTicks) },
    initial: { reads: 0, ticks: 0 },
    applyInput: (state, input) => {
      if (input.from === 'read' && input.value < 0) throw new Error('bot failed')
      return input.from === 'read'
        ? { state: { ...state, reads: state.reads + 1 } }
        : { state: { ...state, ticks: state.ticks + 1 } }
    }
  })
  g.effect('work', {
    requests: { read: every(reads) },
    handle: async ({ value }) => {
      if (value === 13) throw new Error('work failed')
    }
  })
  const graph = g.build()
  const runner = createRunner(graph, options)
  return { graph, runner, halts, reads, seen, bot, atFailure }
}

describe('a graph with a recovery', () => {
  it('keeps only its recovery running after an operator outside it fails, until it winds down', async () => {
    const { runner, reads, seen, bot, atFailure } = recoveringGraph()
    runner.start()
    await sleep(20)
    runner.push(reads, -1)
    expect(atFailure).toMatchObject([{ reads: 1, halts: [] }])
    const botAtFailure = runner.read(bot)!
    const error = await runner.stopped.catch((value: unknown) => value)

    expect(error).toBeInstanceOf(GraphFailedError)
    expect(error).toMatchObject({ origin: 'bot', stop: 'wound down after bot' })
    expect((error as Error).cause).toMatchObject({ message: 'bot failed' })
    expect(runner.read(seen)).toMatchObject({ reads: 1, halts: ['bot'] })
    expect(runner.read(seen)!.ticks).toBeGreaterThanOrEqual(3)
    expect(runner.read(bot)).toStrictEqual(botAtFailure)
  })

  it('winds its recovery down after an effect outside it rejects', async () => {
    const { runner, reads, seen } = recoveringGraph()
    runner.start()
    runner.push(reads, 13)
    await expect(runner.stopped).rejects.toMatchObject({
      origin: 'work',
      stop: 'wound down after work'
    })
    expect(runner.read(seen)).toMatchObject({ reads: 1, halts: ['work'] })
  })

  it('stops at once when the recovery itself fails', async () => {
    const { runner, halts } = recoveringGraph()
    runner.start()
    runner.push(halts, 'member')
    await expect(runner.stopped).rejects.toThrow('member failed')
  })

  it.each([false, []] as const)(
    'stops once the step it rolled back lands, when the recovery has nothing to wind down: %j',
    async nothing => {
      const { runner, reads, seen } = recoveringGraph(nothing)
      runner.push(reads, -1)
      const error = await runner.stopped.catch((value: unknown) => value)
      expect(error).toMatchObject({ origin: 'bot', stop: undefined })
      expect(runner.read(seen)).toMatchObject({ reads: 1, halts: [] })
    }
  )

  it('journals the recovery, so its steps replay as they ran', async () => {
    const entries: JournalEntry[] = []
    const { graph, runner, reads } = recoveringGraph(true, {
      journal: {
        sink: {
          append: async entry => void entries.push(entry),
          finalize: async () => undefined
        },
        capacityBytes: 64_000
      }
    })
    runner.start()
    runner.push(reads, 2)
    runner.push(reads, -1)
    await runner.stopped.catch(() => undefined)
    await sleep(10)

    expect(entries.filter(entry => entry.kind === 'recovery')).toMatchObject([{ origin: 'bot' }])
    expect(replay(graph, entries)).toMatchObject({ ok: true })
  })

  it('refuses a second recovery scope until a composite stop exists', () => {
    const g = createGraph('two')
    const recovery = () => () => undefined
    g.scope('first', s => s.occurrences<string>('halts'), { recovery })
    g.scope('second', s => s.occurrences<string>('halts'), { recovery })
    expect(() => g.build()).toThrow(
      new GraphDefinitionError('two declares 2 recovery scopes; a graph holds one')
    )
  })

  it('takes as members exactly what its scope declares, nested scopes included', () => {
    const { graph } = recoveringGraph()
    expect(layoutOf(graph).recoveries.map(recovery => recovery.members)).toStrictEqual([
      ['ticks', 'seen', 'winder']
    ])
  })

  it('refuses a recovery scope inside another', () => {
    const g = createGraph('nested')
    const recovery = () => () => undefined
    expect(() =>
      g.scope('outer', s => s.scope('inner', () => {}, { recovery }), { recovery })
    ).toThrow(new GraphDefinitionError('recovery scope outer.inner is inside another'))
  })
})

type Journal = NonNullable<RunnerOptions['journal']>

/** A bot fold that fails on a negative read, evaluated before a recovery member that may fail on it too. */
const rerunGraph = (journal: Journal, failing: 'member' | 'recovery' | 'nothing') => {
  const g = createGraph('rerun')
  const reads = g.occurrences<number>('reads')
  g.fold('bot', {
    reads: { read: every(reads) },
    initial: 0,
    applyInput: (n, { value }) => {
      if (value < 0) throw new Error('bot failed')
      return { state: n + 1 }
    }
  })
  g.scope(
    'kernel',
    s =>
      s.fold('member', {
        reads: { read: every(reads) },
        initial: 0,
        applyInput: (n, { value }) => {
          if (value < 0 && failing === 'member') throw new Error('member failed')
          return { state: n + 1 }
        }
      }),
    {
      recovery: () => () => {
        if (failing === 'recovery') throw new Error('recovery failed')
        return undefined
      }
    }
  )
  const graph = g.build()
  const runner = createRunner(graph, { journal })
  return {
    graph,
    runner,
    fill: () => runner.push(reads, 1),
    trigger: () => runner.push(reads, -1)
  }
}

type Scenario = Readonly<{
  build: (journal: Journal) => { runner: Runner; fill: () => void; trigger: () => void }
  stop: (stopped: Promise<unknown>) => Promise<void>
  /** The journal from its first `failed` entry on. */
  journaled: readonly ({ kind: JournalEntry['kind'] } & Record<string, unknown>)[]
}>

const stepOf = (writes: readonly unknown[]) => ({ stamp: expect.any(Object), writes })

const scenarios: Record<string, Scenario> = {
  'a step that throws in a graph without a recovery scope': {
    build: journal => {
      const g = createGraph('plain')
      const reads = g.occurrences<number>('reads')
      g.fold('bot', {
        reads: { read: every(reads) },
        initial: 0,
        applyInput: (n, { value }) => {
          if (value < 0) throw new Error('bot failed')
          return { state: n + 1 }
        }
      })
      const runner = createRunner(g.build(), { journal })
      return { runner, fill: () => runner.push(reads, 1), trigger: () => runner.push(reads, -1) }
    },
    stop: stopped => expect(stopped).rejects.toThrow('bot failed'),
    journaled: [{ kind: 'failed', origin: 'bot', step: stepOf([{ node: 'reads', value: -1 }]) }]
  },
  'a step that throws inside the recovery scope': {
    build: journal => {
      const { runner, reads, halts } = recoveringGraph(true, { journal })
      return {
        runner,
        fill: () => runner.push(reads, 1),
        trigger: () => runner.push(halts, 'member')
      }
    },
    stop: stopped => expect(stopped).rejects.toThrow('member failed'),
    journaled: [
      { kind: 'failed', origin: 'seen', step: stepOf([{ node: 'halts', value: 'member' }]) }
    ]
  },
  'a step that throws outside the recovery scope': {
    build: journal => {
      const { runner, reads } = recoveringGraph(true, { journal })
      runner.start()
      return { runner, fill: () => runner.push(reads, 1), trigger: () => runner.push(reads, -1) }
    },
    stop: stopped =>
      expect(stopped).rejects.toMatchObject({ origin: 'bot', stop: 'wound down after bot' }),
    journaled: [
      { kind: 'failed', origin: 'bot', step: stepOf([{ node: 'reads', value: -1 }]) },
      { kind: 'recovery', origin: 'bot' },
      { kind: 'step', writes: [{ node: 'reads', value: -1 }] }
    ]
  },
  'a member that throws during the re-run': {
    build: journal => rerunGraph(journal, 'member'),
    stop: stopped => expect(stopped).rejects.toThrow('member failed'),
    journaled: [
      { kind: 'failed', origin: 'bot', step: stepOf([{ node: 'reads', value: -1 }]) },
      { kind: 'recovery', origin: 'bot' },
      { kind: 'failed', origin: 'kernel.member', step: stepOf([{ node: 'reads', value: -1 }]) }
    ]
  },
  'a recovery callback that throws': {
    build: journal => rerunGraph(journal, 'recovery'),
    stop: stopped => expect(stopped).rejects.toThrow('recovery failed'),
    journaled: [
      { kind: 'failed', origin: 'bot', step: stepOf([{ node: 'reads', value: -1 }]) },
      { kind: 'recovery', origin: 'bot' },
      { kind: 'step', writes: [{ node: 'reads', value: -1 }] },
      { kind: 'failed' }
    ]
  },
  'a route refusal after its step was journaled': {
    build: journal => {
      const g = createGraph('overflow')
      const requests = g.occurrences<number>('requests')
      const noise = g.occurrences<number>('noise')
      g.effect('quote', {
        requests: { request: every(requests) },
        lane: lane('venue', { concurrency: 1, queue: 1 }),
        handle: () => new Promise<void>(() => {})
      })
      const runner = createRunner(g.build(), { journal })
      return {
        runner,
        fill: () => runner.push(noise, 1),
        trigger: () => runner.pushAll([1, 2, 3].map(n => sourceWrite(requests, n)))
      }
    },
    stop: stopped => expect(stopped).rejects.toBeInstanceOf(LaneOverflowError),
    journaled: [{ kind: 'failed', origin: 'quote' }]
  },
  'an effect that rejects': {
    build: journal => {
      const { runner, reads } = recoveringGraph(true, { journal })
      runner.start()
      return { runner, fill: () => runner.push(reads, 1), trigger: () => runner.push(reads, 13) }
    },
    stop: stopped =>
      expect(stopped).rejects.toMatchObject({ origin: 'work', stop: 'wound down after work' }),
    journaled: [
      { kind: 'failed', origin: 'work' },
      { kind: 'recovery', origin: 'work' }
    ]
  }
}

const failures = (entries: readonly JournalEntry[]) =>
  entries.filter(entry => entry.kind === 'failed')

describe('a failure that stops or degrades the runner', () => {
  it.each(Object.entries(scenarios))(
    'is journaled, cause then consequence, for %s',
    async (_, scenario) => {
      const entries: JournalEntry[] = []
      const { runner, trigger } = scenario.build({
        sink: {
          append: async entry => void entries.push(entry),
          finalize: async () => undefined
        },
        capacityBytes: 64_000
      })
      trigger()
      await scenario.stop(runner.stopped)
      await sleep(10)
      const first = entries.findIndex(entry => entry.kind === 'failed')
      expect(entries.slice(first, first + scenario.journaled.length)).toMatchObject(
        scenario.journaled
      )
      expect(failures(entries)).toHaveLength(
        scenario.journaled.filter(entry => entry.kind === 'failed').length
      )
    }
  )

  it.each(Object.entries(scenarios))(
    'reports write-time growth overflow as failed, writing nothing queued behind it, for %s',
    async (_, scenario) => {
      const capacityBytes = 16_000
      const finalize = vi.fn(async () => undefined)
      const appended: JournalEntry[] = []
      const { runner, trigger } = scenario.build({
        sink: { append: async entry => void appended.push(entry), finalize },
        capacityBytes,
        describe: () => 'x'.repeat(capacityBytes)
      })
      trigger()
      const outcome = await runner.stopped.catch((caught: unknown) => caught)
      expect(outcome).toBeInstanceOf(RunnerFinalizationError)
      expect((outcome as RunnerFinalizationError).journalError).toStrictEqual(
        new JournalOverflowError(capacityBytes)
      )
      expect(finalize).toHaveBeenCalledWith(expect.any(AbortSignal), { clean: false })
      expect(appended.map(entry => entry.kind)).not.toContain('failed')
      expect(appended.map(entry => entry.kind)).not.toContain('recovery')
      await scenario.stop(Promise.reject((outcome as RunnerFinalizationError).runnerError))
    }
  )

  it('leaves error text out unless the journal describes it, and replay counts only steps', async () => {
    const described: JournalEntry[] = []
    const describing = rerunGraph(
      {
        sink: {
          append: async entry => void described.push(entry),
          finalize: async () => undefined
        },
        capacityBytes: 16_000,
        describe: error => (error instanceof Error ? error.message : 'unknown')
      },
      'member'
    )
    describing.trigger()
    await describing.runner.stopped.catch(() => undefined)
    await sleep(0)
    expect(failures(described)).toMatchObject([
      { origin: 'bot', description: 'bot failed' },
      { origin: 'kernel.member', description: 'member failed' }
    ])

    const entries: JournalEntry[] = []
    const { graph, runner, fill, trigger } = rerunGraph(
      {
        sink: {
          append: async entry => void entries.push(entry),
          finalize: async () => undefined
        },
        capacityBytes: 16_000,
        describe: () => {
          throw new Error('describe failed')
        }
      },
      'member'
    )
    fill()
    trigger()
    await expect(runner.stopped).rejects.toThrow('member failed')
    await sleep(0)
    expect(failures(entries)).toHaveLength(2)
    for (const entry of entries) expect(entry).not.toHaveProperty('description')
    expect(replay(graph, entries)).toStrictEqual({ ok: true, steps: 1 })
  })

  it('describes a failure only once the runner has degraded, so describing cannot change the stop', async () => {
    const g = createGraph('reentrant')
    const reads = g.occurrences<number>('reads')
    g.scope(
      'kernel',
      s =>
        s.fold('member', {
          reads: { read: every(reads) },
          initial: 0,
          applyInput: n => ({ state: n + 1 })
        }),
      { recovery: () => () => undefined }
    )
    g.effect('work', {
      requests: { read: every(reads) },
      handle: async ({ value }) => {
        if (value === 1) throw new Error('work failed')
      }
    })
    g.effect('stopper', {
      requests: { read: every(reads) },
      handle: ({ value }, context) => {
        if (value === 2) context.stop('clean')
      }
    })
    const runner: Runner = createRunner(g.build(), {
      journal: {
        sink: { append: async () => undefined, finalize: async () => undefined },
        capacityBytes: 16_000,
        describe: () => {
          runner.push(reads, 2)
          return 'described'
        }
      }
    })
    runner.push(reads, 1)
    await expect(runner.stopped).rejects.toMatchObject({ origin: 'work' })
  })
})

/** Spells out intersections so the identity check compares shapes, not how a type was written. */
type Format1Step = {
  readonly stamp: { readonly seq: number; readonly at: number }
  readonly writes: readonly { readonly node: string; readonly value: unknown }[]
  readonly wakes?: readonly string[]
}

type Format2Write =
  | { readonly node: string; readonly value: Data }
  | {
      readonly node: string
      readonly delta: {
        readonly kind: 'keyed-complete'
        readonly fields: Readonly<Record<string, Data>>
        readonly entries: Readonly<Record<string, Data>>
        readonly removed: readonly string[]
      }
    }

type Format2Step = {
  readonly stamp: { readonly seq: number; readonly at: number }
  readonly writes: readonly Format2Write[]
  readonly wakes?: readonly string[]
}

/** Each format's entry shape as it shipped; a shape is never edited, only added under a new format. */
type ShippedFormats = {
  1:
    | (Format1Step & {
        readonly kind: 'step'
        readonly derived: readonly { readonly node: string; readonly digest: string }[]
      })
    | {
        readonly kind: 'note'
        readonly effect: string
        readonly at: number
        readonly note: unknown
      }
    | {
        readonly kind: 'failed'
        readonly origin?: string
        readonly at: number
        readonly description?: string
        readonly step?: Format1Step
      }
    | { readonly kind: 'recovery'; readonly origin: string; readonly at: number }
  2:
    | (Format2Step & {
        readonly kind: 'step'
        readonly derived: readonly { readonly node: string; readonly digest: string }[]
      })
    | {
        readonly kind: 'note'
        readonly effect: string
        readonly at: number
        readonly note: Data
      }
    | {
        readonly kind: 'failed'
        readonly origin?: string
        readonly at: number
        readonly description?: string
        readonly step?: Format2Step
      }
    | { readonly kind: 'recovery'; readonly origin: string; readonly at: number }
}

describe('the journal format', () => {
  it('names the entry shape it writes, so a shape change cannot ship under an old format', () => {
    expectTypeOf<JournalEntry>().toEqualTypeOf<ShippedFormats[typeof JOURNAL_FORMAT]>()
  })
})
