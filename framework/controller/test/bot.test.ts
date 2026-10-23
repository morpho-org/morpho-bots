import type { Graph, GraphBuilder, Keyed, KeyedWrite, Runner, Source, Stream } from '@repo/engine'
import type {
  KernelActivity,
  KernelHead,
  KernelNodes,
  KernelRequest,
  Validator
} from '@repo/kernel'

import {
  createRunner,
  emitTo,
  every,
  GraphDefinitionError,
  keyedLevel,
  keyedMap,
  lane,
  latest,
  sample
} from '@repo/engine'
import { declareKernelHost } from '@repo/kernel'
import { FakeChain } from '@repo/kernel/testing'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'

import type { Bot, FactNode, KernelHandle, PrepareOutcome, PrepareRequest } from '../src'

import { declareView, defineBot, kernelDomain, parseIntentId, tasks, task } from '../src'
import { configFor, dryHosting, dryWorld, EXECUTOR, FEE, until } from './fixtures'

const executorValidator: Validator = {
  id: 'executor',
  version: 1,
  claims: payload => payload.kind === 'tx' && payload.to === EXECUTOR,
  read: () => ({ ok: true, creates: [], exposes: [], carries: [], retires: [], consumes: {} }),
  confirm: () => true
}

const STEPS = [
  { kind: 'tx' as const, payload: { kind: 'tx' as const, to: EXECUTOR, data: '0x01', value: 0n } }
]
const BACKOFF = { baseBlocks: 1, maxBlocks: 2 }
const ENDED = new Set(['refused', 'settled', 'abandoned', 'failed', 'compensated'])
const JOURNAL = {
  sink: { append: async () => undefined, finalize: async () => undefined },
  capacityBytes: 1_000_000
} as const

type Position = { bid: bigint }

/** Positions as the test writes them, and the candidates they project. */
const positionsOf = (g: GraphBuilder) => {
  const writes = g.occurrences<KeyedWrite<Position>>('positions.writes')
  const positions = keyedLevel(g, 'positions', writes)
  return {
    writes,
    positions,
    candidates: keyedMap(g, 'candidates', positions, ({ bid }) => ({ bid }))
  }
}

/** The first preparation succeeds and every later one declines. */
const ONCE = async ({ seq }: PrepareRequest<Position>): Promise<PrepareOutcome> =>
  seq === 0
    ? { ok: true, validUntil: 60_000, steps: STEPS }
    : { ok: false, reason: 'once', backoff: false }

const UNUSED = async (): Promise<PrepareOutcome> => ({
  ok: false,
  reason: 'unused',
  backoff: false
})

/** A family `id` on `kernel` acting at each position's bid on its own key. */
const actsOn = (
  b: Bot,
  id: string,
  kernel: KernelHandle,
  facts: FactNode<string>,
  { positions, candidates }: ReturnType<typeof positionsOf>,
  handle: (request: PrepareRequest<Position>) => Promise<PrepareOutcome> = UNUSED
) =>
  tasks.each(b, id, {
    kernel,
    candidates,
    facts,
    inputs: positions,
    runId: 'run',
    maxReservations: 4,
    backoff: BACKOFF,
    policy: ({ bid }, key) => task('act', { priority: bid, conflicts: { writes: [key] } }),
    prepare: { lane: lane(`${id}.venue`, { concurrency: 1, queue: 8 }), timeoutMs: 60_000, handle }
  })

/** Why a second family on the kernel the first reaches is refused. */
const SECOND_FAMILY = new GraphDefinitionError(
  'more.requests is a second task family on the kernel acts.requests reaches: a family counts its own reservations, pending submissions and intent numbers, so two would share capacity unseen and could reuse intent ids'
)

/** Why the kernel-loop check refuses the family `acts` resting on `facts`, through `path`. */
const KERNEL_LOOP = (path: string) =>
  new GraphDefinitionError(
    `acts rests on facts, which the kernel's transitions trigger through ${path}; read kernel nodes beside a fact with sample`
  )

/** Tracks which keys have an admitted act that has not ended, from the kernel's activity. */
const track = (
  g: GraphBuilder,
  activity: Stream<readonly KernelActivity[]>,
  heldWrites: Stream<Readonly<Record<string, true>>>
) =>
  g.fold('held.track', {
    reads: { activity: every(activity) },
    emits: [heldWrites],
    initial: {} as Readonly<Record<string, true>>,
    applyInput: (keys, { value }) => {
      const next: Record<string, true> = { ...keys }
      for (const a of value) {
        const key = a.type === 'notice' ? parseIntentId(a.intentId)?.key : undefined
        if (key === undefined || a.type !== 'notice') continue
        if (a.notice === 'admitted') next[key] = true
        else if (ENDED.has(a.notice)) delete next[key]
      }
      return { state: next, emit: [emitTo(heldWrites, next)] }
    }
  })

/** How long a read the test writes stays valid on the tests' clock, which stands at 0. */
const READ_VALID_MS = 60_000

const HOSTING = dryHosting(configFor(executorValidator, { native: 4n * FEE }))

/** The same fact on a task family: `read` and `through` choose how it reads the tracker. */
const looped = (read: typeof latest | typeof sample, through: 'fold' | 'stream' = 'fold') =>
  defineBot('loop', b => {
    const kernel = b.kernel(HOSTING)
    const { keyed, held, heldWrites } = b.raw(g => {
      const tracked = g.node<Readonly<Record<string, true>>>('held.writes')
      return {
        keyed: positionsOf(g),
        heldWrites: tracked,
        held: g.fold('held', {
          reads: { write: every(tracked) },
          initial: {} as Readonly<Record<string, true>>,
          applyInput: (_, { value }) => ({ state: value })
        })
      }
    })
    const facts = b.fact(
      'facts',
      keyed.positions,
      (_, key, inputs) => ({ held: inputs.held[key] === true }),
      { with: { held: read(through === 'fold' ? held : heldWrites) } }
    )
    const acts = actsOn(b, 'acts', kernel, facts, keyed, ONCE)
    b.raw(g => track(g, kernel.nodes.activity, heldWrites))
    const notices: string[] = []
    const submits: KernelRequest[] = []
    const dropped: unknown[] = []
    b.sink('record.activity', {
      on: { activity: kernel.nodes.activity },
      handle: ({ value }) => {
        for (const a of value) if (a.type === 'notice') notices.push(a.notice)
      }
    })
    b.sink('record.submits', {
      on: { request: acts.requests },
      handle: ({ value }) => void submits.push(value)
    })
    b.sink('record.events', {
      on: { event: acts.events },
      handle: ({ value }) => void (value.type === 'dropped' && dropped.push(value))
    })
    return { writes: keyed.writes, kernel, notices, submits, dropped }
  })(undefined)

const run = async (
  graph: Graph,
  nodes: Readonly<{
    writes: Source<KeyedWrite<Position>>
    kernel: Readonly<{ nodes: KernelNodes; start: (runner: Runner) => Promise<void> }>
  }>
) => {
  const runner = createRunner(graph, { now: () => 0, journal: JOURNAL })
  await nodes.kernel.start(runner)
  await until(() => runner.read(nodes.kernel.nodes.state)?.lifecycle.kind === 'running', 'running')
  const head = runner.read(nodes.kernel.nodes.heads)!
  runner.push(nodes.writes, {
    coverage: 'complete',
    entries: { a: { bid: 1n } },
    basis: { block: head.number, blockHash: head.hash },
    expiry: READ_VALID_MS
  })
  return runner
}

/**
 * A fact over a fold of an effect's results, where the effect samples `kernel.state` and, when
 * `gated`, waits on it through `ready`.
 */
const sampledBy = (gated: boolean) =>
  defineBot('loop', b => {
    const kernel = b.kernel(HOSTING)
    const { keyed, results, latestRead } = b.raw(g => {
      const gateResults = g.node<number>('gate.results')
      return {
        keyed: positionsOf(g),
        results: gateResults,
        latestRead: g.fold('gate.latest', {
          reads: { result: every(gateResults) },
          initial: 0,
          applyInput: (_, { value }) => ({ state: value })
        })
      }
    })
    const facts = b.fact('facts', keyed.positions, (_, _key, inputs) => inputs.read, {
      with: { read: latest(latestRead) }
    })
    actsOn(b, 'acts', kernel, facts, keyed)
    b.raw(g =>
      g.effect('gate', {
        requests: { tick: every(kernel.nodes.heads) },
        samples: { state: kernel.nodes.state },
        results,
        ready: gated ? (_, samples) => samples.state().lifecycle.kind === 'running' : undefined,
        handle: (_, context) => context.write(context.samples.state().seq)
      })
    )
    return {}
  })(undefined)

/** A fact over an effect's results, where the effect names `kernel.state` as a `sample` request. */
const sampleRequested = () =>
  defineBot('loop', b => {
    const kernel = b.kernel(HOSTING)
    const { keyed, results, latestRead, ticks } = b.raw(g => {
      const gateResults = g.node<number>('gate.results')
      return {
        keyed: positionsOf(g),
        results: gateResults,
        latestRead: g.fold('gate.latest', {
          reads: { result: every(gateResults) },
          initial: 0,
          applyInput: (_, { value }) => ({ state: value })
        }),
        ticks: g.occurrences<number>('ticks')
      }
    })
    const facts = b.fact('facts', keyed.positions, (_, _key, inputs) => inputs.read, {
      with: { read: latest(latestRead) }
    })
    actsOn(b, 'acts', kernel, facts, keyed)
    b.raw(g =>
      g.effect('gate', {
        requests: { tick: every(ticks), state: sample(kernel.nodes.state) as never },
        results,
        handle: (_, context) => context.write(1)
      })
    )
    return {}
  })(undefined)

it('refuses a registered fact node holding /', () => {
  expect(() =>
    defineBot('slash', b => {
      b.kernel(HOSTING)
      const keyed = b.raw(positionsOf)
      b.fact('facts/open', keyed.positions, ({ bid }) => ({ bid }))
      return {}
    })(undefined)
  ).toThrow(new GraphDefinitionError("fact node facts/open may not contain '/'"))
})

describe('an effect feeding a fact', () => {
  it('builds when it names a kernel node only as a sample request, which is never delivered', () => {
    expect(sampleRequested).not.toThrow()
  })

  it('is refused when its ready waits on a kernel sample', () => {
    expect(() => sampledBy(true)).toThrow(
      KERNEL_LOOP('kernel.state -> gate.results -> gate.latest -> facts')
    )
  })

  it('is allowed when only its handler reads the kernel sample', () => {
    expect(() => sampledBy(false)).not.toThrow()
  })
})

describe('a kernel-reading fact', () => {
  it('is refused at build when a kernel transition can trigger it', () => {
    expect(() => looped(latest)).toThrow(
      KERNEL_LOOP('kernel.activity -> held.writes -> held -> facts')
    )
  })

  it('is refused at build when it samples a kernel node with no initial value', () => {
    expect(() => looped(sample, 'stream')).toThrow(
      KERNEL_LOOP('kernel.activity -> held.writes -> facts')
    )
  })

  it('read by sample, is acted on once: its own admission never moves its evidence', async () => {
    const bot = looped(sample)
    const runner = await run(bot.graph, bot)
    await until(() => bot.notices.includes('settled'), 'the act to settle')
    expect(bot.notices).toStrictEqual(['admitted', 'settled'])
    expect(bot.submits).toHaveLength(1)
    expect(bot.dropped).toStrictEqual([])
    await runner.abandon()
  })
})

/** A bot whose fact reads `kernel.state` by sample, declared after the view was read. */
const lateFact = (second?: 'same' | 'alias') =>
  defineBot('late', b => {
    const kernel = b.kernel({ ...HOSTING, ...dryWorld() })
    const view = kernel.view
    const keyed = b.raw(positionsOf)
    const facts = b.fact('facts', keyed.positions, (_, _key, inputs) => inputs.state.seq >= 0, {
      with: { state: sample(kernel.nodes.state) }
    })
    const acts = actsOn(b, 'acts', kernel, facts, keyed, ONCE)
    if (second) actsOn(b, 'more', second === 'same' ? kernel : { ...kernel }, facts, keyed, ONCE)
    const notices: string[] = []
    b.sink('record.activity', {
      on: { activity: kernel.nodes.activity },
      handle: ({ value }) => {
        for (const a of value) if (a.type === 'notice') notices.push(a.notice)
      }
    })
    return { writes: keyed.writes, kernel, view, notices, acts }
  })(undefined)

/** A kernel taking a family and the bot's own `halts`; `second` names a second family to it. */
const besideFamily = (second = false) =>
  defineBot('beside', b => {
    const halts = b.raw(g => g.occurrences<KernelRequest>('halts'))
    const kernel = b.kernel({ ...HOSTING, ...dryWorld(), requests: [halts] })
    const keyed = b.raw(positionsOf)
    const facts = b.fact('facts', keyed.positions, ({ bid }) => ({ bid }))
    const acts = actsOn(b, 'acts', kernel, facts, keyed)
    if (second) kernel.requestsFrom(b.raw(g => g.node<KernelRequest>('more.requests')))
    return { kernel, halts, acts }
  })(undefined)

/** Two families on a raw-hosted kernel whose handle takes every family it is given. */
const rawHosted = () =>
  defineBot('raw', b => {
    const domain = kernelDomain('raw')
    const { host, view, keyed, facts } = b.raw(g => {
      const kernelHost = declareKernelHost(g, HOSTING)
      const positions = positionsOf(g)
      return {
        host: kernelHost,
        view: declareView(g, 'kernel.view', kernelHost.nodes.state),
        keyed: positions,
        facts: domain.fact(keyedMap(g, 'facts', positions.positions, ({ bid }) => ({ bid })))
      }
    })
    const requests: Stream<KernelRequest>[] = []
    const kernel: KernelHandle = {
      domain,
      nodes: host.nodes,
      view,
      start: host.start,
      requestsFrom: node => void requests.push(node)
    }
    for (const id of ['acts', 'more']) actsOn(b, id, kernel, facts, keyed)
    host.attach({ requests, facts: domain.facts() })
    return {}
  })(undefined)

describe('a bot that reads its kernel before declaring its facts', () => {
  it('acts on a fact declared after the view was read, sampling the kernel state', async () => {
    const bot = lateFact()
    const runner = await run(bot.graph, bot)
    await until(() => bot.notices.includes('settled'), 'the act to settle')
    expect(bot.notices).toStrictEqual(['admitted', 'settled'])
    const { preparing, ready, declined } = runner.read(bot.acts.state)!
    expect({ preparing, ready, declined }).toEqual({ preparing: {}, ready: {}, declined: {} })
    await runner.abandon()
  })

  it('refuses a second task family on one kernel, naming why, however its handle is reached', () => {
    expect(() => lateFact('same')).toThrow(SECOND_FAMILY)
    expect(() => lateFact('alias')).toThrow(SECOND_FAMILY)
  })

  it('refuses a second task family on a kernel the bot hosts raw', () => {
    expect(rawHosted).toThrow(SECOND_FAMILY)
  })

  it('refuses a second family named to the kernel directly', () => {
    expect(() => besideFamily(true)).toThrow(SECOND_FAMILY)
  })

  it('takes the requests b.kernel was given beside the family', async () => {
    const bot = besideFamily()
    const runner = createRunner(bot.graph, { now: () => 0, journal: JOURNAL })
    await bot.kernel.start(runner)
    await until(() => runner.read(bot.kernel.nodes.state)?.lifecycle.kind === 'running', 'running')
    runner.push(bot.halts, { type: 'Halt', reason: 'operator' })
    await until(() => runner.read(bot.kernel.nodes.state)?.lifecycle.kind !== 'running', 'the halt')
    await runner.abandon()
  })

  it('refuses a family that reaches the kernel after the declaration returned', () => {
    const bot = lateFact()
    expect(() => bot.kernel.requestsFrom(bot.acts.requests)).toThrow(
      new GraphDefinitionError(
        'acts.requests reaches the kernel of late after its declaration returned'
      )
    )
  })
})

describe('a sink', () => {
  it('fails the graph when its async handler rejects', async () => {
    const { graph, ticks } = defineBot('sinking', b => {
      const tick = b.raw(g => g.occurrences<number>('ticks'))
      b.sink('fails', {
        on: { tick },
        handle: async () => {
          await sleep(1)
          throw new Error('the sink failed')
        }
      })
      return { ticks: tick }
    })(undefined)
    const runner = createRunner(graph, { now: () => 0 })
    runner.push(ticks, 1)
    await expect(runner.stopped).rejects.toThrow('the sink failed')
  })
})

/** A bot whose one source reads at each head through `read`, against a fake chain. */
/** What a read writes beyond its entry: its coverage, and its own expiry when it sets one. */
type Own = Readonly<{ coverage: 'complete' | 'carried'; expiry?: number }>

const sourced = (
  read: (head: KernelHead) => Promise<void>,
  validForMs = READ_VALID_MS,
  own: Own = { coverage: 'complete' }
) => {
  const chain = new FakeChain()
  const reads: string[] = []
  const bot = defineBot('sourced', b => {
    const kernel = b.kernel({ ...HOSTING, chain, effects: chain.effects })
    const world = b.source('world', {
      level: 'blocks',
      at: 'head',
      queue: 8,
      validForMs,
      read: async head => {
        reads.push(`${head.number}/${head.hash}`)
        await read(head)
        return {
          ...own,
          entries: { head: head.hash },
          basis: { block: head.number, blockHash: head.hash }
        }
      }
    })
    return { kernel, level: world.level }
  })(undefined)
  return { chain, reads, bot }
}

const started = async (bot: ReturnType<typeof sourced>['bot'], now = () => 0) => {
  const runner = createRunner(bot.graph, { now, journal: JOURNAL })
  await bot.kernel.start(runner)
  await until(() => runner.read(bot.kernel.nodes.state)?.lifecycle.kind === 'running', 'running')
  return runner
}

describe('a source read at each head', () => {
  it('skips a queued head the kernel replaced at the same height', async () => {
    const held = Promise.withResolvers<void>()
    const { chain, reads, bot } = sourced(head =>
      head.number === 2 ? held.promise : Promise.resolve()
    )
    const runner = await started(bot)
    chain.mine()
    await until(() => reads.includes('2/0x2'), 'the read of 2')
    chain.mine()
    await until(() => runner.read(bot.kernel.nodes.state)?.head?.number === 3, 'head 3 queued')
    const { blockAt } = chain
    chain.blockAt = number => (number === 3 ? { ...blockAt(3), hash: '0x3b' } : blockAt(number))
    await until(() => runner.read(bot.kernel.nodes.state)?.head?.hash === '0x3b', 'the reorg to 3b')
    held.resolve()
    await until(() => reads.includes('3/0x3b'), 'the read of 3b')
    expect(reads).not.toContain('3/0x3')
    await runner.abandon()
  })

  it('lands a newer head last even when an older read is slower', async () => {
    const { chain, reads, bot } = sourced(head => sleep(head.number === 2 ? 50 : 1))
    const runner = await started(bot)
    chain.mine()
    await until(() => reads.includes('2/0x2'), 'the read of 2')
    chain.mine()
    await until(
      () => runner.read(bot.level)?.keys.head?.status === 'present' && reads.includes('3/0x3'),
      'the read of 3'
    )
    await until(() => keyed(runner.read(bot.level)) === '0x3', 'the level at 3')
    await sleep(80)
    expect(keyed(runner.read(bot.level))).toBe('0x3')
    await runner.abandon()
  })
})

describe('a source', () => {
  it('expires each read validForMs after the read started, not after it landed', async () => {
    const clock = { now: 0 }
    const { chain, reads, bot } = sourced(async () => {
      clock.now += 7
    }, 100)
    const runner = await started(bot, () => clock.now)
    clock.now = 1_000
    chain.mine()
    await until(() => reads.includes('2/0x2'), 'the read of 2')
    await until(() => keyed(runner.read(bot.level)) === '0x2', 'the level at 2')
    expect(runner.read(bot.level)?.keys.head).toMatchObject({ expiry: 1_100 })
    await runner.abandon()
  })

  it.each(['complete', 'carried'] as const)(
    'keeps a %s read its own expiry when that comes first',
    async coverage => {
      const clock = { now: 1_000 }
      const { chain, reads, bot } = sourced(() => Promise.resolve(), 100, {
        coverage,
        expiry: 1_050
      })
      const runner = await started(bot, () => clock.now)
      chain.mine()
      await until(() => reads.includes('2/0x2'), 'the read of 2')
      await until(() => keyed(runner.read(bot.level)) === '0x2', 'the level at 2')
      expect(runner.read(bot.level)?.keys.head).toMatchObject({ expiry: 1_050 })
      await runner.abandon()
    }
  )

  it('refuses a validForMs that is not a positive safe integer', () => {
    for (const validForMs of [0, -1, 1.5, Number.POSITIVE_INFINITY])
      expect(() => sourced(() => Promise.resolve(), validForMs)).toThrow(
        new GraphDefinitionError('world needs a positive safe integer validForMs')
      )
  })
})

const keyed = (level: Keyed<string> | undefined) => {
  const fact = level?.keys.head
  return fact?.status === 'present' ? fact.value : undefined
}

/** A family whose first preparation waits on `release`, on a fake chain, over a level the test writes. */
const preparedOn = () => {
  const chain = new FakeChain()
  const release = Promise.withResolvers<void>()
  const asked: number[] = []
  const notices: string[] = []
  const submits: KernelRequest[] = []
  const bot = defineBot('basis', b => {
    const kernel = b.kernel({ ...HOSTING, chain, effects: chain.effects })
    const keyed = b.raw(positionsOf)
    const facts = b.fact('facts', keyed.positions, ({ bid }) => ({ bid }))
    const acts = actsOn(b, 'acts', kernel, facts, keyed, async request => {
      asked.push(request.seq)
      await release.promise
      return ONCE(request)
    })
    b.sink('record.activity', {
      on: { activity: kernel.nodes.activity },
      handle: ({ value }) => {
        for (const a of value)
          if (a.type === 'notice') notices.push(`${a.notice}${a.reason ? `: ${a.reason}` : ''}`)
      }
    })
    b.sink('record.submits', {
      on: { request: acts.requests },
      handle: ({ value }) => void submits.push(value)
    })
    return { writes: keyed.writes, kernel }
  })(undefined)
  const read = (runner: Runner, block: number, blockHash: string) =>
    runner.push(bot.writes, {
      coverage: 'complete',
      entries: { a: { bid: 1n } },
      basis: { block, blockHash },
      expiry: READ_VALID_MS
    })
  const head = (runner: Runner) => runner.read(bot.kernel.nodes.state)?.head
  return { chain, release, asked, notices, submits, bot, read, head }
}

const evidenceOf = (request: KernelRequest | undefined) =>
  request?.type === 'Submit' ? request.plan.evidence?.map(fact => fact.basis) : undefined

describe('an act prepared before its fact was read again', () => {
  it('rests on the read it was prepared from, so the kernel refuses it once that block is orphaned', async () => {
    const family = preparedOn()
    const runner = createRunner(family.bot.graph, { now: () => 0, journal: JOURNAL })
    await family.bot.kernel.start(runner)
    family.chain.mine()
    await until(() => family.head(runner)?.number === 2, 'head 2')
    family.read(runner, 2, '0x2')
    await until(() => family.asked.length === 1, 'the preparation')
    const { blockAt } = family.chain
    family.chain.blockAt = number =>
      number === 2 ? { ...blockAt(2), hash: '0x2b' } : blockAt(number)
    await until(() => family.head(runner)?.hash === '0x2b', 'the reorg to 2b')
    family.read(runner, 2, '0x2b')
    family.release.resolve()
    await until(() => family.notices.length > 0, 'the kernel to answer')
    expect(evidenceOf(family.submits[0])).toStrictEqual([{ block: 2, blockHash: '0x2' }])
    expect(family.notices[0]).toMatch(/^refused: .*read on an orphaned block/)
    await runner.abandon()
  })

  it('still goes once its fact was only read again at a newer canonical block', async () => {
    const family = preparedOn()
    const runner = createRunner(family.bot.graph, { now: () => 0, journal: JOURNAL })
    await family.bot.kernel.start(runner)
    family.chain.mine()
    await until(() => family.head(runner)?.number === 2, 'head 2')
    family.read(runner, 2, '0x2')
    await until(() => family.asked.length === 1, 'the preparation')
    family.chain.mine()
    await until(() => family.head(runner)?.number === 3, 'head 3')
    family.read(runner, 3, '0x3')
    family.release.resolve()
    await until(() => family.notices.length > 0, 'the kernel to answer')
    expect(evidenceOf(family.submits[0])).toStrictEqual([{ block: 2, blockHash: '0x2' }])
    expect(family.notices[0]).toBe('admitted')
    await runner.abandon()
  })
})
