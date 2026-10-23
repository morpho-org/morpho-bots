import type { NodeRecord } from './core'
import type { Data } from './data'

import { initialValues, layout } from './core'
import { GraphDefinitionError } from './errors'

declare const carries: unique symbol
declare const shaped: unique symbol
declare const reservedFor: unique symbol

/**
 * How a node's writes reach its readers, which fixes how it may be read. A `stream` delivers each
 * write and holds nothing before its first; a `state` always holds a value, from its build-time
 * initial value on: a fold's, or a map's whose every input is a `state`; a `value` is any other
 * level or map output, which may be unwritten, unknown or failed.
 */
export type Shape = 'stream' | 'state' | 'value'

/** A node handle; `T` is what each write to it holds, and `S` its {@link Shape}. */
export type Node<T, S extends Shape = Shape> = Readonly<{
  id: string
  [carries]?: T
  [shaped]: S
}>

/** A node {@link every} may read: none of its writes coalesce, and none is unknown or failed. */
export type Stream<T> = Node<T, 'stream'>

export type State<T> = Node<T, 'state'>

/** A fold's output declared before the fold, which only `fold(reserved, spec)` may produce. */
export type Reserved<T> = State<T> & Readonly<{ [reservedFor]: 'fold' }>

export type SourceKind = 'level' | 'occurrence'

export type Source<T, K extends SourceKind = SourceKind> = Node<
  T,
  K extends 'level' ? 'value' : 'stream'
> &
  Readonly<{ source: K }>

/**
 * A level write is the complete current value at a read point its source defines; a failed read is
 * `unknown` or `failed`, never an empty value.
 */
export type LevelWrite<T> =
  | Readonly<{ value: T; basis: Data; expiry?: number }>
  | Readonly<{ status: 'unknown' | 'failed'; reason?: string }>

export type Written<T, K extends SourceKind> = K extends 'level' ? LevelWrite<T> : T

/** Each push is stamped by the runner; replay feeds the recorded stamp back. */
export type Stamp = Readonly<{ seq: number; at: number }>

export type Delivery<T> = Readonly<{ value: T; stamp: Stamp }>

export type Latest<T, S extends Shape = Shape> = Readonly<{
  mode: 'latest'
  node: Node<T, S>
  trigger: boolean
}>
export type Every<T> = Readonly<{ mode: 'every'; node: Stream<T> }>
export type Watch<T> = Readonly<{ mode: 'watch'; node: Node<T> }>
type Edge = Latest<unknown> | Every<unknown>
type FoldEdge = Every<unknown> | Watch<unknown>

/** The newest write when the reader runs; a change to it schedules the reader. */
export const latest = <T, S extends Shape>(node: Node<T, S>): Latest<T, S> => ({
  mode: 'latest',
  node,
  trigger: true
})

/**
 * The newest write, read only when something else schedules the reader. Until the node is first
 * present it schedules the reader like {@link latest}, so a reader never waits on a sample forever.
 */
export const sample = <T, S extends Shape>(node: Node<T, S>): Latest<T, S> => ({
  mode: 'latest',
  node,
  trigger: false
})

/** Each write since the reader last ran, in delivery order; several such inputs merge by it. */
export const every = <T>(node: Stream<T>): Every<T> => ({ mode: 'every', node })

/**
 * A fold's view of a node's state rather than its writes: once per step in which the node was
 * written, its current record, whose status, basis and expiry are visible even when its value is
 * equal, and again in a step of its own once any of its {@link Expiring} expiries passed. Any node
 * may be watched, since nothing is counted.
 */
export const watch = <T>(node: Node<T>): Watch<T> => ({ mode: 'watch', node })

/** A map whose every input is a `state` has a build-time initial value, so it is one too. */
type MapShape<R> = {
  [K in keyof R]: R[K] extends Latest<unknown, 'state'> ? never : K
}[keyof R] extends never
  ? 'state'
  : 'value'

type ValueOf<E> = E extends Latest<infer T> ? T : E extends Every<infer T> ? T : never

export type MapInputs<R extends Record<string, Edge>> = {
  readonly [K in keyof R]: R[K] extends Every<infer T> ? readonly Delivery<T>[] : ValueOf<R[K]>
}

export type FoldInput<R extends Record<string, FoldEdge>> = {
  [K in keyof R]: Readonly<{
    from: K
    value: R[K] extends Watch<infer T> ? NodeRecord<T> : ValueOf<R[K]>
    stamp: Stamp
  }>
}[keyof R]

export type Emit = Readonly<{ node: Stream<unknown>; value: unknown }>

export const emitTo = <T>(node: Stream<T>, value: T): Emit => ({ node, value })

/** At most `calls` starts in any `perMs` window, as a venue's API quota allows. */
export type Budget = Readonly<{ calls: number; perMs: number }>

/**
 * Effects that share a lane share its concurrency bound and its call budget, which every normal
 * start draws from; recovery work never waits on the budget. Its queue bound counts the requests
 * beyond its free concurrency slots, or every waiting request when concurrency is unbounded, for
 * normal and for recovery work separately, so a flood of normal work never refuses recovery.
 */
export type Lane = Readonly<{ name: string; concurrency: number; queue: number; budget?: Budget }>

export const lane = (
  name: string,
  bounds: { concurrency: number; queue: number; budget?: Budget }
): Lane => {
  const { concurrency, queue, budget } = bounds
  if (!(concurrency > 0 && (Number.isSafeInteger(concurrency) || concurrency === Infinity)))
    throw new GraphDefinitionError(`lane ${name} needs a positive concurrency`)
  if (!(Number.isSafeInteger(queue) && queue > 0))
    throw new GraphDefinitionError(`lane ${name} needs a positive queue bound`)
  if (budget && !(Number.isSafeInteger(budget.calls) && budget.calls > 0 && budget.perMs > 0))
    throw new GraphDefinitionError(`lane ${name} needs a positive call budget`)
  return { name, ...bounds }
}

const UNBOUNDED_CONCURRENCY = lane('default', {
  concurrency: Number.POSITIVE_INFINITY,
  queue: 1_024
})

type Requests = Record<string, Every<unknown>>
type Sampled = Record<string, Node<unknown>>

/** One write delivered to an effect, with the name of the input it came in on. */
export type EffectRequest<Q extends Requests> = {
  [K in keyof Q]: Readonly<{ from: K; value: ValueOf<Q[K]> }>
}[keyof Q]

/**
 * Each sample's current value, read when called rather than when the request was delivered. Only a
 * {@link State} is never undefined: any other node is until its first write, and while unknown or
 * failed.
 */
export type Samples<S extends Sampled> = {
  readonly [K in keyof S]: () => S[K] extends State<infer T>
    ? T
    : S[K] extends Node<infer T>
      ? T | undefined
      : never
}

export type EffectContext<R, S extends Sampled = Record<never, never>> = Readonly<{
  /** Aborts on a cancel naming this request, and on stop; writes made after it are dropped. */
  signal: AbortSignal
  identity: string
  /** The stamp of the step that delivered this request. */
  stamp: Stamp
  now(): number
  /** Journals `note` in order with the steps, for an operator to explain what the effect decided. */
  note(note: Data): void
  samples: Samples<S>
  write(result: R): void
  /** Stops the runner once every effect has settled, resolving its stop promise with `value`. */
  stop(value: unknown): void
}>

/**
 * Every request of one effect is admitted in the order its inputs delivered them, whichever input
 * each came in on, so several inputs never become several independently scheduled effects. Its lane
 * policies (`identify`, `sequence`, `recovery`, `ready`) must not call the runner or a runner
 * context: one that does fails the graph with {@link PolicyReentryError}.
 */
export type EffectSpec<Q extends Requests, R, S extends Sampled = Record<never, never>> = Readonly<{
  requests: Q
  samples?: S
  results?: Stream<R>
  lane?: Lane
  /**
   * Identities are unique within a run: one that is still waiting or running is refused, and the
   * runner stops. Completed identities are not retained, so a producer that numbers its requests
   * monotonically declares {@link EffectSpec.sequence} to have redeliveries refused too.
   */
  identify?: (request: EffectRequest<Q>) => string
  /** A request at or below the highest position admitted so far is refused, and the runner stops. */
  sequence?: (request: EffectRequest<Q>) => number | undefined
  /** Recovery work starts before normal work waiting in the same lane. */
  recovery?: (request: EffectRequest<Q>, samples: Samples<S>) => boolean
  /** A request waits in its lane, counted against its bound, until this holds after some step. */
  ready?: (request: EffectRequest<Q>, samples: Samples<S>) => boolean
  /**
   * Only for an effect with no side effect on funds, such as a reporter: on a clean stop its queued
   * requests still run, with an aborted signal, before the stop settles. A failure drops them, and
   * one of them failing drops the rest and rejects the stop with its error.
   */
  finishOnStop?: boolean
  /** Settles when the request's work is done; stop waits for it, so work that must land ignores the abort. */
  handle(request: EffectRequest<Q>, context: EffectContext<R, S>): void | Promise<void>
}>

export type NodeSpec = Readonly<{
  id: string
  kind: 'level' | 'occurrence' | 'clock' | 'derived'
  /** A coalescing node records no write when a value equals the last; `every` may not read it. */
  coalesces: boolean
  clock?: Readonly<{ everyMs: number; value: (now: number) => unknown }>
  expiries?: (value: unknown) => Iterable<number>
}>

export type OperatorSpec =
  | Readonly<{
      kind: 'map'
      id: string
      reads: Readonly<Record<string, Edge>>
      output: string
      compute: (inputs: Record<string, unknown>) => unknown
    }>
  | Readonly<{
      kind: 'fold'
      id: string
      reads: Readonly<Record<string, FoldEdge>>
      output: string
      emits: readonly string[]
      initial: unknown
      applyInput: (state: unknown, input: FoldInput<Record<string, FoldEdge>>) => FoldStep
      afterInputs?: (state: unknown, stamp: Stamp) => FoldStep
    }>

export type EffectOperator = Readonly<{
  id: string
  reads: Readonly<Record<string, Edge>>
  /** Each sample's node id, by the name the effect reads it under. */
  samples: Readonly<Record<string, string>>
  results?: string
  lane: Lane
  spec: EffectSpec<Requests, unknown, Sampled>
}>

type FoldStep = Readonly<{ state: unknown; emit?: readonly Emit[] }>

export type SourceWrite = Readonly<{ node: Source<unknown>; value: unknown }>

export const sourceWrite = <T, K extends SourceKind>(
  node: Source<T, K>,
  value: Written<T, K>
): SourceWrite => ({ node, value })

/**
 * What a recovery scope pushes to wind itself down after a failure outside every recovery scope, or
 * `undefined` when it holds nothing to wind down.
 */
export type OnFailure = (
  error: unknown,
  origin: string,
  read: <T>(node: Node<T>) => T | undefined
) => readonly SourceWrite[] | undefined

/**
 * One recovery scope: the operators, effects and clocks it declared, by id, which keep running when
 * any operator or effect outside every recovery scope fails. A failure inside any recovery scope
 * still stops the runner at once.
 */
export type Recovery = Readonly<{ members: readonly string[]; onFailure: OnFailure }>
type FoldOperator = Extract<OperatorSpec, { kind: 'fold' }>

/** A built graph's layout: its operators in evaluation order and its effects in dispatch order. */
type Layout = Readonly<{
  nodes: ReadonlyMap<string, NodeSpec>
  /** Each node's value before its first write, which reads see and which schedules nothing. */
  initials: ReadonlyMap<string, unknown>
  operators: readonly OperatorSpec[]
  effects: readonly EffectOperator[]
  recoveries: readonly Recovery[]
  /** Every handle this graph created, so a runner refuses a same-id handle from another graph. */
  handles: WeakSet<Node<unknown>>
}>

/** A built graph. Its layout is keyed by a symbol the package does not export, so it is not API. */
export type Graph = Readonly<{ id: string; [layout]: Layout }>

/**
 * Operators in topological order over every edge they read, ties and cycles broken by declaration
 * order, so only a feedback edge re-enters an operator already evaluated in a step.
 */
const evaluationOrder = (operators: readonly OperatorSpec[]) => {
  const remaining = [...operators]
  const ordered: OperatorSpec[] = []
  const producers = new Map(
    operators.flatMap(op =>
      [op.output, ...(op.kind === 'fold' ? op.emits : [])].map(node => [node, op])
    )
  )
  const upstream = (op: OperatorSpec) =>
    Object.values(op.reads).flatMap(edge => {
      const producer = producers.get(edge.node.id)
      return producer && producer !== op ? [producer] : []
    })
  while (remaining.length > 0) {
    const free = remaining.find(op => upstream(op).every(up => ordered.includes(up)))
    const next = free ?? remaining[0]!
    ordered.push(next)
    remaining.splice(remaining.indexOf(next), 1)
  }
  return ordered
}

const expiring = ({ expiries }: Expiring<never>) =>
  expiries ? { expiries: expiries as NonNullable<NodeSpec['expiries']> } : {}

const scoped = (prefix: string, local: string) =>
  prefix === '' ? local : local === '' ? prefix : `${prefix}.${local}`

/**
 * When a node's value stops holding: a level's own `expiry`, or each time `expiries` finds in a map's
 * or fold's value; a write carrying one that is not a safe integer is refused. The runner wakes the
 * node's watchers at or after each, once for all that passed together, so a fold sees them lapse
 * with no other input. It comes beside the spec, so the spec alone infers the value's type.
 */
export type Expiring<T> = Readonly<{ expiries?: (value: T) => Iterable<number> }>

type FoldSpec<R extends Record<string, FoldEdge>, S> = Readonly<{
  reads: R
  emits?: readonly Stream<unknown>[]
  initial: S
  /** Applies one input, returning the next state and anything it emits. */
  applyInput: (state: S, input: FoldInput<R>) => Readonly<{ state: S; emit?: readonly Emit[] }>
  /**
   * Runs once after the inputs of each evaluation, so a decision reads every input that arrived in
   * the step, rather than the state between two of them.
   */
  afterInputs?: (state: S, stamp: Stamp) => Readonly<{ state: S; emit?: readonly Emit[] }>
}>

/** `recovery` makes the scope a recovery scope, winding down through what its body returned. */
export type ScopeOptions<R> = Readonly<{ recovery?: (scope: R) => OnFailure }>

/** Declares nodes, operators and effects under a scope, which prefixes every id it is given. */
export type GraphBuilder = Readonly<{
  level<T>(nodeId: string): Source<T, 'level'>
  /** Each write is its own occurrence, identified by where the runner delivered it. */
  occurrences<T>(nodeId: string): Source<T, 'occurrence'>
  clock<T>(
    nodeId: string,
    clock: Readonly<{ everyMs: number; value: (now: number) => T }>
  ): Stream<T>
  /** A node an operator will own: a fold's emits or an effect's results. */
  node<T>(nodeId: string): Stream<T>
  map<R extends Record<string, Edge>, T>(
    nodeId: string,
    spec: Readonly<{ reads: R; compute: (inputs: MapInputs<R>) => T }>,
    options?: Expiring<T>
  ): Node<T, MapShape<R>>
  fold<R extends Record<string, FoldEdge>, S>(
    nodeId: string,
    spec: FoldSpec<R, S>,
    options?: Expiring<S>
  ): State<S>
  /** Produces a node `reserve` declared, which readers may already name. */
  fold<R extends Record<string, FoldEdge>, S>(
    reserved: Reserved<S>,
    spec: FoldSpec<R, NoInfer<S>>,
    options?: Expiring<NoInfer<S>>
  ): Reserved<S>
  /**
   * Declares a fold's output before the fold, so readers can name it first. Only that fold may
   * produce it, and `build` refuses a reservation no fold produced.
   */
  reserve<T>(nodeId: string): Reserved<T>
  effect<Q extends Requests, R = never, S extends Sampled = Record<never, never>>(
    effectId: string,
    spec: EffectSpec<Q, R, S>
  ): void
  /**
   * Runs `body` against a builder whose ids are prefixed by `prefix`, and returns what it returns.
   * A recovery scope's members are exactly what its body declares, nested scopes included; a graph
   * holds at most one, which `build` checks.
   */
  scope<R>(prefix: string, body: (scope: GraphBuilder) => R, options?: ScopeOptions<R>): R
}>

/**
 * Declares a graph. Every node has exactly one producer: an external source, a runner clock, or one
 * operator. `build` checks the declaration and fixes the evaluation order.
 */
export const createGraph = (id: string) => {
  const nodes = new Map<string, NodeSpec>()
  const claims = new Map<string, string>()
  const operators: OperatorSpec[] = []
  const effects: EffectOperator[] = []
  const recoveries: Recovery[] = []
  const handles = new WeakSet<Node<unknown>>()
  const reservations = new Set<string>()

  const handle = <N extends Node<unknown>>(node: N) => {
    handles.add(node)
    return node
  }

  /** A handle another graph created may share an id with one of this graph's nodes. */
  const checkOwned = (user: string, node: Node<unknown>) => {
    if (!nodes.has(node.id))
      throw new GraphDefinitionError(`${user} reads undeclared node ${node.id}`)
    if (!handles.has(node))
      throw new GraphDefinitionError(`${user} names ${node.id} by a handle ${id} did not create`)
  }

  const declare = (spec: NodeSpec) => {
    if (nodes.has(spec.id)) throw new GraphDefinitionError(`node ${spec.id} is declared twice`)
    nodes.set(spec.id, spec)
  }

  const checkClaim = (node: string, producer: string) => {
    const owner = claims.get(node)
    if (owner !== undefined)
      throw new GraphDefinitionError(`node ${node} has two producers: ${owner} and ${producer}`)
  }

  const claim = (node: string, producer: string) => {
    checkClaim(node, producer)
    claims.set(node, producer)
  }

  /** Refuses `node` to a producer that is not a fold of its reservation, which only a fold may claim. */
  const checkUnreserved = (node: string, producer: string) => {
    if (reservations.has(node))
      throw new GraphDefinitionError(`${producer} writes ${node}, which is reserved for a fold`)
    checkClaim(node, producer)
  }

  const checkReads = (reader: string, reads: Readonly<Record<string, Edge | FoldEdge>>) => {
    for (const edge of Object.values(reads)) {
      checkOwned(reader, edge.node)
      const spec = nodes.get(edge.node.id)!
      if (edge.mode === 'every' && spec.coalesces)
        throw new GraphDefinitionError(
          `${reader} reads every write of ${edge.node.id}, which coalesces equal writes`
        )
      if (edge.mode === 'every' && spec.kind === 'level')
        throw new GraphDefinitionError(
          `${reader} reads every write of level ${edge.node.id}; read a level with latest, sample or watch`
        )
    }
  }

  /** A builder under `prefix`; `members` collects the ids of the recovery scope it is inside. */
  const builderOf = (prefix: string, members?: string[]) => {
    const memberOf = (memberId: string) => {
      members?.push(memberId)
      return memberId
    }
    const member = (local: string) => memberOf(scoped(prefix, local))
    const declared = {
      level: (local: string) => {
        const nodeId = scoped(prefix, local)
        declare({ id: nodeId, kind: 'level', coalesces: false })
        claim(nodeId, 'source')
        return handle({ id: nodeId, source: 'level' } as Source<unknown, 'level'>)
      },
      occurrences: (local: string) => {
        const nodeId = scoped(prefix, local)
        declare({ id: nodeId, kind: 'occurrence', coalesces: false })
        claim(nodeId, 'source')
        return handle({ id: nodeId, source: 'occurrence' } as Source<unknown, 'occurrence'>)
      },
      clock: (local: string, clock: { everyMs: number; value: (now: number) => unknown }) => {
        const nodeId = member(local)
        if (!(clock.everyMs > 0))
          throw new GraphDefinitionError(`clock ${nodeId} needs a positive period`)
        declare({ id: nodeId, kind: 'clock', coalesces: false, clock })
        claim(nodeId, 'clock')
        return handle({ id: nodeId } as Node<unknown>)
      },
      node: (local: string) => {
        const nodeId = scoped(prefix, local)
        declare({ id: nodeId, kind: 'derived', coalesces: false })
        return handle({ id: nodeId } as Node<unknown>)
      },
      map: (
        local: string,
        spec: { reads: Record<string, Edge>; compute: (inputs: never) => unknown },
        options: Expiring<never> = {}
      ) => {
        const nodeId = member(local)
        checkReads(nodeId, spec.reads)
        declare({ id: nodeId, kind: 'derived', coalesces: true, ...expiring(options) })
        claim(nodeId, nodeId)
        operators.push({
          kind: 'map',
          id: nodeId,
          reads: spec.reads,
          output: nodeId,
          compute: spec.compute as (inputs: Record<string, unknown>) => unknown
        })
        return handle({ id: nodeId } as Node<unknown>)
      },
      reserve: (local: string) => {
        const nodeId = scoped(prefix, local)
        declare({ id: nodeId, kind: 'derived', coalesces: true })
        reservations.add(nodeId)
        return handle({ id: nodeId } as Node<unknown>)
      },
      fold: (
        target: string | Node<unknown>,
        spec: FoldSpec<Record<string, FoldEdge>, unknown>,
        options: Expiring<never> = {}
      ) => {
        const reserved = typeof target !== 'string'
        if (reserved) {
          checkOwned('fold', target)
          if (!reservations.has(target.id))
            throw new GraphDefinitionError(`${target.id} was not reserved for a fold`)
        }
        const nodeId = reserved ? target.id : scoped(prefix, target)
        checkReads(nodeId, spec.reads)
        if (!reserved && nodes.has(nodeId))
          throw new GraphDefinitionError(`node ${nodeId} is declared twice`)
        checkClaim(nodeId, nodeId)
        for (const node of spec.emits ?? []) checkOwned(nodeId, node)
        const emits = (spec.emits ?? []).map(node => node.id)
        for (const [index, node] of emits.entries()) {
          checkUnreserved(node, nodeId)
          if (emits.indexOf(node) !== index)
            throw new GraphDefinitionError(
              `node ${node} has two producers: ${nodeId} and ${nodeId}`
            )
        }
        memberOf(nodeId)
        if (reserved) nodes.set(nodeId, { ...nodes.get(nodeId)!, ...expiring(options) })
        else declare({ id: nodeId, kind: 'derived', coalesces: true, ...expiring(options) })
        claim(nodeId, nodeId)
        for (const node of emits) claim(node, nodeId)
        operators.push({
          kind: 'fold',
          id: nodeId,
          reads: spec.reads,
          output: nodeId,
          emits,
          initial: spec.initial,
          applyInput: spec.applyInput as unknown as FoldOperator['applyInput'],
          ...(spec.afterInputs && {
            afterInputs: spec.afterInputs as unknown as FoldOperator['afterInputs']
          })
        })
        return reserved ? target : handle({ id: nodeId } as Node<unknown>)
      },
      effect: (local: string, spec: EffectSpec<Requests, unknown, Sampled>) => {
        const effectId = scoped(prefix, local)
        if (
          effects.some(effect => effect.id === effectId) ||
          operators.some(op => op.id === effectId)
        )
          throw new GraphDefinitionError(`${effectId} is declared twice`)
        if (spec.finishOnStop && spec.ready)
          throw new GraphDefinitionError(
            `${effectId} finishes on stop, so it cannot wait to be ready`
          )
        checkReads(effectId, spec.requests)
        for (const node of Object.values(spec.samples ?? {})) checkOwned(effectId, node)
        const samples = Object.fromEntries(
          Object.entries(spec.samples ?? {}).map(([name, node]) => [name, node.id])
        )
        if (spec.results) {
          checkOwned(effectId, spec.results)
          checkUnreserved(spec.results.id, effectId)
          claim(spec.results.id, effectId)
        }
        members?.push(effectId)
        effects.push({
          id: effectId,
          reads: spec.requests,
          samples,
          ...(spec.results && { results: spec.results.id }),
          lane: spec.lane ?? UNBOUNDED_CONCURRENCY,
          spec
        })
      },
      scope: (
        local: string,
        body: (scope: GraphBuilder) => unknown,
        options: ScopeOptions<unknown> = {}
      ) => {
        const nested = scoped(prefix, local)
        if (options.recovery && members)
          throw new GraphDefinitionError(`recovery scope ${nested} is inside another`)
        const own = options.recovery ? [] : members
        const result = body(builderOf(nested, own))
        if (options.recovery)
          recoveries.push({ members: own!, onFailure: options.recovery(result) })
        return result
      }
    }
    return declared as unknown as GraphBuilder
  }

  return {
    ...builderOf(''),
    build: (): Graph => {
      for (const node of reservations)
        if (!operators.some(op => op.kind === 'fold' && op.id === node))
          throw new GraphDefinitionError(`node ${node} is reserved but no fold produces it`)
      for (const node of nodes.keys())
        if (!claims.has(node)) throw new GraphDefinitionError(`node ${node} has no producer`)
      if (recoveries.length > 1)
        throw new GraphDefinitionError(
          `${id} declares ${recoveries.length} recovery scopes; a graph holds one`
        )
      const ordered = evaluationOrder(operators)
      return {
        id,
        [layout]: {
          nodes,
          initials: initialValues(ordered),
          operators: ordered,
          effects,
          recoveries,
          handles
        }
      }
    }
  }
}
