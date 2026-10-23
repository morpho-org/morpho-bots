import type { DerivedWrite, NodeRecord, Pending } from './core'
import type { Data } from './data'
import type {
  EffectContext,
  EffectOperator,
  EffectRequest,
  Every,
  Graph,
  Lane,
  Node,
  Source,
  SourceKind,
  SourceWrite,
  Stamp,
  Written
} from './graph'
import type { JournaledStep, JournalEntry, JournalSink } from './journal'

import { createCore, layout } from './core'
import { encode, freezeData } from './data'
import {
  GraphDefinitionError,
  GraphFailedError,
  JournalFailedError,
  JournalIoTimeoutError,
  JournalOverflowError,
  LaneOverflowError,
  PolicyReentryError,
  ReentrantPushError,
  RequestRefusedError,
  RunnerFinalizationError,
  WriteRefusedError
} from './errors'
import { compactJournalEntry } from './journal'

/** Where a failed or overflowing journal is reported to have failed. */
const JOURNAL = 'journal'

/** The longest delay `setTimeout` honours; a longer one fires at once (https://nodejs.org/api/timers.html#settimeoutcallback-delay-args). */
const MAX_TIMEOUT_MS = 2 ** 31 - 1

export const DEFAULT_JOURNAL_IO_TIMEOUT_MS = 30_000

type JournalLimits = Readonly<{ capacityBytes: number; ioTimeoutMs?: number }>

export const validateJournalLimits = (limits: JournalLimits) => {
  if (typeof limits !== 'object' || limits === null)
    throw new GraphDefinitionError('a journal option must be an object')
  const { capacityBytes, ioTimeoutMs } = limits
  if (!(Number.isSafeInteger(capacityBytes) && capacityBytes >= 0))
    throw new GraphDefinitionError('a journal needs a non-negative safe-integer byte capacity')
  if (
    ioTimeoutMs !== undefined &&
    !(Number.isSafeInteger(ioTimeoutMs) && ioTimeoutMs > 0 && ioTimeoutMs <= MAX_TIMEOUT_MS)
  )
    throw new GraphDefinitionError('a journal needs a positive safe-integer I/O timeout')
}

export type RunnerOptions = Readonly<{
  now?: () => number
  /**
   * Written after each step and never awaited by one. A failed append, or more than
   * `capacityBytes` encoded bytes queued plus in flight, closes the journal and fails the graph
   * from `journal`, as a failed step would; nothing is journaled after.
   */
  journal?: Readonly<{
    sink: JournalSink
    capacityBytes: number
    /** Maximum time one append or finalization may take before the journal fails. */
    ioTimeoutMs?: number
    /**
     * A failure's `description`, which must keep credentials out. It runs as the entry is written,
     * after the runner has stopped or degraded; a throw leaves the description out.
     */
    describe?: (error: unknown) => string
  }>
}>

export type Runner = Readonly<{
  /** Whether this run records a journal. */
  hasJournal: boolean
  /** Returns once the push's step has propagated, unless an effect pushed while a step was running. */
  push<T, K extends SourceKind>(node: Source<T, K>, value: Written<T, K>): void
  /** A burst: one step over every write, in order. */
  pushAll(writes: readonly SourceWrite[]): void
  read<T>(node: Node<T>): T | undefined
  record<T>(node: Node<T>): NodeRecord<T>
  /** Starts the graph's clocks, and its wakes as each expiry a node carries passes. */
  start(): void
  /** Aborts every effect and resolves once each has settled; nothing propagates after it. */
  abandon(): Promise<void>
  /**
   * Resolves with the value an effect stopped the runner with. Rejects, once every running effect
   * has settled, with a failure inside a recovery scope or in a graph without any; with a
   * {@link GraphFailedError} once the recovery scopes wound down after a failure outside them.
   */
  stopped: Promise<unknown>
}>

type Delivered = EffectRequest<Record<string, Every<unknown>>>

type Step = Readonly<{ stamp: Stamp; writes: readonly Pending[]; wakes: readonly string[] }>

const journaledStep = ({ stamp, writes, wakes }: Step): JournaledStep => ({
  stamp,
  writes: writes.map(w => ({ node: w.node, value: w.pushed as Data })),
  ...(wakes.length > 0 && { wakes })
})

type Job = Readonly<{
  effect: EffectOperator
  request: Delivered
  stamp: Stamp
  identity: string
  recovery: boolean
}>
type LaneState = {
  running: number
  waiting: Job[]
  /** When each budgeted start within the last window began, oldest first. */
  starts: number[]
  wake?: ReturnType<typeof setTimeout>
}

export const createRunner = (graph: Graph, options: RunnerOptions = {}): Runner => {
  if (options.journal !== undefined) validateJournalLimits(options.journal)
  const now = options.now ?? Date.now
  const core = createCore(graph)
  const pending: (readonly Pending[])[] = []
  const lanes = new Map<Lane, LaneState>()
  /** Lanes start their work in the order their effects were declared. */
  const laneOrder = [...new Set(graph[layout].effects.map(effect => effect.lane))]
  const running = new Map<string, { effect: EffectOperator; controller: AbortController }>()
  const stopping = new AbortController()
  const settling = new Set<Promise<void>>()
  const sequenced = new Map<EffectOperator, number>()
  const timers: { node: string; timer: ReturnType<typeof setInterval> }[] = []
  let started = false
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  const { recoveries } = graph[layout]
  const members = new Set(recoveries.flatMap(recovery => recovery.members))
  /** Set once a failure outside every recovery scope leaves only their members running. */
  let degraded: { error: unknown; origin: string } | undefined
  /** Where the work under way would fail: an operator, or the effect being routed or started. */
  let origin: string | undefined
  /** A step that failed and was rolled back, until its failure is handled. */
  let rolledBack: Step | undefined
  let lateFailure: { error: unknown } | undefined
  /** Whether an operator, effect or clock still runs: all do until a failure degrades the graph. */
  const isActive = (id: string) => degraded === undefined || members.has(id)
  let pushSeq = 0
  let draining = false
  let pumpWanted = false
  let finished = false
  let resolveStopped: (value: unknown) => void = () => undefined
  let rejectStopped: (error: unknown) => void = () => undefined
  const stopped = new Promise<unknown>((resolve, reject) => {
    resolveStopped = resolve
    rejectStopped = reject
  })

  const live = () => !finished

  const journal = options.journal && {
    ...options.journal,
    queue: [] as { entry: JournalEntry; bytes: number }[],
    bytes: 0,
    writing: false,
    writingBytes: 0,
    closed: false,
    closing: false,
    finalizing: false,
    timedOut: false,
    failure: undefined as unknown,
    deltas: new Map() as Parameters<typeof compactJournalEntry>[1],
    completion: Promise.withResolvers<void>()
  }
  /** What failed, for each `failed` entry, described only as it is written. */
  const causes = new WeakMap<JournalEntry, unknown>()

  let handlingFailure = false

  const closeJournal = (error: JournalFailedError | JournalOverflowError) => {
    if (!journal || journal.failure) return
    journal.closed = true
    journal.failure = error
    if (!handlingFailure) fail(error, JOURNAL)
  }

  const journalIo = async (
    operation: 'append' | 'finalize',
    run: (signal: AbortSignal) => Promise<void>
  ) => {
    const controller = new AbortController()
    const timeoutMs = journal?.ioTimeoutMs ?? DEFAULT_JOURNAL_IO_TIMEOUT_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new JournalIoTimeoutError(operation, timeoutMs))
      }, timeoutMs)
    })
    try {
      await Promise.race([Promise.resolve().then(() => run(controller.signal)), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  const described = (entry: JournalEntry): JournalEntry => {
    const describe = journal?.describe
    if (entry.kind !== 'failed' || !describe) return entry
    try {
      return { ...entry, description: describe(causes.get(entry)) }
    } catch {
      return entry
    }
  }

  const writeJournal = () => {
    if (!journal || journal.writing || journal.finalizing) return
    const queued = journal.queue.shift()
    if (!queued) {
      if (!journal.closing) return
      journal.finalizing = true
      if (journal.timedOut) {
        journal.completion.reject(journal.failure)
        return
      }
      void Promise.resolve()
        .then(() =>
          journalIo('finalize', signal =>
            journal.sink.finalize(signal, { clean: journal.failure === undefined })
          )
        )
        .then(
          () => {
            if (journal.failure) journal.completion.reject(journal.failure)
            else journal.completion.resolve()
          },
          (error: unknown) =>
            journal.completion.reject(
              journal.failure
                ? new RunnerFinalizationError(journal.failure, error)
                : new JournalFailedError(error)
            )
        )
      return
    }
    journal.writing = true
    journal.writingBytes = queued.bytes
    void Promise.resolve()
      .then(async () => {
        const nextDeltas = new Map(journal.deltas)
        const entry = compactJournalEntry(described(queued.entry), nextDeltas)
        queued.entry = entry
        const bytes = Buffer.byteLength(encode(entry))
        const added = bytes - queued.bytes
        if (added > 0 && journal.bytes + added > journal.capacityBytes) {
          journal.writing = false
          journal.writingBytes = 0
          journal.queue.length = 0
          journal.bytes = 0
          closeJournal(new JournalOverflowError(journal.capacityBytes))
          writeJournal()
          return false
        }
        journal.bytes += added
        queued.bytes = bytes
        journal.writingBytes = bytes
        await journalIo('append', signal => journal.sink.append(entry, signal))
        return { nextDeltas }
      })
      .then(
        written => {
          if (!written) return
          journal.deltas = written.nextDeltas
          journal.bytes -= queued.bytes
          journal.writing = false
          journal.writingBytes = 0
          writeJournal()
        },
        (cause: unknown) => {
          journal.writing = false
          journal.writingBytes = 0
          journal.queue.length = 0
          journal.bytes = 0
          if (cause instanceof JournalIoTimeoutError) journal.timedOut = true
          closeJournal(new JournalFailedError(cause))
          writeJournal()
        }
      )
  }

  const append = (entry: JournalEntry) => {
    if (!journal || journal.closed || journal.closing) return
    const bytes = Buffer.byteLength(encode(entry))
    if (journal.bytes + bytes > journal.capacityBytes)
      return closeJournal(new JournalOverflowError(journal.capacityBytes))
    journal.bytes += bytes
    journal.queue.push({ entry, bytes })
    writeJournal()
  }

  const finalizeJournal = () => {
    if (!journal) return Promise.resolve()
    journal.closed = true
    journal.closing = true
    writeJournal()
    return journal.completion.promise
  }

  const withJournalFailure = (error: unknown, journalError: unknown) =>
    error === journalError || (error instanceof GraphFailedError && error.cause === journalError)
      ? error
      : new RunnerFinalizationError(error, journalError)

  const read = <T>(node: Node<T>) => core.read(node.id) as T | undefined

  /** The lane policy running now, and its refusal, which stands even if the policy caught it. */
  let policing: { effect: string; refused?: PolicyReentryError } | undefined
  const policy = <T>(effect: EffectOperator, decide: () => T): T => {
    const scope: { effect: string; refused?: PolicyReentryError } = { effect: effect.id }
    policing = scope
    try {
      const decided = decide()
      if (scope.refused) throw scope.refused
      return decided
    } catch (error) {
      throw scope.refused ?? error
    } finally {
      policing = undefined
    }
  }
  const refuseInPolicy = () => {
    if (!policing) return
    policing.refused ??= new PolicyReentryError(policing.effect)
    throw policing.refused
  }

  const samples = new Map(
    graph[layout].effects.map(effect => {
      const named = Object.entries(effect.samples).map(([name, id]) => [name, () => core.read(id)])
      return [effect, Object.freeze(Object.fromEntries(named))]
    })
  )
  const samplesOf = (effect: EffectOperator) => samples.get(effect)!

  const laneOf = (lane: Lane) => {
    const state = lanes.get(lane) ?? {
      running: 0,
      waiting: [],
      starts: []
    }
    lanes.set(lane, state)
    return state
  }

  /** Draws one start from the lane's budget, or sets a wake for when one is available again. */
  const drawBudget = (lane: Lane, state: LaneState) => {
    const { budget } = lane
    if (!budget) return true
    const at = now()
    while (state.starts.length > 0 && at - state.starts[0]! >= budget.perMs) state.starts.shift()
    if (state.starts.length < budget.calls) {
      state.starts.push(at)
      return true
    }
    state.wake ??= setTimeout(
      () => {
        state.wake = undefined
        pumpWanted = true
        drain()
      },
      Math.min(state.starts[0]! + budget.perMs - at, MAX_TIMEOUT_MS)
    )
    return false
  }

  /** Refuses a request at or below the effect's high-water mark, which advances as each is admitted. */
  const checkSequence = (effect: EffectOperator, request: Delivered) => {
    const position = policy(effect, () => effect.spec.sequence?.(request))
    if (position === undefined) return
    const highest = sequenced.get(effect)
    if (highest !== undefined && position <= highest)
      throw new RequestRefusedError(effect.id, `request ${position} is at or below ${highest}`)
    sequenced.set(effect, position)
  }

  const admit = (
    effect: EffectOperator,
    delivery: { from: string; value: unknown; seq: number; stamp: Stamp }
  ) => {
    const { spec } = effect
    const request = { from: delivery.from, value: delivery.value }
    checkSequence(effect, request)
    const identity = policy(effect, () => spec.identify?.(request)) ?? `${delivery.seq}`
    const state = laneOf(effect.lane)
    if (
      running.has(`${effect.id}\u0000${identity}`) ||
      state.waiting.some(job => job.effect === effect && job.identity === identity)
    )
      throw new RequestRefusedError(effect.id, `${identity} is already waiting or running`)
    const recovery = policy(effect, () => spec.recovery?.(request, samplesOf(effect))) ?? false
    const queued = (kind: boolean) => state.waiting.filter(job => job.recovery === kind).length
    const ahead = state.running + (recovery ? 0 : queued(true))
    const { concurrency } = effect.lane
    const free = Number.isFinite(concurrency) ? Math.max(0, concurrency - ahead) : 0
    if (queued(recovery) - free >= effect.lane.queue)
      throw new LaneOverflowError(effect.lane.name, effect.lane.queue)
    state.waiting.push({ effect, request, stamp: delivery.stamp, identity, recovery })
  }

  const route = () => {
    for (const effect of graph[layout].effects) {
      const deliveries = core.take(`effect:${effect.id}`, Object.keys(effect.reads))
      if (!isActive(effect.id)) continue
      origin = effect.id
      for (const delivery of deliveries) admit(effect, delivery)
    }
    origin = undefined
  }

  const contextFor = (
    job: Job,
    signal: AbortSignal
  ): EffectContext<unknown, Record<string, Node<unknown>>> => ({
    signal,
    identity: job.identity,
    stamp: job.stamp,
    now,
    note: note => {
      refuseInPolicy()
      if (!finished)
        append({ kind: 'note', effect: job.effect.id, at: now(), note: freezeData(note) })
    },
    samples: samplesOf(job.effect),
    write: result => {
      refuseInPolicy()
      if (finished || signal.aborted) return
      const results = job.effect.results
      if (results === undefined)
        throw new GraphDefinitionError(`${job.effect.id} has no results node to write`)
      enqueue([core.produced(results, result)])
    },
    stop: value => {
      refuseInPolicy()
      if (!isActive(job.effect.id)) return
      const failed = degraded
      void abandon(true).then(
        () => {
          if (failed) rejectStopped(new GraphFailedError(failed.origin, value, failed.error))
          else if (lateFailure) rejectStopped(lateFailure.error)
          else resolveStopped(value)
        },
        (journalError: unknown) => {
          const error = failed
            ? new GraphFailedError(failed.origin, value, failed.error)
            : lateFailure?.error
          rejectStopped(error ? withJournalFailure(error, journalError) : journalError)
        }
      )
    }
  })

  const start = (job: Job, state: LaneState) => {
    state.running++
    const key = `${job.effect.id}\u0000${job.identity}`
    const controller = new AbortController()
    running.set(key, { effect: job.effect, controller })
    const signal = AbortSignal.any([controller.signal, stopping.signal])
    const finishing = finished
    const settled = Promise.withResolvers<void>()
    settling.add(settled.promise)
    void (async () => job.effect.spec.handle(job.request, contextFor(job, signal)))()
      .catch((error: unknown) =>
        finishing ? failFinishing(error, job.effect.id) : fail(error, job.effect.id)
      )
      .finally(() => {
        settling.delete(settled.promise)
        running.delete(key)
        state.running--
        if (finished) finishQueued()
        else {
          pumpWanted = true
          drain()
        }
        settled.resolve()
      })
  }

  /** Work a clean stop let finish failed: the rest is dropped, and the stop reports this instead. */
  const failFinishing = (error: unknown, at: string) => {
    if (lateFailure) return
    lateFailure = { error }
    journalFailure(error, at, undefined)
    for (const state of lanes.values()) {
      state.waiting = []
      clearTimeout(state.wake)
    }
  }

  /** After a stop, starts only the work {@link abandon} kept, within each lane's concurrency. */
  const finishQueued = () => {
    for (const lane of laneOrder) {
      const state = laneOf(lane)
      while (state.running < lane.concurrency) {
        const job = nextJob(state, () => true)
        if (!job) break
        start(job, state)
      }
    }
  }

  const nextJob = (state: LaneState, effectRead: (job: Job) => boolean) => {
    const ordered = [
      ...state.waiting.filter(job => job.recovery),
      ...state.waiting.filter(job => !job.recovery)
    ]
    const job = ordered.find(effectRead)
    if (job) state.waiting.splice(state.waiting.indexOf(job), 1)
    return job
  }

  const isReady = (job: Job) =>
    policy(job.effect, () => job.effect.spec.ready?.(job.request, samplesOf(job.effect))) ?? true

  const pump = () => {
    for (const lane of laneOrder) {
      const state = laneOf(lane)
      while (
        live() &&
        pending.length === 0 &&
        overdueAt() === undefined &&
        state.running < lane.concurrency
      ) {
        const job = nextJob(state, candidate => {
          origin = candidate.effect.id
          return isReady(candidate)
        })
        origin = undefined
        if (!job) break
        if (!job.recovery && !drawBudget(lane, state)) {
          state.waiting.unshift(job)
          break
        }
        start(job, state)
      }
    }
  }

  /** Sets the one timer for the earliest expiry whose watchers have not seen it pass. */
  const armExpiry = () => {
    clearTimeout(expiryTimer)
    expiryTimer = undefined
    const next = core.nextExpiry()
    if (!started || finished || next === undefined) return
    expiryTimer = setTimeout(
      () => {
        drain()
        armExpiry()
      },
      Math.min(Math.max(next - now(), 0), MAX_TIMEOUT_MS)
    )
  }

  /** The time now, if an expiry has passed by it that its watchers have not seen, once started. */
  const overdueAt = () => {
    const next = started ? core.nextExpiry() : undefined
    const at = now()
    return next !== undefined && next <= at ? at : undefined
  }

  /** Runs `writes` in a step, or with none, wakes the watchers of every node whose expiry passed. */
  const propagate = (writes: readonly Pending[], at = now()) => {
    const wakes = writes.length === 0 ? core.due(at) : []
    if (writes.length === 0 && wakes.length === 0) return
    const stamp = { seq: ++pushSeq, at }
    let derived: readonly DerivedWrite[]
    try {
      derived = core.run(writes, stamp, wakes)
    } catch (error) {
      origin = core.failedOperator()
      rolledBack = { stamp, writes, wakes }
      throw error
    }
    append({ kind: 'step', ...journaledStep({ stamp, writes, wakes }), derived })
    if (!live()) return
    armExpiry()
    route()
    pumpWanted = true
  }

  /**
   * Propagates the next pending step, or else wakes what expired, so no effect starts before its
   * watchers see it, or else starts what effects may; false once there is none of these.
   */
  const work = () => {
    const next = pending.shift()
    const overdue = next ? undefined : overdueAt()
    if (next) propagate(next)
    else if (overdue !== undefined) propagate([], overdue)
    else if (pumpWanted) {
      pumpWanted = false
      pump()
    } else return false
    return true
  }

  /** {@link work}, handing any failure to {@link fail} with where it happened. */
  const guarded = () => {
    try {
      return work()
    } catch (error) {
      const retry = rolledBack
      rolledBack = undefined
      fail(error, origin, retry)
      origin = undefined
      return true
    }
  }

  const drain = () => {
    if (draining) return
    draining = true
    try {
      while (live() && guarded()) {}
    } finally {
      draining = false
    }
  }

  const enqueue = (writes: readonly Pending[]) => {
    if (finished || writes.length === 0) return
    pending.push(writes)
    drain()
  }

  const accept = ({ node, value }: SourceWrite) => {
    if (!graph[layout].handles.has(node))
      throw new WriteRefusedError(node.id, `its handle is not from ${graph.id}`)
    return core.accept(node.id, value)
  }

  const external = (writes: readonly SourceWrite[]) => {
    refuseInPolicy()
    const first = writes[0]
    if (core.propagating() && first) throw new ReentrantPushError(first.node.id)
    if (finished) return
    enqueue(writes.map(accept))
  }

  /** A clean stop keeps queued {@link EffectSpec.finishOnStop} work and settles once it has run. */
  let shutdown: Promise<void> | undefined
  const settleAndFinalize = async () => {
    while (settling.size > 0) await Promise.allSettled(settling)
    await finalizeJournal()
  }

  const abandon = (clean = false) => {
    if (!finished) {
      finished = true
      for (const { timer } of timers) clearInterval(timer)
      clearTimeout(expiryTimer)
      stopping.abort()
      pending.length = 0
    }
    for (const state of lanes.values()) {
      state.waiting = clean ? state.waiting.filter(job => job.effect.spec.finishOnStop) : []
      clearTimeout(state.wake)
    }
    finishQueued()
    return (shutdown ??= settleAndFinalize())
  }

  const journalFailure = (error: unknown, at: string | undefined, step: Step | undefined) => {
    const entry: JournalEntry = {
      kind: 'failed',
      ...(at !== undefined && { origin: at }),
      at: now(),
      ...(step && { step: journaledStep(step) })
    }
    causes.set(entry, error)
    append(entry)
  }

  const halt = (error: unknown, at: string | undefined, step: Step | undefined) => {
    journalFailure(error, at, step)
    void abandon().then(
      () => rejectStopped(error),
      (journalError: unknown) => rejectStopped(withJournalFailure(error, journalError))
    )
  }

  /**
   * A failure outside every recovery scope leaves only the recovery scopes running: it reruns the
   * step it rolled back without the rest, so each scope winds down from the state that step left,
   * then pushes what winds each down, in declaration order, all before any effect starts, so one
   * scope stopping at once never drops another's wind-down. Any other failure stops now.
   */
  const fail = (error: unknown, at?: string, retry?: Step) => {
    if (finished) return
    if (degraded && at !== undefined && !members.has(at)) return
    const wasHandlingFailure = handlingFailure
    handlingFailure = true
    try {
      if (recoveries.length === 0 || degraded || at === undefined || members.has(at))
        return halt(error, at, retry)
      journalFailure(error, at, retry)
      degraded = { error, origin: at }
      core.keepOnly(members)
      append({ kind: 'recovery', origin: at, at: now() })
      for (const { node, timer } of timers) if (!members.has(node)) clearInterval(timer)
      for (const job of running.values()) if (!members.has(job.effect.id)) job.controller.abort()
      for (const state of lanes.values())
        state.waiting = state.waiting.filter(job => members.has(job.effect.id))
      let windDowns: (readonly SourceWrite[])[]
      origin = undefined
      try {
        if (retry) propagate(retry.writes)
        windDowns = recoveries.flatMap(recovery => {
          const windDown = recovery.onFailure(error, at, read)
          return windDown?.length ? [windDown] : []
        })
        pending.push(...windDowns.map(writes => writes.map(accept)))
        drain()
      } catch (cause) {
        const step = rolledBack
        rolledBack = undefined
        halt(cause, origin, step)
        origin = undefined
        return
      }
      if (windDowns.length === 0)
        void abandon().then(
          () => rejectStopped(new GraphFailedError(at, undefined, error)),
          (journalError: unknown) =>
            rejectStopped(
              withJournalFailure(new GraphFailedError(at, undefined, error), journalError)
            )
        )
    } finally {
      handlingFailure = wasHandlingFailure
    }
  }

  return {
    hasJournal: journal !== undefined,
    push: (node, value) => external([{ node, value }]),
    pushAll: external,
    read,
    record: <T>(node: Node<T>) => core.record(node.id) as NodeRecord<T>,
    start: () => {
      refuseInPolicy()
      if (finished || started) return
      started = true
      armExpiry()
      for (const spec of graph[layout].nodes.values()) {
        const clock = spec.clock
        if (clock && isActive(spec.id))
          timers.push({
            node: spec.id,
            timer: setInterval(() => {
              try {
                enqueue([core.produced(spec.id, clock.value(now()))])
              } catch (error) {
                fail(error, spec.id)
              }
            }, clock.everyMs)
          })
      }
    },
    abandon: () => {
      refuseInPolicy()
      return abandon()
    },
    stopped
  }
}
