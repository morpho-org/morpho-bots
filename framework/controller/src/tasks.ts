import type { Emit, Graph, Keyed, KeyRecord, Lane, Node } from '@repo/engine'
import type { Conflicts, KernelActivity, KernelNodes, KernelRequest, StepSpec } from '@repo/kernel'

import { emitTo, every, GraphDefinitionError, keyRecord, reachable, watch } from '@repo/engine'

import type { FactNode, FactReading } from './act'
import type { BackoffPolicy, Backoff } from './backoff'
import type { Bot, KernelHandle } from './bot'
import type { LogSink } from './log'
import type { ByTask } from './own'
import type { KernelView } from './view'

import { act, factOf } from './act'
import { declareBackoff, isBackedOff, isStaleRefusal } from './backoff'
import { onBuild, secondFamily } from './bot'
import { TaskDefectError } from './errors'
import { intentIdOf, parseIntentId } from './intent'
import { entryOf, has, keptTaskEntries, ownRecord, taskEntryOf, withTaskEntry } from './own'
import { isBusy } from './view'

/**
 * `seq` rises with every request a run makes, so an effect can refuse a redelivered one. A
 * preparation builds only from `input`, the key's reading captured when its fact stood at `version`,
 * never from a later read, so the act it returns is what that fact describes.
 */
export type PrepareRequest<I = unknown> = Readonly<{
  id: string
  key: string
  /** The task the request prepares, which its answer backs off when it fails. */
  task: string
  seq: number
  version: string
  input: I
}>

/**
 * A preparation's answer: the steps of an act to submit until `validUntil`, or why there is none and
 * whether that failure backs the key's task off.
 */
export type PrepareOutcome =
  | Readonly<{ ok: true; steps: readonly StepSpec[]; validUntil: number }>
  | Readonly<{ ok: false; reason: string; backoff: boolean }>

/** What a preparation's handler receives beside its request. */
type PrepareContext = Readonly<{
  /** Aborts at the family's `prepare.timeoutMs` and on stop; the runtime stops waiting either way. */
  signal: AbortSignal
}>

/** Why the runtime answered a preparation itself: its handler threw, or did not answer in time. */
type PrepareFault = 'prepare_threw' | 'prepare_timed_out'

/** A fault as the runtime answers it: `error` is the thrown error's class name, never its message. */
type FaultOutcome = Readonly<{
  ok: false
  reason: PrepareFault
  backoff: true
  fault: true
  error?: string
}>

/**
 * An outcome as the runtime stamps it with the request it answers: the act is submitted only while
 * its key's fact is still at `version`.
 */
export type PrepareResult = Readonly<{ id: string; key: string; task: string; version: string }> &
  (PrepareOutcome | FaultOutcome)

/**
 * A key's wish to act: the act named `name`, ranked by `priority` (highest first, equal ones in
 * turn), conflicting with `conflicts`. The runtime acts only on one {@link task} built.
 */
export type Task = Readonly<{
  kind: 'task'
  name: string
  priority: bigint
  conflicts: Conflicts
}>

/** A task's name, which its intent ids carry after a `.`, so it holds neither `.` nor `#`. */
const TASK_NAME = /^[^.#]+$/

const built = new WeakSet<object>()

/** A copy of an id list, `undefined` for none, or `null` for anything but a list of strings. */
const idsOf = (value: unknown) => {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return null
  const ids: string[] = []
  for (const id of value as readonly unknown[]) {
    if (typeof id !== 'string') return null
    ids.push(id)
  }
  return Object.freeze(ids)
}

/**
 * A frozen task, read once from `spec`.
 * @throws TaskDefectError - for a name, priority or conflict set the runtime cannot act on.
 */
export const task = (name: string, spec: Omit<Task, 'kind' | 'name'>): Task => {
  const { priority, conflicts } = spec as Readonly<Record<string, unknown>>
  const { reads: readIds, writes: writeIds } = (conflicts ?? {}) as Record<string, unknown>
  const [reads, writes] = [idsOf(readIds), idsOf(writeIds)]
  const valid =
    typeof name === 'string' &&
    TASK_NAME.test(name) &&
    typeof priority === 'bigint' &&
    typeof conflicts === 'object' &&
    conflicts !== null &&
    reads !== null &&
    writes !== null
  if (!valid) throw new TaskDefectError("a task's name, priority or conflicts are malformed")
  const read = Object.freeze({
    kind: 'task' as const,
    name,
    priority,
    conflicts: Object.freeze({ ...(reads && { reads }), ...(writes && { writes }) })
  })
  built.add(read)
  return read
}

/** Why a policy's return was refused for a key, which then acts on nothing until it returns one. */
type Rejection = 'policy_threw' | 'policy_invalid'

type Wanted = Task | Readonly<{ kind: 'rejected'; reason: Rejection }>

type DropReason =
  | 'preparation_expired'
  | 'not_candidate'
  | 'policy_rejected'
  | 'task_changed'
  | 'fact_unavailable'
  | 'fact_unbounded'
  | 'fact_expired'
  | 'fact_changed'

/** `submitted` rests on its key's fact read at `block`; `fact_unbounded` names the fact. */
export type TaskEvent =
  | Readonly<{ type: 'submitted'; key: string; intentId: string; priority: bigint; block: number }>
  | Readonly<{ type: 'dropped'; key: string; task: string; reason: DropReason; fact?: string }>
  | Readonly<{ type: 'rejected'; key: string; reason: Rejection }>
  | Readonly<{
      type: 'prepare_failed'
      key: string
      task: string
      ticket: string
      reason: PrepareFault
      error?: string
    }>

/** A voided preparation keeps its lane slot until it answers, but can never become ready. */
type Preparation = Readonly<{
  id: string
  reading: FactReading<string>
  inputFingerprint: string
  task: string
  /** The conflicts its task declared when it was asked, which its act carries. */
  conflicts: Conflicts
  void?: true
}>

type Ready = Preparation & Readonly<{ answer: Extract<PrepareResult, { ok: true }> }>

/** An act sent to the kernel: the task it carries out and the reading of its key's fact it rests on. */
type Sent = Readonly<{ intentId: string; task: string; reading: FactReading<string> }>

type Family = Readonly<{
  candidates?: Keyed<unknown>
  facts?: Keyed<unknown>
  inputs?: Keyed<unknown>
  view?: KernelView
  backoff?: Backoff
  preparing: Readonly<Record<string, Preparation>>
  ready: Readonly<Record<string, Ready>>
  /**
   * Keys whose preparation declined without backing off, per task, with the inputs it declined on:
   * a task of a key is not prepared again until the key's candidate, fact or input changes.
   */
  declined: ByTask<string>
  /**
   * Per key and task, the reading of its fact the kernel refused an act on as stale: the task is not
   * prepared again until the fact is read again.
   */
  stale: ByTask<string>
  /** Keys whose policy return was refused, with why: each acts on nothing until it is valid again. */
  rejected: Readonly<Record<string, Rejection>>
  /** Acts sent to the kernel whose first notice has not come back yet. */
  submitted: Readonly<Record<string, Sent>>
  /** The key served last, so equal priorities take turns. */
  served: string
  /** How many intent ids and preparation tickets this run has issued, which numbers the next. */
  issued: number
}>

const sameIds = (left: readonly string[] = [], right: readonly string[] = []) => {
  const sorted = right.toSorted()
  return left.length === right.length && left.toSorted().every((id, i) => id === sorted[i])
}

const sameConflicts = (left: Conflicts, right: Conflicts) =>
  sameIds(left.reads, right.reads) && sameIds(left.writes, right.writes)

/** Why a ready act is discarded whenever the family decides, in the order it is checked. */
const heldDrop = (
  ready: Ready,
  wanted: Wanted | undefined,
  now: number
): DropReason | undefined => {
  if (ready.answer.validUntil <= now) return 'preparation_expired'
  if (wanted === undefined) return 'not_candidate'
  if (wanted.kind === 'rejected') return 'policy_rejected'
  if (wanted.name !== ready.task || !sameConflicts(wanted.conflicts, ready.conflicts))
    return 'task_changed'
  return undefined
}

/** Why a ready act is discarded as it is about to go to the kernel, in the order it is checked. */
const submitDrop = (
  { reading: captured }: Ready,
  reading: FactReading<string> | undefined,
  now: number
): DropReason | undefined => {
  if (reading === undefined) return 'fact_unavailable'
  if (captured.expiry === undefined) return 'fact_unbounded'
  if (captured.expiry <= now) return 'fact_expired'
  if (reading.fact.version !== captured.fact.version) return 'fact_changed'
  return undefined
}

/** A policy return that {@link task} did not build is refused; any failure rejects only its key. */
const normalizePolicy = <C>(policy: Policy<C>, candidate: C, key: string): Wanted => {
  try {
    const value: unknown = policy(candidate, key)
    if (typeof value === 'object' && value !== null && built.has(value)) return value as Task
    return { kind: 'rejected', reason: 'policy_invalid' }
  } catch (error) {
    return {
      kind: 'rejected',
      reason: error instanceof TaskDefectError ? 'policy_invalid' : 'policy_threw'
    }
  }
}

type Policy<C> = (candidate: C, key: string) => Task

type TaskFamilyOptions<C, I> = Readonly<{
  kernel: KernelHandle
  /** The keys that may act; the policy decides each present one. */
  candidates: Node<Keyed<C>>
  /**
   * The fact every key's act rests on. Neither it nor anything it reads may be triggered by the
   * kernel's transitions, which `defineBot` checks: read kernel nodes beside it with `sample`.
   */
  facts: FactNode<string>
  /** What a preparation builds from, captured into its request in the same step as the fact. */
  inputs: Node<Keyed<I>>
  /** Names the run in its intent ids. */
  runId: string
  /** How many native reservations the kernel's caps allow: no act is prepared beyond them. */
  maxReservations: number
  backoff: BackoffPolicy
  policy: Policy<C>
  prepare: PrepareOptions<I>
}>

type PrepareOptions<I> = Readonly<{
  /** Its concurrency bounds how many preparations are outstanding. */
  lane: Lane
  /**
   * How long a preparation may take before the runtime answers it as `prepare_timed_out`, aborts its
   * signal and frees its slot, whether or not the handler stops.
   */
  timeoutMs: number
  /** A throw is answered as `prepare_threw`, which backs the key off as a failure does. */
  handle: (request: PrepareRequest<I>, context: PrepareContext) => Promise<PrepareOutcome>
}>

/** The longest delay `setTimeout` honours: https://nodejs.org/api/timers.html#settimeoutcallback-delay-args */
const MAX_TIMER_MS = 2 ** 31 - 1

const IDENTIFIER = /^[A-Za-z_$][\w$]{0,63}$/

/** The thrown value's class as its code names it, not its mutable `name`, which may carry data. */
const errorName = (error: unknown) => {
  try {
    const name: unknown = error instanceof Error ? error.constructor.name : undefined
    return typeof name === 'string' && IDENTIFIER.test(name) ? name : 'Error'
  } catch {
    return 'Error'
  }
}

/**
 * The handler's outcome, or the runtime's own when it throws or outlives `timeoutMs`; `undefined`
 * once `stop` aborts. Settles by then whether or not the handler heeds its signal.
 */
const prepareWithin = async <I>(
  prepare: PrepareOptions<I>,
  request: PrepareRequest<I>,
  stop: AbortSignal
): Promise<PrepareOutcome | FaultOutcome | undefined> => {
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), prepare.timeoutMs)
  const signal = AbortSignal.any([stop, deadline.signal])
  let release = () => {}
  const gaveUp = new Promise<undefined>(resolve => {
    if (signal.aborted) return resolve(undefined)
    const onAbort = () => resolve(undefined)
    signal.addEventListener('abort', onAbort, { once: true })
    release = () => signal.removeEventListener('abort', onAbort)
  })
  const handled = (async () => ({ outcome: await prepare.handle(request, { signal }) }))().catch(
    (error: unknown) => ({
      outcome: {
        ok: false,
        reason: 'prepare_threw',
        backoff: true,
        fault: true,
        error: errorName(error)
      } as const
    })
  )
  try {
    const answer = await Promise.race([handled, gaveUp])
    if (answer) return answer.outcome
    if (stop.aborted) return undefined
    return { ok: false, reason: 'prepare_timed_out', backoff: true, fault: true }
  } finally {
    clearTimeout(timer)
    release()
  }
}

/** A fact the kernel's transitions can trigger lets an act's own admission withdraw it. */
const checkFactKernelFree = (graph: Graph, family: string, fact: string, kernel: KernelNodes) => {
  const via = reachable(graph, [kernel.state, kernel.activity, kernel.commands], {
    skipRecovery: true
  })
  if (!via.has(fact)) return
  const path = [fact]
  while (via.get(path[0]!) !== path[0]) path.unshift(via.get(path[0]!)!)
  throw new GraphDefinitionError(
    `${family} rests on ${fact}, which the kernel's transitions trigger through ${path.join(' -> ')}; read kernel nodes beside a fact with sample`
  )
}

const ranked = (
  family: Family,
  wanted: Readonly<Record<string, Wanted>>,
  keys: readonly string[]
) => {
  const priorityOf = (key: string) => {
    const want = entryOf(wanted, key)
    return want?.kind === 'task' ? want.priority : 0n
  }
  const inTurn = keys.toSorted()
  const at = inTurn.findIndex(key => key > family.served)
  const turn = at < 0 ? inTurn : [...inTurn.slice(at), ...inTurn.slice(0, at)]
  return turn.toSorted((a, b) => {
    const [left, right] = [priorityOf(a), priorityOf(b)]
    return left === right ? 0 : left > right ? -1 : 1
  })
}

/** What a preparation of `key` would read: its candidate, its fact and its input, by digest. */
const inputFingerprintOf = (family: Family, key: string) => {
  const digest = (keyed: Keyed<unknown> | undefined) => {
    const fact = keyed && keyRecord(keyed, key)
    return fact?.status === 'present' ? fact.digest : 'none'
  }
  return `${digest(family.candidates)}/${digest(family.facts)}/${digest(family.inputs)}`
}

/** Which reading of its fact a preparation rests on: a new read differs even at the same version. */
const readingFingerprintOf = (reading: FactReading<string> | undefined) =>
  reading === undefined
    ? 'none'
    : `${reading.fact.version}@${reading.fact.basis.blockHash}<${reading.expiry ?? ''}`

/**
 * Whether `reading` was taken before our own last inclusion or release on a conflict id of `want`:
 * the kernel refuses an act on it as predating our own effect, so it waits for a later read.
 */
const predatesOwnEffect = (
  view: KernelView | undefined,
  want: Wanted | undefined,
  reading: FactReading<string> | undefined
) => {
  const block = reading?.fact.basis.block
  if (view === undefined || want?.kind !== 'task' || block === undefined) return false
  const { reads = [], writes = [] } = want.conflicts
  return [...reads, ...writes].some(id => block < (entryOf(view.conflictMarks, id) ?? -1))
}

const isFault = (result: PrepareResult): result is PrepareResult & FaultOutcome =>
  !result.ok && 'fault' in result

/** The event a preparation the runtime answered itself logs: none for a handler's own outcome. */
const faultOf = (result: PrepareResult): TaskEvent[] => {
  if (!isFault(result)) return []
  const { key, task, id: ticket, reason, error } = result
  return [
    { type: 'prepare_failed', key, task, ticket, reason, ...(error !== undefined && { error }) }
  ]
}

/** Takes the answer to a key's outstanding ticket; any other answer, or a void ticket's, readies nothing. */
const answered = (family: Family, result: PrepareResult): Family => {
  const asked = entryOf(family.preparing, result.key)
  if (asked?.id !== result.id || asked.reading.fact.version !== result.version) return family
  const { [result.key]: _, ...preparing } = family.preparing
  const declines = !result.ok && !result.backoff && !asked.void
  const declined = withTaskEntry(
    family.declined,
    result.key,
    asked.task,
    declines ? asked.inputFingerprint : undefined
  )
  if (asked.void) return { ...family, preparing, declined }
  return {
    ...family,
    preparing,
    declined,
    ready: result.ok
      ? { ...family.ready, [result.key]: { ...asked, answer: result } }
      : family.ready
  }
}

/**
 * Forgets each submitted act the kernel has answered, and holds the task of one it refused as stale
 * until its fact is read again.
 */
const noticed = (family: Family, activity: readonly KernelActivity[]): Family => {
  const notices = new Map(activity.flatMap(a => (a.type === 'notice' ? [[a.intentId, a]] : [])))
  let { stale } = family
  const submitted = Object.fromEntries(
    Object.entries(family.submitted).filter(([key, sent]) => {
      const notice = notices.get(sent.intentId)
      if (isStaleRefusal(notice))
        stale = withTaskEntry(stale, key, sent.task, readingFingerprintOf(sent.reading))
      return notice === undefined
    })
  )
  return { ...family, submitted, stale }
}

/** Each kernel's family, by the kernel's own `kernel.state` node, which no handle can stand in for. */
const familyOf = new WeakMap<Node<unknown>, Node<unknown>>()

/**
 * Prepares and submits the task each candidate's `policy` wants; the runtime alone admits, rests
 * each act on the family's fact, and fails a key closed whose policy return it refuses. The
 * contract is `framework/controller/SPEC.md` §5; its logs are {@link logTasks}'s.
 * @throws GraphDefinitionError - for a second family on one kernel ({@link secondFamily}).
 */
const each = <C, I>(b: Bot, id: string, options: TaskFamilyOptions<C, I>) => {
  const { requests, prepared } = b.raw(g =>
    g.scope(id, s => ({
      requests: s.node<KernelRequest>('requests'),
      prepared: s.node<PrepareResult>('prepared')
    }))
  )
  const first = familyOf.get(options.kernel.nodes.state)
  if (first) throw secondFamily(requests, first)
  familyOf.set(options.kernel.nodes.state, requests)
  options.kernel.requestsFrom(requests)
  const { domain, view, nodes: kernel } = options.kernel
  const { timeoutMs } = options.prepare
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS)
    throw new GraphDefinitionError(
      `${id} needs prepare.timeoutMs, a whole number of milliseconds from 1 to ${MAX_TIMER_MS}`
    )
  if (parseIntentId(intentIdOf('key', options.runId, 0, 'task'))?.runId !== options.runId)
    throw new GraphDefinitionError(`${id} needs a runId that holds neither '.' nor '#'`)
  const { maxReservations } = options
  if (!Number.isSafeInteger(maxReservations) || maxReservations < 0)
    throw new GraphDefinitionError(`${id} needs maxReservations, a whole number from 0`)
  onBuild(b, graph => checkFactKernelFree(graph, id, options.facts.id, kernel))
  return b.raw(g =>
    g.scope(id, s => {
      const backoff = declareBackoff(s, 'backoff', {
        runId: options.runId,
        prepared,
        activity: kernel.activity,
        heads: kernel.heads,
        policy: options.backoff
      })
      const prepare = s.node<PrepareRequest<I>>('prepare')
      const events = s.node<TaskEvent>('events')

      type Draft = {
        family: Family
        now: number
        declined: Family['declined']
        wanted: Record<string, Wanted>
        ready: Record<string, Ready>
        preparing: Record<string, Preparation>
        submitted: Record<string, Sent>
        issued: number
        served: string
        numReservations: number
        emit: Emit[]
      }

      const busy = (draft: Draft, key: string) =>
        isBusy(draft.family.view, key) || has(draft.submitted, key)

      const drop = (draft: Draft, key: string, reason: DropReason) => {
        const { task, inputFingerprint, reading } = draft.ready[key]!
        delete draft.ready[key]
        if (reason === 'fact_unbounded')
          draft.declined = withTaskEntry(draft.declined, key, task, inputFingerprint)
        draft.emit.push(
          emitTo(events, {
            type: 'dropped',
            key,
            task,
            reason,
            ...(reason === 'fact_unbounded' && { fact: reading.fact.id })
          })
        )
      }

      const submit = (draft: Draft, key: string, now: number) => {
        const ready = entryOf(draft.ready, key)!
        const reading = factOf(options.facts, draft.family.facts, key)
        const reason = submitDrop(ready, reading, now)
        if (reason) return drop(draft, key, reason)
        const want = entryOf(draft.wanted, key) as Task
        const intentId = intentIdOf(key, options.runId, draft.issued++, ready.task)
        const plan = act(domain, {
          intentId,
          steps: ready.answer.steps,
          restsOn: [ready.reading],
          validUntil: ready.answer.validUntil,
          conflicts: ready.conflicts,
          decision: { key, priority: String(want.priority), prepared: ready.id }
        })
        delete draft.ready[key]
        draft.submitted[key] = { intentId, task: ready.task, reading: ready.reading }
        draft.served = key
        draft.numReservations++
        draft.emit.push(
          emitTo(requests, { type: 'Submit', plan }),
          emitTo(events, {
            type: 'submitted',
            key,
            intentId,
            priority: want.priority,
            block: plan.basisBlock
          })
        )
      }

      const preparable = (draft: Draft, key: string) => {
        const { family } = draft
        const want = entryOf(draft.wanted, key)
        if (want?.kind !== 'task') return false
        const fact = family.facts && keyRecord(family.facts, key)
        const input = family.inputs && keyRecord(family.inputs, key)
        const reading = factOf(options.facts, family.facts, key)
        return (
          fact?.status === 'present' &&
          !(fact.expiry !== undefined && fact.expiry <= draft.now) &&
          input?.status === 'present' &&
          taskEntryOf(draft.declined, key, want.name) !== inputFingerprintOf(family, key) &&
          taskEntryOf(family.stale, key, want.name) !== readingFingerprintOf(reading) &&
          !predatesOwnEffect(family.view, want, reading) &&
          !busy(draft, key) &&
          !has(draft.preparing, key) &&
          !has(draft.ready, key) &&
          !isBackedOff(family.backoff, key, want.name)
        )
      }

      const normalizePolicies = (draft: Draft) => {
        const { family, wanted } = draft
        const rejected = ownRecord<Rejection>()
        for (const key of Object.keys(family.candidates?.keys ?? {})) {
          const candidate = keyRecord(family.candidates!, key)
          if (candidate.status !== 'present') continue
          const want = normalizePolicy(options.policy, candidate.value as C, key)
          wanted[key] = want
          if (want.kind !== 'rejected') continue
          rejected[key] = want.reason
          const ticket = entryOf(draft.preparing, key)
          if (ticket && !ticket.void) draft.preparing[key] = { ...ticket, void: true }
          if (entryOf(family.rejected, key) !== want.reason)
            draft.emit.push(emitTo(events, { type: 'rejected', key, reason: want.reason }))
        }
        return rejected
      }

      const prepareNext = (draft: Draft) => {
        const { family } = draft
        const keys = Object.keys(family.candidates?.keys ?? {}).filter(key =>
          preparable(draft, key)
        )
        for (const key of ranked(family, draft.wanted, keys)) {
          const outstanding = Object.keys(draft.preparing).length
          if (outstanding >= options.prepare.lane.concurrency) break
          const pending = draft.numReservations + outstanding + Object.keys(draft.ready).length
          if (pending >= maxReservations) break
          const seq = draft.issued++
          const ticket = `${options.runId}.p${seq}`
          const reading = factOf(options.facts, family.facts, key)!
          const { version } = reading.fact
          const input = keyRecord(family.inputs!, key) as Extract<
            KeyRecord<I>,
            { status: 'present' }
          >
          const { name, conflicts } = entryOf(draft.wanted, key) as Task
          draft.preparing[key] = {
            id: ticket,
            reading,
            inputFingerprint: inputFingerprintOf(family, key),
            task: name,
            conflicts
          }
          draft.served = key
          draft.emit.push(
            emitTo(prepare, { id: ticket, key, seq, version, input: input.value, task: name })
          )
        }
      }

      const decide = (family: Family, now: number): { state: Family; emit: Emit[] } => {
        const wanted = ownRecord<Wanted>()
        const draft: Draft = {
          family,
          now,
          declined: family.declined,
          wanted,
          ready: ownRecord(family.ready),
          preparing: ownRecord(family.preparing),
          submitted: ownRecord(family.submitted),
          issued: family.issued,
          served: family.served,
          numReservations:
            (family.view?.numReservations ?? 0) + Object.keys(family.submitted).length,
          emit: []
        }
        const rejected = normalizePolicies(draft)
        for (const [key, ready] of Object.entries(draft.ready)) {
          const reason = heldDrop(ready, entryOf(wanted, key), now)
          if (reason) drop(draft, key, reason)
        }
        if (family.view?.acceptingNewWork === true) {
          for (const key of ranked(family, wanted, Object.keys(draft.ready))) {
            if (draft.numReservations >= maxReservations) break
            const ready = entryOf(draft.ready, key)!
            if (!busy(draft, key) && !isBackedOff(family.backoff, key, ready.task))
              submit(draft, key, now)
          }
          prepareNext(draft)
        }
        const declined = keptTaskEntries(
          draft.declined,
          (key, fingerprint) => fingerprint === inputFingerprintOf(family, key)
        )
        const stale = keptTaskEntries(
          family.stale,
          (key, fingerprint) =>
            fingerprint === readingFingerprintOf(factOf(options.facts, family.facts, key))
        )
        const { ready, preparing, submitted, issued, served, emit } = draft
        return {
          state: {
            ...family,
            ready,
            preparing,
            declined,
            stale,
            rejected,
            submitted,
            served,
            issued
          },
          emit
        }
      }

      const state = s.fold('', {
        reads: {
          candidates: watch(options.candidates),
          facts: watch(options.facts),
          inputs: watch(options.inputs),
          view: watch(view),
          backoff: watch(backoff.state),
          prepared: every(prepared),
          activity: every(kernel.activity)
        },
        emits: [prepare, requests, events],
        initial: {
          preparing: {},
          ready: {},
          declined: {},
          stale: {},
          rejected: {},
          submitted: {},
          served: '',
          issued: 0
        } as Family,
        applyInput: (family, input) => {
          if (input.from === 'prepared') {
            const result = input.value
            return {
              state: answered(family, result),
              emit: faultOf(result).map(fault => emitTo(events, fault))
            }
          }
          if (input.from === 'activity') return { state: noticed(family, input.value) }
          return { state: { ...family, [input.from]: input.value.value } }
        },
        afterInputs: (family, stamp) => decide(family, stamp.at)
      })

      s.effect('preparation', {
        requests: { request: every(prepare) },
        results: prepared,
        lane: options.prepare.lane,
        identify: ({ value }) => value.id,
        sequence: ({ value }) => value.seq,
        handle: async ({ value: request }, context) => {
          const { id, key, task, version } = request
          const outcome = await prepareWithin(
            { ...options.prepare, timeoutMs },
            request,
            context.signal
          )
          if (outcome) context.write({ ...outcome, id, key, task, version })
        }
      })

      return { state, events, backoff, requests, prepared }
    })
  )
}

export const tasks = { each }

/**
 * Logs each event as `act.${type}` with its fields and its key as `id`: `rejected` and
 * `prepare_failed` warn.
 */
export const logTasks = (logger: LogSink, { type, key, ...fields }: TaskEvent) =>
  logger[type === 'rejected' || type === 'prepare_failed' ? 'warn' : 'info'](`act.${type}`, {
    id: key,
    ...fields
  })
