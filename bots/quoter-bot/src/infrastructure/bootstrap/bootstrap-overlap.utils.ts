import type { BookOffer } from '@repo/offers'
import type { Hex } from 'viem'

import { TickLib } from '@morpho-org/midnight-sdk'
import { hasNegativeSpread } from '@repo/offers'

import type { BootstrapOffer } from '../../domain/bootstrap/position-bootstrap'
import type { BootstrapRawGroup } from './bootstrap-groups.utils'

import { BootstrapAdapterError } from './bootstrap-adapter.error'
import { bootstrapBookOffers } from './bootstrap-groups.utils'

const BPS_WAD = 100_000_000_000_000n

/** Live ladder-sell evidence that permits one intentional bootstrap overlap. */
export type BootstrapOverlapBookOffer = BookOffer & {
  continuousFeeCap?: bigint
  effectiveRateBps?: bigint
  bootstrapOverlap?: {
    remainingAssets: bigint
    effectiveRateBps: bigint
  }
}

const negativeSpread = () => new BootstrapAdapterError('negative-spread')

const currentEffectiveRateBps = (tick: bigint, maturity: bigint | undefined, now: bigint) => {
  if (maturity === undefined || maturity <= now) return undefined
  try {
    const rateBps = TickLib.tickToApr(tick, maturity - now) / BPS_WAD
    return rateBps >= 0n ? rateBps : undefined
  } catch {
    return undefined
  }
}

/**
 * Enriches indexed ladder sells with the only evidence accepted for bootstrap overlap handling.
 * @param parameters - Complete maker groups, ladder-owned sell IDs, rebuilt pending ladder offers,
 * and current block timestamp.
 * @returns The complete indexed and pending book, with positive remaining size and current rate
 * attached only to eligible indexed ladder sells whose exact published tick is available.
 * @remarks Rebuilt pending, unknown, matured, or malformed sells remain in the book without
 * eligibility so any crossing they cause still fails closed in `resolveBootstrapProspectiveOffer`.
 */
export const bootstrapLadderSellOverlapBookOffers = (parameters: {
  groups: readonly BootstrapRawGroup[]
  eligibleSellGroupIds: ReadonlySet<Hex>
  currentTimestamp: bigint
  pendingLadderOffers?: readonly (BootstrapOverlapBookOffer & {
    remainingAssets: bigint
    effectiveRateBps: bigint
  })[]
}): BootstrapOverlapBookOffer[] => {
  const indexed = bootstrapBookOffers(parameters.groups).map(offer => {
    if (
      offer.buy ||
      offer.remainingAssets <= 0n ||
      !parameters.eligibleSellGroupIds.has(offer.groupId)
    ) {
      return offer
    }
    const effectiveRateBps = currentEffectiveRateBps(
      offer.tick,
      offer.maturity,
      parameters.currentTimestamp
    )
    if (effectiveRateBps === undefined) return offer
    return {
      ...offer,
      bootstrapOverlap: { remainingAssets: offer.remainingAssets, effectiveRateBps }
    }
  })
  const pending = parameters.pendingLadderOffers ?? []
  return [...indexed, ...pending]
}

/**
 * Resolves a premium-adjusted bootstrap buy against the current maker book.
 * @param parameters - Desired offer, its exact prospective tick, retained book, replacement IDs,
 * and exact tick projector used only when overlap requires repricing at the selected sell tick.
 * @returns The original safe offer, a sell-rate-adjusted positive remainder, or `undefined` when
 * the selected sell already covers the expected bootstrap assets.
 * @throws `BootstrapAdapterError` when a crossing is pre-existing, ambiguous, not caused by the
 * prospective buy, or lacks positive ladder-owned size and current effective-rate evidence.
 * @remarks Only the unique lowest-tick (highest-rate) eligible ladder sell may overlap. The
 * adjusted offer is re-projected and must remain non-crossing against every other retained offer.
 */
export const resolveBootstrapProspectiveOffer = async (parameters: {
  desiredOffer: BootstrapOffer
  prospective: BootstrapOverlapBookOffer
  replacedGroupIds: ReadonlySet<Hex>
  book: readonly BootstrapOverlapBookOffer[]
  toProspectiveBookOffer: (
    offer: BootstrapOffer,
    exactTick?: bigint
  ) => Promise<BootstrapOverlapBookOffer>
  minimumRateBps: bigint
  maximumRateBps: bigint
}) => {
  const retained = parameters.book.filter(
    offer =>
      offer.marketId === parameters.desiredOffer.marketId &&
      (offer.groupId === undefined || !parameters.replacedGroupIds.has(offer.groupId))
  )
  if (hasNegativeSpread(retained)) throw negativeSpread()

  const prospective = parameters.prospective
  if (!hasNegativeSpread([...retained, prospective])) {
    return { offer: parameters.desiredOffer, prospective }
  }
  if (!prospective.buy || prospective.marketId !== parameters.desiredOffer.marketId) {
    throw negativeSpread()
  }

  const sells = retained.filter(offer => !offer.buy)
  const highestRateTick = sells.reduce<bigint | undefined>(
    (lowest, offer) => (lowest === undefined || offer.tick < lowest ? offer.tick : lowest),
    undefined
  )
  const selected = sells.filter(offer => offer.tick === highestRateTick)
  if (selected.length !== 1) throw negativeSpread()

  const crossingSell = selected[0]!
  const evidence = crossingSell.bootstrapOverlap
  if (
    prospective.tick < crossingSell.tick ||
    evidence === undefined ||
    evidence.remainingAssets <= 0n ||
    evidence.effectiveRateBps < parameters.minimumRateBps ||
    evidence.effectiveRateBps > parameters.maximumRateBps
  ) {
    throw negativeSpread()
  }

  const assets = parameters.desiredOffer.assets - evidence.remainingAssets
  if (assets <= 0n) return undefined

  const offer = {
    ...parameters.desiredOffer,
    assets,
    rateBps: evidence.effectiveRateBps
  }
  const adjustedProspective = await parameters.toProspectiveBookOffer(offer, crossingSell.tick)
  const adjustedRateBps = adjustedProspective.effectiveRateBps ?? evidence.effectiveRateBps
  if (
    adjustedRateBps < parameters.minimumRateBps ||
    adjustedRateBps > parameters.maximumRateBps ||
    hasNegativeSpread([
      ...retained.filter(candidate => candidate !== crossingSell),
      adjustedProspective
    ])
  ) {
    throw negativeSpread()
  }
  return {
    offer: { ...offer, rateBps: adjustedRateBps },
    prospective: adjustedProspective
  }
}
