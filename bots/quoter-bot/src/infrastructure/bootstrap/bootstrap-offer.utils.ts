import type { Address, Hex } from 'viem'

import { MAX_TICK, Offer, TickLib, type IMarketParams } from '@morpho-org/midnight-sdk'

import type { BootstrapOffer } from '../../domain/bootstrap/position-bootstrap'

import { BootstrapAdapterError } from './bootstrap-adapter.error'

const WAD = 10n ** 18n
const YEAR_SECONDS = 31_536_000n
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
  now: bigint
) => {
  const periodRateWad =
    (rateBps * (WAD / 10_000n) * (BigInt(market.params.maturity) - now)) / YEAR_SECONDS
  return TickLib.priceToTick(TickLib.rateToPrice(periodRateWad), BigInt(market.tickSpacing))
}

const bootstrapEffectiveAprWad = (
  tick: bigint,
  market: Pick<BootstrapOfferMarket, 'params'>,
  now: bigint
) => TickLib.tickToApr(tick, BigInt(market.params.maturity) - now)

const firstBootstrapTickAtOrBelowApr = (
  maximumAprWad: bigint,
  market: Pick<BootstrapOfferMarket, 'params' | 'tickSpacing'>,
  now: bigint
) => {
  const tickSpacing = BigInt(market.tickSpacing)
  let low = 0n
  let high = MAX_TICK / tickSpacing
  while (low < high) {
    const middle = (low + high) / 2n
    if (bootstrapEffectiveAprWad(middle * tickSpacing, market, now) <= maximumAprWad) high = middle
    else low = middle + 1n
  }
  return low * tickSpacing
}

const lastBootstrapTickAtOrAboveApr = (
  minimumAprWad: bigint,
  market: Pick<BootstrapOfferMarket, 'params' | 'tickSpacing'>,
  now: bigint
) => {
  const tickSpacing = BigInt(market.tickSpacing)
  let low = 0n
  let high = MAX_TICK / tickSpacing
  while (low < high) {
    const middle = (low + high + 1n) / 2n
    if (bootstrapEffectiveAprWad(middle * tickSpacing, market, now) >= minimumAprWad) low = middle
    else high = middle - 1n
  }
  return low * tickSpacing
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
 * @param parameters - Offer intent, fresh market state, maker policy, current block time, and an
 * optional exact owned ladder-sell tick for intentional overlap.
 * @returns A Midnight buy offer with the exact overlap tick or live maturity-adjusted tick and fee cap.
 * @throws `BootstrapAdapterError` when a required live market fee is malformed; SDK validation failures propagate.
 * @remarks The fresh block timestamp prevents a later publication from reusing a consumed
 * content-addressed group while preserving the market maturity as the offer expiry.
 */
export const createBootstrapOffer = (parameters: {
  offer: BootstrapOffer
  market: BootstrapOfferMarket
  maker: Address
  ratifier: Address
  now: bigint
  exactTick?: bigint
}) => {
  return Offer.create({
    market: parameters.market.params,
    buy: true,
    maker: parameters.maker,
    start: parameters.now,
    tick:
      parameters.exactTick ??
      bootstrapOfferTick(parameters.offer.rateBps, parameters.market, parameters.now),
    expiry: parameters.market.params.maturity,
    ratifier: parameters.ratifier,
    maxAssets: parameters.offer.assets,
    continuousFeeCap: bootstrapContinuousFeeCap(parameters.market)
  })
}

/**
 * Creates a bootstrap buy on a spacing-aligned tick inside hard APR and cross-book limits.
 * @param parameters - Offer, fresh market and timestamp, maker policy, inclusive APR bounds, and the
 * crossing sell tick that the resulting buy must remain strictly below.
 * @returns The exact offer plus its WAD APR and reconstruction-safe ceiling integer-bps quote.
 * @throws `BootstrapAdapterError` when no spacing-aligned tick satisfies every bound and strict gap;
 * SDK validation failures propagate.
 * @remarks Higher APR maps to lower ticks. The selected tick stays as close as possible to the
 * nominal quote while preferring neither a hard-bound violation nor a zero cross-book spread.
 */
export const createBoundedBootstrapOffer = (parameters: {
  offer: BootstrapOffer
  market: BootstrapOfferMarket
  maker: Address
  ratifier: Address
  now: bigint
  minimumRateBps: bigint
  maximumRateBps: bigint
  maximumExclusiveTick: bigint
}) => {
  const tickSpacing = BigInt(parameters.market.tickSpacing)
  if (parameters.maximumExclusiveTick <= 0n) {
    throw new BootstrapAdapterError('negative-spread')
  }
  const minimumTick = firstBootstrapTickAtOrBelowApr(
    parameters.maximumRateBps * (WAD / 10_000n),
    parameters.market,
    parameters.now
  )
  const maximumBoundTick = lastBootstrapTickAtOrAboveApr(
    parameters.minimumRateBps * (WAD / 10_000n),
    parameters.market,
    parameters.now
  )
  const maximumSpreadTick = ((parameters.maximumExclusiveTick - 1n) / tickSpacing) * tickSpacing
  const maximumTick = maximumSpreadTick < maximumBoundTick ? maximumSpreadTick : maximumBoundTick
  const requestedTick = bootstrapOfferTick(
    parameters.offer.rateBps,
    parameters.market,
    parameters.now
  )
  const tick = requestedTick < minimumTick ? minimumTick : requestedTick
  const boundedTick = tick > maximumTick ? maximumTick : tick
  if (maximumTick < minimumTick || boundedTick < 0n) {
    throw new BootstrapAdapterError('negative-spread')
  }
  const effectiveAprWad = bootstrapEffectiveAprWad(boundedTick, parameters.market, parameters.now)
  if (
    effectiveAprWad < parameters.minimumRateBps * (WAD / 10_000n) ||
    effectiveAprWad > parameters.maximumRateBps * (WAD / 10_000n)
  ) {
    throw new BootstrapAdapterError('negative-spread')
  }
  return {
    created: createBootstrapOffer({ ...parameters, exactTick: boundedTick }),
    effectiveAprWad,
    effectiveRateBps: (effectiveAprWad + WAD / 10_000n - 1n) / (WAD / 10_000n)
  }
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
  let highestTick = bootstrapOfferTick(parameters.offer.rateBps, parameters.market, windowStart)
  for (let now = windowStart + 1n; now <= lastPossibleStart; now += 1n) {
    const tick = bootstrapOfferTick(parameters.offer.rateBps, parameters.market, now)
    if (tick > highestTick) highestTick = tick
  }
  return highestTick
}
