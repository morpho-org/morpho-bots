import type { Hex } from 'viem'

import type { LadderSubmittedTransaction } from './ladder-verbose'

/** Signals that a confirmed ladder cancellation could not be removed from durable ownership. */
export class LadderOwnershipCleanupError extends Error {
  readonly code = 'LADDER_OWNERSHIP_CLEANUP_FAILED'
  readonly kind = 'cleanup-error'

  /**
   * Creates a sanitized ownership-cleanup failure after an onchain cancellation completed.
   * @param groupId - Confirmed canceled ladder group.
   * @param submittedTransactions - Confirmed cancellation transaction retained for reporting.
   * @param cleanupErrorName - Allowlisted classification of the ownership write failure.
   */
  constructor(
    readonly groupId: Hex,
    readonly submittedTransactions: readonly LadderSubmittedTransaction[],
    readonly cleanupErrorName: string
  ) {
    super('Ladder ownership cleanup failed after confirmed cancellation')
    this.name = 'LadderOwnershipCleanupError'
  }
}
