import type { Tree } from '@morpho-org/midnight-sdk'
import type { Address, Hex } from 'viem'

import type { ValidLadderConfig } from '../../domain/ladder'
import type {
  LadderAdapters,
  LadderPreparation
} from '../../infrastructure/ladder/production-ladder'
import type { PreparationReading } from './world'

import { borrowingOpen } from '../../domain/market-maturity'
import { LadderAdapterError } from '../../errors'
import { activeOwnedLadderGroupIds } from '../../infrastructure/ladder/ladder-active-publication.utils'
import {
  hasClearableCrossing,
  ladderBookCrossing,
  ownBootstrapBuyTickCeiling,
  retainedOpposingBookTicks
} from '../../infrastructure/ladder/ladder-cross-book.utils'
import { buildPublishableLadderTree } from '../../infrastructure/ladder/ladder-offer.utils'
import { assertLadderProspectiveSpread } from '../../infrastructure/ladder/ladder-spread.utils'
import { completeBook, consumedAtBlock } from './complete-book'

/** A ladder replacement prepared from one reading, its tree not yet API-validated. */
type PreparedLadder = Omit<LadderPreparation, 'publication'> & {
  publication?: Omit<NonNullable<LadderPreparation['publication']>, 'witness'> & { tree: Tree }
}

/**
 * Prepares the exact tree that replaces a market's live ladder, from one {@link PreparationReading}
 * of the complete book, as if the replaced groups were already cancelled: rechecks a `book-crossed`
 * crossing, builds the tree clear of the retained book, and asserts its spread against own offers.
 * @param parameters - The preparation reading, the prepare request, market config, maker, ratifier,
 * and configured V0 group ids.
 * @returns The replacement, its tree not yet validated against the API.
 * @throws `LadderAdapterError` `market-matured`, `borrowing-closed` when {@link borrowingOpen} at
 * this reading disagrees with the quote's `debtCapable`, `negative-spread`, and what the tree build
 * throws.
 */
export const prepareLadder = (parameters: {
  reading: PreparationReading
  request: Omit<Parameters<LadderAdapters['prepareReplacement']>[0], 'ownership'>
  config: ValidLadderConfig
  maker: Address
  ratifier: Address
  v0OfferGroupIds: readonly Hex[]
}): PreparedLadder => {
  const { reading, request, config, maker } = parameters
  const { marketId, desired } = request
  const { market, groups, ownership } = reading
  const now = reading.block.timestamp
  const timeToMaturity = BigInt(market.params.maturity) - now
  if (timeToMaturity <= 0n) throw new LadderAdapterError('market-matured')
  const borrowing = borrowingOpen(config.debt, {
    maturityTimestamp: BigInt(market.params.maturity),
    observedTimestamp: now
  })
  if (borrowing !== (desired.debtCapable === true)) throw new LadderAdapterError('borrowing-closed')
  const publications = ownership.ladderPublications
  const replacedGroupIds = new Set(
    activeOwnedLadderGroupIds(
      publications,
      consumedAtBlock(groups, reading.consumed, LadderAdapterError),
      marketId
    )
  )
  const book = completeBook({
    marketId,
    maker,
    v0OfferGroupIds: parameters.v0OfferGroupIds,
    book: reading.book,
    groups,
    ownership,
    consumed: reading.consumed,
    adapterError: LadderAdapterError
  })
  const bookCrossing = ladderBookCrossing({
    marketId,
    maker,
    book,
    publications,
    activeLadderGroupIds: replacedGroupIds,
    config,
    timeToMaturity,
    tickSpacing: BigInt(market.tickSpacing)
  })
  if (
    request.reason === 'book-crossed' &&
    !hasClearableCrossing(bookCrossing, request.bookCrossedSides)
  )
    return { reconciliation: { preparedAtTimestamp: now, bookCrossing, applied: false } }
  const reconciliation = { preparedAtTimestamp: now, bookCrossing, applied: true }
  const ceiling = ownBootstrapBuyTickCeiling(book, marketId)
  const { prepared, withdrawnSides } = buildPublishableLadderTree({
    quote: desired,
    market,
    maker,
    ratifier: parameters.ratifier,
    now,
    minimumRateBps: config.minimumRateBps,
    maximumRateBps: config.maximumRateBps,
    opposingBookTicks: retainedOpposingBookTicks({
      marketId,
      replacedGroupIds,
      book,
      depthFloor: { maker, minimumOpposingAssets: config.minimumOfferAssets }
    }),
    ...(ceiling === undefined ? {} : { ownBootstrapBuyTickCeiling: ceiling }),
    ...(config.debt === undefined ? {} : { debt: config.debt })
  })
  const withdrawn = withdrawnSides.length === 0 ? {} : { withdrawnSides }
  if (!prepared) return { reconciliation, ...withdrawn }
  assertLadderProspectiveSpread({
    marketId,
    maker,
    replacedGroupIds,
    book,
    prospective: prepared.bookOffers.map(offer => ({
      ...offer,
      ...(!offer.buy ? { overlapOwner: 'ladder-sell' as const } : {})
    }))
  })
  return {
    reconciliation,
    bookClearedRungs: prepared.bookClearedRungs,
    ...withdrawn,
    publication: {
      quote: {
        ...desired,
        lower: withdrawnSides.includes('lower') ? [] : desired.lower,
        higher: withdrawnSides.includes('higher') ? [] : desired.higher
      },
      groups: prepared.groups,
      tree: prepared.tree
    }
  }
}
