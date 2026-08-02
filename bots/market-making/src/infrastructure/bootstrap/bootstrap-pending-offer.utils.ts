import type { Hex } from 'viem'

import type { BootstrapOffer } from '../../domain/bootstrap/position-bootstrap'
import type { BootstrapRawGroup } from './bootstrap-groups.utils'
import type { BootstrapActiveGroup } from './bootstrap-position.service'

type OwnedBootstrapOffer = BootstrapOffer & { groupId: Hex }

/**
 * Projects persisted bootstrap publications that have not appeared in the Morpho API yet.
 * @param groups - Current maker groups returned by the eventually consistent API.
 * @param ownedOffers - Reserved or confirmed offer intents persisted before publication.
 * @returns Pending active groups with their original sizing, rate, and reference observation.
 * @remarks Indexed groups are omitted even when consumed; only API absence is treated as pending so monitor cycles cannot duplicate a confirmed publication.
 */
export const pendingBootstrapGroups = (
  groups: readonly BootstrapRawGroup[],
  ownedOffers: readonly OwnedBootstrapOffer[]
): BootstrapActiveGroup[] => {
  const indexedGroupIds = new Set(groups.map(group => group.id))
  return ownedOffers
    .filter(offer => !indexedGroupIds.has(offer.groupId))
    .map(offer => ({
      id: offer.groupId,
      marketId: offer.marketId,
      assets: offer.assets,
      rateBps: offer.rateBps,
      referenceObservationId: offer.referenceObservationId
    }))
}
