import type { LendHalt } from '../../domain/loss-factor'
import type { MarketReport } from '../engine/market-report'
import type { LadderConsumptionBaselines } from './ladder-monitoring.utils'
import type { MonitoringEvent } from './monitoring-event'

import { incrementalLossBps } from '../../domain/loss-factor'
import { bootstrapFactEvents } from './bootstrap-monitoring.utils'
import { ladderConsumptionEvents, ladderFactEvents } from './ladder-monitoring.utils'

/** Polls a continuing, unchanged lend halt stays silent between repeated `guardrail.lend-halted` records. */
export const LEND_HALTED_REPEAT_POLLS = 10

type WithheldReason = Extract<
  MonitoringEvent,
  { event: 'guardrail.publication-withheld' }
>['reason']

const WITHHELD_REASONS = new Set([
  'loss-factor-mismatch',
  'price-changed',
  'below-minimum-offer',
  'rate-out-of-range'
])

/**
 * The liveness record: the one field set the shipped monitoring contract guarantees.
 * @param report - The market's report for this cycle.
 * @returns The `cycle.completed` record; optional fields appear only when the report sets them.
 */
export const cycleCompleted = (report: MarketReport): MonitoringEvent => ({
  event: 'cycle.completed',
  workflow: report.workflow,
  marketId: report.marketId,
  status: report.status,
  ...(report.stage === undefined ? {} : { stage: report.stage }),
  ...(report.action === undefined ? {} : { action: report.action }),
  ...(report.reason === undefined ? {} : { reason: report.reason }),
  ...(report.errorName === undefined ? {} : { errorName: report.errorName }),
  ...(report.adapterOperation === undefined ? {} : { adapterOperation: report.adapterOperation }),
  ...(report.condition === undefined ? {} : { condition: report.condition })
})

const publicationWithheld = (report: MarketReport): readonly MonitoringEvent[] => {
  const reason =
    report.action === 'publication-withheld'
      ? report.reason !== undefined && WITHHELD_REASONS.has(report.reason)
        ? (report.reason as WithheldReason)
        : ('capacity-changed' as const)
      : report.status === 'failed' && report.adapterOperation === 'snapshot-unavailable'
        ? ('snapshot-unavailable' as const)
        : undefined
  return reason === undefined
    ? []
    : [
        {
          event: 'guardrail.publication-withheld',
          workflow: report.workflow,
          marketId: report.marketId,
          reason,
          ...(reason === 'below-minimum-offer' && report.minimumAssets !== undefined
            ? { minimumAssets: report.minimumAssets }
            : {})
        }
      ]
}

const classifiedEvents = (report: MarketReport): readonly MonitoringEvent[] => {
  const { workflow, marketId } = report
  return [
    ...(report.status === 'halted'
      ? [
          {
            event: 'guardrail.halted',
            workflow,
            marketId,
            stage: report.stage ?? 'unknown',
            reason: report.reason ?? report.errorName ?? 'unknown',
            strategyInvalidated: report.strategyInvalidated === true,
            ...(report.adapterOperation === undefined
              ? {}
              : { adapterOperation: report.adapterOperation })
          } satisfies MonitoringEvent
        ]
      : []),
    ...(workflow === 'bootstrap' && report.adapterOperation === 'negative-spread'
      ? [{ event: 'guardrail.spread-rejected', marketId } satisfies MonitoringEvent]
      : []),
    ...publicationWithheld(report),
    ...(workflow === 'ladder'
      ? (report.withdrawnSides ?? []).map(
          (side): MonitoringEvent => ({
            event: 'guardrail.side-withdrawn',
            workflow,
            marketId,
            side
          })
        )
      : []),
    ...(report.facts === undefined
      ? []
      : report.workflow === 'ladder'
        ? ladderFactEvents(marketId, report.facts)
        : bootstrapFactEvents(marketId, report.facts)),
    ...(report.transactions ?? []).map(
      (transaction): MonitoringEvent => ({
        event: 'transaction.settled',
        workflow,
        marketId,
        operation: transaction.operation,
        txHash: transaction.txHash
      })
    )
  ]
}

const lendHaltOf = (report: MarketReport): LendHalt | undefined =>
  report.lossFactor !== undefined &&
  report.acceptedLossFactor !== undefined &&
  report.defaulted !== undefined &&
  report.direction !== undefined
    ? (report as LendHalt)
    : undefined

/**
 * Projects each poll's market reports into flat monitoring records.
 * @returns A projection to call once per completed markets poll, with every report of that poll.
 * @remarks Holds two pieces of in-process state, so a restart re-establishes both: per-group fill
 * baselines for `offer.consumed` (see `ladderConsumptionEvents`), and current lend halts, which emit
 * `guardrail.lend-halted` when a halt starts or its values change and again every
 * {@link LEND_HALTED_REPEAT_POLLS} polls while it continues. A report carrying no halt ends its
 * market's halt; a market absent from a poll keeps it.
 */
export const createMarketProjection = () => {
  const baselines: LadderConsumptionBaselines = { groups: new Map(), poll: 0 }
  const halts = new Map<string, { values: string; polls: number }>()

  const lendHalted = (report: MarketReport): readonly MonitoringEvent[] => {
    const key = `${report.workflow}:${report.marketId}`
    const halt = lendHaltOf(report)
    if (!halt) {
      halts.delete(key)
      return []
    }
    const values = `${halt.lossFactor}:${halt.acceptedLossFactor}`
    const previous = halts.get(key)
    const repeated = previous?.values === values && previous.polls + 1 < LEND_HALTED_REPEAT_POLLS
    halts.set(key, { values, polls: repeated ? previous.polls + 1 : 0 })
    if (repeated) return []
    const lossBps = incrementalLossBps(halt)
    return [
      {
        event: 'guardrail.lend-halted',
        workflow: report.workflow,
        marketId: report.marketId,
        lossFactor: halt.lossFactor,
        acceptedLossFactor: halt.acceptedLossFactor,
        defaulted: halt.defaulted,
        direction: halt.direction,
        ...(lossBps === undefined ? {} : { incrementalLossBps: lossBps })
      }
    ]
  }

  return (reports: readonly MarketReport[]): readonly MonitoringEvent[] => [
    ...reports.flatMap(report => [
      cycleCompleted(report),
      ...classifiedEvents(report),
      ...lendHalted(report)
    ]),
    ...ladderConsumptionEvents(
      reports.flatMap(report =>
        report.workflow === 'ladder' ? (report.facts?.groupConsumption ?? []) : []
      ),
      baselines
    )
  ]
}
