import type { IMarket } from '@morpho-org/midnight-sdk'

import { MarketUtils, TakeAmountsLib } from '@morpho-org/midnight-sdk'

/** One buy-side cash reservation at its exact protocol pricing terms. */
type BuyerAssetReservation = {
  assets: bigint
  tick: bigint
  settlementFee: bigint
  continuousFeeCap: bigint
}

/**
 * Converts a remaining raw buyer-asset cap into conservative credit units.
 * @param reservation - Remaining maxAssets and the exact encoded offer pricing terms.
 * @returns Maximum credit units that consuming the buyer-asset cap can create.
 * @remarks Midnight buy offers round buyer-assets-to-units up. The canonical SDK conversion also
 * applies the protocol's settlement-fee side semantics; continuousFeeCap is carried explicitly so
 * callers cannot conflate reservations created under different accepted fee policies.
 */
export const buyerAssetReservationCredit = (reservation: BuyerAssetReservation): bigint => {
  void reservation.continuousFeeCap
  return TakeAmountsLib.buyerAssetsToUnits({
    offer: { buy: true, tick: reservation.tick },
    targetBuyerAssets: reservation.assets,
    settlementFee: reservation.settlementFee
  })
}

/**
 * Captures canonical live fee terms for one exact encoded buy tick.
 * @param parameters - Raw buyer assets, encoded tick, hydrated market, and observation timestamp.
 * @returns Immutable conversion inputs used by cash and credit accounting independently.
 */
export const createBuyerAssetReservation = (parameters: {
  assets: bigint
  tick: bigint
  market: IMarket
  now: bigint
}): BuyerAssetReservation => ({
  assets: parameters.assets,
  tick: parameters.tick,
  settlementFee: MarketUtils.getSettlementFee({
    settlementFeeCbps: parameters.market.settlementFeeCbps,
    timeToMaturity: BigInt(parameters.market.params.maturity) - parameters.now
  }),
  continuousFeeCap: BigInt(parameters.market.continuousFee)
})
