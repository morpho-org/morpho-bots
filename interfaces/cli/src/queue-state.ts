import type { BackoffState, PendingQueueState } from '@repo/bot-kit'

import { loadState } from './state'

/**
 * The queue-file schema version, owned by the CLI (the `queue` command is not a `DomainAdapter`, so
 * the cores' cache versions don't apply here). Bump when {@link PendingQueueState} or
 * {@link BackoffState} change shape; a mismatched or corrupt file is discarded (warn `state.reset`),
 * never migrated — the queue reconciles against chain truth on the next `onBlock`.
 */
export const QUEUE_STATE_VERSION = 1

/** The full persisted queue state: the pending-tx queue plus the per-position failure backoff. */
export type QueueState = {
  version: number
  queue: PendingQueueState
  backoff: BackoffState
}

/** The read-only advisory `act` derives from the queue state file (never mutates it). */
type AdvisorySnapshot = { backoff: BackoffState | null; inflightLabels: string[] }

/**
 * Builds `act`'s advisory snapshot from a read-only load of the queue state file. Atomic writes mean
 * the file is never torn, and a ≤1-tick-stale read is fine — it only saves quotes/sims. A
 * missing/corrupt/version-mismatched file yields an empty advisory (no backoff, nothing in flight).
 */
export function readAdvisory(path: string): AdvisorySnapshot {
  const { state } = loadState<QueueState>(path, QUEUE_STATE_VERSION)
  if (!state) return { backoff: null, inflightLabels: [] }
  const labels = new Set<string>()
  for (const entry of state.queue.pending) labels.add(entry.label)
  for (const [label] of state.queue.settledAt) labels.add(label)
  return { backoff: state.backoff, inflightLabels: [...labels] }
}
