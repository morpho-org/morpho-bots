import type { BookOffer } from '@repo/offers'
import type { Hex } from 'viem'

import { batchProspectiveBook, hasNegativeSpread } from '@repo/offers'

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
  book: readonly BookOffer[]
  prospective: readonly BookOffer[]
}) => {
  if (hasNegativeSpread(batchProspectiveBook(parameters))) {
    throw new LadderAdapterError('negative-spread')
  }
}
