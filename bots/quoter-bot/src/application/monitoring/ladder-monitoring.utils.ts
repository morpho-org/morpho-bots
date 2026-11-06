import type { Hex } from 'viem'

import { MAX_OFFER_CAP } from '@morpho-org/midnight-sdk'

import type { LadderQuoteSet, LadderRung, LadderSideDiagnostics } from '../../domain/ladder'
import type { LadderFacts } from '../engine/market-report'
import type { LadderGroupConsumption } from '../ladder/ladder-verbose'
import type { MonitoringEvent, MonitoringSide } from './monitoring-event'

const SIDES: readonly MonitoringSide[] = ['lower', 'higher']

const defined = <Key extends string>(key: Key, value: bigint | undefined) =>
  value === undefined ? {} : ({ [key]: value } as Record<Key, bigint>)

// Emitted for both sides whenever the market was read, including when no quote is active at all:
// an absent record is indistinguishable from an unshipped one, so "not quoting" needs a positive
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
    totalUnits: rungs.reduce((sum, rung) => sum + rung.assets, 0n),
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

const rateOmitted = (
  marketId: Hex,
  side: MonitoringSide,
  facts: LadderFacts,
  omission: { bound: 'minimum' | 'maximum'; rungs: number; assets: bigint; rateBps?: bigint }
): readonly MonitoringEvent[] =>
  omission.rungs > 0 && omission.rateBps !== undefined
    ? [
        {
          event: 'guardrail.rate-omitted',
          workflow: 'ladder',
          marketId,
          side,
          omittedRungs: omission.rungs,
          omittedAssets: omission.assets,
          bound: omission.bound,
          outermostRateBps: omission.rateBps,
          ...defined('referenceRateBps', facts.referenceRateBps),
          minimumRateBps: facts.bounds.minimumRateBps,
          maximumRateBps: facts.bounds.maximumRateBps
        }
      ]
    : []

const sideGuardrails = (
  marketId: Hex,
  side: MonitoringSide,
  diagnostics: LadderSideDiagnostics,
  facts: LadderFacts
): readonly MonitoringEvent[] => [
  ...rateOmitted(marketId, side, facts, {
    bound: 'minimum',
    rungs: diagnostics.omittedBelowMinimumRungs,
    assets: diagnostics.omittedBelowMinimumAssets,
    ...(diagnostics.lowestOmittedRateBps === undefined
      ? {}
      : { rateBps: diagnostics.lowestOmittedRateBps })
  }),
  ...rateOmitted(marketId, side, facts, {
    bound: 'maximum',
    rungs: diagnostics.omittedAboveMaximumRungs,
    assets: diagnostics.omittedAboveMaximumAssets,
    ...(diagnostics.highestOmittedRateBps === undefined
      ? {}
      : { rateBps: diagnostics.highestOmittedRateBps })
  }),
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

/**
 * Projects what one ladder market observed and derived into its reference, position, book, and
 * guardrail records.
 * @remarks The position record reports both the saturating capacities and the balance primitives
 * they were derived from, because the capacities alone cannot be inverted into a position value.
 * Fill records need the previous poll's consumption; see {@link ladderConsumptionEvents}.
 * @param marketId - The ladder market the facts describe.
 * @param facts - What the market's decision observed and derived.
 * @returns The records in emission order; a fact that is absent emits nothing.
 */
export const ladderFactEvents = (marketId: Hex, facts: LadderFacts): readonly MonitoringEvent[] => {
  const events: MonitoringEvent[] = []
  if (facts.referenceRateBps !== undefined)
    events.push({
      event: 'reference.observed',
      workflow: 'ladder',
      marketId,
      referenceRateBps: facts.referenceRateBps,
      ...defined('targetRateBps', facts.targetRateBps)
    })
  const market = facts.market
  if (market) {
    events.push({
      event: 'position.observed',
      marketId,
      ...defined('cashBalanceAssets', market.cashBalanceAssets),
      ...defined('creditAssets', market.creditAssets),
      ...defined('debtAssets', market.debtAssets),
      ...defined('debtCeilingAssets', market.debtCeilingAssets),
      ...defined('otherMarketCreditAssets', market.otherMarketCreditAssets),
      ...defined('reservedAssets', market.reservedAssets),
      ...defined('marketReservedAssets', market.marketReservedAssets),
      ...defined('maturityTimestamp', market.maturityTimestamp),
      ...defined('lowerRateCapacityAssets', market.lowerRateCapacityAssets),
      ...defined('higherRateCapacityAssets', market.higherRateCapacityAssets),
      ...defined('targetMarketCapacityAssets', market.targetMarketCapacityAssets),
      ...defined('maximumTotalCapacityAssets', market.maximumTotalCapacityAssets)
    })
    events.push(...SIDES.map(side => sideBook(marketId, side, facts.activeQuote)))
  }
  const diagnostics = facts.diagnostics
  if (diagnostics?.inventorySkew)
    events.push({
      event: 'inventory-skew.observed',
      workflow: 'ladder',
      marketId,
      ...diagnostics.inventorySkew
    })
  if (diagnostics)
    for (const side of SIDES)
      events.push(...sideGuardrails(marketId, side, diagnostics[side], facts))
  for (const side of SIDES) {
    const crossing = facts.bookCrossing?.[side]
    if (crossing?.crossed)
      events.push({
        event: 'guardrail.book-crossed',
        workflow: 'ladder',
        marketId,
        side,
        clearable: crossing.clearable,
        suppressed: crossing.suppressed
      })
  }
  return events
}

/**
 * Polls a baseline is retained for after a group was last seen in the indexed set.
 * @remarks Sized far beyond the group API's consistency window so a transiently absent group is
 * never re-baselined, while still bounding memory: reconciliation reserves fresh group IDs on every
 * recenter and resize, so without eviction the set of observed IDs grows for the process lifetime.
 */
const RETAINED_BASELINE_POLLS = 500

/** Per-group fill baselines carried across polls; in-process only, so a restart loses one poll of fills. */
export type LadderConsumptionBaselines = {
  groups: Map<Hex, { consumed: bigint; lastSeenPoll: number }>
  poll: number
}

/**
 * Diffs monotonic per-group consumption against the previous poll to derive taker fills.
 * @param consumption - Every ladder market's group consumption in one poll.
 * @param baselines - Consumption last observed per group; advanced in place for the next call.
 * @returns One `offer.consumed` record per group whose consumption grew.
 * @remarks Correct where a quote-set diff is not: reconciliation reserves fresh group IDs on every
 * recenter and resize, while a group's `consumed` only ever grows. A group first seen establishes a
 * baseline and emits nothing, and under `per-book` `groupRateBps` is the group's best rate rather
 * than the executed one. A baseline is never lowered and survives a poll in which its group is
 * absent, since the indexer is eventually consistent; it is evicted after
 * `RETAINED_BASELINE_POLLS` polls unseen.
 */
export const ladderConsumptionEvents = (
  consumption: readonly LadderGroupConsumption[],
  baselines: LadderConsumptionBaselines
): readonly MonitoringEvent[] => {
  const events: MonitoringEvent[] = []
  const seen = new Set<Hex>()
  baselines.poll += 1
  for (const group of consumption) {
    if (seen.has(group.groupId) || group.consumed === MAX_OFFER_CAP) continue
    seen.add(group.groupId)
    const before = baselines.groups.get(group.groupId)?.consumed
    baselines.groups.set(group.groupId, {
      consumed: before === undefined || group.consumed > before ? group.consumed : before,
      lastSeenPoll: baselines.poll
    })
    if (before === undefined || group.consumed <= before) continue
    events.push({
      event: 'offer.consumed',
      marketId: group.marketId,
      side: group.side,
      consumedDeltaUnits: group.consumed - before,
      groupRateBps: group.groupRateBps,
      remainingUnits: group.remainingUnits,
      groupId: group.groupId
    })
  }
  for (const [groupId, baseline] of baselines.groups)
    if (baselines.poll - baseline.lastSeenPoll > RETAINED_BASELINE_POLLS)
      baselines.groups.delete(groupId)
  return events
}
