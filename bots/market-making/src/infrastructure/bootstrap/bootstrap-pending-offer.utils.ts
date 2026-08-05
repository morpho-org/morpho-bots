import type { Hex } from 'viem'

import type { BootstrapOffer } from '../../domain/bootstrap/position-bootstrap'
import type { BootstrapRawGroup } from './bootstrap-groups.utils'
type OwnedBootstrapOffer = BootstrapOffer & { groupId: Hex; tick?: bigint }

/**
 * Selects persisted bootstrap intents whose groups are still absent from the provider book.
 * @param groups - Current maker groups returned by the eventually consistent API.
 * @param ownedOffers - Reserved or confirmed offer intents persisted before publication.
 * @returns Original pending intents for exact protocol-offer reconstruction.
 */
export const pendingBootstrapOffers = (
  groups: readonly BootstrapRawGroup[],
  ownedOffers: readonly OwnedBootstrapOffer[]
) => {
  const indexedGroupIds = new Set(groups.map(group => group.id))
  return ownedOffers.filter(offer => !indexedGroupIds.has(offer.groupId))
}

/**
 * Resolves API-missing bootstrap offer intents against authoritative on-chain consumption.
 * @param parameters - Indexed groups, persisted intents, and the Midnight consumption reader.
 * @returns Still-live pending intents with exact persisted ticks and both original and remaining capacity.
 * @throws When on-chain consumption cannot be read for an API-missing persisted group.
 * @remarks Reads only API-missing groups. Fully consumed groups are omitted; partially consumed
 * groups retain their original rate and ownership identity with only their remaining assets.
 */
export const readLivePendingBootstrapOffers = async (parameters: {
  groups: readonly BootstrapRawGroup[]
  offers: readonly OwnedBootstrapOffer[]
  readGroupConsumed: (groupId: Hex) => Promise<bigint>
}) => {
  const pendingOffers = pendingBootstrapOffers(parameters.groups, parameters.offers)
  const resolvedOffers = await Promise.all(
    pendingOffers.map(async offer => {
      const consumed = await parameters.readGroupConsumed(offer.groupId)
      if (consumed >= offer.assets) return undefined

      return { ...offer, maximumAssets: offer.assets, assets: offer.assets - consumed }
    })
  )

  return resolvedOffers.flatMap(offer => (offer ? [offer] : []))
}
