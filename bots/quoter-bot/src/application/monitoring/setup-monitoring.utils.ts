import type { SetupCheckReport } from '../setup/setup-check.service'
import type { MonitoringEvent } from './monitoring-event'

/**
 * Projects one setup readiness report into flat monitoring records.
 * @param report - Complete readiness report from one setup check.
 * @returns A readiness record, one record per failed check, and a terminating cycle record.
 * @remarks A failed check contributes only its stable `check` name: `observed` and `required` are
 * typed `unknown` and routinely hold objects, which would violate the flat-scalar rule the event
 * contract relies on for grouping. `SetupCheck` carries no error classification, so no `errorName`
 * is emitted.
 */
export const setupMonitoringEvents = (report: SetupCheckReport): readonly MonitoringEvent[] => [
  { event: 'setup.ready', ready: report.ready },
  ...report.checks
    .filter(check => check.status === 'failed')
    .map((check): MonitoringEvent => ({ event: 'setup.check-failed', check: check.name })),
  {
    event: 'cycle.completed',
    workflow: 'setup-check',
    status: report.ready ? 'ready' : 'failed'
  }
]
