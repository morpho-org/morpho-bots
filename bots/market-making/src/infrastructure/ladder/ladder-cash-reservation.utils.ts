import type { Hex } from 'viem'

import type { BootstrapRawGroup } from '../bootstrap/bootstrap-groups.utils'
import type { OwnedLadderPublication } from './ladder-group-ownership.utils'

import { LadderAdapterError } from './ladder-adapter.error'

type BootstrapOfferIntent = {
  groupId: Hex
  marketId: Hex
  assets: bigint
  tick?: bigint
  continuousFeeCap?: bigint
}

type LadderCashReservation = {
  id: Hex
  marketIds: readonly Hex[]
  assets: bigint
  offers: readonly { marketId: Hex; tick: bigint; continuousFeeCap: bigint }[]
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
        if (
          group.ticks === undefined ||
          group.ticks.length !== group.rungIndexes.length ||
          group.continuousFeeCap === undefined
        ) {
          throw new LadderAdapterError('group-ownership-state')
        }
        return {
          id: group.groupId,
          marketIds: [publication.marketId],
          assets,
          offers: group.ticks.map(tick => ({
            marketId: publication.marketId,
            tick,
            continuousFeeCap: group.continuousFeeCap as bigint
          }))
        }
      })
  )
}

/**
 * Combines indexed and persisted cross-strategy buy reservations for ladder sizing.
 * @param parameters - API groups, durable ownership, bootstrap intents, and replaced ladder IDs.
 * @returns One reservation per group, including groups still awaiting API indexing.
 * @remarks Current-market groups being replaced are excluded; all other owned buys remain reserved.
 */
export const ladderCashReservations = (parameters: {
  groups: readonly BootstrapRawGroup[]
  publications: readonly OwnedLadderPublication[]
  bootstrapGroupIds: readonly Hex[]
  bootstrapOffers: readonly BootstrapOfferIntent[]
  replacedGroupIds: ReadonlySet<Hex>
}): LadderCashReservation[] => {
  const ladderGroupIds = parameters.publications.flatMap(publication =>
    publication.groups.map(group => group.groupId)
  )
  const owned = new Set([...parameters.bootstrapGroupIds, ...ladderGroupIds])
  const indexedIds = new Set(parameters.groups.map(group => group.id))
  const reservations = new Map<Hex, LadderCashReservation>()

  for (const group of parameters.groups) {
    if (
      reservations.has(group.id) ||
      !owned.has(group.id) ||
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
        assets: group.maxAssets - group.consumed,
        offers: group.offers
          .filter(offer => offer.buy)
          .map(offer => ({
            marketId: offer.marketId,
            tick: offer.tick,
            continuousFeeCap: group.continuousFeeCap ?? 0n
          }))
      })
    }
  }

  for (const reservation of pendingLadderBuyReservations(
    parameters.groups,
    parameters.publications
  )) {
    if (!parameters.replacedGroupIds.has(reservation.id)) {
      reservations.set(reservation.id, reservation)
    }
  }
  for (const offer of parameters.bootstrapOffers) {
    if (!indexedIds.has(offer.groupId) && !reservations.has(offer.groupId)) {
      reservations.set(offer.groupId, {
        id: offer.groupId,
        marketIds: [offer.marketId],
        assets: offer.assets,
        offers:
          offer.tick === undefined
            ? []
            : [
                {
                  marketId: offer.marketId,
                  tick: offer.tick,
                  continuousFeeCap: offer.continuousFeeCap ?? 0n
                }
              ]
      })
    }
  }
  return [...reservations.values()]
}
