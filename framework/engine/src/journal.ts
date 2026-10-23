import type { DerivedWrite } from './core'
import type { Data } from './data'
import type { Stamp } from './graph'

import { encode } from './data'

/** Any change to {@link JournalEntry}'s shape bumps this; a journal's header records it. */
export const JOURNAL_FORMAT = 2

export type JournalWrite =
  | Readonly<{ node: string; value: Data }>
  | Readonly<{
      node: string
      delta: Readonly<{
        kind: 'keyed-complete'
        fields: Readonly<Record<string, Data>>
        entries: Readonly<Record<string, Data>>
        removed: readonly string[]
      }>
    }>

export type JournaledStep = Readonly<{
  stamp: Stamp
  writes: readonly JournalWrite[]
  wakes?: readonly string[]
}>

/**
 * The journal, in order: each step as replay needs it (the stamped external writes, the nodes whose
 * expiry woke their watchers, and what they derived), and each note an effect made, such as a
 * guard's verdict and the time it observed.
 */
export type JournalEntry =
  | (Readonly<{ kind: 'step'; derived: readonly DerivedWrite[] }> & JournaledStep)
  | Readonly<{ kind: 'note'; effect: string; at: number; note: Data }>
  /** A failure that stopped or degraded the runner, with the step it rolled back, if any. */
  | Readonly<{
      kind: 'failed'
      origin?: string
      at: number
      description?: string
      step?: JournaledStep
    }>
  /** From here on only the graph's recovery runs, after a failure at `origin`. */
  | Readonly<{ kind: 'recovery'; origin: string; at: number }>

export type JournalSink = Readonly<{
  append(entry: JournalEntry, signal?: AbortSignal): Promise<void>
  finalize(signal?: AbortSignal, result?: Readonly<{ clean: boolean }>): Promise<void>
}>

type CompleteKeyedWrite = Readonly<{
  fields: Readonly<Record<string, Data>>
  entries: Readonly<Record<string, Data>>
}>

const isDataRecord = (value: Data): value is { readonly [field: string]: Data | undefined } =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const completeKeyedWrite = (value: Data): CompleteKeyedWrite | undefined => {
  if (!isDataRecord(value)) return undefined
  if (value.coverage !== 'complete') return undefined
  const entries = value.entries
  if (!entries || !isDataRecord(entries)) return undefined
  const fields = Object.fromEntries(
    Object.entries(value).filter(
      (field): field is [string, Data] => field[0] !== 'entries' && field[1] !== undefined
    )
  )
  return {
    fields,
    entries: Object.fromEntries(
      Object.entries(entries).filter((field): field is [string, Data] => field[1] !== undefined)
    )
  }
}

type JournalDeltaState = Map<string, CompleteKeyedWrite>

export type JournalDeltaShapeState = Map<string, ReadonlySet<string>>

const validDelta = (
  before: ReadonlySet<string>,
  delta: Extract<JournalWrite, { delta: unknown }>['delta']
) => {
  if (delta.fields.coverage !== 'complete' || Object.hasOwn(delta.fields, 'entries')) return false
  const removed = new Set(delta.removed)
  if (removed.size !== delta.removed.length) return false
  if (delta.removed.some(key => !before.has(key) || Object.hasOwn(delta.entries, key))) return false
  return true
}

export const advanceJournalWriteShape = (
  write: JournalWrite,
  previous: JournalDeltaShapeState
): boolean => {
  if ('value' in write) {
    const complete = completeKeyedWrite(write.value)
    if (complete) previous.set(write.node, new Set(Object.keys(complete.entries)))
    else previous.delete(write.node)
    return true
  }
  const before = previous.get(write.node)
  if (!before || !validDelta(before, write.delta)) return false
  const entries = new Set(before)
  for (const key of write.delta.removed) entries.delete(key)
  for (const key of Object.keys(write.delta.entries)) entries.add(key)
  previous.set(write.node, entries)
  return true
}

export const compactJournalEntry = (
  entry: JournalEntry,
  previous: JournalDeltaState
): JournalEntry => {
  if (entry.kind !== 'step') return entry
  return {
    ...entry,
    writes: entry.writes.map(write => {
      if (!('value' in write)) return write
      const complete = completeKeyedWrite(write.value)
      const before = previous.get(write.node)
      if (!complete) {
        previous.delete(write.node)
        return write
      }
      previous.set(write.node, complete)
      if (!before) return write
      const entries = Object.fromEntries(
        Object.entries(complete.entries).filter(
          ([key, value]) =>
            !Object.hasOwn(before.entries, key) || encode(before.entries[key]) !== encode(value)
        )
      )
      const removed = Object.keys(before.entries).filter(
        key => !Object.hasOwn(complete.entries, key)
      )
      return {
        node: write.node,
        delta: { kind: 'keyed-complete', fields: complete.fields, entries, removed }
      }
    })
  }
}

export const expandJournalWrite = (
  write: JournalWrite,
  previous: JournalDeltaState
): Readonly<{ node: string; value: Data }> | undefined => {
  if ('value' in write) {
    const complete = completeKeyedWrite(write.value)
    if (complete) previous.set(write.node, complete)
    else previous.delete(write.node)
    return write
  }
  const before = previous.get(write.node)
  if (!before || !validDelta(new Set(Object.keys(before.entries)), write.delta)) return undefined
  const entries = new Map(Object.entries(before.entries))
  for (const key of write.delta.removed) entries.delete(key)
  for (const [key, value] of Object.entries(write.delta.entries)) entries.set(key, value)
  const expandedEntries = Object.fromEntries(entries)
  previous.set(write.node, { fields: write.delta.fields, entries: expandedEntries })
  return { node: write.node, value: { ...write.delta.fields, entries: expandedEntries } }
}
