import type { MonitoringEvent, MonitoringWorkflow } from './monitoring-event'

import { setupMonitoringEvents } from './setup-monitoring.utils'

type Outcome = { status: 'fulfilled'; report: unknown } | { status: 'rejected'; errorName: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown) => (typeof value === 'string' ? value : undefined)

const isSetupReport = (value: unknown) =>
  isRecord(value) && typeof value.ready === 'boolean' && Array.isArray(value.checks)

const workflowFailure = (workflow: MonitoringWorkflow, outcome: unknown): MonitoringEvent[] => {
  if (!isRecord(outcome)) return []
  const settled = outcome as Outcome
  if (settled.status === 'rejected') {
    return [
      { event: 'bot.failed', workflow, reason: 'workflow-error', errorName: settled.errorName }
    ]
  }
  const report = settled.report
  if (!isRecord(report) || report.status !== 'halted') return []
  const errorName = text(report.cycleErrorName)
  return [
    {
      event: 'bot.failed',
      workflow,
      reason: text(report.reason) ?? 'halted',
      ...(errorName === undefined ? {} : { errorName })
    }
  ]
}

/**
 * Projects a terminal failure report into flat records explaining why the process is stopping.
 * @param report - Sanitized report carried by a reported error, or `undefined` for an unclassified
 * failure.
 * @param errorName - Allowlisted classification of the failure itself.
 * @returns A `bot.failed` record, plus per-workflow records and failed readiness checks when the
 * report identifies them.
 * @remarks This is the only signal for the two failures no cycle record can describe: a readiness
 * check that fails during startup, before any monitor loop begins, and a fail-together lifecycle
 * where one of the three supervised workflows ends and stops its peers. Without it the shipped
 * stream shows a start and a stop with nothing between them. The reports are read structurally
 * because each reported error carries a different shape; anything unrecognized still yields the
 * top-level record.
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

  const workflows = report.workflows
  if (isRecord(workflows)) {
    return [
      { event: 'bot.failed', reason: text(report.reason) ?? 'halted', errorName },
      ...workflowFailure('setup-check', workflows.setupCheck),
      ...workflowFailure('bootstrap', workflows.bootstrap),
      ...workflowFailure('ladder', workflows.ladder)
    ]
  }
  const cycleErrorName = text(report.cycleErrorName)
  return [
    {
      event: 'bot.failed',
      reason: text(report.reason) ?? 'halted',
      errorName: cycleErrorName ?? errorName
    }
  ]
}
