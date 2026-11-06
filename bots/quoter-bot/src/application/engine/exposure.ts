import type { Hex } from 'viem'

import { MAX_OFFER_CAP } from '@morpho-org/midnight-sdk'
import { bigintMin } from '@repo/utils'

import type { LadderDebtConfig, LoanCollateral } from '../../domain/debt-ceiling'
import type { OfferCap } from '../../domain/offer-cap'
import type { MakerOfferGroup } from '../../infrastructure/provider/offer-groups.utils'
import type { OperatorAdapterErrorClass } from '../monitoring/operator-error-name.utils'
import type { Read } from './readings'
import type { WorldAccounting, WorldOwnership, WorldReading } from './world'

import { debtCeilingUnits, debtHeadroomUnits } from '../../domain/debt-ceiling'
import { MAX_LOSS_FACTOR } from '../../domain/loss-factor'
import { borrowingOpen } from '../../domain/market-maturity'
import { remainingBuyAssets, remainingCap } from '../../domain/offer-cap'
import { calculateLadderCapacities } from '../../infrastructure/ladder/ladder-capacity.utils'
import { strategyRead, valueOf } from './world'

/** A recorded buy group; its cap is absent when no intent was recorded for it. */
type DurableBuyReservation = { groupId: Hex; marketIds: readonly Hex[]; cap?: OfferCap }

/**
 * One known maker buy group's cash reservation at the snapshot block.
 * @remarks `cancelled` groups hold the protocol cancellation sentinel, and `retired` groups are
 * ones the kernel retired at finality (`WorldOwnership.retiredGroupIds`); neither reserves
 * anything. `indexed-live` groups take
 * their cap from the indexer and `reserved-pending` groups from persisted intent; both take
 * consumption from the chain at the snapshot block. `remainingAssets` is the group's remaining
 * credit units, its exposure; `remainingCashAssets` is its {@link remainingBuyAssets} at its indexed
 * buy ticks.
 */
export type ExposureGroup = {
  groupId: Hex
  marketIds: readonly Hex[]
  state: 'cancelled' | 'retired' | 'indexed-live' | 'reserved-pending'
  remainingAssets: bigint
  remainingCashAssets: bigint
}

/** One exposure market's accrued position and its loss factor at the snapshot block. */
export type ExposurePosition = {
  marketId: Hex
  credit: bigint
  debt: bigint
  lossFactor: bigint
  loanCollateral?: LoanCollateral
}

/** Accrued credit, cash, allowance, and every known buy group's reservation at one block. */
export type ExposureSnapshot = {
  blockNumber: bigint
  timestamp: bigint
  cashBalance: bigint
  allowance: bigint
  positions: readonly ExposurePosition[]
  groups: readonly ExposureGroup[]
}

/**
 * Loan-token cash a new buy can draw; both strategies size buys from it.
 * @param snapshot - The maker's loan-token balance and allowance at one block.
 * @returns The lesser of balance and allowance, since a fill pulls through `transferFrom`.
 */
export const spendableCash = (snapshot: Pick<ExposureSnapshot, 'cashBalance' | 'allowance'>) =>
  bigintMin(snapshot.cashBalance, snapshot.allowance)

type KnownBuyGroup = {
  marketIds: readonly Hex[]
  buyTicks: readonly bigint[]
  cap?: OfferCap
  indexed: boolean
}

const addMarkets = (existing: readonly Hex[] | undefined, added: readonly Hex[]) => [
  ...new Set([...(existing ?? []), ...added])
]

const reconciledCap = (
  indexed: OfferCap | undefined,
  durable: OfferCap | undefined,
  adapterError: OperatorAdapterErrorClass
) => {
  if (indexed === undefined || durable === undefined) return indexed ?? durable
  if (indexed.kind !== durable.kind) throw new adapterError('group-ownership-state')
  return indexed.maximum >= durable.maximum ? indexed : durable
}

const knownBuyGroups = (
  indexedGroups: readonly MakerOfferGroup[],
  durableReservations: readonly DurableBuyReservation[],
  adapterError: OperatorAdapterErrorClass
) => {
  const indexedIds = new Set(indexedGroups.map(group => group.id))
  const known = new Map<Hex, KnownBuyGroup>()
  for (const group of indexedGroups) {
    const buys = group.offers.filter(offer => offer.buy)
    if (buys.length === 0) continue
    const previous = known.get(group.id)
    known.set(group.id, {
      marketIds: addMarkets(previous?.marketIds, buys.map(offer => offer.marketId)),
      buyTicks: [...(previous?.buyTicks ?? []), ...buys.map(offer => offer.tick)],
      cap: group.cap,
      indexed: true
    })
  }
  for (const reservation of durableReservations) {
    const previous = known.get(reservation.groupId)
    const durableCap = reservation.cap
    if (indexedIds.has(reservation.groupId)) {
      if (previous) previous.cap = reconciledCap(previous.cap, durableCap, adapterError)
      continue
    }
    const cap = reconciledCap(previous?.cap, durableCap, adapterError)
    known.set(reservation.groupId, {
      marketIds: addMarkets(previous?.marketIds, reservation.marketIds),
      buyTicks: previous?.buyTicks ?? [],
      ...(cap === undefined ? {} : { cap }),
      indexed: false
    })
  }
  return known
}

/**
 * Higher-side ladder groups, every owned bootstrap group, and every buy group the kernel holds, with
 * persisted caps when known.
 */
const durableBuyReservations = (ownership: WorldOwnership): DurableBuyReservation[] => {
  const ladder = ownership.ladderPublications.flatMap(publication =>
    publication.groups
      .filter(group => group.side === 'higher')
      .map(group => {
        const indexes = new Set(group.rungIndexes)
        return {
          groupId: group.groupId,
          marketIds: [publication.marketId],
          cap: {
            kind: 'units' as const,
            maximum: publication.quote.higher
              .filter(rung => indexes.has(rung.index))
              .reduce((sum, rung) => sum + rung.assets, 0n)
          }
        }
      })
  )
  const offers = new Map(ownership.bootstrapOffers.map(offer => [offer.groupId, offer]))
  const bootstrap = [...new Set([...ownership.bootstrapGroupIds, ...offers.keys()])].map(
    groupId => {
      const offer = offers.get(groupId)
      return offer
        ? {
            groupId,
            marketIds: [offer.marketId],
            cap: { kind: 'units' as const, maximum: offer.assets }
          }
        : { groupId, marketIds: [] }
    }
  )
  const named = new Set([...ladder, ...bootstrap].map(reservation => reservation.groupId))
  const held = ownership.heldBuyGroups.filter(group => !named.has(group.groupId))
  return [...ladder, ...bootstrap, ...held]
}

/**
 * Every known maker buy group's remaining reservation at the block `consumed` was read at.
 * @param indexedGroups - The maker's groups as the API indexes them.
 * @param ownership - Durable ownership: the strategies' recorded groups and intents.
 * @param adapterError - Operator error class to throw on an inconsistent or missing read.
 * @returns A validator that applies that block's consumption to the groups known now.
 * @throws `group-ownership-state` at once when the indexer and durable intent disagree on a group's
 * cap kind; the validator throws `missing-owned-group-intent` for an unindexed, unretired,
 * uncancelled durable group without a persisted cap, `cash-capped-buy-group` while any known
 * cash-capped buy is not cancelled, retired or not, and `group-consumption-read` for a known group
 * whose consumption was not read.
 * @remarks Every indexed maker buy group counts, attributed to a strategy or not: each commits maker
 * cash whether or not durable ownership still records it. Only immutable facts (ids, caps, markets)
 * come from the indexer; consumption always comes from the chain. When both the indexer and durable
 * intent state a group's cap, the larger one is reserved. Face limits are only enforceable against
 * units-capped buys: a cash-capped buy stays takeable for fills that round to zero assets even once
 * its cap is used up, so only its cancellation ends it.
 */
export const exposureGroups = (
  indexedGroups: readonly MakerOfferGroup[],
  ownership: WorldOwnership,
  adapterError: OperatorAdapterErrorClass
) => {
  const known = knownBuyGroups(indexedGroups, durableBuyReservations(ownership), adapterError)
  const retired = new Set(ownership.retiredGroupIds)
  return (consumed: Readonly<Record<string, bigint>>) =>
    [...known].map(([groupId, group]): ExposureGroup => {
      const ended = (state: 'cancelled' | 'retired'): ExposureGroup => ({
        groupId,
        marketIds: group.marketIds,
        state,
        remainingAssets: 0n,
        remainingCashAssets: 0n
      })
      if (!Object.hasOwn(consumed, groupId)) throw new adapterError('group-consumption-read')
      const groupConsumed = consumed[groupId]!
      if (groupConsumed === MAX_OFFER_CAP) return ended('cancelled')
      if (group.cap?.kind === 'assets') throw new adapterError('cash-capped-buy-group')
      if (retired.has(groupId)) return ended('retired')
      if (group.cap === undefined) throw new adapterError('missing-owned-group-intent')
      return {
        groupId,
        marketIds: group.marketIds,
        state: group.indexed ? 'indexed-live' : 'reserved-pending',
        remainingAssets: remainingCap(group.cap, groupConsumed),
        remainingCashAssets: remainingBuyAssets(group.cap, groupConsumed, group.buyTicks)
      }
    })
}

/**
 * Accrued credit, cash, allowance, and every known buy group's remaining reservation at the world's
 * block.
 * @param world - One world poll's reading.
 * @param accounting - The markets whose positions count toward exposure.
 * @param adapterError - Operator error class to throw on a missing or invalid read.
 * @returns The snapshot at the world's block.
 * @throws The first failed read it needs, what {@link exposureGroups} throws, and
 * `loss-factor-read` for a loss factor that is not a uint128.
 */
export const exposureSnapshot = (
  world: WorldReading,
  accounting: Pick<WorldAccounting, 'marketIds'>,
  adapterError: OperatorAdapterErrorClass
): ExposureSnapshot => {
  const own = <T>(read: Read<T>) => valueOf(strategyRead(read, world.strategy))
  const reservations = exposureGroups(own(world.groups), world.ownership, adapterError)
  const positions = accounting.marketIds.map(marketId => {
    const position = world.positions[marketId]
    if (!position) throw new adapterError('position-unavailable')
    const { credit, debt, lossFactor, loanCollateral } = own(position)
    return {
      marketId,
      credit,
      debt,
      lossFactor,
      ...(loanCollateral === undefined ? {} : { loanCollateral })
    }
  })
  const cash = own(world.cash)
  const consumed = own(world.consumed)
  if (
    positions.some(
      position =>
        typeof position.lossFactor !== 'bigint' ||
        position.lossFactor < 0n ||
        position.lossFactor > MAX_LOSS_FACTOR
    )
  )
    throw new adapterError('loss-factor-read')
  const groups = reservations(consumed)
  return {
    blockNumber: BigInt(world.block),
    timestamp: world.timestamp,
    cashBalance: cash.cashBalance,
    allowance: cash.allowance,
    positions,
    groups
  }
}

/**
 * Derives ladder capacities from one snapshot, reserving every live group but `excludedGroupIds`.
 * @param snapshot - Exposure at the assessed block.
 * @param parameters - The market, error class, groups not to reserve, exposure limits in loan
 * assets, and the market's maturity.
 * @returns The market's ladder capacities; while {@link borrowingOpen} at the snapshot, sells use
 * debt headroom alone, since fees or slashing can erase credit before a fill. Replaced sells are
 * cancelled before publication.
 * @throws `position-unavailable` when the snapshot holds no position for the market.
 */
export const snapshotLadderCapacities = (
  snapshot: ExposureSnapshot,
  parameters: {
    marketId: Hex
    adapterError: OperatorAdapterErrorClass
    excludedGroupIds: ReadonlySet<Hex>
    targetMarketExposureAssets: bigint
    maximumTotalExposureAssets: bigint
    debt?: LadderDebtConfig
    maturity?: bigint
  }
) => {
  const position = snapshot.positions.find(item => item.marketId === parameters.marketId)
  if (!position) throw new parameters.adapterError('position-unavailable')
  const capacities = calculateLadderCapacities({
    marketId: parameters.marketId,
    balance: spendableCash(snapshot),
    walletBalance: snapshot.cashBalance,
    currentCredit: position.credit,
    otherMarketCredit: snapshot.positions
      .filter(item => item.marketId !== parameters.marketId)
      .reduce((sum, item) => sum + item.credit, 0n),
    creditSaleCapacityAssets: position.credit,
    targetMarketExposureAssets: parameters.targetMarketExposureAssets,
    maximumTotalExposureAssets: parameters.maximumTotalExposureAssets,
    reservations: snapshot.groups
      .filter(
        group => group.remainingAssets > 0n && !parameters.excludedGroupIds.has(group.groupId)
      )
      .map(group => ({
        id: group.groupId,
        marketIds: group.marketIds,
        assets: group.remainingAssets,
        cashAssets: group.remainingCashAssets
      }))
  })
  if (parameters.debt === undefined) return capacities
  const open = borrowingOpen(parameters.debt, {
    maturityTimestamp: parameters.maturity,
    observedTimestamp: snapshot.timestamp
  })
  return {
    ...capacities,
    ...(open ? { lowerRateCapacityAssets: debtHeadroomUnits(parameters.debt, position) } : {}),
    debtAssets: position.debt,
    debtCeilingAssets: debtCeilingUnits(parameters.debt, position.loanCollateral)
  }
}
