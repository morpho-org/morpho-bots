import type { IMarket } from '@morpho-org/midnight-sdk'

import { OfferUtils } from '@morpho-org/midnight-sdk'

/** One buy-side cash reservation at its exact protocol pricing and eligibility terms. */
type BuyerAssetReservation = {
  assets: bigint
  tick: bigint
  market: IMarket
  start: bigint
  expiry: bigint
  continuousFeeCap: bigint
  timestamp: bigint
}

/**
 * Converts a remaining raw buyer-asset cap into the canonical maximum consumable credit units.
 * @param reservation - Remaining maxAssets, hydrated market, encoded offer terms, and timestamp.
 * @returns Greatest credit units accepted by Midnight's floor-rounded maxAssets cap, or zero when
 *   the offer is not live or no longer accepts the market continuous fee.
 * @remarks This deliberately uses the SDK's max-cap conversion rather than target-asset conversion.
 * Continuous fee is an eligibility gate; settlement fees are resolved from the hydrated market.
 */
export const buyerAssetReservationCredit = (reservation: BuyerAssetReservation): bigint =>
  OfferUtils.getConsumableUnits({
    offer: {
      market: reservation.market,
      buy: true,
      start: reservation.start,
      expiry: reservation.expiry,
      tick: reservation.tick,
      maxUnits: 0n,
      maxAssets: reservation.assets,
      continuousFeeCap: reservation.continuousFeeCap
    },
    consumed: 0n,
    timestamp: reservation.timestamp
  })

/**
 * Captures exact live terms for a prospective buy reservation.
 * @param parameters - Raw buyer assets, encoded tick, hydrated market, and observation timestamp.
 * @returns Immutable canonical SDK conversion inputs.
 */
export const createBuyerAssetReservation = (parameters: {
  assets: bigint
  tick: bigint
  market: IMarket
  now: bigint
}): BuyerAssetReservation => ({
  assets: parameters.assets,
  tick: parameters.tick,
  market: parameters.market,
  start: parameters.now,
  expiry: BigInt(parameters.market.params.maturity),
  continuousFeeCap: BigInt(parameters.market.continuousFee),
  timestamp: parameters.now
})
