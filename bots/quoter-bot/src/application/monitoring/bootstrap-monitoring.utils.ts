import { zeroFloorSub } from '@repo/utils'

import type { BootstrapRunResult } from '../bootstrap/position-bootstrap.service'
import type { MonitoringEvent } from './monitoring-event'

const cycleCompleted = (result: BootstrapRunResult): MonitoringEvent => ({
  event: 'cycle.completed',
  workflow: 'bootstrap',
  marketId: result.marketId,
  status: result.status,
  ...('stage' in result ? { stage: result.stage } : {}),
  ...('action' in result ? { action: result.action } : {}),
  ...('reason' in result ? { reason: result.reason } : {}),
  ...('errorName' in result ? { errorName: result.errorName } : {}),
  ...(result.verbose?.durationMs === undefined ? {} : { durationMs: result.verbose.durationMs })
})

const haltReason = (result: Extract<BootstrapRunResult, { status: 'halted' }>) => {
  if ('reason' in result) return result.reason
  if ('errorName' in result) return result.errorName
  return 'unknown'
}

const verboseEvents = (result: BootstrapRunResult): readonly MonitoringEvent[] => {
  const verbose = result.verbose
  if (!verbose) return []

  const events: MonitoringEvent[] = []
  const marketId = result.marketId

  if (verbose.referenceRate) {
    events.push({
      event: 'reference.observed',
      workflow: 'bootstrap',
      marketId,
      referenceRateBps: verbose.referenceRate.rateBps,
      ...(verbose.targetRateBps === undefined ? {} : { targetRateBps: verbose.targetRateBps })
    })
  }

  if (verbose.currentState.status === 'observed') {
    const position = verbose.effectiveState ?? verbose.currentState.position
    events.push({
      event: 'bootstrap.progress',
      marketId,
      creditAssets: position.credit,
      creditTargetAssets: verbose.config.creditTarget,
      shortfallAssets: zeroFloorSub(verbose.config.creditTarget, position.credit),
      mode: verbose.referenceRate?.mode ?? 'static'
    })
  }

  const diagnostics = verbose.diagnostics
  if (diagnostics?.clampedBound !== undefined) {
    events.push({
      event: 'guardrail.rate-clamped',
      workflow: 'bootstrap',
      marketId,
      clampedRungs: 1,
      bound: diagnostics.clampedBound,
      minimumRateBps: verbose.config.minimumRateBps,
      maximumRateBps: verbose.config.maximumRateBps
    })
  }

  if (diagnostics && diagnostics.cappedAssets < diagnostics.requestedAssets) {
    events.push({
      event: 'guardrail.exposure-capped',
      workflow: 'bootstrap',
      marketId,
      requestedAssets: diagnostics.requestedAssets,
      cappedAssets: diagnostics.cappedAssets,
      cap: diagnostics.cap
    })
  }

  for (const transaction of verbose.submittedTransactions ?? []) {
    events.push({
      event: 'transaction.settled',
      workflow: 'bootstrap',
      marketId,
      operation: transaction.operation,
      status: 'confirmed',
      txHash: transaction.txHash
    })
  }

  return events
}

/**
 * Projects one bootstrap cycle's sanitized results into flat monitoring records.
 * @param results - Ordered per-market outcomes returned by one bootstrap cycle.
 * @returns Monitoring events in stable per-result order: cycle completion, guardrail signals, then
 * verbose reference, progress, clamp, cap, and settled-transaction records.
 * @remarks Pure projection: it never re-classifies errors, and passes each arm's already-sanitized
 * `errorName` through unchanged. `guardrail.spread-rejected` keys on the allowlisted
 * `adapterOperation` rather than the collapsed `errorName`, so it fires only on an actual cross-book
 * rejection and not on every adapter failure. Guardrail, reference, and progress records require
 * verbose results; a non-verbose cycle yields only completion and halt records.
 */
export const bootstrapMonitoringEvents = (
  results: readonly BootstrapRunResult[]
): readonly MonitoringEvent[] =>
  results.flatMap(result => [
    cycleCompleted(result),
    ...(result.status === 'halted'
      ? ([
          {
            event: 'guardrail.halted',
            workflow: 'bootstrap',
            marketId: result.marketId,
            stage: result.stage,
            reason: haltReason(result),
            strategyInvalidated: result.strategyInvalidated
          }
        ] as const)
      : []),
    ...('adapterOperation' in result && result.adapterOperation === 'negative-spread'
      ? ([
          {
            event: 'guardrail.spread-rejected',
            marketId: result.marketId,
            errorName: result.errorName
          }
        ] as const)
      : []),
    ...verboseEvents(result)
  ])
