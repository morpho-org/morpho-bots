import type { Address } from 'viem'

import { Offer, type IMarketParams } from '@morpho-org/midnight-sdk'

import type { BootstrapOffer } from '../../domain/position-bootstrap'

import {
  alignedRateTick,
  admissibleRateTick,
  isEmptyTickWindow,
  rateTickWindow
} from '../../domain/tick-window'
import { BootstrapAdapterError } from './bootstrap-adapter.error'

type BootstrapOfferMarket = {
  params: IMarketParams
  tickSpacing: number
  continuousFee: unknown
}

type BootstrapRateBounds = { minimumRateBps?: bigint; maximumRateBps?: bigint }

const bootstrapTickRange = (
  market: Pick<BootstrapOfferMarket, 'params' | 'tickSpacing'>,
  derivation: BootstrapRateBounds & { now: bigint }
) => ({
  ...(derivation.minimumRateBps === undefined ? {} : { minimumRateBps: derivation.minimumRateBps }),
  ...(derivation.maximumRateBps === undefined ? {} : { maximumRateBps: derivation.maximumRateBps }),
  timeToMaturity: BigInt(market.params.maturity) - derivation.now,
  tickSpacing: BigInt(market.tickSpacing)
})

/**
 * Reports whether no aligned tick encodes a rate inside the bootstrap's hard range at `now`.
 * @param market - Market maturity and tick spacing.
 * @param derivation - Observation timestamp and the optional inclusive hard rate bounds.
 * @returns `false` once the market has matured, leaving that to the matured path.
 * @remarks Tick rounding depends on time to maturity, so a range that holds a tick at the snapshot
 * can hold none by the publication block, where {@link createBootstrapOffer} throws
 * `rate-window-empty`.
 */
export const bootstrapRateWindowIsEmpty = (
  market: Pick<BootstrapOfferMarket, 'params' | 'tickSpacing'>,
  derivation: BootstrapRateBounds & { now: bigint }
) => {
  const range = bootstrapTickRange(market, derivation)
  return range.timeToMaturity > 0n && isEmptyTickWindow(rateTickWindow(range))
}

/**
 * Recognizes the failure {@link createBootstrapOffer} raises when the hard range holds no tick.
 * @param error - Any thrown value.
 * @returns Whether the publication must be withheld rather than counted as a failure.
 */
export const isRateWindowEmpty = (error: unknown) =>
  error instanceof BootstrapAdapterError && error.operation === 'rate-window-empty'

const bootstrapOfferTick = (
  rateBps: bigint,
  market: Pick<BootstrapOfferMarket, 'params' | 'tickSpacing'>,
  derivation: BootstrapRateBounds & { now: bigint }
) => {
  const range = bootstrapTickRange(market, derivation)
  if (derivation.minimumRateBps === undefined && derivation.maximumRateBps === undefined) {
    return alignedRateTick(rateBps, range.timeToMaturity, range.tickSpacing)
  }
  const window = rateTickWindow(range)
  if (isEmptyTickWindow(window)) throw new BootstrapAdapterError('rate-window-empty')
  const tick = admissibleRateTick(rateBps, range, window)
  if (tick === undefined) throw new BootstrapAdapterError('rate-out-of-range')
  return tick
}

/**
 * Converts the authoritative live Midnight Market fee into an explicit offer cap.
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
 * @param parameters - Offer intent, fresh market state, maker policy, current block time, optional
 * inclusive hard rate bounds, and an optional exact tick that bypasses derivation entirely.
 * @returns A Midnight buy offer with the exact requested tick or live maturity-adjusted tick and fee cap.
 * @throws `BootstrapAdapterError` when a required live market fee is malformed, the hard rate
 * range contains no aligned tick ({@link isRateWindowEmpty}), or a derived rate is outside it
 * (`rate-out-of-range`); SDK validation failures propagate.
 * @remarks A derived rate is encoded by {@link admissibleRateTick}, so tick rounding never carries
 * the published APR past a bound. The fresh block timestamp prevents a later publication
 * from reusing a consumed content-addressed group while preserving the market maturity as the
 * offer expiry.
 */
export const createBootstrapOffer = (parameters: {
  offer: BootstrapOffer
  market: BootstrapOfferMarket
  maker: Address
  ratifier: Address
  now: bigint
  exactTick?: bigint
  minimumRateBps?: bigint
  maximumRateBps?: bigint
}) => {
  return Offer.create({
    market: parameters.market.params,
    buy: true,
    maker: parameters.maker,
    start: parameters.now,
    tick:
      parameters.exactTick ??
      bootstrapOfferTick(parameters.offer.rateBps, parameters.market, {
        now: parameters.now,
        ...(parameters.minimumRateBps === undefined
          ? {}
          : { minimumRateBps: parameters.minimumRateBps }),
        ...(parameters.maximumRateBps === undefined
          ? {}
          : { maximumRateBps: parameters.maximumRateBps })
      }),
    tickSpacing: parameters.market.tickSpacing,
    expiry: parameters.market.params.maturity,
    ratifier: parameters.ratifier,
    maxUnits: parameters.offer.assets,
    continuousFeeCap: bootstrapContinuousFeeCap(parameters.market)
  })
}
