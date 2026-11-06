import type { Hex } from 'viem'

import { TickLib } from '@morpho-org/midnight-sdk'
import { MathLib } from '@morpho-org/morpho-ts'

import type { MakerBookOffer, MakerOfferGroup } from '../provider/offer-groups.utils'

import { remainingCap } from '../../domain/offer-cap'

const BPS_WAD = MathLib.WAD / 10_000n

/** Active lend group projection required by bootstrap reconciliation. */
export type BootstrapActiveGroup = {
  id: Hex
  marketId: Hex
  assets: bigint
  rateBps: bigint
  /** Exact protocol tick when this projection represents a bootstrap offer. */
  tick?: bigint
  /** Original protocol group cap before cumulative consumption. */
  maximumAssets?: bigint
  /** Total number of offers sharing the protocol group. */
  offerCount?: number
  /** Maximum market continuous fee accepted by the resting protocol offer. */
  continuousFeeCap?: bigint
  referenceObservationId?: string
}

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
