import type { MonitoringEvent } from './monitoring-event'

import { setupMonitoringEvents } from './setup-monitoring.utils'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown) => (typeof value === 'string' ? value : undefined)

const isSetupReport = (value: unknown) =>
  isRecord(value) && typeof value.ready === 'boolean' && Array.isArray(value.checks)

/** Reasons whose report names its own cause: a failed decision graph, or a kernel that could not clean up. */
const SELF_CLASSIFIED = new Set(['graph-error', 'cleanup-failed'])

/**
 * Projects a terminal failure report into flat records explaining why the process is stopping.
 * @param report - Sanitized report carried by a reported error, or `undefined` for an unclassified
 * failure.
 * @param errorName - Allowlisted classification of the failure itself.
 * @returns A `bot.failed` record, plus failed readiness checks when the report is a setup report.
 * @remarks This is the only signal for the two failures no cycle record can describe: a readiness
 * check that fails during startup, before any market may act, and a halt, which stops the whole
 * bot. Without it the shipped stream shows a start and a stop with nothing between them. Reports
 * are read structurally because each reported error carries a different shape.
 */
export const terminalMonitoringEvents = (
  report: unknown,
  errorName: string
): readonly MonitoringEvent[] => {
  if (isSetupReport(report)) {
    return [
      { event: 'bot.failed', workflow: 'setup-check', reason: 'setup-failed', errorName },
      ...setupMonitoringEvents(report as Parameters<typeof setupMonitoringEvents>[0])
    ]
  }
  if (!isRecord(report)) return [{ event: 'bot.failed', reason: 'unclassified', errorName }]
  const reason = text(report.reason) ?? 'halted'
  return [
    {
      event: 'bot.failed',
      reason,
      errorName:
        text(report.cycleErrorName) ??
        (SELF_CLASSIFIED.has(reason) ? text(report.errorName) : undefined) ??
        errorName
    }
  ]
}
