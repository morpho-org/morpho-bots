import type { SetupCheckReport } from './setup-check.service'

/** Signals that the complete read-only setup report contains one or more failed checks. */
export class SetupFailedError extends Error {
  /**
   * Creates a stable readiness failure while retaining every sanitized check result.
   * @param report - Complete operator-safe report; it must not contain provider URLs or credentials.
   */
  constructor(readonly report: SetupCheckReport) {
    const failed = report.checks.filter(check => check.status === 'failed')
    super(`Setup check failed: ${failed.map(check => check.name).join(', ')}`)
    this.name = 'SetupFailedError'
  }
}
