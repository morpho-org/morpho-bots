import type {
  EffectRequest,
  Every,
  Graph,
  GraphBuilder,
  Keyed,
  KeyedMapOptions,
  KeyedWrite,
  KeyRead,
  Latest,
  MapInputs,
  Node,
  Runner,
  Samples,
  State,
  Stream
} from '@repo/engine'
import type { KernelHead, KernelHostOptions, KernelNodes, KernelRequest } from '@repo/kernel'

import {
  createGraph,
  emitTo,
  every,
  GraphDefinitionError,
  keyedLevel,
  keyedMap,
  lane
} from '@repo/engine'
import { declareKernelHost } from '@repo/kernel'

import type { FactNode, KernelDomain } from './act'
import type { KernelView } from './view'

import { kernelDomain } from './act'
import { declareView } from './view'

/** Why one kernel takes one task family, which its refusal names. */
const ONE_FAMILY =
  'a family counts its own reservations, pending submissions and intent numbers, so two would share capacity unseen and could reuse intent ids'

/** The refusal of `second`, a task family on the kernel `first` already reaches. */
export const secondFamily = (second: Node<unknown>, first: Node<unknown>) =>
  new GraphDefinitionError(
    `${second.id} is a second task family on the kernel ${first.id} reaches: ${ONE_FAMILY}`
  )

/**
 * The bot's one kernel and its view `kernel.view`, whose handles exist at once. Its folds are
 * declared once the bot's declaration returns, over every fact `b.fact` registered, the one node
 * `requestsFrom` named and the `requests` `b.kernel` took, wherever in the declaration they came.
 */
export type KernelHandle = Readonly<{
  domain: KernelDomain<string>
  nodes: KernelNodes
  view: Node<KernelView>
  start: (runner: Runner) => Promise<void>
  /**
   * Names the node the kernel's one task family writes its acts to.
   * @throws GraphDefinitionError - for a second family ({@link secondFamily}), or once the
   * declaration has returned.
   */
  requestsFrom: (node: Stream<KernelRequest>) => void
}>

type Project<I, O, W extends Record<string, Latest<unknown>>> = (
  value: I,
  key: string,
  inputs: MapInputs<W>,
  read: KeyRead
) => O | undefined

type Streams = Record<string, Stream<unknown>>
type Requested<R extends Streams> = {
  [K in keyof R]: R[K] extends Stream<infer T> ? Every<T> : never
}

type SourceSpec<T> = Readonly<{
  level: string
  at: 'head' | Readonly<{ everyMs: number }>
  /** How many reads may wait behind the one in flight. */
  queue: number
  /** How long a read's keys hold, from when the read started: its write's expiry is no later. */
  validForMs: number
  read: (head: KernelHead, now: () => number) => Promise<KeyedWrite<T>>
}>

/**
 * Declares a bot's graph. Each helper declares plain engine nodes under the ids its TSDoc names and
 * returns their handles, so anything it does can be written in `raw` instead.
 */
export type Bot = Readonly<{
  /** The escape hatch: `body` declares on the engine's builder, taking and returning handles. */
  raw: <R>(body: (g: GraphBuilder) => R) => R
  /** `requests` are the nodes besides the task family's that write the kernel. */
  kernel: (options: Omit<KernelHostOptions, 'facts'>) => KernelHandle
  /**
   * The effect `id` on lane `id`, writing `${id}.reads` folded into `level`, each read expiring
   * `validForMs` after it started; `everyMs` adds
   * `${level}.interval` and `${level}.due`, `'head'` skips a head the kernel has passed or
   * replaced. Reads run one at a time, so each lands in the order its head came and a newer head's
   * read always lands last. `read` returns a failed write for its own failures: a throw fails the
   * graph.
   * @throws GraphDefinitionError - for a `validForMs` that is not a positive safe integer.
   */
  source: <T>(
    id: string,
    spec: SourceSpec<T>
  ) => Readonly<{ writes: Stream<KeyedWrite<T>>; level: State<Keyed<T>> }>
  /** `keyedMap(g, id, over, project, options)`, registered with the kernel as a fact. */
  fact: <I, O, W extends Record<string, Latest<unknown>> = Record<never, never>>(
    id: string,
    over: Node<Keyed<I>>,
    project: Project<I, O, W>,
    options?: KeyedMapOptions<I, W>
  ) => FactNode<string, O>
  /** `keyedMap(g, id, over, project, options)`. */
  derive: <I, O, W extends Record<string, Latest<unknown>> = Record<never, never>>(
    id: string,
    over: Node<Keyed<I>>,
    project: Project<I, O, W>,
    options?: KeyedMapOptions<I, W>
  ) => Node<Keyed<O>>
  /**
   * The effect `id`: every write of each node in `on`, by its name there, read beside `samples`. An
   * async `handle` is awaited, so its rejection fails the graph as a throw does.
   */
  sink: <R extends Streams, S extends Record<string, Node<unknown>> = Record<never, never>>(
    id: string,
    spec: Readonly<{
      on: R
      samples?: S
      /** The engine's `EffectSpec.finishOnStop`: only for a sink with no side effect on funds. */
      finishOnStop?: boolean
      handle: (event: EffectRequest<Requested<R>>, samples: Samples<S>) => void | Promise<void>
    }>
  ) => void
}>

type Check = (graph: Graph) => void

const checks = new WeakMap<Bot, Check[]>()

/** Registers a check the bot's graph must pass when it is built; it throws to refuse the graph. */
export const onBuild = (b: Bot, check: Check) => {
  checks.get(b)!.push(check)
}

/** `write` expiring no later than `expiry`; a failed write carries no keys to expire. */
const expiringBy = <T>(write: KeyedWrite<T>, expiry: number): KeyedWrite<T> =>
  write.coverage === 'complete' || write.coverage === 'carried'
    ? { ...write, expiry: Math.min(write.expiry ?? expiry, expiry) }
    : write

/** Emits a head once the last read landed and `everyMs` passed since it started. */
const dueEvery = (
  g: GraphBuilder,
  level: string,
  everyMs: number,
  heads: Stream<KernelHead>,
  writes: Stream<unknown>
) => {
  const due = g.node<KernelHead>(`${level}.due`)
  g.fold(`${level}.interval`, {
    reads: { head: every(heads), read: every(writes) },
    emits: [due],
    initial: { readAt: undefined as number | undefined, reading: false },
    applyInput: (state, input) => {
      if (input.from === 'read') return { state: { ...state, reading: false } }
      const waiting = state.readAt !== undefined && input.stamp.at - state.readAt < everyMs
      if (state.reading || waiting) return { state }
      return { state: { readAt: input.stamp.at, reading: true }, emit: [emitTo(due, input.value)] }
    }
  })
  return due
}

/**
 * `declare` builds a bot on `b`; the result is its handles and the graph, built once every
 * declaration landed and checked by what each task family registered with `onBuild`.
 * @throws GraphDefinitionError - for a graph the engine or a family refuses.
 */
export const defineBot =
  <O, R>(id: string, declare: (b: Bot, options: O) => R) =>
  (options: O): R & Readonly<{ graph: Graph }> => {
    const { build, ...g } = createGraph(id)
    const domain = kernelDomain(id)
    let family: Stream<KernelRequest> | undefined
    let host: ReturnType<typeof declareKernelHost> | undefined
    let otherRequests: readonly Stream<KernelRequest>[] = []
    let attached = false
    const own: Check[] = []
    const b: Bot = {
      raw: body => body(g),
      kernel: ({ requests = [], ...hosting }) => {
        if (host) throw new GraphDefinitionError(`${id} declares its kernel twice`)
        host = declareKernelHost(g, hosting)
        otherRequests = requests
        return {
          domain,
          nodes: host.nodes,
          view: declareView(g, 'kernel.view', host.nodes.state),
          start: host.start,
          requestsFrom: node => {
            if (attached)
              throw new GraphDefinitionError(
                `${node.id} reaches the kernel of ${id} after its declaration returned`
              )
            if (family) throw secondFamily(node, family)
            family = node
          }
        }
      },
      source: <T>(sourceId: string, spec: SourceSpec<T>) => {
        if (!host) throw new GraphDefinitionError(`${id} declares ${sourceId} before its kernel`)
        if (!Number.isSafeInteger(spec.validForMs) || spec.validForMs <= 0)
          throw new GraphDefinitionError(`${sourceId} needs a positive safe integer validForMs`)
        const { heads, state } = host.nodes
        const writes = g.node<KeyedWrite<T>>(`${sourceId}.reads`)
        const level = keyedLevel(g, spec.level, writes)
        const requests: Readonly<Record<string, Every<KernelHead>>> =
          spec.at === 'head'
            ? { head: every(heads) }
            : { due: every(dueEvery(g, spec.level, spec.at.everyMs, heads, writes)) }
        g.effect(sourceId, {
          requests,
          samples: { state },
          results: writes,
          lane: lane(sourceId, { concurrency: 1, queue: spec.queue }),
          handle: async ({ from, value: head }, context) => {
            const startedAt = context.now()
            const current = context.samples.state().head
            if (from === 'head' && (current?.number !== head.number || current.hash !== head.hash))
              return
            const write = await spec.read(from === 'head' ? head : (current ?? head), context.now)
            context.write(expiringBy(write, startedAt + spec.validForMs))
          }
        })
        return { writes, level }
      },
      fact: (factId, over, project, factOptions) =>
        domain.fact(keyedMap(g, factId, over, project, factOptions)),
      derive: (deriveId, over, project, deriveOptions) =>
        keyedMap(g, deriveId, over, project, deriveOptions),
      sink: (sinkId, spec) => {
        const on = Object.fromEntries(
          Object.entries(spec.on).map(([name, node]) => [name, every(node)])
        )
        g.effect(sinkId, {
          requests: on,
          ...(spec.samples && { samples: spec.samples }),
          ...(spec.finishOnStop && { finishOnStop: true }),
          handle: (event, context) => spec.handle(event as never, context.samples as never)
        })
      }
    }
    checks.set(b, own)
    const result = declare(b, options)
    host?.attach({
      requests: [...(family ? [family] : []), ...otherRequests],
      facts: domain.facts()
    })
    attached = true
    const graph = build()
    for (const check of own) check(graph)
    return { ...result, graph }
  }
