import type {
  EffectContext,
  GraphBuilder,
  Keyed,
  Node,
  NodeRecord,
  Runner,
  Source,
  State,
  Stream
} from '@repo/engine'

import { emitTo, every, GraphDefinitionError, lane, sourceWrite, watch } from '@repo/engine'

import type { KernelChain } from './chain-adapter'
import type { KernelEffects, ExecutorPort } from './executor'
import type { LedgerStore } from './store'
import type {
  Authored,
  Command,
  Hash,
  KernelActivity,
  KernelConfig,
  KernelEvent,
  KernelState
} from './types'

import { createChainAdapter } from './chain-adapter'
import { KernelJournalRequiredError } from './errors'
import { createExecutor } from './executor'
import { createKernel } from './kernel'
import { OBSERVING, observeActivity, observeNode, observeRequest } from './observe'

type StartEvent = Extract<KernelEvent, { type: 'Start' }>
type TickEvent = Extract<KernelEvent, { type: 'Tick' }>
type NonceLookup = Extract<Command, { type: 'findNonceTx' }>

/**
 * Every kernel effect runs its work at once; its queue holds what one step admits and simulations
 * waiting for a head, sized for a maturity burst, with as much again kept for recovery.
 */
const KERNEL_LANE = { concurrency: Number.POSITIVE_INFINITY, queue: 4_096 }

type Submit = Extract<KernelEvent, { type: 'Submit' }>

/**
 * What the bot sends the kernel; `Stop` and `Halt` ride with its acts. A plan and an advance are
 * {@link Authored}, so their evidence is never assembled by hand.
 */
export type KernelRequest =
  | (Submit & Readonly<{ plan: Submit['plan'] & Authored<'plan'> }>)
  | (Extract<KernelEvent, { type: 'Advance' }> & Authored<'advance'>)
  | Extract<KernelEvent, { type: 'Affirm' | 'Stop' | 'Halt' }>

/** A head the kernel's chain adapter delivered, in order, after any rollback it follows; once each. */
export type KernelHead = Readonly<{ number: number; hash: Hash }>

export type KernelNodes = Readonly<{
  requests: Source<KernelRequest, 'occurrence'>
  state: State<KernelState>
  commands: Stream<Command>
  activity: Stream<readonly KernelActivity[]>
  heads: Stream<KernelHead>
}>

export type KernelHostOptions = {
  /** Where the bot's library folds emit requests, besides the `nodes.requests` source. */
  requests?: readonly Stream<KernelRequest>[]
  /**
   * The keyed fact nodes a plan's evidence may name, as `factId(node, key)`. The kernel sees the
   * current observation of each fact a plan names with the plan, and every change to it after.
   * A fact node's id may not hold `/`; its keys may.
   */
  facts?: readonly Node<Keyed<unknown>>[]
  config: KernelConfig
  store: LedgerStore
  chain: KernelChain
  effects: KernelEffects
  enrollment: 'enrolled' | 'enrolling'
  pollMs: number
  effectTimeoutMs: number
  /** How many delivered blocks are kept to find a fork point; a deeper reorg halts the kernel. */
  reorgDepth: number
  now?: () => number
  /** Each transition's {@link KernelActivity}, in order, before its commands run. */
  onActivity?: (activity: readonly KernelActivity[]) => void
  /** A failed read or effect; the error is the caller's to log without its URL or body. */
  onError: (source: string, error: unknown) => void
}

type Parts = Readonly<{
  kernel: ReturnType<typeof createKernel>
  executor: ReturnType<typeof createExecutor>
  adapter: ReturnType<typeof createChainAdapter>
  fail: (source: string, error: unknown) => void
}>

type Hosting = Omit<KernelHostOptions, 'requests' | 'facts'>

const partsOf = (options: Hosting): Parts => {
  const fail = (source: string, error: unknown) => {
    try {
      options.onError(source, error)
    } catch {
      // A throwing error hook must not wedge the event loop.
    }
  }
  const kernel = createKernel(options.config)
  return {
    kernel,
    executor: createExecutor({ ...options, kernel, onError: fail }),
    adapter: createChainAdapter({ ...options, onError: fail }),
    fail
  }
}

/** The kernel's sources, clock and the streams its folds and effects write. */
const declareNodes = (g: GraphBuilder, options: Hosting) => {
  const start = g.occurrences<StartEvent>('kernel.start')
  const requests = g.occurrences<KernelRequest>('kernel.requests')
  const tick = g.clock<TickEvent>('kernel.tick', {
    everyMs: options.pollMs,
    value: now => ({ type: 'Tick', now })
  })
  const chainEvents = g.node<KernelEvent>('kernel.chain.events')
  const results = g.node<KernelEvent>('kernel.effects.results')
  const observed = g.node<KernelEvent>('kernel.observed')
  const input = g.node<KernelEvent>('kernel.in')
  const commands = g.node<Command>('kernel.commands')
  const lookups = g.node<NonceLookup>('kernel.lookups')
  const activity = g.node<readonly KernelActivity[]>('kernel.activity')
  const heads = g.node<KernelHead>('kernel.heads')

  return {
    start,
    requests,
    tick,
    chainEvents,
    results,
    observed,
    input,
    commands,
    lookups,
    activity,
    heads
  }
}

type HostNodes = ReturnType<typeof declareNodes>

/** The outputs of `observe`, the merge and the reducer, reserved so readers can name them first. */
const reserveFolds = (g: GraphBuilder) => ({
  observe: g.reserve<typeof OBSERVING>('kernel.observe'),
  merge: g.reserve<KernelHead | null>('kernel.merge'),
  state: g.reserve<KernelState>('kernel.state')
})

/** `observe`, the merge and the reducer, which produces `kernel.state`, into `reserved`. */
const declareFolds = (
  g: GraphBuilder,
  nodes: HostNodes,
  kernel: Parts['kernel'],
  inputs: Pick<KernelHostOptions, 'requests' | 'facts'>,
  reserved: ReturnType<typeof reserveFolds>
) => {
  const { start, requests, tick, chainEvents, results, observed, input, commands, lookups } = nodes
  const { activity, heads } = nodes
  const facts = inputs.facts ?? []
  for (const node of facts) {
    if (node.id.includes('/'))
      throw new GraphDefinitionError(`fact node ${node.id} may not contain '/'`)
  }
  g.fold(reserved.observe, {
    reads: {
      requests: every(requests),
      activity: every(activity),
      ...Object.fromEntries((inputs.requests ?? []).map((node, i) => [`acts${i}`, every(node)])),
      ...Object.fromEntries(facts.map((node, i) => [`fact${i}`, watch(node)]))
    },
    emits: [observed],
    initial: OBSERVING,
    applyInput: (observing, input) => {
      if (input.from === 'activity') return { state: observeActivity(observing, input.value) }
      if (!input.from.startsWith('fact')) {
        const next = observeRequest(observing, input.value as KernelEvent)
        return { state: next.state, emit: [emitTo(observed, next.request)] }
      }
      const node = facts[Number(input.from.slice(4))]!.id
      const record = input.value as unknown as NodeRecord<Keyed<unknown>>
      const next = observeNode(observing, node, record)
      return {
        state: next.state,
        emit:
          next.changes.length === 0
            ? []
            : [emitTo(observed, { type: 'Observed', observations: next.changes })]
      }
    }
  })

  g.fold(reserved.merge, {
    reads: {
      start: every(start),
      chain: every(chainEvents),
      results: every(results),
      observed: every(observed),
      tick: every(tick)
    },
    emits: [input, heads],
    initial: null as KernelHead | null,
    applyInput: (last, { from, value, stamp }) => {
      if (from === 'results')
        return {
          state: last,
          emit: [emitTo(input, { type: 'Tick', now: stamp.at }), emitTo(input, value)]
        }
      const head = value.type === 'Head' ? { number: value.number, hash: value.hash } : undefined
      if (!head || (head.number === last?.number && head.hash === last.hash))
        return { state: last, emit: [emitTo(input, value)] }
      return { state: head, emit: [emitTo(input, value), emitTo(heads, head)] }
    }
  })

  g.fold(reserved.state, {
    reads: { event: every(input) },
    emits: [commands, lookups, activity],
    initial: kernel.initialState(),
    applyInput: (previous, { value }) => {
      const next = kernel.reduce(previous, value)
      return {
        state: next.state,
        emit: [
          ...(next.activity.length > 0 ? [emitTo(activity, next.activity)] : []),
          ...next.commands.map(command =>
            command.type === 'findNonceTx' ? emitTo(lookups, command) : emitTo(commands, command)
          )
        ]
      }
    }
  })
}

const declareEffects = (
  g: GraphBuilder,
  nodes: HostNodes,
  state: State<KernelState>,
  parts: Parts,
  options: Hosting
) => {
  const { start, tick, chainEvents, results, commands, lookups, activity } = nodes
  const { executor, adapter, fail } = parts
  g.effect('kernel.listener', {
    requests: { activity: every(activity) },
    lane: lane('kernel.listener', KERNEL_LANE),
    handle: ({ value: transition }) => {
      try {
        options.onActivity?.(transition)
      } catch (error) {
        fail('activity', error)
      }
    }
  })

  const portOf = (context: EffectContext<KernelEvent, { state: typeof state }>): ExecutorPort => ({
    signal: context.signal,
    emittedAt: context.stamp.at,
    now: context.now,
    write: context.write,
    note: context.note,
    state: context.samples.state,
    stop: context.stop
  })
  g.effect('kernel.executor', {
    requests: { command: every(commands) },
    samples: { state },
    results,
    lane: lane('kernel.executor', KERNEL_LANE),
    sequence: ({ value: command }) => ('request' in command ? command.request : undefined),
    recovery: ({ value: command }, samples) => executor.recovery(command, samples.state()),
    ready: ({ value: command }, samples) => executor.ready(command, samples.state()),
    handle: ({ value: command }, context) => executor.execute(command, portOf(context))
  })

  g.effect('kernel.chain', {
    requests: { start: every(start), tick: every(tick), lookup: every(lookups) },
    samples: { state },
    results: chainEvents,
    lane: lane('kernel.chain', KERNEL_LANE),
    handle: ({ value: request }, context) =>
      adapter.handle(request.type === 'findNonceTx' ? request : { type: 'poll' }, {
        signal: context.signal,
        write: context.write,
        state: context.samples.state
      })
  })
}

/** Halts a kernel that is acting when anything outside it fails, withdrawing what it holds. */
const haltOn =
  (state: State<KernelState>, requests: Source<KernelRequest, 'occurrence'>) =>
  (error: unknown, origin: string, read: <T>(node: Node<T>) => T | undefined) => {
    const lifecycle = read(state)?.lifecycle.kind
    if (lifecycle === undefined || lifecycle === 'idle' || lifecycle === 'stopped') return undefined
    const name = error instanceof Error ? error.name : 'unknown'
    return [sourceWrite(requests, { type: 'Halt', reason: `${origin} failed: ${name}` })]
  }

/** Pushes `Start` with the stored ledger, then starts the poll clock unless the kernel stopped. */
const starter =
  (options: Hosting, start: Source<StartEvent, 'occurrence'>, adapter: Parts['adapter']) =>
  async (runner: Runner) => {
    if (!runner.hasJournal) throw new KernelJournalRequiredError()
    const now = options.now ?? Date.now
    runner.push(start, {
      type: 'Start',
      ledger: await options.store.read(),
      enrollment: options.enrollment,
      now: now(),
      accountCode: await adapter.accountCode()
    })
    runner.start()
  }

/**
 * Declares the kernel in a bot's graph: `observe`, which carries the bot's requests to the kernel
 * with the observations of the facts they name, and every later change to those facts; a merge
 * fold over the nodes its producers own, writing a `Tick` at the result's push time before each
 * effect result, so a late result is judged when it arrives; the reducer as one fold; and the
 * executor, chain adapter and activity listener as effects. The bot pushes its acts to
 * `nodes.requests` or emits them to the `requests` option, and reads `nodes.state`; `start` must
 * be the runner's first push.
 *
 * The kernel is a recovery scope: when an operator or effect outside it fails, or the journal
 * does, it halts and runs on until the runner stops, withdrawing what it holds. A failure inside it
 * stops the runner at once: nothing runs in-process after it, so what it holds waits for its own
 * onchain expiry or the next start's adoption.
 * A graph holds one recovery scope, so `build` refuses a second kernel in it.
 */
export const declareKernel = (g: GraphBuilder, options: KernelHostOptions) => {
  const { attach, ...kernel } = declareKernelHost(g, options)
  attach(options)
  return kernel
}

/**
 * {@link declareKernel} in two steps, for a bot that reads the kernel before it has declared every
 * fact and request: its sources, effects and the reserved outputs of its folds now, `kernel.state`
 * among them, and `attach`, called once before `build`, declares `observe`, the merge and the
 * reducer over `requests` and `facts`.
 * @throws GraphDefinitionError - from `attach`, when it is called twice or a fact node's id holds `/`.
 */
export const declareKernelHost = (g: GraphBuilder, options: Hosting) => {
  const parts = partsOf(options)
  const { scope, nodes, reserved } = g.scope(
    '',
    inner => {
      const declared = declareNodes(inner, options)
      const reserved = reserveFolds(inner)
      declareEffects(inner, declared, reserved.state, parts, options)
      return { scope: inner, nodes: declared, reserved }
    },
    { recovery: ({ nodes, reserved }) => haltOn(reserved.state, nodes.requests) }
  )
  const state = reserved.state
  const { start, requests, commands, activity, heads } = nodes
  let attached = false
  return {
    nodes: { requests, state, commands, activity, heads } satisfies KernelNodes,
    start: starter(options, start, parts.adapter),
    attach: (inputs: Pick<KernelHostOptions, 'requests' | 'facts'>) => {
      if (attached) throw new GraphDefinitionError('the kernel is attached twice')
      attached = true
      declareFolds(scope, nodes, parts.kernel, inputs, reserved)
    }
  }
}
