import type { Hex } from 'viem'

import type { LadderMarketState, ValidLadderConfig } from '../../domain/ladder'
import type { BootstrapActiveGroup } from '../../infrastructure/bootstrap/bootstrap-groups.utils'
import type { ExposureSnapshot } from './exposure'
import type { LadderReading, Read } from './readings'
import type { WorldAccounting, WorldReading } from './world'

import { acceptedLossFactorOf, lendHalt, MAX_LOSS_FACTOR } from '../../domain/loss-factor'
import { LadderAdapterError } from '../../errors'
import {
  activeOwnedLadderGroupIds,
  ownedLadderGroupConsumption,
  reconstructOwnedLadderPublication
} from '../../infrastructure/ladder/ladder-active-publication.utils'
import { ladderBookCrossing } from '../../infrastructure/ladder/ladder-cross-book.utils'
import { snapshotRateWindow } from '../../infrastructure/ladder/ladder-offer.utils'
import { bootstrapActiveGroups } from './bootstrap-state'
import { completeBook, consumedAtBlock } from './complete-book'
import { snapshotLadderCapacities } from './exposure'
import { derive, strategyRead, valueOf } from './world'

/**
 * The lowest rate among the live own-bootstrap buys in one market, at the world's block: the binding
 * one, since every ladder sell must clear every own buy.
 * @remarks An indexed group with no persisted intent is rated from its tick, which is zero once its
 * market matured; such a group no longer binds.
 */
const lowestBootstrapBuyRateBps = (
  active: readonly BootstrapActiveGroup[],
  marketId: Hex
): bigint | undefined =>
  active
    .filter(
      group =>
        group.marketId === marketId &&
        (group.referenceObservationId !== undefined || group.rateBps > 0n)
    )
    .reduce<bigint | undefined>(
      (lowest, { rateBps }) => (lowest === undefined || rateBps < lowest ? rateBps : lowest),
      undefined
    )

const positionOf = (world: WorldReading, marketId: Hex) => {
  const position = world.positions[marketId]
  if (!position) throw new LadderAdapterError('position-unavailable')
  return valueOf(strategyRead(position, 'ladder'))
}

/** The market's loss factor at the world's block, beside the value the operator accepted. */
const lendGuard = (world: WorldReading, marketId: Hex, accounting: WorldAccounting) => {
  const { lossFactor } = positionOf(world, marketId)
  if (typeof lossFactor !== 'bigint' || lossFactor > MAX_LOSS_FACTOR)
    throw new LadderAdapterError('loss-factor-read')
  return { lossFactor, ...acceptedLossFactorOf(accounting.acceptedLossFactor, marketId) }
}

/** The market's live ladder, reconstructed from its publications, and its groups' consumption. */
const activeState = (world: WorldReading, marketId: Hex) => {
  const groups = consumedAtBlock(
    valueOf(strategyRead(world.groups, 'ladder')),
    valueOf(world.consumed),
    LadderAdapterError
  )
  const publications = world.ownership.ladderPublications
  const quote = publications
    .filter(item => item.marketId === marketId)
    .toReversed()
    .map(publication => reconstructOwnedLadderPublication(publication, groups))
    .find(item => item !== undefined)
  return {
    ...(quote === undefined ? {} : { quote }),
    consumption: ownedLadderGroupConsumption(publications, groups, marketId)
  }
}

/** Capacities, own-bootstrap ceiling, book crossing, maturity, and rate window, all at one block. */
const marketState = (input: {
  world: WorldReading
  exposure: Read<ExposureSnapshot>
  config: ValidLadderConfig
  accounting: WorldAccounting
}): LadderMarketState => {
  const { world, config, accounting } = input
  const { marketId } = config
  const snapshot = valueOf(input.exposure)
  const groups = valueOf(strategyRead(world.groups, 'ladder'))
  const market = positionOf(world, marketId)
  if (!world.book) throw new LadderAdapterError('market-configuration-missing')
  const wholeBook = valueOf(strategyRead(world.book, 'ladder'))
  const { ladderPublications: publications } = world.ownership
  const now = world.timestamp
  const replacedGroupIds = new Set(
    publications
      .filter(publication => publication.marketId === marketId)
      .flatMap(publication => publication.groups.map(group => group.groupId))
  )
  const bootstrapBuyRateBps = lowestBootstrapBuyRateBps(
    bootstrapActiveGroups({
      exposure: snapshot.groups,
      groups,
      ownership: world.ownership,
      timestamp: now
    }),
    marketId
  )
  const timeToMaturity = market.maturity - now
  const crossing =
    wholeBook === null || timeToMaturity <= 0n
      ? undefined
      : ladderBookCrossing({
          marketId,
          maker: accounting.maker,
          book: completeBook({
            marketId,
            maker: accounting.maker,
            v0OfferGroupIds: accounting.v0OfferGroupIds,
            book: wholeBook,
            groups,
            ownership: world.ownership,
            consumed: valueOf(world.consumed),
            adapterError: LadderAdapterError
          }),
          publications,
          activeLadderGroupIds: new Set(
            activeOwnedLadderGroupIds(
              publications,
              consumedAtBlock(groups, valueOf(world.consumed), LadderAdapterError),
              marketId
            )
          ),
          config,
          timeToMaturity,
          tickSpacing: BigInt(market.tickSpacing)
        })
  return {
    ...snapshotLadderCapacities(snapshot, {
      marketId,
      adapterError: LadderAdapterError,
      excludedGroupIds: replacedGroupIds,
      targetMarketExposureAssets: config.targetMarketExposureAssets,
      maximumTotalExposureAssets: config.maximumTotalExposureAssets,
      ...(config.debt === undefined ? {} : { debt: config.debt, maturity: market.maturity })
    }),
    ...(bootstrapBuyRateBps === undefined ? {} : { bootstrapBuyRateBps }),
    ...(crossing === undefined ? {} : { bookCrossing: crossing }),
    maturityTimestamp: market.maturity,
    observedTimestamp: now,
    ...snapshotRateWindow({
      market: { params: { maturity: market.maturity }, tickSpacing: market.tickSpacing },
      now,
      minimumRateBps: config.minimumRateBps,
      maximumRateBps: config.maximumRateBps,
      minimumOfferAssets: config.minimumOfferAssets
    })
  }
}

/**
 * One ladder market's reading from one world poll, in the readers' order: the lend guard, then,
 * unless it halts lending, the active ladder and the market state.
 * @param input - The world reading, exposure snapshot, market config, and accounting.
 * @returns The market's reading; `active` and `market` are absent while the guard halts lending.
 */
export const ladderReading = (input: {
  world: WorldReading
  exposure: Read<ExposureSnapshot>
  config: ValidLadderConfig
  accounting: WorldAccounting
}): LadderReading => {
  const { world, config } = input
  const guard = derive(() => lendGuard(world, config.marketId, input.accounting))
  const base = {
    strategy: 'ladder' as const,
    marketId: config.marketId,
    block: world.block,
    guard
  }
  const positionFailed = !derive(() => positionOf(world, config.marketId)).ok
  if (!positionFailed && (!guard.ok || lendHalt(guard.value))) return base
  return {
    ...base,
    active: derive(() => activeState(world, config.marketId)),
    market: derive(() => marketState(input))
  }
}
