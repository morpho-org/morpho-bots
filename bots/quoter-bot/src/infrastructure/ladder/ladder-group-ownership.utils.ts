import type { Hex } from 'viem'

import type { LadderQuoteSet } from '../../domain/ladder'

/** Relationship between one protocol group, the quote-set rungs it caps, and its signed offers. */
export type LadderGroupReference = {
  groupId: Hex
  side: 'lower' | 'higher'
  rungIndexes: readonly number[]
  /** Exact tick of every offer the group was signed with, which a rung's `rateBps` cannot recover. */
  ticks: readonly bigint[]
}

/** The quote behind one ladder publication, kept while any of its groups may still be live. */
export type OwnedLadderPublication = {
  marketId: Hex
  status: 'reserved' | 'confirmed'
  quote: LadderQuoteSet
  groups: readonly LadderGroupReference[]
}
