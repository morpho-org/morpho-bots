import type { Hex } from 'viem'

import type { BootstrapFacts } from '../engine/market-report'
import type { MonitoringEvent } from './monitoring-event'

/**
 * Projects what one bootstrap market observed and derived into its reference, progress, and
 * guardrail records.
 * @param marketId - The bootstrap market the facts describe.
 * @param facts - What the market's decision observed and derived.
 * @returns The records in emission order; a fact that is absent emits nothing.
 */
export const bootstrapFactEvents = (
  marketId: Hex,
  facts: BootstrapFacts
): readonly MonitoringEvent[] => {
  const events: MonitoringEvent[] = []
  if (facts.referenceRateBps !== undefined)
    events.push({
      event: 'reference.observed',
      workflow: 'bootstrap',
      marketId,
      referenceRateBps: facts.referenceRateBps,
      ...(facts.targetRateBps === undefined ? {} : { targetRateBps: facts.targetRateBps })
    })
  if (facts.creditAssets !== undefined)
    events.push({
      event: 'bootstrap.progress',
      marketId,
      creditAssets: facts.creditAssets,
      creditTargetAssets: facts.creditTargetAssets
    })
  const diagnostics = facts.diagnostics
  if (!diagnostics) return events
  if (diagnostics.outOfRangeBound !== undefined)
    events.push({
      event: 'guardrail.rate-omitted',
      workflow: 'bootstrap',
      marketId,
      omittedRungs: 1,
      omittedAssets: diagnostics.cappedAssets,
      bound: diagnostics.outOfRangeBound,
      outermostRateBps: diagnostics.requestedRateBps,
      ...(facts.referenceRateBps === undefined ? {} : { referenceRateBps: facts.referenceRateBps }),
      minimumRateBps: facts.bounds.minimumRateBps,
      maximumRateBps: facts.bounds.maximumRateBps
    })
  if (diagnostics.rateWindowEmpty === true)
    events.push({
      event: 'guardrail.side-withdrawn',
      workflow: 'bootstrap',
      marketId,
      side: 'higher'
    })
  if (diagnostics.cappedAssets < diagnostics.requestedAssets)
    events.push({
      event: 'guardrail.exposure-capped',
      workflow: 'bootstrap',
      marketId,
      requestedAssets: diagnostics.requestedAssets,
      cappedAssets: diagnostics.cappedAssets,
      cap: diagnostics.cap
    })
  return events
}
