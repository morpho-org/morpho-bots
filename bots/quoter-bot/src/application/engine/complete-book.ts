import type { Address, Hex } from 'viem'

import { MAX_OFFER_CAP, MAX_TICK } from '@morpho-org/midnight-sdk'

import type { OwnedOverlapBookOffer } from '../../domain/intentional-overlap'
import type { OfferCap } from '../../domain/offer-cap'
import type { MakerOfferGroup } from '../../infrastructure/provider/offer-groups.utils'
import type { OperatorAdapterErrorClass } from '../monitoring/operator-error-name.utils'
import type { WorldOwnership } from './world'

import { remainingCap } from '../../domain/offer-cap'
import { bootstrapBookOffers } from '../../infrastructure/bootstrap/bootstrap-groups.utils'
import { livePendingBootstrapOffers } from '../../infrastructure/bootstrap/bootstrap-pending-offer.utils'
import { ownedLadderBookOffers } from '../../infrastructure/ladder/ladder-active-publication.utils'
import {
  durableBootstrapGroupIds,
  markOwnBootstrapBuys
} from '../../infrastructure/ladder/ladder-cross-book.utils'

const offerKey = (offer: OwnedOverlapBookOffer) =>
  `${offer.groupId ?? ''}:${offer.buy ? 'buy' : 'sell'}:${offer.tick}`

/** Every own group's cap: the indexer's, else the units its ladder publication or bootstrap intent signed. */
const ownCaps = (groups: readonly MakerOfferGroup[], ownership: WorldOwnership) => {
  const caps = new Map<Hex, OfferCap>()
  for (const offer of ownership.bootstrapOffers)
    caps.set(offer.groupId, { kind: 'units', maximum: offer.assets })
  for (const publication of ownership.ladderPublications)
    for (const group of publication.groups) {
      const rungs = new Set(group.rungIndexes)
      const maximum = publication.quote[group.side]
        .filter(rung => rungs.has(rung.index))
        .reduce((sum, rung) => sum + rung.assets, 0n)
      caps.set(group.groupId, { kind: 'units', maximum })
    }
  for (const group of groups) caps.set(group.id, group.cap)
  return caps
}

/**
 * The maker's indexed groups with each one's consumption read from the chain at the assessed block;
 * the index supplies only their immutable ids, caps and markets.
 * @param groups - The maker's indexed groups.
 * @param consumed - Each group's consumption at the assessed block, keyed by group id.
 * @param adapterError - Operator error class thrown for a group with no consumption read.
 * @returns The groups with `consumed` replaced by the block's chain value.
 * @throws `adapterError` `group-consumption-read` for a group whose consumption was not read.
 */
export const consumedAtBlock = (
  groups: readonly MakerOfferGroup[],
  consumed: Readonly<Record<string, bigint>>,
  adapterError: OperatorAdapterErrorClass
): MakerOfferGroup[] =>
  groups.map(group => {
    if (!Object.hasOwn(consumed, group.id)) throw new adapterError('group-consumption-read')
    return { ...group, consumed: consumed[group.id]! }
  })

/**
 * One market's book as every assessment of it reads it: the API's takeable book, the maker's
 * indexed groups, the live bootstrap intents the API has not indexed at their persisted ticks, and
 * the active ladder groups it has not indexed at their signed ticks, each offer once, with every own
 * group's liveness taken from `consumed`, read at the assessed block.
 * @remarks Every offer the maker signed carries `maker`, so no own offer reads as third-party
 * liquidity, and every buy of a durably owned bootstrap group is marked `bootstrap-buy`. A pending
 * intent without a persisted tick sits at `MAX_TICK`, the buy every sell must clear. An own offer
 * whose group is cancelled, or whose units cap is used up, is no liquidity; a cash-capped buy stays
 * until it is cancelled (see `isGroupClosed`).
 * @param parameters - The market, maker, V0 group ids, API book, indexed groups, ownership,
 * block consumption, and the operator error class to throw.
 * @returns Every live offer in the market once, own offers marked with `maker`.
 * @throws `adapterError` `group-consumption-read` for an indexed group whose consumption was not
 * read, and `BootstrapAdapterError` as {@link livePendingBootstrapOffers} throws.
 */
export const completeBook = (parameters: {
  marketId: Hex
  maker: Address
  v0OfferGroupIds: readonly Hex[]
  book: readonly OwnedOverlapBookOffer[]
  groups: readonly MakerOfferGroup[]
  ownership: WorldOwnership
  consumed: Readonly<Record<string, bigint>>
  adapterError: OperatorAdapterErrorClass
}): OwnedOverlapBookOffer[] => {
  const { marketId, maker, ownership, consumed } = parameters
  const groups = consumedAtBlock(parameters.groups, consumed, parameters.adapterError)
  const caps = ownCaps(groups, ownership)
  const spent = (offer: OwnedOverlapBookOffer) => {
    if (offer.groupId === undefined || !Object.hasOwn(consumed, offer.groupId)) return false
    const used = consumed[offer.groupId]!
    if (used === MAX_OFFER_CAP) return true
    const cap = caps.get(offer.groupId)
    return (
      cap !== undefined && !(offer.buy && cap.kind === 'assets') && remainingCap(cap, used) === 0n
    )
  }
  const retired = new Set(ownership.retiredGroupIds)
  const pending = livePendingBootstrapOffers({
    groups,
    ownedGroupIds: ownership.bootstrapGroupIds.filter(groupId => !retired.has(groupId)),
    offers: ownership.bootstrapOffers,
    consumed
  }).map(offer => ({
    groupId: offer.groupId,
    marketId: offer.marketId,
    maker,
    buy: true,
    tick: offer.tick ?? MAX_TICK
  }))
  const ownLadder = ownedLadderBookOffers(ownership.ladderPublications, groups, marketId).map(
    offer => ({ ...offer, maker })
  )
  const union = new Map<string, OwnedOverlapBookOffer>()
  for (const offer of [
    ...parameters.book,
    ...bootstrapBookOffers(groups),
    ...pending,
    ...ownLadder
  ])
    if (offer.marketId === marketId && !union.has(offerKey(offer)) && !spent(offer))
      union.set(offerKey(offer), offer)
  return markOwnBootstrapBuys(
    [...union.values()],
    durableBootstrapGroupIds({
      v0OfferGroupIds: parameters.v0OfferGroupIds,
      ownedGroupIds: ownership.bootstrapGroupIds,
      persistedOffers: ownership.bootstrapOffers
    })
  )
}
