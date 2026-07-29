/** Signals that the ladder CLI was invoked before its runtime adapters were composed. */
export class LadderRuntimeUnavailableError extends Error {
  readonly code = 'LADDER_RUNTIME_UNAVAILABLE' as const
  readonly kind = 'configuration' as const

  /** Creates a stable operator-safe ladder composition failure. */
  constructor() {
    super('Ladder runtime adapters are not configured')
    this.name = 'LadderRuntimeUnavailableError'
  }
}
