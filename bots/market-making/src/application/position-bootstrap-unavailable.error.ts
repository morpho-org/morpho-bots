/** Expected operator error raised when the CLI has no composed position-bootstrap adapter. */
export class PositionBootstrapUnavailableError extends Error {
  readonly code = 'POSITION_BOOTSTRAP_UNAVAILABLE' as const
  readonly kind = 'configuration' as const

  /** Creates a stable failure without exposing runtime configuration or dependency details. */
  constructor() {
    super('Position bootstrap is not configured')
    this.name = 'PositionBootstrapUnavailableError'
  }
}
