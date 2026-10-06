import type { Hex } from 'viem'

import { TickLib } from '@morpho-org/midnight-sdk'
import { MathLib } from '@morpho-org/morpho-ts'

import type { MakerBookOffer, MakerOfferGroup } from '../provider/offer-groups.utils'

import { remainingBuyAssets, remainingCap } from '../../domain/offer-cap'

const BPS_WAD = MathLib.WAD / 10_000n

/**
 * Selects strategy groups using durable explicit ownership evidence.
 * @param groups - Canonical groups read from the maker-scoped API endpoint.
 * @param ownedGroupIds - Configured or safely persisted group IDs issued for this strategy.
 * @returns Active lend groups whose IDs are explicitly owned and whose projections are complete.
 * @remarks Market membership is deliberately not ownership evidence; unknown same-market groups stay unknown.
 */
export const strategyBootstrapGroups = (
  groups: readonly MakerOfferGroup[],
  ownedGroupIds: readonly Hex[]
) => {
  const ownedGroups = new Set(ownedGroupIds)
  return groups.filter(
    group =>
      ownedGroups.has(group.id) &&
      group.marketId !== undefined &&
      group.tick !== undefined &&
      group.maturity !== undefined &&
      group.offers.length > 0
  )
}

/**
 * Annualizes one indexed group's resting tick over the term it still has left.
 * @param parameters - Group tick, group maturity, and the timestamp that maturity is compared
 *   against.
 * @returns Simple APR in basis points, or `0n` once the group's market has matured.
 * @remarks A matured group has no remaining term to annualize over, and `TickLib.tickToApr` rejects
 * a zero or negative term. Projecting it as a zero rate keeps the group visible as ownership and
 * cleanup evidence instead of failing the whole inventory read for every configured market.
 */
export const bootstrapGroupRateBps = (parameters: {
  tick: bigint
  maturity: bigint
  observedTimestamp: bigint
}) =>
  parameters.maturity > parameters.observedTimestamp
    ? TickLib.tickToApr(parameters.tick, parameters.maturity - parameters.observedTimestamp) /
      BPS_WAD
    : 0n

/**
 * Totals the unfilled cash reserve of every distinct live buy group.
 * @param groups - Canonical maker groups, which may contain one projection per offer market.
 * @param excludedGroupIds - Groups being replaced and therefore not reserved alongside the new offer.
 * @returns Aggregate {@link remainingBuyAssets} of distinct live buy groups.
 * @remarks Attribution deliberately does not filter this total; see `readExposureSnapshot` in
 * `../exposure/exposure-snapshot.utils.ts` for why exposure counts every live maker buy group.
 */
export const bootstrapReservedLoanAssets = (
  groups: readonly MakerOfferGroup[],
  excludedGroupIds: ReadonlySet<Hex> = new Set()
) => {
  return [
    ...new Map(
      groups
        .filter(group => !excludedGroupIds.has(group.id) && group.offers.some(offer => offer.buy))
        .map(group => [group.id, group])
    ).values()
  ]
    .map(group =>
      remainingBuyAssets(
        group.cap,
        group.consumed,
        group.offers.filter(offer => offer.buy).map(offer => offer.tick)
      )
    )
    .reduce((total, assets) => total + assets, 0n)
}

/**
 * Flattens the provider book without re-expanding each multi-market group projection.
 * @param groups - Canonical groups, potentially repeated once per buy-offer market.
 * @param ignoredGroupIds - Recently canceled groups that may remain visible during indexer lag.
 * @returns Distinct active, non-ignored offers annotated with their owning group ID in linear space and time.
 * @remarks Fully consumed groups remain visible in provider history but cannot contribute live book
 * liquidity, so they are excluded before spread validation.
 */
export const bootstrapBookOffers = (
  groups: readonly MakerOfferGroup[],
  ignoredGroupIds: readonly Hex[] = []
) => {
  const ignoredGroups = new Set(ignoredGroupIds)
  const visitedGroups = new Set<Hex>()
  const offers = new Map<
    string,
    MakerBookOffer & {
      groupId: Hex
      remainingAssets: bigint
    }
  >()
  for (const group of groups) {
    const remainingAssets = remainingCap(group.cap, group.consumed)
    if (remainingAssets === 0n || ignoredGroups.has(group.id) || visitedGroups.has(group.id))
      continue
    visitedGroups.add(group.id)
    for (const offer of group.offers) {
      const key = `${group.id}:${offer.marketId}:${offer.buy ? 'buy' : 'sell'}:${offer.tick}`
      offers.set(key, {
        ...offer,
        groupId: group.id,
        remainingAssets
      })
    }
  }
  return [...offers.values()]
}
