import type { GraphBuilder, Stream } from '@repo/engine'
import type { KernelActivity, KernelHead, RefusalCode } from '@repo/kernel'

import { emitTo, every, GraphDefinitionError } from '@repo/engine'

import type { LogSink } from './log'
import type { ByTask } from './own'
import type { PrepareResult } from './tasks'

import { parseIntentId } from './intent'
import { entryOf, keptTaskEntries, taskEntryOf, withTaskEntry } from './own'

/**
 * A failing key waits `baseBlocks`, doubling up to `maxBlocks`, so however long it keeps failing it
 * settles at one preparation per `maxBlocks`.
 */
export type BackoffPolicy = Readonly<{
  baseBlocks: number
  maxBlocks: number
}>

/** A key's consecutive failures at one task, and the first block it may be prepared again. */
export type KeyBackoff = Readonly<{ failures: number; until: number }>

/** An act whose intent id names no task backs off its key under this one, which every task heeds. */
const UNTASKED = ''

export type Backoff = Readonly<{
  /** The newest head the kernel's chain delivered, which backoff windows are measured from. */
  block: number
  /** Each key's backoff per task, so one task's failures never hold another's. */
  keys: ByTask<KeyBackoff>
}>

/**
 * `backoff`: a failure set the key's wait, from `block` until `until`; `cleared`: a settlement
 * reset it. `reason` is the failed preparation's reason, or the kernel notice that ended the act.
 */
export type BackoffEvent =
  | Readonly<{
      type: 'backoff'
      key: string
      task?: string
      reason: string
      failures: number
      block: number
      until: number
    }>
  | Readonly<{ type: 'cleared'; key: string; task?: string }>

/** Caps the exponent so a chronically failing key cannot overflow its wait. */
const MAX_SHIFT = 32
/** Notices that end an act without settling it: each backs its key off, as a failed preparation does. */
const FAILED = new Set(['refused', 'abandoned', 'compensating', 'failed'])
/** Notices that end or withdraw an earlier run's act because that run stopped, not because the act was bad. */
const ENDED_BY_RESTART = new Set(['abandoned', 'compensating'])
/** Refusals of evidence read too long ago or before our own effect, which a fresh read may pass. */
const STALE_EVIDENCE: ReadonlySet<RefusalCode> = new Set([
  'evidence_expired',
  'evidence_too_old',
  'evidence_predates_own_effect',
  'decision_predates_own_effect'
])

export const isStaleRefusal = (activity: KernelActivity | undefined) =>
  activity?.type === 'notice' && activity.notice === 'refused' && STALE_EVIDENCE.has(activity.code)

const holds = (backoff: Backoff, entry: KeyBackoff | undefined) =>
  entry !== undefined && backoff.block < entry.until

/**
 * Whether `key` waits before `task` may be prepared again, its own backoff or one an untasked act
 * of the key set; with no `task`, whether any of the key's tasks waits.
 */
export const isBackedOff = (backoff: Backoff | undefined, key: string, task?: string) => {
  if (backoff === undefined) return false
  if (task === undefined)
    return Object.values(entryOf(backoff.keys, key) ?? {}).some(entry => holds(backoff, entry))
  return (
    holds(backoff, taskEntryOf(backoff.keys, key, task)) ||
    holds(backoff, taskEntryOf(backoff.keys, key, UNTASKED))
  )
}

const widenedWait = (
  backoff: Backoff,
  key: string,
  task: string,
  policy: BackoffPolicy
): KeyBackoff => {
  const failures = (taskEntryOf(backoff.keys, key, task)?.failures ?? 0) + 1
  const wait = Math.min(
    policy.baseBlocks * 2 ** Math.min(failures - 1, MAX_SHIFT),
    policy.maxBlocks
  )
  return { failures, until: backoff.block + wait }
}

/** Forgets a task whose last wait ended a whole maximum wait ago, so state stays bounded. */
const pruned = (backoff: Backoff, policy: BackoffPolicy) =>
  keptTaskEntries(backoff.keys, (_, entry) => entry.until + policy.maxBlocks > backoff.block)

/** The key and task an intent id names, untasked when it names none. */
const slotOfIntent = (intentId: string) => {
  const parsed = parseIntentId(intentId)
  return parsed && { key: parsed.key, task: parsed.task ?? UNTASKED, runId: parsed.runId }
}

/**
 * The slot a notice backs off, if it says the act itself was bad: not an act refused on stale
 * evidence, which waits for a fresh read instead, nor one an earlier run abandoned or a restart withdrew.
 */
const failureOf = (activity: KernelActivity, runId: string) => {
  if (activity.type !== 'notice' || !FAILED.has(activity.notice)) return undefined
  const slot = slotOfIntent(activity.intentId)
  if (slot === undefined) return undefined
  if (ENDED_BY_RESTART.has(activity.notice) && slot.runId !== runId) return undefined
  if (isStaleRefusal(activity)) return undefined
  return { key: slot.key, task: slot.task, reason: activity.notice }
}

/** `task` as an event carries it: absent for an untasked act. */
const taskField = (task: string) => (task === UNTASKED ? {} : { task })

/**
 * Per-key, per-task retry state: a failed preparation that asks for it, or an act the kernel
 * ended unsettled for a reason {@link failureOf} counts, doubles that task's wait from the current
 * head; a settlement clears it. Not persisted, so a restart retries every key at once. Its log
 * contract is {@link logBackoff}.
 * @throws GraphDefinitionError - for a bound that is not a whole number of blocks from 1.
 */
export const declareBackoff = (
  g: GraphBuilder,
  id: string,
  sources: Readonly<{
    /** The run whose acts these are: an act another run issued was adopted on restart. */
    runId: string
    prepared: Stream<PrepareResult>
    activity: Stream<readonly KernelActivity[]>
    heads: Stream<KernelHead>
    policy: BackoffPolicy
  }>
) => {
  const policy = Object.freeze({ ...sources.policy })
  if (![policy.baseBlocks, policy.maxBlocks].every(n => Number.isSafeInteger(n) && n >= 1))
    throw new GraphDefinitionError(`${id} needs baseBlocks and maxBlocks, whole numbers from 1`)
  const events = g.node<BackoffEvent>(`${id}.events`)
  const state = g.fold(id, {
    reads: {
      prepared: every(sources.prepared),
      activity: every(sources.activity),
      head: every(sources.heads)
    },
    emits: [events],
    initial: { block: 0, keys: {} } as Backoff,
    applyInput: (backoff, input) => {
      if (input.from === 'head') {
        const next = { ...backoff, block: Math.max(backoff.block, input.value.number) }
        return { state: { ...next, keys: pruned(next, policy) } }
      }
      const failures =
        input.from === 'prepared'
          ? input.value.ok || !input.value.backoff
            ? []
            : [{ key: input.value.key, task: input.value.task, reason: input.value.reason }]
          : input.value.flatMap(activity => failureOf(activity, sources.runId) ?? [])
      const settled =
        input.from === 'activity'
          ? input.value.flatMap(activity =>
              activity.type === 'notice' && activity.notice === 'settled'
                ? (slotOfIntent(activity.intentId) ?? [])
                : []
            )
          : []
      let keys = backoff.keys
      const emit = []
      for (const { key, task } of settled) {
        if (taskEntryOf(keys, key, task) === undefined) continue
        keys = withTaskEntry(keys, key, task, undefined)
        emit.push(emitTo(events, { type: 'cleared', key, ...taskField(task) }))
      }
      for (const { key, task, reason } of failures) {
        const entry = widenedWait({ ...backoff, keys }, key, task, policy)
        keys = withTaskEntry(keys, key, task, entry)
        emit.push(
          emitTo(events, {
            type: 'backoff',
            key,
            ...taskField(task),
            reason,
            block: backoff.block,
            ...entry
          })
        )
      }
      return { state: { ...backoff, keys }, emit }
    }
  })
  return { state, events }
}

/**
 * Logs `backoff.set` and `backoff.cleared` with the key as `id`. An act whose intent id names no
 * task has no `task` and `scope: 'key'`: it holds every task of the key.
 */
export const logBackoff = (logger: LogSink, event: BackoffEvent) => {
  const held = event.task === undefined ? { scope: 'key' } : { task: event.task, scope: 'task' }
  if (event.type === 'cleared') return logger.info('backoff.cleared', { id: event.key, ...held })
  logger.info('backoff.set', {
    id: event.key,
    ...held,
    reason: event.reason,
    failures: event.failures,
    block: event.block,
    untilBlock: event.until
  })
}
