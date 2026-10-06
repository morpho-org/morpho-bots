import type { Hex } from 'viem'

import type { LadderGroupConsumption } from '../../application/ladder/ladder-verbose'
import type { LadderQuoteSet, LadderRung } from '../../domain/ladder'
import type { MakerOfferGroup } from '../provider/offer-groups.utils'
import type { OwnedLadderPublication } from './ladder-group-ownership.utils'

import { isGroupClosed, remainingCap } from '../../domain/offer-cap'

const distinctIndexedGroups = (groups: readonly MakerOfferGroup[]) =>
  new Map(groups.map(group => [group.id, group]))

const scaleRungs = (rungs: readonly LadderRung[], assets: bigint): LadderRung[] => {
  const total = rungs.reduce((sum, rung) => sum + rung.assets, 0n)
  if (total === 0n || assets === 0n) return []
  const scaled = rungs.map(rung => ({ ...rung, assets: (assets * rung.assets) / total }))
  const allocated = scaled.reduce((sum, rung) => sum + rung.assets, 0n)
  const last = scaled.at(-1)
  if (last) last.assets += assets - allocated
  return scaled.filter(rung => rung.assets > 0n)
}

/**
 * Reconstructs a durable ladder publication while treating API-missing groups as pending.
 * @param publication - Reserved or receipt-confirmed publication intent persisted before broadcast.
 * @param groups - Current maker groups returned by the eventually consistent Morpho API.
 * @returns Remaining indexed rungs plus original pending rungs, or no quote once every group is indexed as consumed.
 * @remarks An absent owned group retains its intended capacity so monitor reconciliation cannot publish a duplicate before indexing catches up.
 */
export const reconstructOwnedLadderPublication = (
  publication: OwnedLadderPublication,
  groups: readonly MakerOfferGroup[]
): LadderQuoteSet | undefined => {
  const indexedGroups = distinctIndexedGroups(groups)
  const side = (name: 'lower' | 'higher') => {
    const original = publication.quote[name]
    const byIndex = new Map(original.map(rung => [rung.index, rung]))
    const reconstructed: LadderRung[] = []
    for (const reference of publication.groups.filter(group => group.side === name)) {
      const rungs = reference.rungIndexes.flatMap(index => {
        const rung = byIndex.get(index)
        return rung ? [rung] : []
      })
      const indexed = indexedGroups.get(reference.groupId)
      const assets = indexed
        ? remainingCap(indexed.cap, indexed.consumed)
        : rungs.reduce((sum, rung) => sum + rung.assets, 0n)
      if (indexed && assets === 0n) continue
      reconstructed.push(...scaleRungs(rungs, assets))
    }
    return reconstructed.toSorted((left, right) => left.index - right.index)
  }
  const lower = side('lower')
  const higher = side('higher')
  if (lower.length === 0 && higher.length === 0) return undefined
  return { ...publication.quote, lower, higher }
}

/**
 * Joins indexed group consumption to the side and rate each group was published at.
 * @param publications - Durable reserved and confirmed ladder publication intents.
 * @param groups - Current maker groups returned by the eventually consistent Morpho API.
 * @param marketId - Optional strategy market restriction.
 * @returns One record per owned group the API has indexed, deduplicated by group ID.
 * @remarks `consumed` is monotonic per group — the strategy's own cancel and republish reserve fresh
 * group IDs rather than decrementing an existing one — so differences between cycles are taker
 * fills. Groups absent from the API are omitted rather than reported as unconsumed. `groupRateBps`
 * is the configured rate of the group's rung nearest the center: under `per-book` it is only the
 * best of several rates sharing the group, and publication aligns a rate to the market tick spacing,
 * so neither mode reports the executed price. Rung indexes restart per side, so rates are resolved
 * within the group's own side.
 */
export const ownedLadderGroupConsumption = (
  publications: readonly OwnedLadderPublication[],
  groups: readonly MakerOfferGroup[],
  marketId?: Hex
): readonly LadderGroupConsumption[] => {
  const indexedGroups = distinctIndexedGroups(groups)
  const consumption = new Map<Hex, LadderGroupConsumption>()
  for (const publication of publications) {
    if (marketId !== undefined && publication.marketId !== marketId) continue
    const rateByIndex = {
      lower: new Map(publication.quote.lower.map(rung => [rung.index, rung.rateBps])),
      higher: new Map(publication.quote.higher.map(rung => [rung.index, rung.rateBps]))
    }
    for (const reference of publication.groups) {
      const indexed = indexedGroups.get(reference.groupId)
      if (!indexed || indexed.cap.kind !== 'units' || consumption.has(reference.groupId)) continue
      const nearestIndex = reference.rungIndexes.reduce<number | undefined>(
        (lowest, index) => (lowest === undefined || index < lowest ? index : lowest),
        undefined
      )
      const groupRateBps =
        nearestIndex === undefined ? undefined : rateByIndex[reference.side].get(nearestIndex)
      if (groupRateBps === undefined) continue
      consumption.set(reference.groupId, {
        groupId: reference.groupId,
        marketId: publication.marketId,
        side: reference.side,
        groupRateBps,
        maxUnits: indexed.cap.maximum,
        consumed: indexed.consumed,
        remainingUnits: remainingCap(indexed.cap, indexed.consumed)
      })
    }
  }
  return [...consumption.values()]
}

/**
 * Selects owned ladder groups that remain live or have not appeared in the API yet.
 * @param publications - Durable reserved and confirmed ladder publication intents.
 * @param groups - Current maker groups returned by the Morpho API.
 * @param marketId - Optional strategy market restriction.
 * @returns Distinct group IDs requiring replacement or cancellation, including pending API indexing.
 * @remarks An API-indexed closed group (see {@link isGroupClosed}) is excluded; an absent persisted group remains active to prevent unsafe republishing.
 */
export const activeOwnedLadderGroupIds = (
  publications: readonly OwnedLadderPublication[],
  groups: readonly MakerOfferGroup[],
  marketId?: Hex
) => {
  const indexedGroups = distinctIndexedGroups(groups)
  return [
    ...new Set(
      publications
        .filter(publication => marketId === undefined || publication.marketId === marketId)
        .flatMap(publication => publication.groups)
        .filter(group => {
          const indexed = indexedGroups.get(group.groupId)
          return (
            indexed === undefined ||
            !isGroupClosed({ cap: indexed.cap, buy: group.side === 'higher' }, indexed.consumed)
          )
        })
        .map(group => group.groupId)
    )
  ]
}

/**
 * Splits owned ladder groups that remain active by the rate side each was published on.
 * @param publications - Durable reserved and confirmed ladder publication intents.
 * @param marketId - Strategy market whose publications are split.
 * @param activeGroupIds - Group IDs {@link activeOwnedLadderGroupIds} still reports as active.
 * @returns The active group IDs of that market per rate side.
 */
export const activeOwnedLadderGroupIdsBySide = (
  publications: readonly OwnedLadderPublication[],
  marketId: Hex,
  activeGroupIds: ReadonlySet<Hex>
) => {
  const groups = publications
    .filter(publication => publication.marketId === marketId)
    .flatMap(publication => publication.groups)
    .filter(group => activeGroupIds.has(group.groupId))
  const side = (name: 'lower' | 'higher') =>
    new Set(groups.filter(group => group.side === name).map(group => group.groupId))
  return { lower: side('lower'), higher: side('higher') }
}

/**
 * Replays every offer of an active owned ladder group at the exact tick it was signed with.
 * @param publications - Durable reserved and confirmed ladder publication intents.
 * @param groups - Current maker groups returned by the eventually consistent API.
 * @param marketId - Market whose book is being validated.
 * @returns One book offer per persisted tick of every group {@link activeOwnedLadderGroupIds}
 * reports in `marketId`, so spread validation sees an offer the API has not indexed, or has
 * indexed only partly.
 */
export const ownedLadderBookOffers = (
  publications: readonly OwnedLadderPublication[],
  groups: readonly MakerOfferGroup[],
  marketId: Hex
) => {
  const activeGroupIds = new Set(activeOwnedLadderGroupIds(publications, groups, marketId))
  return publications
    .filter(publication => publication.marketId === marketId)
    .flatMap(publication =>
      publication.groups
        .filter(group => activeGroupIds.has(group.groupId))
        .flatMap(group =>
          group.ticks.map(tick => ({
            groupId: group.groupId,
            marketId,
            buy: group.side === 'higher',
            tick
          }))
        )
    )
}
