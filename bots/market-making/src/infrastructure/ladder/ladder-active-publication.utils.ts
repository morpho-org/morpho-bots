import type { Hex } from 'viem'

import type { LadderQuoteSet, LadderRung } from '../../domain/ladder/ladder'
import type { BootstrapRawGroup } from '../bootstrap/bootstrap-groups.utils'
import type { OwnedLadderPublication } from './ladder-group-ownership.utils'

const distinctIndexedGroups = (groups: readonly BootstrapRawGroup[]) =>
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
  groups: readonly BootstrapRawGroup[]
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
      if (indexed && indexed.maxAssets <= indexed.consumed) continue
      const assets = indexed
        ? indexed.maxAssets - indexed.consumed
        : rungs.reduce((sum, rung) => sum + rung.assets, 0n)
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
 * Selects retained centers only from ladder publications that still reconstruct as active.
 * @param publications - Durable ladder publication intents.
 * @param groups - Current maker groups returned by the eventually consistent API.
 * @param marketId - Strategy market whose retained centers are required.
 * @returns Center rates for active or not-yet-indexed publications in persistence order.
 */
export const activeLadderCenterRateBps = (
  publications: readonly OwnedLadderPublication[],
  groups: readonly BootstrapRawGroup[],
  marketId: Hex
) =>
  publications
    .filter(publication => publication.marketId === marketId)
    .flatMap(publication =>
      reconstructOwnedLadderPublication(publication, groups)
        ? [publication.quote.centerRateBps]
        : []
    )

/**
 * Selects owned ladder groups that remain live or have not appeared in the API yet.
 * @param publications - Durable reserved and confirmed ladder publication intents.
 * @param groups - Current maker groups returned by the Morpho API.
 * @param marketId - Optional strategy market restriction.
 * @returns Distinct group IDs requiring replacement or cancellation, including pending API indexing.
 * @remarks An API-indexed fully consumed group is excluded; an absent persisted group remains active to prevent unsafe republishing.
 */
export const activeOwnedLadderGroupIds = (
  publications: readonly OwnedLadderPublication[],
  groups: readonly BootstrapRawGroup[],
  marketId?: Hex
) => {
  const indexedGroups = distinctIndexedGroups(groups)
  return [
    ...new Set(
      publications
        .filter(publication => marketId === undefined || publication.marketId === marketId)
        .flatMap(publication => publication.groups.map(group => group.groupId))
        .filter(groupId => {
          const indexed = indexedGroups.get(groupId)
          return indexed === undefined || indexed.maxAssets > indexed.consumed
        })
    )
  ]
}

/**
 * Projects only ladder rungs whose persisted groups are still absent from the provider book.
 * @param publications - Durable reserved and confirmed ladder publication intents.
 * @param groups - Current maker groups returned by the eventually consistent API.
 * @returns Quote fragments that can be rebuilt into pending book offers for spread validation.
 */
export const pendingLadderQuoteSets = (
  publications: readonly OwnedLadderPublication[],
  groups: readonly BootstrapRawGroup[]
) => {
  const indexedGroupIds = new Set(groups.map(group => group.id))
  return publications.flatMap(publication => {
    const pendingIndexes = (side: 'lower' | 'higher') =>
      new Set(
        publication.groups
          .filter(group => group.side === side && !indexedGroupIds.has(group.groupId))
          .flatMap(group => group.rungIndexes)
      )
    const lowerIndexes = pendingIndexes('lower')
    const higherIndexes = pendingIndexes('higher')
    const lower = publication.quote.lower.filter(rung => lowerIndexes.has(rung.index))
    const higher = publication.quote.higher.filter(rung => higherIndexes.has(rung.index))
    return lower.length === 0 && higher.length === 0
      ? []
      : [{ ...publication.quote, lower, higher }]
  })
}
