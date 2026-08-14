import type { Address, Hex } from 'viem'

import { MAX_TICK, Offer, type IMarketParams } from '@morpho-org/midnight-sdk'

import type { BootstrapOffer } from '../../domain/bootstrap/position-bootstrap'

import {
  alignedRateTick,
  clampTickToWindow,
  isEmptyTickWindow,
  rateTickWindow
} from '../tick-window.utils'
import { BootstrapAdapterError } from './bootstrap-adapter.error'

const REFERENCE_OBSERVATION_SECONDS = 3_600n
const REFERENCE_STALENESS_SECONDS = 300n

type BootstrapOfferMarket = {
  params: IMarketParams
  tickSpacing: number
  continuousFee: unknown
}

const bootstrapOfferTick = (
  rateBps: bigint,
  market: Pick<BootstrapOfferMarket, 'params' | 'tickSpacing'>,
  derivation: { now: bigint; minimumRateBps?: bigint; maximumRateBps?: bigint }
) => {
  const timeToMaturity = BigInt(market.params.maturity) - derivation.now
  const tickSpacing = BigInt(market.tickSpacing)
  const aligned = alignedRateTick(rateBps, timeToMaturity, tickSpacing)
  if (derivation.minimumRateBps === undefined && derivation.maximumRateBps === undefined) {
    return aligned
  }
  const window = rateTickWindow({
    ...(derivation.minimumRateBps === undefined
      ? {}
      : { minimumRateBps: derivation.minimumRateBps }),
    ...(derivation.maximumRateBps === undefined
      ? {}
      : { maximumRateBps: derivation.maximumRateBps }),
    timeToMaturity,
    tickSpacing
  })
  if (isEmptyTickWindow(window)) throw new BootstrapAdapterError('rate-window-empty')
  return clampTickToWindow(aligned, window)
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
 * @param parameters - Offer intent, fresh market state, maker policy, current block time, optional
 * inclusive hard rate bounds, and an optional exact tick that bypasses derivation entirely.
 * @returns A Midnight buy offer with the exact requested tick or live maturity-adjusted tick and fee cap.
 * @throws `BootstrapAdapterError` when a required live market fee is malformed or the hard rate
 * range contains no aligned tick; SDK validation failures propagate.
 * @remarks A derived tick whose encoded rate would leave the supplied hard range saturates at the
 * nearest in-range tick instead of failing. The fresh block timestamp prevents a later publication
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
    expiry: parameters.market.params.maturity,
    ratifier: parameters.ratifier,
    maxAssets: parameters.offer.assets,
    continuousFeeCap: bootstrapContinuousFeeCap(parameters.market)
  })
}

/**
 * Recovers the exact protocol tick of a pre-v4 persisted bootstrap offer.
 * @param parameters - Legacy group identity, original asset and optional fee caps, current market
 * data, maker, and ratifier used by the original publication.
 * @returns The aligned tick whose singleton content-addressed group matches, or `undefined` when
 * the legacy offer cannot be reconstructed exactly.
 * @throws `BootstrapAdapterError` when a required live market fee is malformed; SDK validation failures propagate.
 * @remarks Bootstrap ownership v3 did not persist ticks. Those offers used the SDK's historical
 * default `start` of zero, so scanning the bounded protocol tick domain at the market's live spacing
 * and accepting only an exact group hash match recovers their price without deriving it from a later
 * block timestamp.
 */
export const recoverLegacyBootstrapOfferTick = (parameters: {
  groupId: Hex
  maximumAssets: bigint
  market: BootstrapOfferMarket
  maker: Address
  ratifier: Address
  continuousFeeCap?: bigint
}) => {
  const continuousFeeCap =
    parameters.continuousFeeCap ?? bootstrapContinuousFeeCap(parameters.market)
  const tickSpacing = BigInt(parameters.market.tickSpacing)
  for (let tick = 0n; tick <= MAX_TICK; tick += tickSpacing) {
    const candidate = Offer.create({
      market: parameters.market.params,
      buy: true,
      maker: parameters.maker,
      tick,
      tickSpacing,
      expiry: parameters.market.params.maturity,
      ratifier: parameters.ratifier,
      maxAssets: parameters.maximumAssets,
      continuousFeeCap
    })
    if (candidate.group === parameters.groupId) return tick
  }
  return undefined
}

/**
 * Bounds the tick of a legacy variable-rate offer when its original fee cap is unavailable.
 * @param parameters - Persisted offer semantics and current immutable market parameters.
 * @returns The highest tick reachable during the offer's original hourly observation window plus
 * the reference freshness allowance, or `undefined` for non-hourly or post-maturity observations.
 * @remarks This migration-only fallback never uses a later current block. A buy at the highest
 * possible tick is conservative for crossed-book validation because it cannot hide an unsafe sell.
 */
export const legacyBootstrapOfferTickUpperBound = (parameters: {
  offer: BootstrapOffer
  market: Pick<BootstrapOfferMarket, 'params' | 'tickSpacing'>
}) => {
  const observation = /^hour:(0|[1-9]\d*)$/.exec(parameters.offer.referenceObservationId)
  if (!observation?.[1]) return undefined

  const windowStart = BigInt(observation[1]) * REFERENCE_OBSERVATION_SECONDS
  const maturity = BigInt(parameters.market.params.maturity)
  if (windowStart > maturity) return undefined

  const windowEnd = windowStart + REFERENCE_OBSERVATION_SECONDS + REFERENCE_STALENESS_SECONDS
  const lastPossibleStart = windowEnd < maturity ? windowEnd : maturity
  let highestTick = bootstrapOfferTick(parameters.offer.rateBps, parameters.market, {
    now: windowStart
  })
  for (let now = windowStart + 1n; now <= lastPossibleStart; now += 1n) {
    const tick = bootstrapOfferTick(parameters.offer.rateBps, parameters.market, { now })
    if (tick > highestTick) highestTick = tick
  }
  return highestTick
}
