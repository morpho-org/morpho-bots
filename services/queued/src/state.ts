import type { PendingQueueState } from './pending-queue'

/**
 * The queue daemon's state schema version. Bump when {@link PendingQueueState} changes shape; a
 * mismatched or corrupt file is discarded (warn
 * `state.reset`), never migrated — the queue reconciles against chain truth on the next `onBlock`.
 */
export const QUEUE_STATE_VERSION = 3

/** The queue daemon's persisted pending transactions. */
export type QueueState = {
  version: number
  queue: PendingQueueState
}
