import type { MarketReport } from './application/engine/market-report'
import type { SetupReading } from './application/engine/readings'
import type { MonitoringEvent } from './application/monitoring/monitoring-event'
import type { QuoterReport } from './infrastructure/engine/quoter-polls'

import { marketKey } from './application/engine/readings'
import {
  createMarketProjection,
  cycleCompleted
} from './application/monitoring/market-monitoring.utils'
import { setupMonitoringEvents } from './application/monitoring/setup-monitoring.utils'

const failing = (report: MarketReport) => report.status === 'failed' || report.status === 'halted'

/** What a run's reporter knows once the run ends. */
export type QuoterReports = Readonly<{
  /**
   * Each market's final report: its last act's outcome if it acted, unless a failed or halted
   * decision came after it; otherwise its last decision.
   */
  final: () => readonly MarketReport[]
  /** Each counted market's last counted report, while any of them is failed or halted. */
  lastFailed: () => readonly MarketReport[] | undefined
  /** Whether the last setup monitoring report was ready, once one arrived. */
  setupReady: () => boolean | undefined
  /** The error a setup monitoring cycle threw, once one did. */
  cycleErrorName: () => string | undefined
  /** How many records failed to be written. */
  writeFailures: () => number
}>

/** The fields of a failed record an operator may see: its name, and the market it was about. */
const writeFailureFields = (event: MonitoringEvent) => {
  const record = event as Readonly<Record<string, unknown>>
  return {
    event: event.event,
    ...(typeof record.workflow === 'string' ? { workflow: record.workflow } : {}),
    ...(typeof record.marketId === 'string' ? { marketId: record.marketId } : {})
  }
}

/** The record an operator sees when a monitoring record could not be written. */
export type WriteFailure = ReturnType<typeof writeFailureFields>

/**
 * Turns the graph's reports into monitoring records, written synchronously as they come: a failed
 * write is counted and handed to `onWriteError` with the record's name and market, never its
 * payload, and never holds or fails the graph. An act's outcome is recorded as it ends, so a run
 * that stops on it still reports it.
 * @param parameters - The run's market keys, the record writer, and the write-failure observer.
 * @returns `reports`, which summarizes the run so far, and the graph's report and setup observers.
 */
export const createQuoterReporter = (parameters: {
  keys: readonly string[]
  emit?: (event: MonitoringEvent) => void
  onWriteError?: (error: unknown, failed: WriteFailure) => void
}) => {
  const decided = new Map<string, MarketReport>()
  const acted = new Map<string, MarketReport>()
  const project = createMarketProjection()
  let writeFailures = 0
  const counted = new Map<string, MarketReport>()
  let setupReady: boolean | undefined
  let cycleErrorName: string | undefined

  const emit = (events: readonly MonitoringEvent[]) => {
    for (const event of events) {
      try {
        parameters.emit?.(event)
      } catch (error) {
        writeFailures += 1
        try {
          parameters.onWriteError?.(error, writeFailureFields(event))
        } catch {
          // A failing error hook must not fail the graph's report.
        }
      }
    }
  }

  /** Telemetry may be lost to a projection failure, but the liveness record never is. */
  const eventsOf = (reports: readonly MarketReport[]) => {
    try {
      return project(reports)
    } catch {
      return reports.map(cycleCompleted)
    }
  }

  const reports: QuoterReports = {
    final: () =>
      parameters.keys.flatMap(key => {
        const report = acted.get(key) ?? decided.get(key)
        return report ? [report] : []
      }),
    lastFailed: () => {
      const latest = parameters.keys.flatMap(key => {
        const report = counted.get(key)
        return report ? [report] : []
      })
      return latest.some(failing) ? latest : undefined
    },
    setupReady: () => setupReady,
    cycleErrorName: () => cycleErrorName,
    writeFailures: () => writeFailures
  }

  return {
    reports,
    /** Records a graph report and writes its monitoring records. */
    onReport: (report: QuoterReport) => {
      if (report.type === 'outcome') {
        acted.set(report.key, report.report)
        return emit(eventsOf([report.report]))
      }
      if (report.type === 'decided') {
        parameters.keys.forEach((key, i) => {
          const value = report.decided[i]
          if (!value) return
          decided.set(key, value)
          if (failing(value)) acted.delete(key)
        })
        return
      }
      for (const value of report.counted)
        counted.set(marketKey(value.workflow, value.marketId), value)
      emit(eventsOf(report.decided))
    },
    /** Records setup readiness and writes the setup monitoring records. */
    onSetup: (reading: SetupReading) => {
      setupReady = reading.report.ready
      cycleErrorName = reading.cycleErrorName ?? cycleErrorName
      emit(setupMonitoringEvents(reading.report))
    }
  }
}
