import type { Hex } from 'viem'

/** Sanitized cancellation failure produced after a complete hard-halt cleanup attempt. */
type BootstrapHardHaltFailure = { groupId: Hex; errorName: string }

/** Deterministic aggregate failure after every strategy-owned group cancellation was attempted. */
export class BootstrapHardHaltError extends Error {
  readonly code = 'BOOTSTRAP_HARD_HALT_FAILED'
  readonly kind = 'cleanup-error'

  /** Creates a sanitized aggregate. @param failures - Ordered group IDs and allowlisted error names. */
  constructor(readonly failures: readonly BootstrapHardHaltFailure[]) {
    super('Position bootstrap hard-halt cleanup failed')
    this.name = 'BootstrapHardHaltError'
  }
}
