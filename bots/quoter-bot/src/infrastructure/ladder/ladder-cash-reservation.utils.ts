import type { Hex } from 'viem'

import type { BootstrapRawGroup } from '../bootstrap/bootstrap-groups.utils'
import type { OwnedLadderPublication } from './ladder-group-ownership.utils'

type BootstrapOfferIntent = { groupId: Hex; marketId: Hex; assets: bigint }

type LadderCashReservation = {
  id: Hex
  marketIds: readonly Hex[]
  assets: bigint
}

/**
 * Projects persisted higher-side ladder groups that the offer-groups API has not indexed yet.
 * @param groups - Current eventually consistent maker groups.
 * @param publications - Durable reserved and confirmed ladder publication intents.
 * @returns Distinct API-missing buy reservations with their market and maximum assets.
 */
export const pendingLadderBuyReservations = (
  groups: readonly BootstrapRawGroup[],
  publications: readonly OwnedLadderPublication[]
): LadderCashReservation[] => {
  const indexed = new Set(groups.map(group => group.id))
  return publications.flatMap(publication =>
    publication.groups
      .filter(group => group.side === 'higher' && !indexed.has(group.groupId))
      .map(group => {
        const indexes = new Set(group.rungIndexes)
        const assets = publication.quote.higher
          .filter(rung => indexes.has(rung.index))
          .reduce((sum, rung) => sum + rung.assets, 0n)
        return { id: group.groupId, marketIds: [publication.marketId], assets }
      })
  )
}

/**
 * Combines indexed and persisted cross-strategy buy reservations for ladder sizing.
 * @param parameters - API groups, ladder publications, bootstrap intents, and replaced ladder IDs.
 * @returns One reservation per group, including groups still awaiting API indexing.
 * @remarks Every live maker buy group reserves, attributed to this strategy or not: the groups come
 * from the maker's own book, so each one commits maker cash whether or not durable ownership still
 * records it. Reserving only attributed groups would let a lost ownership store hide live
 * commitments and size fresh offers past the configured exposure caps. Ownership still gates
 * reconciliation, cancellation, and replacement; it must not gate exposure. Current-market groups
 * being replaced are excluded.
 */
export const ladderCashReservations = (parameters: {
  groups: readonly BootstrapRawGroup[]
  publications: readonly OwnedLadderPublication[]
  bootstrapOffers: readonly BootstrapOfferIntent[]
  replacedGroupIds: ReadonlySet<Hex>
  ignoredGroupIds?: ReadonlySet<Hex>
}): LadderCashReservation[] => {
  const indexedIds = new Set(parameters.groups.map(group => group.id))
  const reservations = new Map<Hex, LadderCashReservation>()

  for (const group of parameters.groups) {
    if (
      reservations.has(group.id) ||
      parameters.ignoredGroupIds?.has(group.id) ||
      parameters.replacedGroupIds.has(group.id)
    ) {
      continue
    }
    const marketIds = [
      ...new Set(group.offers.filter(offer => offer.buy).map(offer => offer.marketId))
    ]
    if (marketIds.length > 0) {
      reservations.set(group.id, {
        id: group.id,
        marketIds,
        assets: group.maxAssets - group.consumed
      })
    }
  }

  for (const reservation of pendingLadderBuyReservations(
    parameters.groups,
    parameters.publications
  )) {
    if (
      !parameters.ignoredGroupIds?.has(reservation.id) &&
      !parameters.replacedGroupIds.has(reservation.id)
    ) {
      reservations.set(reservation.id, reservation)
    }
  }
  for (const offer of parameters.bootstrapOffers) {
    if (
      !parameters.ignoredGroupIds?.has(offer.groupId) &&
      !indexedIds.has(offer.groupId) &&
      !reservations.has(offer.groupId)
    ) {
      reservations.set(offer.groupId, {
        id: offer.groupId,
        marketIds: [offer.marketId],
        assets: offer.assets
      })
    }
  }
  return [...reservations.values()]
}
