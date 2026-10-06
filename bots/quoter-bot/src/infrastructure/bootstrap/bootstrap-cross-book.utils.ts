import type { BookOffer } from '@repo/offers'
import type { Hex } from 'viem'

import { MathLib } from '@morpho-org/morpho-ts'

import type { BootstrapOffer } from '../../domain/position-bootstrap'

import { clampRateBps, CROSS_BOOK_CLEARANCE_BPS } from '../../domain/cross-book'
import { isAprWadInRange } from '../../domain/tick-window'
import { BootstrapAdapterError } from './bootstrap-adapter.error'

/** Book projection of one live, pending, or prospective offer used for bootstrap crossing checks. */
export type BootstrapCrossBookOffer = BookOffer & {
  /** Maximum market continuous fee accepted by a projected prospective offer. */
  continuousFeeCap?: bigint
  /** Exact encoded WAD APR (`TickLib.tickToApr`), attached to exact-tick projections. */
  effectiveRateWad?: bigint
  /** Market tick spacing, attached by projections that read fresh market state. */
  tickSpacing?: bigint
}

const negativeSpread = () => new BootstrapAdapterError('negative-spread')
const evidenceMissing = () => new BootstrapAdapterError('cross-book-evidence-missing')
const BPS_WAD = MathLib.WAD / 10_000n

const encodedRateWad = (projection: BootstrapCrossBookOffer) => {
  if (projection.effectiveRateWad === undefined) throw evidenceMissing()
  return projection.effectiveRateWad
}

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
 * APR is re-validated against the hard bounds at full precision before the offer is returned.
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
  let offer = {
    ...parameters.desiredOffer,
    rateBps: clampRateBps(
      encodedRateWad(reference) / BPS_WAD + CROSS_BOOK_CLEARANCE_BPS,
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
    const clearedRateWad = encodedRateWad(cleared)
    if (!isAprWadInRange(clearedRateWad, parameters)) return undefined
    offer = { ...offer, rateBps: clearedRateWad / BPS_WAD }
    adjusted = await parameters.toProspectiveBookOffer(offer, clearedTick)
    if (!isAprWadInRange(encodedRateWad(adjusted), parameters)) return undefined
  }
  if (adjusted.tick >= highestRateSellTick) throw negativeSpread()
  return { offer, prospective: adjusted }
}
