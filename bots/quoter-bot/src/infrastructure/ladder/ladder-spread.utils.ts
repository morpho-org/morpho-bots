import type { Hex } from 'viem'

import type { OwnedOverlapBookOffer } from '../intentional-overlap.utils'

import { hasInvalidOwnedBootstrapLadderSpread } from '../intentional-overlap.utils'
import { LadderAdapterError } from './ladder-adapter.error'

/**
 * Rejects a prospective ladder that crosses itself or any opposing retained offer.
 * @param parameters - Selected market, replaced groups, complete market book, and prospective offers.
 * @returns Nothing after strict positive spread is proven.
 * @throws `LadderAdapterError` when prospective offers cross themselves or an opposing retained
 * offer outside the narrow durably owned bootstrap-buy / ladder-sell equality.
 * @remarks Existing crossings among retained third-party offers do not implicate the prospective
 * ladder and are ignored.
 */
export const assertLadderProspectiveSpread = (parameters: {
  marketId: Hex
  replacedGroupIds: ReadonlySet<Hex>
  book: readonly OwnedOverlapBookOffer[]
  prospective: readonly OwnedOverlapBookOffer[]
}) => {
  const retained = parameters.book.filter(
    offer =>
      offer.marketId === parameters.marketId &&
      (offer.groupId === undefined || !parameters.replacedGroupIds.has(offer.groupId))
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
