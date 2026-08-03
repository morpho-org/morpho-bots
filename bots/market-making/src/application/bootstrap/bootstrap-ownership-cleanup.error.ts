import type { Hex } from 'viem'

import type { BootstrapSubmittedTransaction } from './position-bootstrap-verbose'

/** Signals that a confirmed bootstrap cancellation could not be removed from durable ownership. */
export class BootstrapOwnershipCleanupError extends Error {
  readonly code = 'BOOTSTRAP_OWNERSHIP_CLEANUP_FAILED'
  readonly kind = 'cleanup-error'

  /**
   * Creates a sanitized ownership-cleanup failure after an onchain cancellation completed.
   * @param groupId - Confirmed canceled bootstrap group.
   * @param submittedTransactions - Confirmed cancellation transaction retained for reporting.
   * @param cleanupErrorName - Allowlisted classification of the ownership write failure.
   */
  constructor(
    readonly groupId: Hex,
    readonly submittedTransactions: readonly BootstrapSubmittedTransaction[],
    readonly cleanupErrorName: string
  ) {
    super('Bootstrap ownership cleanup failed after confirmed cancellation')
    this.name = 'BootstrapOwnershipCleanupError'
  }
}
