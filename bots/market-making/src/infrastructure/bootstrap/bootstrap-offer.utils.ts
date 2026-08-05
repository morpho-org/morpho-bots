import type { Address, Hex } from 'viem'

import {
  DEFAULT_TICK_SPACING,
  MAX_TICK,
  Offer,
  TickLib,
  type IMarketParams
} from '@morpho-org/midnight-sdk'

import type { BootstrapOffer } from '../../domain/bootstrap/position-bootstrap'

import { BootstrapAdapterError } from './bootstrap-adapter.error'

const WAD = 10n ** 18n
const YEAR_SECONDS = 31_536_000n

type BootstrapOfferMarket = {
  params: IMarketParams
  tickSpacing: number
  continuousFee: unknown
}

/**
 * Converts the authoritative live Midnight market fee into an explicit offer cap.
 * @param market - Freshly fetched market state.
 * @returns The exact current continuous fee accepted by the bootstrap offer.
 * @throws `BootstrapAdapterError` when the provider omits or corrupts the uint32 fee.
 * @remarks The cap intentionally accepts no fee increase beyond the observed live policy.
 */
export const bootstrapContinuousFeeCap = (market: { continuousFee: unknown }) => {
  if (
    typeof market.continuousFee !== 'number' ||
    !Number.isSafeInteger(market.continuousFee) ||
    market.continuousFee < 0 ||
    market.continuousFee > 0xffff_ffff
  ) {
    throw new BootstrapAdapterError('market-continuous-fee')
  }
  return BigInt(market.continuousFee)
}

/**
 * Recreates the exact protocol offer for a persisted or prospective bootstrap intent.
 * @param parameters - Offer intent, fresh market state, maker policy, and current block time.
 * @returns A Midnight buy offer with the live maturity-adjusted tick and fee cap.
 * @throws `BootstrapAdapterError` when the live market fee is malformed; SDK validation failures propagate.
 * @remarks The fresh block timestamp prevents a later publication from reusing a consumed
 * content-addressed group while preserving the market maturity as the offer expiry.
 */
export const createBootstrapOffer = (parameters: {
  offer: BootstrapOffer
  market: BootstrapOfferMarket
  maker: Address
  ratifier: Address
  now: bigint
}) => {
  const periodRateWad =
    (parameters.offer.rateBps *
      (WAD / 10_000n) *
      (BigInt(parameters.market.params.maturity) - parameters.now)) /
    YEAR_SECONDS
  return Offer.create({
    market: parameters.market.params,
    buy: true,
    maker: parameters.maker,
    start: parameters.now,
    tick: TickLib.priceToTick(
      TickLib.rateToPrice(periodRateWad),
      BigInt(parameters.market.tickSpacing)
    ),
    expiry: parameters.market.params.maturity,
    ratifier: parameters.ratifier,
    maxAssets: parameters.offer.assets,
    continuousFeeCap: bootstrapContinuousFeeCap(parameters.market)
  })
}

/**
 * Recovers the exact protocol tick of a pre-v4 persisted bootstrap offer.
 * @param parameters - Legacy group identity, original offer cap, current immutable market data,
 * maker, and ratifier used by the original publication.
 * @returns The aligned tick whose singleton content-addressed group matches, or `undefined` when
 * the legacy offer cannot be reconstructed exactly.
 * @throws `BootstrapAdapterError` when the live market fee is malformed; SDK validation failures propagate.
 * @remarks Bootstrap ownership v3 did not persist ticks. Those offers used the SDK's historical
 * default `start` of zero, so scanning the bounded protocol tick domain and accepting only an exact
 * group hash match recovers their price without deriving it from a later block timestamp.
 */
export const recoverLegacyBootstrapOfferTick = (parameters: {
  groupId: Hex
  maximumAssets: bigint
  market: BootstrapOfferMarket
  maker: Address
  ratifier: Address
}) => {
  const continuousFeeCap = bootstrapContinuousFeeCap(parameters.market)
  for (let tick = 0n; tick <= MAX_TICK; tick += DEFAULT_TICK_SPACING) {
    const candidate = Offer.create({
      market: parameters.market.params,
      buy: true,
      maker: parameters.maker,
      tick,
      expiry: parameters.market.params.maturity,
      ratifier: parameters.ratifier,
      maxAssets: parameters.maximumAssets,
      continuousFeeCap
    })
    if (candidate.group === parameters.groupId) return tick
  }
  return undefined
}
