import type { Hex } from 'viem'

import type { OwnedOverlapBookOffer } from '../intentional-overlap.utils'

import { hasInvalidOwnedBootstrapLadderSpread } from '../intentional-overlap.utils'
import { LadderAdapterError } from './ladder-adapter.error'

/**
 * Rejects a prospective ladder that crosses itself or any retained maker offer.
 * @param parameters - Selected market, replaced groups, full maker book, and prospective offers.
 * @returns Nothing after strict positive spread is proven.
 * @throws `LadderAdapterError` when the resulting selected-market book is crossed.
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
  if (hasInvalidOwnedBootstrapLadderSpread([...retained, ...prospective])) {
    throw new LadderAdapterError('negative-spread')
  }
}
