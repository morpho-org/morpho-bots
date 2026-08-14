import type { BookOffer } from '@repo/offers'
import type { Hex } from 'viem'

import type { BootstrapOffer } from '../../domain/bootstrap/position-bootstrap'

import { clampRateBps, CROSS_BOOK_CLEARANCE_BPS } from '../../domain/cross-book'
import { BootstrapAdapterError } from './bootstrap-adapter.error'

/** Book projection of one live, pending, or prospective offer used for bootstrap crossing checks. */
export type BootstrapCrossBookOffer = BookOffer & {
  /** Maximum market continuous fee accepted by a projected prospective offer. */
  continuousFeeCap?: bigint
  /** Exact encoded annual rate, attached to exact-tick projections. */
  effectiveRateBps?: bigint
  /** Market tick spacing, attached by projections that read fresh market state. */
  tickSpacing?: bigint
}

const negativeSpread = () => new BootstrapAdapterError('negative-spread')
const evidenceMissing = () => new BootstrapAdapterError('cross-book-evidence-missing')

/**
 * Resolves a premium-adjusted bootstrap buy against the current maker book.
 * @param parameters - Desired offer, its exact prospective projection, retained book, replacement
 * IDs, inclusive hard rate bounds, and the projector used to reprice a crossing buy.
 * @returns The original offer when its prospective buy clears every retained sell, a repriced offer
 * quoting {@link CROSS_BOOK_CLEARANCE_BPS} above the highest-rate retained sell, or `undefined` when
 * no non-crossing tick exists inside the hard rate range so this cycle publishes nothing.
 * @throws `BootstrapAdapterError` `negative-spread` when the prospective projection is not the
 * selected-market buy or a repriced projection still crosses a retained sell;
 * `cross-book-evidence-missing` when a projection omits the effective-rate or tick-spacing evidence
 * repricing requires.
 * @remarks A crossing buy reprices against the lowest-tick (highest-rate) retained sell regardless
 * of who owns it. Existing crossings between retained third-party offers do not implicate the
 * prospective buy and are ignored. When tick rounding leaves the repriced buy at or above the sell
 * tick, the buy steps to exactly one tick spacing below it and adopts that tick's encoded rate. The
 * final projection always describes the returned offer, so a transport caching its latest
 * projection for publication can never observe a reference projection at the crossing sell tick
 * last; because each projection may read a newer block timestamp, that final projection's encoded
 * rate is re-validated against the hard bounds before the offer is returned.
 */
export const resolveBootstrapProspectiveOffer = async (parameters: {
  desiredOffer: BootstrapOffer
  prospective: BootstrapCrossBookOffer
  replacedGroupIds: ReadonlySet<Hex>
  book: readonly BootstrapCrossBookOffer[]
  toProspectiveBookOffer: (
    offer: BootstrapOffer,
    exactTick?: bigint
  ) => Promise<BootstrapCrossBookOffer>
  minimumRateBps: bigint
  maximumRateBps: bigint
}) => {
  const retained = parameters.book.filter(
    offer =>
      offer.marketId === parameters.desiredOffer.marketId &&
      (offer.groupId === undefined || !parameters.replacedGroupIds.has(offer.groupId))
  )
  const prospective = parameters.prospective
  if (!prospective.buy || prospective.marketId !== parameters.desiredOffer.marketId) {
    throw negativeSpread()
  }

  const highestRateSellTick = retained
    .filter(offer => !offer.buy)
    .reduce<bigint | undefined>(
      (lowest, offer) => (lowest === undefined || offer.tick < lowest ? offer.tick : lowest),
      undefined
    )
  if (highestRateSellTick === undefined || prospective.tick < highestRateSellTick) {
    return { offer: parameters.desiredOffer, prospective }
  }

  const reference = await parameters.toProspectiveBookOffer(
    parameters.desiredOffer,
    highestRateSellTick
  )
  if (reference.effectiveRateBps === undefined) throw evidenceMissing()
  let offer = {
    ...parameters.desiredOffer,
    rateBps: clampRateBps(
      reference.effectiveRateBps + CROSS_BOOK_CLEARANCE_BPS,
      parameters.minimumRateBps,
      parameters.maximumRateBps
    )
  }
  let adjusted = await parameters.toProspectiveBookOffer(offer)
  if (adjusted.tick >= highestRateSellTick) {
    const tickSpacing = adjusted.tickSpacing ?? reference.tickSpacing
    if (tickSpacing === undefined || tickSpacing <= 0n) throw evidenceMissing()
    const clearedTick = highestRateSellTick - tickSpacing
    if (clearedTick < 0n) return undefined
    const cleared = await parameters.toProspectiveBookOffer(offer, clearedTick)
    const exactRateBps = cleared.effectiveRateBps
    if (exactRateBps === undefined) throw evidenceMissing()
    if (exactRateBps < parameters.minimumRateBps || exactRateBps > parameters.maximumRateBps) {
      return undefined
    }
    offer = { ...offer, rateBps: exactRateBps }
    adjusted = await parameters.toProspectiveBookOffer(offer, clearedTick)
    const finalRateBps = adjusted.effectiveRateBps
    if (finalRateBps === undefined) throw evidenceMissing()
    if (finalRateBps < parameters.minimumRateBps || finalRateBps > parameters.maximumRateBps) {
      return undefined
    }
  }
  if (adjusted.tick >= highestRateSellTick) throw negativeSpread()
  return { offer, prospective: adjusted }
}
