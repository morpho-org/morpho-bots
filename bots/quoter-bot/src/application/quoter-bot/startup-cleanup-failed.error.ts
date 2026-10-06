import type { StartupCleanupReport } from './startup-cleanup.utils'

/** Expected CLI failure after a writer startup failure whose owned-offer cleanup did not complete. */
export class StartupCleanupFailedError extends Error {
  readonly name = 'StartupCleanupFailedError'
  readonly code = 'STARTUP_CLEANUP_FAILED'
  readonly kind = 'cleanup-error'

  /**
   * Creates the failure from its operator-safe report.
   * @param report - Startup failure classification and each strategy's sanitized cleanup outcome.
   */
  constructor(readonly report: StartupCleanupReport) {
    super('Startup failed and owned offers may still be live')
  }
}
