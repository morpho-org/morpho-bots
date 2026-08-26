import type { Hex } from 'viem'

import type { LadderQuoteSet, LadderRung, LadderSideDiagnostics } from '../../domain/ladder/ladder'
import type { LadderRunResult } from '../ladder/ladder-quoter.service'
import type { LadderGroupConsumption, LadderVerboseDetails } from '../ladder/ladder-verbose'
import type { MonitoringEvent, MonitoringSide } from './monitoring-event'

const SIDES: readonly MonitoringSide[] = ['lower', 'higher']

const defined = <Key extends string>(key: Key, value: bigint | undefined) =>
  value === undefined ? {} : ({ [key]: value } as Record<Key, bigint>)

// Emitted for both sides on every observed cycle, including when no quote is active at all: an
// absent record is indistinguishable from an unshipped one, so "not quoting" needs a positive
// `state: 'empty'` signal rather than silence.
const sideBook = (marketId: Hex, side: MonitoringSide, quote?: LadderQuoteSet): MonitoringEvent => {
  const rungs: readonly LadderRung[] = quote?.[side] ?? []
  const rates = rungs.map(rung => rung.rateBps)
  return {
    event: 'book.observed',
    marketId,
    side,
    state: rungs.length === 0 ? 'empty' : 'quoting',
    rungs: rungs.length,
    totalAssets: rungs.reduce((sum, rung) => sum + rung.assets, 0n),
    ...(rates.length === 0
      ? {}
      : {
          // The rung nearest the center is the competitive one, and the sides run in opposite
          // directions from it: lower rungs sit below the center, higher rungs above.
          bestRateBps: rates.reduce((best, rate) =>
            side === 'lower' ? (rate > best ? rate : best) : rate < best ? rate : best
          ),
          worstRateBps: rates.reduce((worst, rate) =>
            side === 'lower' ? (rate < worst ? rate : worst) : rate > worst ? rate : worst
          )
        }),
    ...(quote === undefined ? {} : { centerRateBps: quote.centerRateBps })
  }
}

const sideGuardrails = (
  marketId: Hex,
  side: MonitoringSide,
  diagnostics: LadderSideDiagnostics,
  config: LadderVerboseDetails['config']
): readonly MonitoringEvent[] => [
  ...(diagnostics.clampedToMinimumRungs > 0
    ? [
        {
          event: 'guardrail.rate-clamped',
          workflow: 'ladder',
          marketId,
          side,
          clampedRungs: diagnostics.clampedToMinimumRungs,
          bound: 'minimum',
          minimumRateBps: config.minimumRateBps,
          maximumRateBps: config.maximumRateBps
        } satisfies MonitoringEvent
      ]
    : []),
  ...(diagnostics.clampedToMaximumRungs > 0
    ? [
        {
          event: 'guardrail.rate-clamped',
          workflow: 'ladder',
          marketId,
          side,
          clampedRungs: diagnostics.clampedToMaximumRungs,
          bound: 'maximum',
          minimumRateBps: config.minimumRateBps,
          maximumRateBps: config.maximumRateBps
        } satisfies MonitoringEvent
      ]
    : []),
  ...(diagnostics.clearedRungs > 0
    ? [
        {
          event: 'guardrail.cross-book-cleared',
          workflow: 'ladder',
          marketId,
          side,
          clearedRungs: diagnostics.clearedRungs
        } satisfies MonitoringEvent
      ]
    : []),
  ...(diagnostics.fundedRungs < diagnostics.configuredRungs
    ? [
        {
          event: 'guardrail.rungs-truncated',
          marketId,
          side,
          configuredRungs: diagnostics.configuredRungs,
          fundedRungs: diagnostics.fundedRungs
        } satisfies MonitoringEvent
      ]
    : [])
]

const verboseEvents = (
  marketId: Hex,
  verbose: LadderVerboseDetails,
  status: LadderRunResult['status']
): readonly MonitoringEvent[] => {
  const events: MonitoringEvent[] = []
  if (verbose.referenceRateBps !== undefined) {
    events.push({
      event: 'reference.observed',
      workflow: 'ladder',
      marketId,
      referenceRateBps: verbose.referenceRateBps,
      ...(verbose.targetRateBps === undefined ? {} : { targetRateBps: verbose.targetRateBps })
    })
  }
  if (verbose.currentState.status === 'observed') {
    const observedAfter =
      verbose.stateAfterCheck.status === 'observed' ? verbose.stateAfterCheck : verbose.currentState
    const market = observedAfter.market
    events.push({
      event: 'position.observed',
      marketId,
      ...defined('cashBalanceAssets', market.cashBalanceAssets),
      ...defined('creditAssets', market.creditAssets),
      ...defined('otherMarketCreditAssets', market.otherMarketCreditAssets),
      ...defined('reservedAssets', market.reservedAssets),
      ...defined('marketReservedAssets', market.marketReservedAssets),
      ...defined('maturityTimestamp', market.maturityTimestamp),
      ...defined('lowerRateCapacityAssets', market.lowerRateCapacityAssets),
      ...defined('higherRateCapacityAssets', market.higherRateCapacityAssets),
      ...defined('targetMarketCapacityAssets', market.targetMarketCapacityAssets),
      ...defined('maximumTotalCapacityAssets', market.maximumTotalCapacityAssets)
    })
    const activeQuote = observedAfter.activeQuote
    events.push(...SIDES.map(side => sideBook(marketId, side, activeQuote)))
  }
  if (verbose.diagnostics) {
    for (const side of SIDES) {
      events.push(...sideGuardrails(marketId, side, verbose.diagnostics[side], verbose.config))
    }
  }
  for (const transaction of verbose.submittedTransactions ?? []) {
    events.push({
      event: 'transaction.settled',
      workflow: 'ladder',
      ...(status === 'halted' ? {} : { marketId }),
      operation: transaction.operation,
      txHash: transaction.txHash
    })
  }
  return events
}

/**
 * Projects one ladder cycle's results into flat, aggregatable monitoring records.
 * @param results - Sanitized per-market outcomes from one ladder cycle.
 * @returns One `cycle.completed` per market plus every guardrail, reference, position, book, and
 * settled-transaction record derivable from the attached verbose diagnostics.
 * @remarks A pure projection: it reads nothing and performs no provider calls. Everything beyond
 * `cycle.completed` and `guardrail.halted` requires `--verbose`, which shipping auto-enables.
 * `position.observed` and `book.observed` describe the post-check snapshot when that read succeeded
 * and fall back to the pre-decision read otherwise. The position record reports both the saturating
 * capacities and the balance primitives they were derived from, because the capacities alone cannot
 * be inverted into a position value. Fill records are not produced here — see
 * `ladderConsumptionEvents`, which needs the previous cycle's consumption to compute a delta.
 */
export const ladderMonitoringEvents = (
  results: readonly LadderRunResult[]
): readonly MonitoringEvent[] =>
  results.flatMap(result => {
    const marketId = result.marketId
    const events: MonitoringEvent[] = [
      {
        event: 'cycle.completed',
        workflow: 'ladder',
        marketId,
        status: result.status,
        ...('stage' in result ? { stage: result.stage } : {}),
        ...('action' in result ? { action: result.action } : {}),
        ...('reason' in result ? { reason: result.reason } : {}),
        ...('errorName' in result ? { errorName: result.errorName } : {}),
        ...(result.verbose?.durationMs === undefined
          ? {}
          : { durationMs: result.verbose.durationMs })
      }
    ]
    if (result.status === 'halted') {
      events.push({
        event: 'guardrail.halted',
        workflow: 'ladder',
        marketId,
        stage: result.stage,
        reason: result.errorName,
        strategyInvalidated: result.strategyInvalidated
      })
    }
    if (result.verbose) events.push(...verboseEvents(marketId, result.verbose, result.status))
    return events
  })

/**
 * Cycles a baseline is retained for after a group was last seen in the indexed set.
 * @remarks Sized far beyond the group API's consistency window so a transiently absent group is
 * never re-baselined, while still bounding memory: reconciliation reserves fresh group IDs on every
 * recenter and resize, so without eviction the set of observed IDs grows for the process lifetime.
 */
const RETAINED_BASELINE_CYCLES = 500

/** Per-group fill baselines carried across ladder cycles. */
type LadderConsumptionBaselines = {
  groups: Map<Hex, { consumedAssets: bigint; lastSeenCycle: number }>
  cycle: number
}

/**
 * Creates empty fill baselines for one process.
 * @returns Baselines holding no groups, positioned before the first cycle.
 * @remarks In-process only: nothing is persisted, so a restart re-establishes every baseline and the
 * first cycle after one reports no fills.
 */
export const createLadderConsumptionBaselines = (): LadderConsumptionBaselines => ({
  groups: new Map(),
  cycle: 0
})

/**
 * Diffs monotonic per-group consumption against the previous cycle to derive taker fills.
 * @param results - Sanitized per-market outcomes carrying verbose group consumption.
 * @param baselines - Consumption last observed per group; advanced in place for the next call.
 * @returns One `offer.consumed` record per group whose consumption grew.
 * @remarks Correct where a quote-set diff is not: reconciliation reserves fresh group IDs and
 * invalidates the old ones on every recenter and resize, so the active set churns for reasons
 * unrelated to takers, while a group's `consumed` only ever grows. Two limits are inherent. A group
 * first seen establishes a baseline and emits nothing, so a restart loses one cycle of fills. And
 * under `per-book` every rung on a side shares one group, so `groupRateBps` is the group's best rate
 * rather than the rate that actually executed.
 *
 * A baseline is never lowered and is not dropped merely because a group is absent for a cycle: the
 * indexer is eventually consistent, so either would silently swallow a fill. Baselines are instead
 * evicted after {@link RETAINED_BASELINE_CYCLES} cycles without a sighting, which bounds memory
 * without reaching the consistency window.
 */
export const ladderConsumptionEvents = (
  results: readonly LadderRunResult[],
  baselines: LadderConsumptionBaselines
): readonly MonitoringEvent[] => {
  const events: MonitoringEvent[] = []
  const seen = new Set<Hex>()
  baselines.cycle += 1
  const consumption: readonly LadderGroupConsumption[] = results.flatMap(
    result => result.verbose?.groupConsumption ?? []
  )
  for (const group of consumption) {
    if (seen.has(group.groupId)) continue
    seen.add(group.groupId)
    const previous = baselines.groups.get(group.groupId)
    const before = previous?.consumedAssets
    // Only ever advance. The group API is eventually consistent and can return an older `consumed`
    // after a newer one; lowering the baseline would re-emit the already-counted portion when the
    // next fresh value arrives.
    baselines.groups.set(group.groupId, {
      consumedAssets: before === undefined || group.consumed > before ? group.consumed : before,
      lastSeenCycle: baselines.cycle
    })
    if (before === undefined || group.consumed <= before) continue
    events.push({
      event: 'offer.consumed',
      marketId: group.marketId,
      side: group.side,
      consumedDeltaAssets: group.consumed - before,
      groupRateBps: group.groupRateBps,
      remainingAssets: group.remainingAssets,
      groupId: group.groupId
    })
  }
  for (const [groupId, baseline] of baselines.groups) {
    if (baselines.cycle - baseline.lastSeenCycle > RETAINED_BASELINE_CYCLES) {
      baselines.groups.delete(groupId)
    }
  }
  return events
}
