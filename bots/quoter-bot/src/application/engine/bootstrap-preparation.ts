import type { Offer } from '@morpho-org/midnight-sdk'
import type { Address, Hex } from 'viem'

import { TickLib } from '@morpho-org/midnight-sdk'

import type { BootstrapOffer, ValidBootstrapConfig } from '../../domain/position-bootstrap'
import type { BootstrapCrossBookOffer } from '../../infrastructure/bootstrap/bootstrap-cross-book.utils'
import type { BootstrapAdapters } from '../../infrastructure/bootstrap/production-bootstrap'
import type { PreparationReading } from './world'

import { BootstrapAdapterError } from '../../errors'
import { resolveBootstrapProspectiveOffer } from '../../infrastructure/bootstrap/bootstrap-cross-book.utils'
import { createBootstrapOffer } from '../../infrastructure/bootstrap/bootstrap-offer.utils'
import { bootstrapMarketGroupIds } from '../../infrastructure/bootstrap/bootstrap-spread.utils'
import { bootstrapActiveGroups } from './bootstrap-state'
import { completeBook } from './complete-book'
import { exposureGroups } from './exposure'

/**
 * A bootstrap replacement prepared from one reading: nothing to publish, a live group to keep, or
 * the exact offer to publish with the cash every other live buy group keeps reserved.
 */
type PreparedBootstrap =
  | Readonly<{ offer?: undefined }>
  | Readonly<{ offer: BootstrapOffer; retainedGroupId: Hex }>
  | Readonly<{ offer: BootstrapOffer; created: Offer; reservedLoanAssets: bigint }>

/**
 * Resolves the exact offer a bootstrap replacement publishes, from one {@link PreparationReading}
 * of the complete book, as if the market's groups were already cancelled; a live group whose
 * remaining assets, tick, and fee cap already match it is kept instead.
 * @param parameters - The preparation reading, the prepare request, rate bounds, maker, ratifier,
 * and configured V0 group ids.
 * @returns Nothing to publish, the live group to keep, or the offer to publish with its reserve.
 * @throws `BootstrapAdapterError` when the inventory or book fails closed
 * (`missing-owned-group-intent`, `cash-capped-buy-group`, `group-ownership-state`,
 * `group-consumption-read`, `shared-group-reconciliation`), a configured V0 group the replacement
 * would leave takeable beside it (`unowned-group`), the rate range holds no tick
 * (`rate-window-empty`, `rate-out-of-range`), or a repriced offer still crosses (`negative-spread`).
 */
export const prepareBootstrap = (parameters: {
  reading: PreparationReading
  request: Omit<Parameters<BootstrapAdapters['prepareReplacement']>[0], 'ownership'>
  config: Pick<ValidBootstrapConfig, 'minimumRateBps' | 'maximumRateBps'>
  maker: Address
  ratifier: Address
  v0OfferGroupIds: readonly Hex[]
}): PreparedBootstrap => {
  const { reading, request, config, maker } = parameters
  const { marketId, desiredOffer } = request
  const { market, groups, ownership } = reading
  const now = reading.block.timestamp
  const exposure = exposureGroups(groups, ownership, BootstrapAdapterError)(reading.consumed)
  const activeGroups = bootstrapActiveGroups({
    exposure,
    groups,
    ownership,
    timestamp: now
  })
  const marketGroupIds = bootstrapMarketGroupIds(activeGroups, marketId)
  const book = completeBook({
    marketId,
    maker,
    v0OfferGroupIds: parameters.v0OfferGroupIds,
    book: reading.book,
    groups,
    ownership,
    consumed: reading.consumed,
    adapterError: BootstrapAdapterError
  })
  const project = (offer: BootstrapOffer, exactTick?: bigint) =>
    createBootstrapOffer({
      offer,
      market,
      maker,
      ratifier: parameters.ratifier,
      now,
      exactTick,
      minimumRateBps: config.minimumRateBps,
      maximumRateBps: config.maximumRateBps
    })
  let created = project(desiredOffer)
  const resolved = resolveBootstrapProspectiveOffer({
    desiredOffer,
    prospective: {
      marketId,
      buy: true,
      tick: created.tick,
      continuousFeeCap: created.continuousFeeCap
    },
    replacedGroupIds: new Set([...marketGroupIds, ...ownership.bootstrapGroupIds]),
    book,
    minimumRateBps: config.minimumRateBps,
    maximumRateBps: config.maximumRateBps,
    toProspectiveBookOffer: (offer, exactTick): BootstrapCrossBookOffer => {
      created = project(offer, exactTick)
      return {
        marketId: offer.marketId,
        buy: true,
        tick: created.tick,
        continuousFeeCap: created.continuousFeeCap,
        tickSpacing: BigInt(market.tickSpacing),
        ...(exactTick === undefined
          ? {}
          : {
              effectiveRateWad: TickLib.tickToApr(
                created.tick,
                BigInt(market.params.maturity) - now
              )
            })
      }
    }
  })
  const configured = new Set(parameters.v0OfferGroupIds.map(id => id.toLowerCase()))
  const refuseUnowned = (kept?: Hex) => {
    if ([...marketGroupIds].some(id => id !== kept && configured.has(id.toLowerCase())))
      throw new BootstrapAdapterError('unowned-group')
  }
  if (!resolved) {
    refuseUnowned()
    return {}
  }
  const retained = activeGroups.find(
    group =>
      group.marketId === marketId &&
      group.assets === resolved.offer.assets &&
      group.tick === created.tick &&
      group.offerCount === 1 &&
      group.continuousFeeCap !== undefined &&
      group.continuousFeeCap === created.continuousFeeCap
  )
  refuseUnowned(retained?.id)
  if (retained) return { offer: resolved.offer, retainedGroupId: retained.id }
  return {
    offer: resolved.offer,
    created,
    reservedLoanAssets: exposure
      .filter(group => !marketGroupIds.has(group.groupId))
      .reduce((total, group) => total + group.remainingCashAssets, 0n)
  }
}
