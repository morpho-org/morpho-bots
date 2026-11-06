import type { Hex } from 'viem'

import { MAX_OFFER_CAP } from '@morpho-org/midnight-sdk'

import type { BootstrapOffer } from '../../domain/position-bootstrap'
import type { MakerOfferGroup } from '../provider/offer-groups.utils'

import { BootstrapAdapterError } from '../../errors'
type OwnedBootstrapOffer = BootstrapOffer & {
  groupId: Hex
  tick?: bigint
  continuousFeeCap?: bigint
}

/**
 * Selects persisted bootstrap intents whose groups are still absent from the provider book.
 * @param groups - Current maker groups returned by the eventually consistent API.
 * @param ownedOffers - Reserved or confirmed offer intents persisted before publication.
 * @returns Original pending intents for exact protocol-offer reconstruction.
 */
export const pendingBootstrapOffers = (
  groups: readonly MakerOfferGroup[],
  ownedOffers: readonly OwnedBootstrapOffer[]
) => {
  const indexedGroupIds = new Set(groups.map(group => group.id))
  return ownedOffers.filter(offer => !indexedGroupIds.has(offer.groupId))
}

/**
 * Resolves API-missing bootstrap offer intents against authoritative consumption read at one block.
 * @param parameters - Indexed groups, explicit ownership IDs, persisted intents, and every group's
 * consumption.
 * @returns Still-live pending intents with exact persisted ticks and both original and remaining
 * capacity.
 * @throws `BootstrapAdapterError` `missing-owned-group-intent` when an API-missing, non-canceled
 * owned group lacks persisted intent, and `group-consumption-read` for a group whose consumption
 * was not read.
 * @remarks Groups canceled at `MAX_OFFER_CAP` and fully consumed persisted offers are omitted;
 * partially consumed persisted offers retain their original rate and ownership identity with only
 * their remaining assets.
 */
export const livePendingBootstrapOffers = (parameters: {
  groups: readonly MakerOfferGroup[]
  ownedGroupIds: readonly Hex[]
  offers: readonly OwnedBootstrapOffer[]
  consumed: Readonly<Record<string, bigint>>
}) => {
  const consumedOf = (groupId: Hex) => {
    if (!Object.hasOwn(parameters.consumed, groupId))
      throw new BootstrapAdapterError('group-consumption-read')
    return parameters.consumed[groupId]!
  }
  const indexedGroupIds = new Set(parameters.groups.map(group => group.id))
  const intendedGroupIds = new Set(parameters.offers.map(offer => offer.groupId))
  if (
    parameters.ownedGroupIds.some(
      groupId =>
        !indexedGroupIds.has(groupId) &&
        !intendedGroupIds.has(groupId) &&
        consumedOf(groupId) !== MAX_OFFER_CAP
    )
  )
    throw new BootstrapAdapterError('missing-owned-group-intent')
  return pendingBootstrapOffers(parameters.groups, parameters.offers).flatMap(offer => {
    const consumed = consumedOf(offer.groupId)
    return consumed >= offer.assets
      ? []
      : [{ ...offer, maximumAssets: offer.assets, assets: offer.assets - consumed }]
  })
}
