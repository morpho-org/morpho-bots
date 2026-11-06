import type { Hex } from 'viem'

import type { BootstrapOffer, ValidBootstrapConfig } from '../../domain/position-bootstrap'
import type { BootstrapActiveGroup } from '../../infrastructure/bootstrap/bootstrap-groups.utils'
import type { MakerOfferGroup } from '../../infrastructure/provider/offer-groups.utils'
import type { ExposureGroup, ExposureSnapshot } from './exposure'
import type { BootstrapReading, Read } from './readings'
import type { WorldAccounting, WorldOwnership, WorldReading } from './world'

import { acceptedLossFactorOf } from '../../domain/loss-factor'
import { BootstrapAdapterError } from '../../errors'
import {
  bootstrapGroupRateBps,
  strategyBootstrapGroups
} from '../../infrastructure/bootstrap/bootstrap-groups.utils'
import {
  bootstrapContinuousFeeCap,
  bootstrapRateWindowIsEmpty
} from '../../infrastructure/bootstrap/bootstrap-offer.utils'
import { spendableCash } from './exposure'
import { derive, strategyRead, valueOf } from './world'

/**
 * The owned bootstrap groups still live at one block, indexed or pending, each with its remaining
 * assets from that block's {@link ExposureGroup}s.
 * @param parameters - The block's exposure groups, indexed groups, ownership, and timestamp.
 * @returns Live owned bootstrap groups; a group with no remaining assets is omitted.
 */
export const bootstrapActiveGroups = (parameters: {
  exposure: readonly ExposureGroup[]
  groups: readonly MakerOfferGroup[]
  ownership: WorldOwnership
  timestamp: bigint
}): BootstrapActiveGroup[] => {
  const { groups, ownership } = parameters
  const remaining = new Map(
    parameters.exposure.map(group => [group.groupId, group.remainingAssets])
  )
  const intended = new Map(
    ownership.bootstrapOffers.map(offer => [`${offer.groupId}:${offer.marketId}`, offer] as const)
  )
  const indexedIds = new Set(groups.map(group => group.id))
  const indexed = strategyBootstrapGroups(groups, ownership.bootstrapGroupIds).flatMap(
    (group): BootstrapActiveGroup[] => {
      const assets = remaining.get(group.id) ?? 0n
      if (assets === 0n) return []
      const groupMarketId = group.marketId as Hex
      const persisted = intended.get(`${group.id}:${groupMarketId}`)
      return [
        {
          id: group.id,
          marketId: groupMarketId,
          assets,
          tick: group.tick as bigint,
          maximumAssets: group.cap.maximum,
          offerCount: group.offers.length,
          continuousFeeCap: group.continuousFeeCap,
          rateBps:
            persisted?.rateBps ??
            bootstrapGroupRateBps({
              tick: group.tick as bigint,
              maturity: group.maturity as bigint,
              observedTimestamp: parameters.timestamp
            }),
          ...(persisted ? { referenceObservationId: persisted.referenceObservationId } : {})
        }
      ]
    }
  )
  const pending = ownership.bootstrapOffers
    .filter(offer => !indexedIds.has(offer.groupId))
    .flatMap(({ groupId, ...offer }): BootstrapActiveGroup[] => {
      const assets = remaining.get(groupId) ?? 0n
      return assets === 0n
        ? []
        : [{ id: groupId, ...offer, maximumAssets: offer.assets, assets, offerCount: 1 }]
    })
  return [...indexed, ...pending]
}

/** Every buy reservation the snapshot holds, once per market it reserves. */
const cashReservations = (snapshot: ExposureSnapshot) =>
  snapshot.groups
    .filter(group => group.remainingAssets > 0n)
    .flatMap(group =>
      group.marketIds.map(marketId => ({
        id: group.groupId,
        marketId,
        assets: group.remainingAssets
      }))
    )

const distinct = <T extends { id: Hex }>(groups: readonly T[]) => [
  ...new Map(groups.map(group => [group.id, group])).values()
]

/**
 * One market's position, cash after every other reservation, exposures, active offer, and whether
 * duplicate or stale groups require reconciliation, at the world's block.
 */
const bootstrapPosition = (input: {
  world: WorldReading
  exposure: Read<ExposureSnapshot>
  config: ValidBootstrapConfig
  accounting: WorldAccounting
}) => {
  const { world, config } = input
  const { marketId } = config
  const snapshot = valueOf(input.exposure)
  const groups = valueOf(strategyRead(world.groups, 'bootstrap'))
  const activeGroups = bootstrapActiveGroups({
    exposure: snapshot.groups,
    groups,
    ownership: world.ownership,
    timestamp: snapshot.timestamp
  })
  const marketRead = world.positions[marketId]
  if (!marketRead) throw new BootstrapAdapterError('position-unavailable')
  const market = valueOf(strategyRead(marketRead, 'bootstrap'))
  const marketContinuousFeeCap = bootstrapContinuousFeeCap(market)
  const terms = { params: { maturity: market.maturity }, tickSpacing: market.tickSpacing }
  const position = snapshot.positions.find(item => item.marketId === marketId)
  if (!position) throw new BootstrapAdapterError('position-unavailable')
  const uniqueGroups = distinct(activeGroups)
  const marketGroups = distinct(activeGroups.filter(group => group.marketId === marketId))
  const activeGroup = marketGroups[0]
  const remainingBootstrapGroups = activeGroup
    ? uniqueGroups.filter(group => group.id !== activeGroup.id)
    : uniqueGroups
  const bootstrapGroupIds = new Set(uniqueGroups.map(group => group.id))
  const otherReservations = cashReservations(snapshot).filter(
    group => !bootstrapGroupIds.has(group.id)
  )
  const replacementGroups = [...remainingBootstrapGroups, ...distinct(otherReservations)]
  const reservedByMarket = distinct(
    [...remainingBootstrapGroups, ...otherReservations].filter(group => group.marketId === marketId)
  ).reduce((total, group) => total + group.assets, 0n)
  const reservedCash = replacementGroups.reduce((total, group) => total + group.assets, 0n)
  const cashBalance = spendableCash(snapshot)
  const activeOffer: BootstrapOffer | undefined = activeGroup
    ? {
        marketId,
        assets: activeGroup.assets,
        rateBps: activeGroup.rateBps,
        referenceObservationId: activeGroup.referenceObservationId ?? `group:${activeGroup.id}`
      }
    : undefined
  return {
    maturityTimestamp: market.maturity,
    observedTimestamp: world.timestamp,
    rateWindowEmpty: bootstrapRateWindowIsEmpty(terms, {
      now: world.timestamp,
      minimumRateBps: config.minimumRateBps,
      maximumRateBps: config.maximumRateBps
    }),
    credit: position.credit,
    debt: position.debt,
    lossFactor: {
      lossFactor: position.lossFactor,
      ...acceptedLossFactorOf(input.accounting.acceptedLossFactor, marketId)
    },
    cashBalance: cashBalance > reservedCash ? cashBalance - reservedCash : 0n,
    marketExposure: position.credit + reservedByMarket,
    totalExposure:
      snapshot.positions.reduce((total, item) => total + item.credit, 0n) + reservedCash,
    ...(activeOffer ? { activeOffer } : {}),
    requiresReconciliation:
      marketGroups.length > 1 ||
      marketGroups.some(
        group =>
          (group.offerCount !== undefined && group.offerCount !== 1) ||
          group.continuousFeeCap !== marketContinuousFeeCap
      )
  }
}

/**
 * One bootstrap market's reading from one world poll.
 * @param input - The world reading, exposure snapshot, market config, accounting, and target flag.
 * @returns The market's reading; a failed position derivation is carried as a failed read.
 */
export const bootstrapReading = (input: {
  world: WorldReading
  exposure: Read<ExposureSnapshot>
  config: ValidBootstrapConfig
  accounting: WorldAccounting
  /** Whether an earlier poll of this run saw the market reach its initial target. */
  initialTargetCompleted: boolean
}): BootstrapReading => ({
  strategy: 'bootstrap',
  marketId: input.config.marketId,
  block: input.world.block,
  position: derive(() => bootstrapPosition(input)),
  initialTargetCompleted: input.initialTargetCompleted
})
