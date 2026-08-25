import type { BootstrapRunResult } from '../bootstrap/position-bootstrap.service'
import type { LadderRunResult } from '../ladder/ladder-quoter.service'
import type { QuoterBotEvent } from '../quoter-bot/quoter-bot.service'
import type { SetupCheckReport } from '../setup/setup-check.service'
import type { MonitoringEvent } from './monitoring-event'

import { bootstrapMonitoringEvents } from './bootstrap-monitoring.utils'
import {
  createLadderConsumptionBaselines,
  ladderConsumptionEvents,
  ladderMonitoringEvents
} from './ladder-monitoring.utils'
import { setupMonitoringEvents } from './setup-monitoring.utils'

/**
 * Creates the stateful projection from cycle outputs to flat monitoring records.
 * @returns Per-workflow projections plus a combined-lifecycle dispatcher.
 * @remarks Holds one in-process map of per-group ladder consumption so fills can be derived as a
 * cycle-over-cycle delta. Nothing is persisted: a restart re-establishes the baseline, so the first
 * cycle after one reports no fills. The workflow is always known statically at the call site, so no
 * record shape is ever sniffed. Callers own ordering — each projection is pure apart from the
 * consumption baseline it advances.
 */
export const createMonitoringProjection = () => {
  const consumption = createLadderConsumptionBaselines()

  /**
   * The monitor ports type their cycle observers structurally, so the concrete result types are
   * recovered here rather than forcing a cast at each composition-root call site.
   */
  const ladder = (results: readonly { status: string }[]) => {
    const cycle = results as readonly LadderRunResult[]
    return [...ladderMonitoringEvents(cycle), ...ladderConsumptionEvents(cycle, consumption)]
  }
  const bootstrap = (results: readonly { status: string }[]) =>
    bootstrapMonitoringEvents(results as readonly BootstrapRunResult[])

  return {
    /**
     * Projects one readiness report.
     * @param report - Sanitized readiness report from a completed setup cycle.
     * @returns Readiness, failed-check, and cycle records.
     */
    setup: (report: SetupCheckReport): readonly MonitoringEvent[] => setupMonitoringEvents(report),
    /**
     * Projects one bootstrap cycle.
     * @param results - Sanitized per-market outcomes from one bootstrap cycle.
     * @returns Cycle, guardrail, reference, progress, and settled-transaction records.
     */
    bootstrap: (results: readonly { status: string }[]): readonly MonitoringEvent[] =>
      bootstrap(results),
    /**
     * Projects one ladder cycle and advances the fill baseline.
     * @param results - Sanitized per-market outcomes from one ladder cycle.
     * @returns Cycle, guardrail, reference, position, book, fill, and transaction records.
     */
    ladder: (results: readonly { status: string }[]): readonly MonitoringEvent[] => ladder(results),
    /**
     * Projects one tagged event from the combined setup, bootstrap, and ladder lifecycle.
     * @param event - Tagged workflow event emitted by the combined monitor.
     * @returns Records for a completed cycle, or none for an already-named transaction event.
     * @remarks Transaction-submitted events already carry their own `event` name and ship unchanged.
     */
    combined: (event: QuoterBotEvent): readonly MonitoringEvent[] => {
      if (event.event !== 'quoter-bot.cycle') return []
      if (event.workflow === 'setup-check') return setupMonitoringEvents(event.report)
      if (event.workflow === 'bootstrap') return bootstrap(event.results)
      return ladder(event.results)
    }
  }
}

/** Stateful projection from cycle outputs to flat monitoring records. */
export type MonitoringProjection = ReturnType<typeof createMonitoringProjection>
