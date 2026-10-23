import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import type { JournalEntry, Keyed, KeyedWrite, KeyRecord, Latest, Node } from '../src'

import {
  createGraph,
  createRunner,
  every,
  GraphDefinitionError,
  keyedLevel,
  keyedMap,
  keyRecord,
  latest,
  sample,
  UNREAD,
  watch,
  WriteRefusedError
} from '../src'
import { replay } from '../src/replay'

const positions = () => {
  const g = createGraph('keyed')
  const writes = g.occurrences<KeyedWrite<{ debt: number }>>('positions.writes')
  const level = keyedLevel(g, 'positions', writes)
  const liquidatable = keyedMap(g, 'liquidatable', level, ({ debt }) =>
    debt > 0 ? { open: true } : undefined
  )
  const runner = createRunner(g.build())
  return { runner, writes, level, liquidatable }
}

describe('a keyed level', () => {
  it('reads a newly written key at once, and a key no complete write carried as absent', async () => {
    const { runner, writes, level } = positions()
    expect(keyRecord(runner.read(level)!, 'a').status).toBe('unknown')
    runner.push(writes, { coverage: 'complete', entries: { a: { debt: 1 } }, basis: 1 })
    expect(keyRecord(runner.read(level)!, 'a')).toMatchObject({ status: 'present', basis: 1 })
    expect(keyRecord(runner.read(level)!, 'b')).toStrictEqual({ status: 'absent', basis: 1 })
    expect(keyRecord(runner.read(level)!, 'constructor')).toStrictEqual({
      status: 'absent',
      basis: 1
    })
    runner.push(writes, {
      coverage: 'complete',
      entries: { a: { debt: 1 }, b: { debt: 2 } },
      basis: 2
    })
    expect(keyRecord(runner.read(level)!, 'b')).toMatchObject({ status: 'present', basis: 2 })
    await runner.abandon()
  })

  it('leaves every key as it was when the scope read fails, so nothing becomes absent', async () => {
    const { runner, writes, level, liquidatable } = positions()
    runner.push(writes, { coverage: 'complete', entries: { a: { debt: 1 } }, basis: 1 })
    const before = keyRecord(runner.read(liquidatable)!, 'a')
    runner.push(writes, { coverage: 'failed', reason: 'discovery' })
    expect(runner.read(level)!.coverage).toStrictEqual({ status: 'failed', reason: 'discovery' })
    expect(keyRecord(runner.read(liquidatable)!, 'a')).toStrictEqual(before)
    expect(keyRecord(runner.read(level)!, 'b')).toStrictEqual({ status: 'absent', basis: 1 })
    await runner.abandon()
  })

  it('changes only the keys a carried write or a per-key failure names', async () => {
    const { runner, writes, level } = positions()
    runner.push(writes, {
      coverage: 'complete',
      entries: { a: { debt: 1 }, b: { debt: 1 } },
      basis: 1
    })
    runner.push(writes, { coverage: 'carried', entries: { a: { debt: 5 } }, basis: 2 })
    runner.push(writes, { coverage: 'unknown', keys: ['b'] })
    runner.push(writes, {
      coverage: 'carried',
      entries: {},
      absent: ['c'],
      failed: ['b'],
      basis: 3
    })
    const keyed = runner.read(level)!
    expect(keyRecord(keyed, 'a')).toMatchObject({ value: { debt: 5 }, basis: 2 })
    expect(keyRecord(keyed, 'b')).toStrictEqual({ status: 'failed' })
    expect(keyRecord(keyed, 'c')).toStrictEqual({ status: 'absent', basis: 3 })
    expect(keyed.coverage.status).toBe('complete')
    await runner.abandon()
  })

  it('stops rather than read an empty complete level nobody asserted', async () => {
    const { runner, writes, level } = positions()
    runner.push(writes, { coverage: 'complete', entries: {}, basis: 1 })
    await expect(runner.stopped).rejects.toBeInstanceOf(WriteRefusedError)
    expect(runner.read(level)!.absentBasis).toBeUndefined()
  })

  it('accepts an asserted empty level, which makes every key absent', async () => {
    const { runner, writes, level } = positions()
    runner.push(writes, { coverage: 'complete', entries: {}, basis: 1, empty: true })
    expect(keyRecord(runner.read(level)!, 'a')).toStrictEqual({ status: 'absent', basis: 1 })
    await runner.abandon()
  })

  it('keeps a projected key at one digest while its input moves within the projection', async () => {
    const { runner, writes, liquidatable } = positions()
    runner.push(writes, { coverage: 'complete', entries: { a: { debt: 1 } }, basis: 1 })
    const first = keyRecord(runner.read(liquidatable)!, 'a')
    runner.push(writes, { coverage: 'complete', entries: { a: { debt: 7 } }, basis: 2 })
    const second = keyRecord(runner.read(liquidatable)!, 'a')
    expect(second).toMatchObject({ status: 'present', basis: 2 })
    expect(second.status === 'present' && first.status === 'present' && second.digest).toBe(
      first.status === 'present' && first.digest
    )
    runner.push(writes, { coverage: 'complete', entries: { a: { debt: 0 } }, basis: 3 })
    expect(keyRecord(runner.read(liquidatable)!, 'a')).toStrictEqual({
      status: 'absent',
      basis: 3
    })
    await runner.abandon()
  })
})

describe('the absence a keyed level reads, and when it expires', () => {
  it('gives every key a complete write omits its expiry, and every key a carried write reads as gone', async () => {
    const { runner, writes, level } = positions()
    runner.push(writes, {
      coverage: 'complete',
      entries: { a: { debt: 1 } },
      basis: 1,
      expiry: 100
    })
    expect(runner.read(level)!.absentExpiry).toBe(100)
    expect(keyRecord(runner.read(level)!, 'z')).toStrictEqual({
      status: 'absent',
      basis: 1,
      expiry: 100
    })
    runner.push(writes, { coverage: 'carried', entries: {}, absent: ['a'], basis: 2, expiry: 50 })
    expect(keyRecord(runner.read(level)!, 'a')).toStrictEqual({
      status: 'absent',
      basis: 2,
      expiry: 50
    })
    await runner.abandon()
  })

  it('keeps the absence a failed or carried read did not replace, and clears an expiry the next complete write lacks', async () => {
    const { runner, writes, level } = positions()
    runner.push(writes, { coverage: 'complete', entries: {}, basis: 1, expiry: 100, empty: true })
    runner.push(writes, { coverage: 'failed', reason: 'rpc' })
    runner.push(writes, { coverage: 'unknown', keys: ['b'] })
    runner.push(writes, { coverage: 'carried', entries: { c: { debt: 1 } }, basis: 2 })
    expect(runner.read(level)).toMatchObject({ absentBasis: 1, absentExpiry: 100 })
    expect(keyRecord(runner.read(level)!, 'a')).toStrictEqual({
      status: 'absent',
      basis: 1,
      expiry: 100
    })
    runner.push(writes, { coverage: 'complete', entries: {}, basis: 3, empty: true })
    expect(runner.read(level)!.absentExpiry).toBeUndefined()
    expect(keyRecord(runner.read(level)!, 'a')).toStrictEqual({ status: 'absent', basis: 3 })
    await runner.abandon()
  })
})

type Price = Readonly<{ price: number; until?: number }>

/** Positions valued at a price read whole through `edge`, each expiring no later than its `until`. */
const valued = (edge: (node: Node<Price>) => Latest<Price>) => {
  const g = createGraph('valued')
  const writes = g.occurrences<KeyedWrite<{ debt: number }>>('positions.writes')
  const level = keyedLevel(g, 'positions', writes)
  const prices = g.level<Price>('prices')
  const projected: number[] = []
  const map = keyedMap(
    g,
    'valued',
    level,
    ({ debt }, _key, { prices: { price } }) => {
      projected.push(price)
      return debt > 0 ? { value: debt * price } : undefined
    },
    { with: { prices: edge(prices) }, expiry: (_value, _key, { prices: { until } }) => until }
  )
  const statuses: string[] = []
  g.fold('valued.statuses', {
    reads: { map: watch(map) },
    initial: 0,
    applyInput: (count, { value }) => {
      statuses.push(value.status)
      return { state: count + 1 }
    }
  })
  return { g, writes, prices, map, projected, statuses }
}

const digestOf = (fact: KeyRecord<unknown>) => (fact.status === 'present' ? fact.digest : undefined)

/** A fact over a keyed level, and a fold watching it that logs, at each evaluation, whether `a` has expired. */
const expiring = () => {
  const g = createGraph('expiring')
  const writes = g.occurrences<KeyedWrite<{ debt: number }>>('positions.writes')
  const unrelated = g.occurrences<number>('unrelated')
  const level = keyedLevel(g, 'positions', writes)
  const facts = keyedMap(g, 'facts', level, ({ debt }) => ({ debt }))
  const seen = g.fold('seen', {
    reads: { facts: watch(facts) },
    initial: { facts: UNREAD as Keyed<{ debt: number }>, log: [] as string[] },
    applyInput: (state, { value }) => ({ state: { ...state, facts: value.value! } }),
    afterInputs: (state, { at }) => {
      const fact = keyRecord(state.facts, 'a')
      const expired = fact.status === 'present' && fact.expiry! <= at
      return { state: { ...state, log: [...state.log, `${at} ${expired ? 'expired' : 'held'}`] } }
    }
  })
  g.fold('others', {
    reads: { n: every(unrelated) },
    initial: 0,
    applyInput: n => ({ state: n + 1 })
  })
  return { g, writes, unrelated, seen }
}

const read = (debt: number, expiry: number): KeyedWrite<{ debt: number }> => ({
  coverage: 'complete',
  entries: { a: { debt } },
  basis: debt,
  expiry
})

describe("a keyed fact's expiry", () => {
  const withFakeTime = async (body: () => Promise<void>) => {
    vi.useFakeTimers({ now: 0 })
    try {
      await body()
    } finally {
      vi.useRealTimers()
    }
  }

  it('wakes its watchers at its expiry with no further write, not at the next unrelated input', () =>
    withFakeTime(async () => {
      const { g, writes, unrelated, seen } = expiring()
      const runner = createRunner(g.build())
      runner.start()
      runner.push(writes, read(1, 100))
      await vi.advanceTimersByTimeAsync(99)
      expect(runner.read(seen)!.log).toStrictEqual(['0 held'])
      await vi.advanceTimersByTimeAsync(1)
      expect(runner.read(seen)!.log).toStrictEqual(['0 held', '100 expired'])
      await vi.advanceTimersByTimeAsync(50)
      runner.push(unrelated, 1)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(runner.read(seen)!.log).toStrictEqual(['0 held', '100 expired'])
      await runner.abandon()
    }))

  it('wakes nothing at an expiry a later read replaced, and wakes at the later one', () =>
    withFakeTime(async () => {
      const { g, writes, seen } = expiring()
      const runner = createRunner(g.build())
      runner.start()
      runner.push(writes, read(1, 100))
      await vi.advanceTimersByTimeAsync(50)
      runner.push(writes, read(2, 200))
      await vi.advanceTimersByTimeAsync(100)
      expect(runner.read(seen)!.log).toStrictEqual(['0 held', '50 held'])
      await vi.advanceTimersByTimeAsync(50)
      expect(runner.read(seen)!.log).toStrictEqual(['0 held', '50 held', '200 expired'])
      await runner.abandon()
    }))

  it('wakes nothing before the runner starts', () =>
    withFakeTime(async () => {
      const { g, writes, seen } = expiring()
      const runner = createRunner(g.build())
      runner.push(writes, read(1, 100))
      await vi.advanceTimersByTimeAsync(1_000)
      expect(runner.read(seen)!.log).toStrictEqual(['0 held'])
      await runner.abandon()
    }))

  it('journals the wake as a step of its own, which replay reproduces', () =>
    withFakeTime(async () => {
      const entries: JournalEntry[] = []
      const { g, writes } = expiring()
      const runner = createRunner(g.build(), {
        journal: {
          sink: {
            append: async entry => void entries.push(entry),
            finalize: async () => undefined
          },
          capacityBytes: 16_000
        }
      })
      runner.start()
      runner.push(writes, read(1, 100))
      await vi.advanceTimersByTimeAsync(100)
      await runner.abandon()
      const steps = entries.filter(entry => entry.kind === 'step')
      expect(
        steps.map(({ stamp, writes: pushed, wakes }) => [stamp.at, pushed.length, wakes])
      ).toStrictEqual([
        [0, 1, undefined],
        [100, 0, ['facts']]
      ])
      expect(replay(expiring().g.build(), entries)).toStrictEqual({ ok: true, steps: 2 })
      const skipped = entries.map(entry =>
        entry.kind === 'step' ? { ...entry, wakes: [] } : entry
      )
      expect(replay(expiring().g.build(), skipped)).toMatchObject({ ok: false, step: 2 })
    }))
})

describe('a keyed map that reads whole nodes', () => {
  it('blocks every key while a triggering input is unknown or failed, and recovers once it is present', async () => {
    const { g, writes, prices, map, statuses } = valued(latest)
    const runner = createRunner(g.build())
    runner.push(writes, { coverage: 'complete', entries: { a: { debt: 1 } }, basis: 1 })
    expect(runner.read(map)).toBeUndefined()
    expect(statuses.at(-1)).toBe('unknown')
    runner.push(prices, { value: { price: 2 }, basis: 'api' })
    expect(keyRecord(runner.read(map)!, 'a')).toMatchObject({ value: { value: 2 } })
    runner.push(prices, { status: 'failed', reason: 'api' })
    expect(runner.read(map)).toBeUndefined()
    expect(statuses.at(-1)).toBe('failed')
    runner.push(prices, { value: { price: 3 }, basis: 'api' })
    expect(keyRecord(runner.read(map)!, 'a')).toMatchObject({ value: { value: 3 } })
    await runner.abandon()
  })

  it('re-evaluates on a latest input, and leaves a sampled change unread until another trigger', async () => {
    const live = valued(latest)
    const reading = createRunner(live.g.build())
    reading.push(live.writes, { coverage: 'complete', entries: { a: { debt: 1 } }, basis: 1 })
    reading.push(live.prices, { value: { price: 2 }, basis: 'api' })
    reading.push(live.prices, { value: { price: 3 }, basis: 'api' })
    expect(live.projected).toStrictEqual([2, 3])
    await reading.abandon()

    const { g, writes, prices, map, projected } = valued(sample)
    const runner = createRunner(g.build())
    runner.push(writes, { coverage: 'complete', entries: { a: { debt: 1 } }, basis: 1 })
    runner.push(prices, { value: { price: 2 }, basis: 'api' })
    const first = digestOf(keyRecord(runner.read(map)!, 'a'))
    runner.push(prices, { value: { price: 3 }, basis: 'api' })
    expect(projected).toStrictEqual([2])
    expect(digestOf(keyRecord(runner.read(map)!, 'a'))).toBe(first)
    runner.push(writes, { coverage: 'complete', entries: { a: { debt: 1 } }, basis: 2 })
    expect(projected).toStrictEqual([2, 3])
    expect(keyRecord(runner.read(map)!, 'a')).toMatchObject({ value: { value: 3 }, basis: 2 })
    expect(digestOf(keyRecord(runner.read(map)!, 'a'))).not.toBe(first)
    await runner.abandon()
  })

  it('evaluates once a sampled input first becomes present, so it never waits on a sample forever', async () => {
    const { g, writes, prices, map, statuses } = valued(sample)
    const runner = createRunner(g.build())
    runner.push(writes, { coverage: 'complete', entries: { a: { debt: 1 } }, basis: 1 })
    expect(statuses).toStrictEqual(['unknown'])
    runner.push(prices, { value: { price: 2 }, basis: 'api' })
    expect(keyRecord(runner.read(map)!, 'a')).toMatchObject({ value: { value: 2 } })
    await runner.abandon()
  })

  it('blocks the next evaluation after a sampled input fails, not the output already written', async () => {
    const { g, writes, prices, map, statuses } = valued(sample)
    const runner = createRunner(g.build())
    runner.push(writes, { coverage: 'complete', entries: { a: { debt: 1 } }, basis: 1 })
    runner.push(prices, { value: { price: 2 }, basis: 'api' })
    runner.push(prices, { status: 'failed', reason: 'api' })
    expect(keyRecord(runner.read(map)!, 'a')).toMatchObject({ value: { value: 2 } })
    runner.push(writes, { coverage: 'complete', entries: { a: { debt: 1 } }, basis: 2 })
    expect(runner.read(map)).toBeUndefined()
    expect(statuses.at(-1)).toBe('failed')
    await runner.abandon()
  })

  it('passes coverage, failed keys and absence through from its keyed input alone', async () => {
    const { g, writes, prices, map } = valued(latest)
    const runner = createRunner(g.build())
    runner.push(prices, { value: { price: 2 }, basis: 'api' })
    runner.push(writes, {
      coverage: 'complete',
      entries: { a: { debt: 1 }, b: { debt: 1 } },
      basis: 1,
      expiry: 100
    })
    runner.push(writes, {
      coverage: 'carried',
      entries: {},
      failed: ['b'],
      absent: ['c'],
      basis: 2,
      expiry: 50
    })
    runner.push(writes, { coverage: 'failed', reason: 'discovery' })
    const keyed = runner.read(map)!
    expect(keyed.coverage).toStrictEqual({ status: 'failed', reason: 'discovery' })
    expect(keyed).toMatchObject({ absentBasis: 1, absentExpiry: 100 })
    expect(keyRecord(keyed, 'a')).toMatchObject({ status: 'present', basis: 1, expiry: 100 })
    expect(keyRecord(keyed, 'b')).toStrictEqual({ status: 'failed' })
    expect(keyRecord(keyed, 'c')).toStrictEqual({ status: 'absent', basis: 2, expiry: 50 })
    expect(keyRecord(keyed, 'z')).toStrictEqual({ status: 'absent', basis: 1, expiry: 100 })
    await runner.abandon()
  })

  it('keeps the expiry of the read a projected absence came from', async () => {
    const { g, writes, prices, map } = valued(latest)
    const runner = createRunner(g.build())
    runner.push(prices, { value: { price: 2, until: 10 }, basis: 'api' })
    runner.push(writes, {
      coverage: 'complete',
      entries: { a: { debt: 0 } },
      basis: 1,
      expiry: 100
    })
    expect(keyRecord(runner.read(map)!, 'a')).toStrictEqual({
      status: 'absent',
      basis: 1,
      expiry: 100
    })
    await runner.abandon()
  })

  it.each([
    ['shortens its input expiry', 100, 40, 40],
    ['never extends its input expiry', 100, 400, 100],
    ['sets an expiry its input lacks', undefined, 40, 40],
    ['keeps its input expiry when it names none', 100, undefined, 100]
  ] as const)('an expiry option %s', async (_name, read, until, expiry) => {
    const { g, writes, prices, map } = valued(latest)
    const runner = createRunner(g.build())
    runner.push(prices, {
      value: { price: 2, ...(until !== undefined && { until }) },
      basis: 'api'
    })
    runner.push(writes, {
      coverage: 'complete',
      entries: { a: { debt: 1 } },
      basis: 1,
      ...(read !== undefined && { expiry: read })
    })
    expect(keyRecord(runner.read(map)!, 'a')).toMatchObject({ status: 'present', expiry })
    await runner.abandon()
  })

  it('keeps one digest across a basis refresh, and moves it with the projected value', async () => {
    const { g, writes, prices, map } = valued(latest)
    const runner = createRunner(g.build())
    runner.push(prices, { value: { price: 2 }, basis: 'api' })
    runner.push(writes, { coverage: 'complete', entries: { a: { debt: 1 } }, basis: 1 })
    const first = digestOf(keyRecord(runner.read(map)!, 'a'))
    runner.push(writes, { coverage: 'complete', entries: { a: { debt: 1 } }, basis: 2, expiry: 9 })
    expect(keyRecord(runner.read(map)!, 'a')).toMatchObject({ basis: 2, expiry: 9 })
    expect(digestOf(keyRecord(runner.read(map)!, 'a'))).toBe(first)
    runner.push(writes, { coverage: 'complete', entries: { a: { debt: 2 } }, basis: 3 })
    expect(digestOf(keyRecord(runner.read(map)!, 'a'))).not.toBe(first)
    await runner.abandon()
  })

  it('hands each projection the basis and expiry its key was read under, typed as written', async () => {
    type ReadAt = { block: number; readAt: number }
    const g = createGraph('read')
    const writes = g.occurrences<KeyedWrite<{ debt: number }, ReadAt>>('writes')
    const level = keyedLevel(g, 'level', writes)
    const reads: unknown[] = []
    const aged = keyedMap(g, 'aged', level, ({ debt }, key, _, read) => {
      expectTypeOf(read.basis).toEqualTypeOf<ReadAt>()
      reads.push({ key, ...read })
      return { debt, readAt: read.basis.readAt }
    })
    const runner = createRunner(g.build())
    const basis = { block: 7, readAt: 70 }
    runner.push(writes, { coverage: 'complete', entries: { a: { debt: 1 } }, basis, expiry: 9 })
    runner.push(writes, { coverage: 'carried', entries: { b: { debt: 2 } }, basis })
    expect(reads).toStrictEqual([
      { key: 'a', basis, expiry: 9 },
      { key: 'a', basis, expiry: 9 },
      { key: 'b', basis }
    ])
    expect(keyRecord(runner.read(aged)!, 'b')).toMatchObject({ value: { debt: 2, readAt: 70 } })
    await runner.abandon()
  })

  it("keeps its keyed input's basis exactly while a whole-node input's basis and expiry move", async () => {
    const { g, writes, prices, map, projected } = valued(latest)
    const runner = createRunner(g.build())
    const basis = { block: 1, blockHash: '0x1a' }
    runner.push(writes, { coverage: 'complete', entries: { a: { debt: 1 } }, basis })
    runner.push(prices, { value: { price: 2 }, basis: { block: 900, blockHash: '0xother' } })
    runner.push(prices, {
      value: { price: 2 },
      basis: { block: 901, blockHash: '0xelsewhere' },
      expiry: 5
    })
    expect(projected).toStrictEqual([2, 2])
    const fact = keyRecord(runner.read(map)!, 'a')
    expect(fact).toStrictEqual({
      status: 'present',
      value: { value: 2 },
      digest: digestOf(fact),
      basis
    })
    expect(runner.read(map)!.absentBasis).toStrictEqual(basis)
    await runner.abandon()
  })

  it('replays keyed deltas including a removed key and a complete write that drops keys', async () => {
    const entries: JournalEntry[] = []
    const { g, writes, prices } = valued(sample)
    const runner = createRunner(g.build(), {
      journal: {
        sink: {
          append: async entry => void entries.push(entry),
          finalize: async () => undefined
        },
        capacityBytes: 64_000
      }
    })
    runner.push(writes, { coverage: 'complete', entries: { a: { debt: 1 } }, basis: 1, expiry: 9 })
    runner.push(writes, { coverage: 'complete', entries: { b: { debt: 2 } }, basis: 2 })
    runner.push(prices, { value: { price: 2, until: 5 }, basis: 'api' })
    runner.push(prices, { value: { price: 3 }, basis: 'api' })
    runner.push(writes, { coverage: 'carried', entries: { b: { debt: 0 } }, basis: 2 })
    runner.push(prices, { status: 'failed' })
    runner.push(writes, { coverage: 'complete', entries: {}, basis: 3, empty: true })
    await sleep(0)
    await runner.abandon()
    const delta = entries
      .filter(entry => entry.kind === 'step')
      .flatMap(entry => entry.writes)
      .find(write => 'delta' in write)
    expect(delta).toStrictEqual({
      node: 'positions.writes',
      delta: {
        kind: 'keyed-complete',
        fields: { coverage: 'complete', basis: 2 },
        entries: { b: { debt: 2 } },
        removed: ['a']
      }
    })
    expect(entries.filter(entry => entry.kind === 'step')).toHaveLength(7)
    expect(replay(valued(sample).g.build(), entries)).toStrictEqual({ ok: true, steps: 7 })
  })

  it.each([
    ['unbounded', Number.POSITIVE_INFINITY],
    ['negatively unbounded', Number.NEGATIVE_INFINITY],
    ['fractional', 100.5],
    ['negative', -1],
    ['beyond a safe integer', Number.MAX_SAFE_INTEGER + 2],
    ['not a number', Number.NaN]
  ])('stops rather than project a key whose expiry option is %s', async (_name, bad) => {
    const g = createGraph('bad-expiry')
    const writes = g.occurrences<KeyedWrite<number>>('writes')
    const level = keyedLevel(g, 'positions', writes)
    const map = keyedMap(g, 'projected', level, value => value, { expiry: () => bad })
    const runner = createRunner(g.build())
    runner.push(writes, { coverage: 'complete', entries: { a: 1 }, basis: 1, expiry: 100 })
    await expect(runner.stopped).rejects.toBeInstanceOf(WriteRefusedError)
    expect(runner.record(map).status).toBe('unwritten')
    expect(runner.read(map)).toStrictEqual({ coverage: { status: 'unknown' }, keys: {} })
  })

  it('refuses a whole-node input named after its keyed input', () => {
    const g = createGraph('clash')
    const level = keyedLevel(g, 'positions', g.occurrences<KeyedWrite<number>>('writes'))
    const other = g.level<number>('other')
    expect(() =>
      keyedMap(g, 'clash', level, value => value, { with: { over: latest(other) } })
    ).toThrow(GraphDefinitionError)
  })
})
