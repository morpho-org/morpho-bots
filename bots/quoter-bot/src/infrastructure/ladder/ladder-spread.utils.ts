import type { Address, Hex } from 'viem'

import { isAddressEqual } from 'viem'

import type { OwnedOverlapBookOffer } from '../intentional-overlap.utils'

import { hasInvalidOwnedBootstrapLadderSpread } from '../intentional-overlap.utils'
import { LadderAdapterError } from './ladder-adapter.error'

/**
 * Rejects a prospective ladder that crosses itself or an opposing retained offer the maker owns.
 * @param parameters - Selected market, the configured maker, replaced groups, complete market book,
 * and prospective offers.
 * @returns Nothing after strict positive spread against the own book is proven.
 * @throws `LadderAdapterError` when prospective offers cross themselves or an opposing own retained
 * offer outside the narrow durably owned bootstrap-buy / ladder-sell equality.
 * @remarks Crossing an own offer is a self-trade and fails closed; an offer whose `maker` is
 * unknown counts as own so a wiring gap fails closed rather than open. Crossing a third party is a
 * pricing concern the clearance handles best-effort, never a reason to reject a publication.
 */
export const assertLadderProspectiveSpread = (parameters: {
  marketId: Hex
  maker: Address
  replacedGroupIds: ReadonlySet<Hex>
  book: readonly OwnedOverlapBookOffer[]
  prospective: readonly OwnedOverlapBookOffer[]
}) => {
  const retained = parameters.book.filter(
    offer =>
      offer.marketId === parameters.marketId &&
      (offer.groupId === undefined || !parameters.replacedGroupIds.has(offer.groupId)) &&
      (offer.maker === undefined || isAddressEqual(offer.maker, parameters.maker))
  )
  const prospective = parameters.prospective.filter(offer => offer.marketId === parameters.marketId)
  if (hasInvalidOwnedBootstrapLadderSpread(prospective)) {
    throw new LadderAdapterError('negative-spread')
  }
  for (const offer of prospective) {
    const opposingRetainedOffers = retained.filter(retainedOffer => retainedOffer.buy !== offer.buy)
    if (hasInvalidOwnedBootstrapLadderSpread([...opposingRetainedOffers, offer])) {
      throw new LadderAdapterError('negative-spread')
    }
  }
}
