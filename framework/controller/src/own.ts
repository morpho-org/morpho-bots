/**
 * Records indexed by bot keys, so a key such as `constructor` or `__proto__` is only ever read as an
 * own field, and drafts that are written to have no prototype.
 */
export const has = (record: object, key: string) => Object.hasOwn(record, key)

export const entryOf = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
  has(record, key) ? record[key] : undefined

export const ownRecord = <T>(from: Readonly<Record<string, T>> = {}): Record<string, T> =>
  Object.assign(Object.create(null) as Record<string, T>, from)

/** Per key, an entry per task. */
export type ByTask<T> = Readonly<Record<string, Readonly<Record<string, T>>>>

export const taskEntryOf = <T>(byTask: ByTask<T>, key: string, task: string) => {
  const entries = entryOf(byTask, key)
  return entries === undefined ? undefined : entryOf(entries, task)
}

/** `byTask` with `task` of `key` set to `value`, or forgotten when `value` is undefined. */
export const withTaskEntry = <T>(
  byTask: ByTask<T>,
  key: string,
  task: string,
  value: T | undefined
): ByTask<T> => {
  const { [task]: _, ...others } = entryOf(byTask, key) ?? {}
  const entries = value === undefined ? others : { ...others, [task]: value }
  const { [key]: __, ...rest } = byTask
  return Object.keys(entries).length === 0 ? rest : { ...rest, [key]: entries }
}

/** `byTask` with only the entries `keep` holds for, and no key left without one. */
export const keptTaskEntries = <T>(
  byTask: ByTask<T>,
  keep: (key: string, value: T) => boolean
): ByTask<T> =>
  Object.fromEntries(
    Object.entries(byTask).flatMap(([key, entries]) => {
      const kept = Object.entries(entries).filter(([, value]) => keep(key, value))
      return kept.length === 0 ? [] : [[key, Object.fromEntries(kept)]]
    })
  )
