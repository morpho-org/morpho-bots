import type { Hex } from 'viem'

import { MAX_OFFER_CAP } from '@morpho-org/midnight-sdk'
import { tryCatch } from '@repo/utils'

import type { BootstrapOffer } from '../../domain/bootstrap/position-bootstrap'
import type { BootstrapRawGroup } from './bootstrap-groups.utils'

import { BootstrapAdapterError } from './bootstrap-adapter.error'
type OwnedBootstrapOffer = BootstrapOffer & {
  groupId: Hex
  tick?: bigint
  continuousFeeCap?: bigint
}

type ReadUncanceledGroupIdsParameters = {
  groupIds: readonly Hex[]
  readGroupConsumed: (groupId: Hex) => Promise<bigint>
}

/**
 * Removes group IDs whose authoritative consumption equals the SDK cancellation cap.
 * @param parameters - Explicit group IDs and a deterministic on-chain consumption reader.
 * @returns IDs that have not been conclusively canceled with `MAX_OFFER_CAP`.
 * @throws `BootstrapAdapterError` when any required consumption read fails.
 * @remarks A max-consumed group cannot retain exposure, even when the eventually consistent API
 * has already omitted it. This prevents confirmed cancellation transactions from being repeated
 * after a process restart.
 */
export const readUncanceledGroupIds = async (
  parameters: ReadUncanceledGroupIdsParameters
): Promise<Hex[]> => {
  const consumedGroups = await Promise.all(
    parameters.groupIds.map(async groupId => {
      const { data: consumed, error } = await tryCatch(parameters.readGroupConsumed(groupId))
      if (error) throw new BootstrapAdapterError('group-consumption-read')

      return { groupId, consumed }
    })
  )

  return consumedGroups
    .filter(({ consumed }) => consumed !== MAX_OFFER_CAP)
    .map(({ groupId }) => groupId)
}

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
 * @param parameters - Indexed groups, explicit ownership IDs, persisted intents, and the Midnight consumption reader.
 * @returns Still-live pending intents with exact persisted ticks and both original and remaining capacity.
 * @throws `BootstrapAdapterError` when an API-missing, non-canceled owned group lacks persisted
 * capacity/intent, or when a required on-chain consumption read fails.
 * @remarks Reads only API-missing groups. Groups canceled at `MAX_OFFER_CAP` and fully consumed
 * persisted offers are omitted; partially consumed persisted offers retain their original rate and
 * ownership identity with only their remaining assets.
 */
export const readLivePendingBootstrapOffers = async (parameters: {
  groups: readonly BootstrapRawGroup[]
  ownedGroupIds: readonly Hex[]
  offers: readonly OwnedBootstrapOffer[]
  readGroupConsumed: (groupId: Hex) => Promise<bigint>
}) => {
  const indexedGroupIds = new Set(parameters.groups.map(group => group.id))
  const intendedGroupIds = new Set(parameters.offers.map(offer => offer.groupId))
  const missingIntentGroupIds = parameters.ownedGroupIds.filter(
    groupId => !indexedGroupIds.has(groupId) && !intendedGroupIds.has(groupId)
  )
  const uncanceledMissingIntentGroupIds = await readUncanceledGroupIds({
    groupIds: missingIntentGroupIds,
    readGroupConsumed: parameters.readGroupConsumed
  })
  if (uncanceledMissingIntentGroupIds.length > 0) {
    throw new BootstrapAdapterError('missing-owned-group-intent')
  }

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
