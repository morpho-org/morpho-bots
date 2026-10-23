import { describe, expect, expectTypeOf, it } from 'vitest'

import type { State } from '../src'

import {
  createGraph,
  createRunner,
  emitTo,
  every,
  GraphDefinitionError,
  latest,
  sample
} from '../src'
import { layoutOf } from '../src/testing'

describe('a graph declaration', () => {
  it('refuses a node with two producers', () => {
    const g = createGraph('two')
    const source = g.occurrences<number>('source')
    const out = g.node<number>('out')
    g.fold('a', {
      reads: { source: every(source) },
      emits: [out],
      initial: 0,
      applyInput: s => ({ state: s })
    })
    expect(() =>
      g.fold('b', {
        reads: { source: every(source) },
        emits: [out],
        initial: 0,
        applyInput: s => ({ state: s })
      })
    ).toThrow(new GraphDefinitionError('node out has two producers: a and b'))
  })

  it('refuses a node no producer writes', () => {
    const g = createGraph('orphan')
    g.node<number>('orphan')
    expect(() => g.build()).toThrow(new GraphDefinitionError('node orphan has no producer'))
  })

  it('refuses an every read of a map output, which coalesces equal writes', () => {
    const g = createGraph('coalescing')
    const source = g.occurrences<number>('source')
    const doubled = g.map('doubled', { reads: { n: latest(source) }, compute: ({ n }) => n * 2 })
    expect(() =>
      g.fold('count', {
        // @ts-expect-error a map output is not a stream
        reads: { doubled: every(doubled) },
        initial: 0,
        applyInput: s => ({ state: s + 1 })
      })
    ).toThrow(
      new GraphDefinitionError('count reads every write of doubled, which coalesces equal writes')
    )
  })

  it('refuses an every read of a fold output, which coalesces equal writes', () => {
    const g = createGraph('folded')
    const source = g.occurrences<number>('source')
    const total = g.fold('total', {
      reads: { n: every(source) },
      initial: 0,
      applyInput: (sum, { value }) => ({ state: sum + value })
    })
    expect(() =>
      // @ts-expect-error a fold output is not a stream
      g.effect('send', { requests: { total: every(total) }, handle: () => {} })
    ).toThrow(
      new GraphDefinitionError('send reads every write of total, which coalesces equal writes')
    )
  })

  it('refuses an every read of a level, whose failed writes carry no value', () => {
    const g = createGraph('levels')
    const price = g.level<number>('price')
    expect(() =>
      // @ts-expect-error a level is not a stream
      g.fold('sum', { reads: { price: every(price) }, initial: 0, applyInput: s => ({ state: s }) })
    ).toThrow(
      new GraphDefinitionError(
        'sum reads every write of level price; read a level with latest, sample or watch'
      )
    )
  })

  it('reads every write of an occurrence source, a clock and an emitted node', () => {
    const g = createGraph('streams')
    const source = g.occurrences<number>('source')
    const tick = g.clock('tick', { everyMs: 1, value: now => now })
    const out = g.node<number>('out')
    g.fold('relay', {
      reads: { source: every(source), tick: every(tick) },
      emits: [out],
      initial: 0,
      applyInput: (n, { value }) => ({ state: n, emit: [emitTo(out, value)] })
    })
    g.effect('send', { requests: { out: every(out) }, handle: () => {} })
    expect([...layoutOf(g.build()).nodes.keys()]).toStrictEqual(['source', 'tick', 'out', 'relay'])
  })

  it('refuses two effects with one id', () => {
    const g = createGraph('effects')
    const source = g.occurrences<number>('source')
    g.effect('send', { requests: { n: every(source) }, handle: () => {} })
    expect(() => g.effect('send', { requests: { n: every(source) }, handle: () => {} })).toThrow(
      new GraphDefinitionError('send is declared twice')
    )
  })

  it('keeps an effect and an operator apart whatever ids they are declared with', async () => {
    const g = createGraph('keys')
    const source = g.occurrences<number>('r')
    const sent: number[] = []
    g.effect('send', {
      requests: { r: every(source) },
      handle: ({ value }) => void sent.push(value)
    })
    const count = g.fold('effect:send', {
      reads: { r: every(source) },
      initial: 0,
      applyInput: n => ({ state: n + 1 })
    })
    const runner = createRunner(g.build())
    runner.push(source, 7)
    expect(runner.read(count)).toBe(1)
    expect(sent).toStrictEqual([7])
    await runner.abandon()
  })

  it('refuses a read of a node from another graph', () => {
    const foreign = createGraph('other').occurrences<number>('elsewhere')
    const g = createGraph('reader')
    expect(() => g.map('copy', { reads: { n: sample(foreign) }, compute: ({ n }) => n })).toThrow(
      new GraphDefinitionError('copy reads undeclared node elsewhere')
    )
  })

  it('refuses a handle another graph created, though its id names a node of this one', () => {
    const other = createGraph('other')
    const ticks = other.occurrences<number>('ticks')
    const foreign = other.fold('shared', {
      reads: { tick: every(ticks) },
      initial: 0,
      applyInput: n => ({ state: n + 1 })
    })
    const g = createGraph('reader')
    const orders = g.occurrences<number>('orders')
    g.level<number>('shared')
    expect(() =>
      g.effect('send', {
        requests: { order: every(orders) },
        samples: { foreign },
        handle: () => {}
      })
    ).toThrow(new GraphDefinitionError('send names shared by a handle reader did not create'))
    expect(() => g.map('copy', { reads: { n: latest(foreign) }, compute: ({ n }) => n })).toThrow(
      new GraphDefinitionError('copy names shared by a handle reader did not create')
    )
  })

  it('prefixes every id a scope declares', () => {
    const g = createGraph('scoped')
    g.scope('chain', s => {
      const tick = s.clock('tick', { everyMs: 1, value: now => now })
      const count = s.fold('count', {
        reads: { tick: every(tick) },
        initial: 0,
        applyInput: n => ({ state: n + 1 })
      })
      s.scope('inner', inner =>
        inner.map('doubled', { reads: { n: latest(count) }, compute: ({ n }) => n * 2 })
      )
      const named = s.occurrences<number>('named')
      const unnamed = s.occurrences<number>('unnamed')
      s.effect('send', {
        requests: { named: every(named), unnamed: every(unnamed) },
        handle: () => {}
      })
    })
    const graph = g.build()
    expect([...layoutOf(graph).nodes.keys()]).toStrictEqual([
      'chain.tick',
      'chain.count',
      'chain.inner.doubled',
      'chain.named',
      'chain.unnamed'
    ])
    expect(layoutOf(graph).effects.map(effect => effect.id)).toStrictEqual(['chain.send'])
    expect(layoutOf(graph).recoveries).toStrictEqual([])
  })

  it('evaluates operators after the operators they read, whatever the declaration order', async () => {
    const g = createGraph('order')
    const source = g.occurrences<number>('source')
    const late = g.node<number>('late')
    const first = g.map('first', { reads: { n: latest(late) }, compute: ({ n }) => n * 10 })
    g.fold('second', {
      reads: { source: every(source) },
      emits: [late],
      initial: 0,
      applyInput: (s, { value }) => ({ state: s, emit: [{ node: late, value }] })
    })
    const runner = createRunner(g.build())
    runner.push(source, 5)
    expect(runner.read(first)).toBe(50)
    runner.push(source, 6)
    expect(runner.read(first)).toBe(60)
    await runner.abandon()
  })
})

describe('a reserved fold output', () => {
  it("is read before its fold is declared, and holds the fold's initial value from the start", async () => {
    const g = createGraph('reserved')
    const source = g.occurrences<number>('source')
    const total = g.reserve<number>('total')
    const doubled = g.map('doubled', {
      reads: { total: latest(total) },
      compute: ({ total }) => total * 2
    })
    const produced = g.fold(total, {
      reads: { source: every(source) },
      initial: 1,
      applyInput: (sum, { value }) => ({ state: sum + value })
    })
    expect(produced).toBe(total)
    const graph = g.build()
    expect(layoutOf(graph).nodes.get('total')).toStrictEqual({
      id: 'total',
      kind: 'derived',
      coalesces: true
    })
    expect(layoutOf(graph).initials.get('doubled')).toBe(2)
    const runner = createRunner(graph)
    runner.push(source, 4)
    expect(runner.read(doubled)).toBe(10)
    await runner.abandon()
  })

  it('may be produced by its fold alone: not an effect, a fold emit or a map', () => {
    const g = createGraph('only')
    const source = g.occurrences<number>('source')
    const total = g.reserve<number>('total')
    expect(() =>
      g.effect('writer', {
        requests: { source: every(source) },
        results: total as never,
        handle: () => {}
      })
    ).toThrow(new GraphDefinitionError('writer writes total, which is reserved for a fold'))
    expect(() =>
      g.fold('emitter', {
        reads: { source: every(source) },
        emits: [total as never],
        initial: 0,
        applyInput: n => ({ state: n })
      })
    ).toThrow(new GraphDefinitionError('emitter writes total, which is reserved for a fold'))
    expect(() =>
      g.map('total', { reads: { source: latest(source) }, compute: ({ source }) => source })
    ).toThrow(new GraphDefinitionError('node total is declared twice'))
  })

  it('refuses a reservation no fold produces', () => {
    const g = createGraph('unclaimed')
    g.reserve<number>('total')
    expect(() => g.build()).toThrow(
      new GraphDefinitionError('node total is reserved but no fold produces it')
    )
  })

  it('refuses a second fold of one reservation, and a fold of a node that was not reserved', () => {
    const g = createGraph('claimed')
    const source = g.occurrences<number>('source')
    const total = g.reserve<number>('total')
    const fold = {
      reads: { source: every(source) },
      initial: 0,
      applyInput: (n: number) => ({ state: n })
    }
    g.fold(total, fold)
    expect(() => g.fold(total, fold)).toThrow(
      new GraphDefinitionError('node total has two producers: total and total')
    )
    const plain = g.fold('plain', fold)
    expect(() => g.fold(plain as never, fold)).toThrow(
      new GraphDefinitionError('plain was not reserved for a fold')
    )
  })

  it('keeps a reservation unclaimed when its fold is refused, and refuses to build without it', () => {
    const g = createGraph('refused')
    const source = g.occurrences<number>('source')
    const total = g.reserve<number>('total')
    const out = g.node<number>('out')
    g.effect('writer', { requests: { source: every(source) }, results: out, handle: () => {} })
    expect(() =>
      g.fold(total, {
        reads: { source: every(source) },
        emits: [out],
        initial: 0,
        applyInput: n => ({ state: n })
      })
    ).toThrow(new GraphDefinitionError('node out has two producers: writer and total'))
    expect(() => g.build()).toThrow(
      new GraphDefinitionError('node total is reserved but no fold produces it')
    )
  })

  it('types a fold of a reservation by the reservation alone', () => {
    const g = createGraph('typed')
    const source = g.occurrences<number>('source')
    const total = g.reserve<number>('total')
    const widened = {
      reads: { source: every(source) },
      initial: 0 as number | string,
      applyInput: (n: number | string) => ({ state: n })
    }
    const declareWidened = () =>
      // @ts-expect-error a fold may not widen the state its reservation declared
      g.fold(total, widened)
    expect(declareWidened).toBeTypeOf('function')
  })

  it('refuses a reservation another graph made', () => {
    const other = createGraph('other').reserve<number>('total')
    const g = createGraph('mine')
    const source = g.occurrences<number>('source')
    g.reserve<number>('total')
    expect(() =>
      g.fold(other, {
        reads: { source: every(source) },
        initial: 0,
        applyInput: n => ({ state: n })
      })
    ).toThrow(new GraphDefinitionError('fold names total by a handle mine did not create'))
  })

  it('belongs to the recovery scope its fold is declared in, not the one it was reserved in', () => {
    const g = createGraph('recovery')
    const source = g.occurrences<number>('source')
    const total = g.reserve<number>('total')
    const { kept } = g.scope(
      'kept',
      s => ({
        kept: s.fold(total, {
          reads: { source: every(source) },
          initial: 0,
          applyInput: (n, { value }) => ({ state: n + value })
        })
      }),
      { recovery: () => () => undefined }
    )
    expect(kept).toBe(total)
    expect(layoutOf(g.build()).recoveries.map(recovery => recovery.members)).toStrictEqual([
      ['total']
    ])
  })
})

describe("a map's expiries", () => {
  it('read the value its compute infers', () => {
    const g = createGraph('expiries')
    const source = g.occurrences<number>('source')
    const last = g.fold('last', {
      reads: { source: every(source) },
      initial: 0,
      applyInput: (_, { value }) => ({ state: value })
    })
    const until = g.map(
      'until',
      { reads: { n: latest(last) }, compute: ({ n }) => ({ until: n }) },
      { expiries: ({ until: at }) => [at] }
    )
    expectTypeOf(until).toEqualTypeOf<State<{ until: number }>>()
  })
})
