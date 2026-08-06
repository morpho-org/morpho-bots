/** Expected setup-monitor interval validation failure with no rejected value attached. */
export class SetupMonitorConfigurationError extends Error {
  readonly name = 'SetupMonitorConfigurationError'
  readonly code = 'INVALID_SETUP_MONITOR_CONFIGURATION'
  readonly kind = 'configuration'

  /** Creates a sanitized setup-monitor configuration error. */
  constructor() {
    super('Setup monitor interval must be a positive safe integer')
  }
}
