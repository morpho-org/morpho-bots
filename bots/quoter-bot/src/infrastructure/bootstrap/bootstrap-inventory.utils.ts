import type { Hex } from 'viem'

import type { BootstrapOffer } from '../../domain/position-bootstrap'
import type { ExposureSnapshot } from '../exposure/exposure-snapshot.utils'
import type { MakerOfferGroup } from '../provider/offer-groups.utils'
import type { BootstrapActiveGroup, BootstrapInventory } from './bootstrap-position.service'

import { spendableCash } from '../exposure/exposure-snapshot.utils'
import { bootstrapGroupRateBps, strategyBootstrapGroups } from './bootstrap-groups.utils'

type OwnedBootstrapOffer = BootstrapOffer & {
  groupId: Hex
  tick?: bigint
  continuousFeeCap?: bigint
}

/**
 * Projects one exposure snapshot into the bootstrap inventory that sizing reads.
 * @param parameters - Coherent snapshot, the indexed groups and durable ownership it was read with.
 * @returns Positions, {@link spendableCash}, owned bootstrap groups, and every other buy reservation, each
 * group's remaining assets taken from the snapshot block.
 */
export const bootstrapInventoryFromSnapshot = (parameters: {
  snapshot: ExposureSnapshot
  groups: readonly MakerOfferGroup[]
  ownedGroupIds: readonly Hex[]
  ownedOffers: readonly OwnedBootstrapOffer[]
}): BootstrapInventory => {
  const { snapshot } = parameters
  const remaining = new Map(snapshot.groups.map(group => [group.groupId, group.remainingAssets]))
  const intended = new Map(
    parameters.ownedOffers.map(offer => [`${offer.groupId}:${offer.marketId}`, offer] as const)
  )
  const indexedIds = new Set(parameters.groups.map(group => group.id))
  const indexed = strategyBootstrapGroups(parameters.groups, parameters.ownedGroupIds).flatMap(
    (group): BootstrapActiveGroup[] => {
      const assets = remaining.get(group.id) ?? 0n
      if (assets === 0n) return []
      const groupMarketId = group.marketId as Hex
      const persisted = intended.get(`${group.id}:${groupMarketId}`)
      return [
        {
          id: group.id,
          marketId: groupMarketId,
          assets,
          tick: group.tick as bigint,
          maximumAssets: group.cap.maximum,
          offerCount: group.offers.length,
          continuousFeeCap: group.continuousFeeCap,
          rateBps:
            persisted?.rateBps ??
            bootstrapGroupRateBps({
              tick: group.tick as bigint,
              maturity: group.maturity as bigint,
              observedTimestamp: snapshot.timestamp
            }),
          ...(persisted ? { referenceObservationId: persisted.referenceObservationId } : {})
        }
      ]
    }
  )
  const pending = parameters.ownedOffers
    .filter(offer => !indexedIds.has(offer.groupId))
    .flatMap(({ groupId, ...offer }): BootstrapActiveGroup[] => {
      const assets = remaining.get(groupId) ?? 0n
      return assets === 0n
        ? []
        : [{ id: groupId, ...offer, maximumAssets: offer.assets, assets, offerCount: 1 }]
    })
  return {
    positions: snapshot.positions,
    cashBalance: spendableCash(snapshot),
    groupInventory: {
      activeGroups: [...indexed, ...pending],
      cashReservations: snapshot.groups
        .filter(group => group.remainingAssets > 0n)
        .flatMap(group =>
          group.marketIds.map(marketId => ({
            id: group.groupId,
            marketId,
            assets: group.remainingAssets,
            rateBps: 0n
          }))
        )
    }
  }
}
