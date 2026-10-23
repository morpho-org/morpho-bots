import { randomBytes } from 'node:crypto'

/**
 * The intent id of a run's `n`th submission for a key, and of the task it carries out when it names
 * one; its prefix attributes the key's entries. A task name holds no `.` or `#`.
 */
export const intentIdOf = (key: string, runId: string, n: number, task?: string) =>
  `${key}#${runId}.${n}${task === undefined ? '' : `.${task}`}`

/** The key, run and task of an intent id this library issued, or undefined for any other. */
export const parseIntentId = (intentId: string) => {
  const at = intentId.lastIndexOf('#')
  if (at < 0) return undefined
  const [runId, n, task, ...rest] = intentId.slice(at + 1).split('.')
  if (runId === undefined || n === undefined || !/^\d+$/.test(n)) return undefined
  if (task === '' || rest.length > 0) return undefined
  return { key: intentId.slice(0, at), runId, ...(task !== undefined && { task }) }
}

/**
 * A run's id, unique per process even on one clock reading: the ledger outlives the run, and the
 * kernel refuses an intent id that an adopted entry still holds.
 */
export const runIdAt = (at: number) => `${at.toString(36)}-${randomBytes(4).toString('hex')}`
