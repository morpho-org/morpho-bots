import type { SetupCheckReport } from '../setup/setup-check.service'
import type { MonitoringEvent } from './monitoring-event'

/**
 * Projects one setup readiness report into flat monitoring records.
 * @param report - Complete readiness report from one setup check.
 * @returns One record per failed or warning check, and a terminating cycle record carrying overall
 * readiness.
 * @remarks A graded check contributes only its stable `check` name and `status`: `observed` and
 * `required` are typed `unknown` and routinely hold objects, which would violate the flat-scalar
 * rule the event contract relies on for grouping. `SetupCheck` carries no error classification, so
 * no `errorName` is emitted. The `status` is load-bearing beyond grouping — the shipping logger
 * derives its level from it, so a `failed` check is what raises the record naming the halt cause
 * above `info`. Readiness itself is not a separate record: `cycle.completed` already carries it as
 * `status`, and emitting both would restate the same fact every minute.
 */
export const setupMonitoringEvents = (report: SetupCheckReport): readonly MonitoringEvent[] => [
  ...report.checks.flatMap((check): MonitoringEvent[] =>
    check.status === 'failed' || check.status === 'warning'
      ? [{ event: 'setup.check-failed', check: check.name, status: check.status }]
      : []
  ),
  {
    event: 'cycle.completed',
    workflow: 'setup-check',
    status: report.ready ? 'ready' : 'failed'
  }
]
