import type { Hex } from 'viem'

import type { LadderQuoteSet, LadderRung, LadderSideDiagnostics } from '../../domain/ladder/ladder'
import type { LadderRunResult } from '../ladder/ladder-quoter.service'
import type { LadderGroupConsumption, LadderVerboseDetails } from '../ladder/ladder-verbose'
import type { MonitoringEvent, MonitoringSide } from './monitoring-event'

import { CROSS_BOOK_CLEARANCE_BPS } from '../../domain/cross-book'

const SIDES: readonly MonitoringSide[] = ['lower', 'higher']

const defined = <Key extends string>(key: Key, value: bigint | undefined) =>
  value === undefined ? {} : ({ [key]: value } as Record<Key, bigint>)

const sideBook = (marketId: Hex, side: MonitoringSide, quote: LadderQuoteSet): MonitoringEvent => {
  const rungs: readonly LadderRung[] = quote[side]
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
          bestRateBps: rates.reduce((best, rate) => (rate > best ? rate : best)),
          worstRateBps: rates.reduce((worst, rate) => (rate < worst ? rate : worst))
        }),
    centerRateBps: quote.centerRateBps
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
          clearedRungs: diagnostics.clearedRungs,
          clearanceBps: CROSS_BOOK_CLEARANCE_BPS
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
  verbose: LadderVerboseDetails
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
    const market = verbose.currentState.market
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
    const activeQuote = verbose.currentState.activeQuote
    if (activeQuote) events.push(...SIDES.map(side => sideBook(marketId, side, activeQuote)))
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
      marketId,
      operation: transaction.operation,
      status: 'confirmed',
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
 * `position.observed` reports both the saturating capacities and the balance primitives they were
 * derived from, because the capacities alone cannot be inverted into a position value. Fill records are not produced here — see `ladderConsumptionEvents`, which needs
 * the previous cycle's consumption to compute a delta.
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
    if (result.verbose) events.push(...verboseEvents(marketId, result.verbose))
    return events
  })

/**
 * Diffs monotonic per-group consumption against the previous cycle to derive taker fills.
 * @param results - Sanitized per-market outcomes carrying verbose group consumption.
 * @param previous - Consumption observed for each group ID at the end of the previous cycle;
 * mutated in place so the next call diffs against this cycle.
 * @returns One `offer.consumed` record per group whose consumption grew.
 * @remarks Correct where a quote-set diff is not: reconciliation reserves fresh group IDs and
 * invalidates the old ones on every recenter and resize, so the active set churns for reasons
 * unrelated to takers, while a group's `consumed` only ever grows. Two limits are inherent. A group
 * first seen this cycle establishes a baseline and emits nothing, so a restart loses one cycle of
 * fills. And under `per-book` every rung on a side shares one group, so `groupRateBps` is the
 * group's best rate rather than the rate that actually executed.
 *
 * Baselines are never dropped for an absent group: the indexer is eventually consistent, so a group
 * missing from one cycle would otherwise re-baseline on return and silently swallow the fill that
 * happened in between. Callers own the map's lifetime and should not share one across markets that
 * can reuse a group ID.
 */
export const ladderConsumptionEvents = (
  results: readonly LadderRunResult[],
  previous: Map<Hex, bigint>
): readonly MonitoringEvent[] => {
  const events: MonitoringEvent[] = []
  const seen = new Set<Hex>()
  const consumption: readonly LadderGroupConsumption[] = results.flatMap(
    result => result.verbose?.groupConsumption ?? []
  )
  for (const group of consumption) {
    if (seen.has(group.groupId)) continue
    seen.add(group.groupId)
    const before = previous.get(group.groupId)
    previous.set(group.groupId, group.consumed)
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
  return events
}
