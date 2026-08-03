import type { Hex } from 'viem'

/** One sanitized ladder cleanup failure. */
type LadderHardHaltFailure = { groupId: Hex; errorName: string }

/** Aggregate failure raised after every owned ladder group has been attempted. */
export class LadderHardHaltError extends Error {
  readonly code = 'LADDER_HARD_HALT_FAILED'
  readonly kind = 'cleanup-error'

  /** Creates the aggregate. @param failures - Ordered group IDs and sanitized error names. */
  constructor(readonly failures: readonly LadderHardHaltFailure[]) {
    super('Ladder hard-halt cleanup failed')
    this.name = 'LadderHardHaltError'
  }
}
