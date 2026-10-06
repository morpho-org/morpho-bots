import type { Address, Hex, HttpTransport, PublicClient } from 'viem'

import { MAX_OFFER_CAP, midnightAbi } from '@morpho-org/midnight-sdk'
import { bigintMin, delay } from '@repo/utils'
import { erc20Abi, getAbiItem } from 'viem'

import type { OperatorAdapterErrorClass } from '../../application/monitoring/operator-error-name.utils'
import type { supportedChain } from '../../config/supported-chains.utils'
import type { OfferCap } from '../../domain/offer-cap'
import type { BootstrapOffer } from '../../domain/position-bootstrap'
import type { OwnedLadderPublication } from '../ladder/ladder-group-ownership.utils'
import type { MakerOfferGroup } from '../provider/offer-groups.utils'

import { MAX_LOSS_FACTOR } from '../../domain/loss-factor'
import { remainingBuyAssets, remainingCap } from '../../domain/offer-cap'
import { PROVIDER_READ_ATTEMPTS, providerBackoffDelayMs } from '../provider/provider-retry.utils'

/** A durably recorded buy group; `maxUnits` is absent when no intent was persisted for it. */
export type DurableBuyReservation = { groupId: Hex; marketIds: readonly Hex[]; maxUnits?: bigint }

/**
 * One known maker buy group's cash reservation at the snapshot block.
 * @remarks `cancelled` groups hold the protocol cancellation sentinel. `indexed-live` groups take
 * their cap from the indexer and `reserved-pending` groups from persisted intent; both take
 * consumption from the chain at the snapshot block. `remainingAssets` is the group's remaining
 * credit units, its exposure; `remainingCashAssets` is its {@link remainingBuyAssets} at its indexed
 * buy ticks.
 */
export type ExposureGroup = {
  groupId: Hex
  marketIds: readonly Hex[]
  state: 'cancelled' | 'indexed-live' | 'reserved-pending'
  remainingAssets: bigint
  remainingCashAssets: bigint
}

/** One exposure market's accrued position and its loss factor at the snapshot block. */
export type ExposurePosition = { marketId: Hex; credit: bigint; debt: bigint; lossFactor: bigint }

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
 * Loan-token cash a new buy can draw; both writers size buys from it.
 * @param snapshot - Wallet balance and remaining Midnight allowance at one block.
 * @returns The lesser of the two, since a fill pulls through `transferFrom`.
 */
export const spendableCash = (snapshot: Pick<ExposureSnapshot, 'cashBalance' | 'allowance'>) =>
  bigintMin(snapshot.cashBalance, snapshot.allowance)

/** Block-pinned chain reads a snapshot is assembled from. */
export interface ExposureSnapshotReader {
  /**
   * Reads the current head.
   * @returns Head number and timestamp.
   * @throws When the provider cannot return the head.
   */
  readLatestBlock(): Promise<{ number: bigint; timestamp: bigint }>
  /**
   * Reads every exposure market's position accrued to the block timestamp, and its loss factor.
   * @param block - Snapshot block.
   * @returns One accrued position per exposure market.
   * @throws When any position read fails.
   */
  readPositions(block: { number: bigint; timestamp: bigint }): Promise<readonly ExposurePosition[]>
  /**
   * Reads the maker's loan-token balance and protocol allowance.
   * @param blockNumber - Snapshot block.
   * @returns Balance and allowance at that block.
   * @throws When either read fails.
   */
  readCash(blockNumber: bigint): Promise<{ cashBalance: bigint; allowance: bigint }>
  /**
   * Reads protocol consumption for every group in one batch.
   * @param groupIds - Groups to read, in order.
   * @param blockNumber - Snapshot block.
   * @returns Consumption in the same order as `groupIds`.
   * @throws When any read fails.
   */
  readConsumed(groupIds: readonly Hex[], blockNumber: bigint): Promise<readonly bigint[]>
}

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
    const durableCap =
      reservation.maxUnits === undefined
        ? undefined
        : { kind: 'units' as const, maximum: reservation.maxUnits }
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
 * Projects durable ownership into the buy reservations a snapshot must count.
 * @param parameters - Ladder publications and bootstrap owned IDs with their persisted intents.
 * @returns Higher-side ladder groups and every owned bootstrap group, with persisted caps when known.
 */
export const durableBuyReservations = (parameters: {
  ladderPublications: readonly OwnedLadderPublication[]
  bootstrapGroupIds: readonly Hex[]
  bootstrapOffers: readonly (BootstrapOffer & { groupId: Hex })[]
}): DurableBuyReservation[] => {
  const ladder = parameters.ladderPublications.flatMap(publication =>
    publication.groups
      .filter(group => group.side === 'higher')
      .map(group => {
        const indexes = new Set(group.rungIndexes)
        return {
          groupId: group.groupId,
          marketIds: [publication.marketId],
          maxUnits: publication.quote.higher
            .filter(rung => indexes.has(rung.index))
            .reduce((sum, rung) => sum + rung.assets, 0n)
        }
      })
  )
  const offers = new Map(parameters.bootstrapOffers.map(offer => [offer.groupId, offer]))
  const bootstrap = [...new Set([...parameters.bootstrapGroupIds, ...offers.keys()])].map(
    groupId => {
      const offer = offers.get(groupId)
      return offer
        ? { groupId, marketIds: [offer.marketId], maxUnits: offer.assets }
        : { groupId, marketIds: [] }
    }
  )
  return [...ladder, ...bootstrap]
}

/**
 * Derives a snapshot's minimum block from the cancellation receipts a replacement confirmed.
 * @param blocks - Receipt block of every confirmed cancellation.
 * @returns The latest receipt block as `minimumBlockNumber`, or nothing when none confirmed.
 */
export const minimumBlockAfter = (blocks: readonly bigint[]) =>
  blocks.length === 0
    ? {}
    : { minimumBlockNumber: blocks.reduce((latest, block) => (block > latest ? block : latest)) }

/**
 * Polls the head until it reaches a minimum block, with the provider read retry budget.
 * @param parameters - Head reader, optional minimum block, and the strategy's adapter error.
 * @returns The first head at or after `minimumBlockNumber`, or the current head without one.
 * @throws `snapshot-unavailable` when the head stays behind after every attempt; head read
 * failures propagate unchanged.
 */
export const waitForMinimumBlock = async (parameters: {
  readLatestBlock: ExposureSnapshotReader['readLatestBlock']
  minimumBlockNumber?: bigint
  adapterError: OperatorAdapterErrorClass
}) => {
  for (let attempt = 1; ; attempt += 1) {
    const block = await parameters.readLatestBlock()
    if (
      parameters.minimumBlockNumber === undefined ||
      block.number >= parameters.minimumBlockNumber
    )
      return block
    if (attempt >= PROVIDER_READ_ATTEMPTS) {
      throw new parameters.adapterError('snapshot-unavailable')
    }
    await delay(providerBackoffDelayMs(attempt))
  }
}

/**
 * Reads accrued credit, cash, allowance, and every known buy group's remaining reservation at one
 * block at or after `minimumBlockNumber`.
 * @param parameters - Chain reader, indexed maker groups, durable reservations, optional minimum
 * block, and the strategy's adapter error.
 * @returns A coherent exposure snapshot.
 * @throws `snapshot-unavailable` when the head never reaches the minimum block,
 * `missing-owned-group-intent` for an unindexed, uncancelled durable group without a persisted cap,
 * `group-ownership-state` when the indexer and durable intent disagree on a group's cap kind,
 * `cash-capped-buy-group` while any known cash-capped buy is not cancelled,
 * `loss-factor-read` for a loss factor that is not a uint128, and any provider read failure.
 * @remarks Every indexed maker buy group counts, attributed to a strategy or not: each commits maker
 * cash whether or not durable ownership still records it. Only immutable facts (ids, caps, markets)
 * come from the indexer; consumption always comes from the chain at the snapshot block. When both
 * the indexer and durable intent state a group's cap, the larger one is reserved. Face limits are
 * only enforceable against units-capped buys: a cash-capped buy stays takeable for fills that round
 * to zero assets even once its cap is used up, so only its cancellation ends it.
 */
export const readExposureSnapshot = async (parameters: {
  reader: ExposureSnapshotReader
  indexedGroups: readonly MakerOfferGroup[]
  durableReservations: readonly DurableBuyReservation[]
  minimumBlockNumber?: bigint
  adapterError: OperatorAdapterErrorClass
}): Promise<ExposureSnapshot> => {
  const block = await waitForMinimumBlock({
    readLatestBlock: () => parameters.reader.readLatestBlock(),
    ...(parameters.minimumBlockNumber === undefined
      ? {}
      : { minimumBlockNumber: parameters.minimumBlockNumber }),
    adapterError: parameters.adapterError
  })
  const known = knownBuyGroups(
    parameters.indexedGroups,
    parameters.durableReservations,
    parameters.adapterError
  )
  const groupIds = [...known.keys()]
  const [positions, cash, consumed] = await Promise.all([
    parameters.reader.readPositions(block),
    parameters.reader.readCash(block.number),
    groupIds.length === 0
      ? Promise.resolve([])
      : parameters.reader.readConsumed(groupIds, block.number)
  ])
  if (consumed.length !== groupIds.length) {
    throw new parameters.adapterError('group-consumption-read')
  }
  if (
    positions.some(
      position =>
        typeof position.lossFactor !== 'bigint' ||
        position.lossFactor < 0n ||
        position.lossFactor > MAX_LOSS_FACTOR
    )
  ) {
    throw new parameters.adapterError('loss-factor-read')
  }
  const groups = groupIds.map((groupId, index): ExposureGroup => {
    const group = known.get(groupId)!
    const groupConsumed = consumed[index]!
    if (groupConsumed === MAX_OFFER_CAP) {
      return {
        groupId,
        marketIds: group.marketIds,
        state: 'cancelled',
        remainingAssets: 0n,
        remainingCashAssets: 0n
      }
    }
    if (group.cap === undefined) {
      throw new parameters.adapterError('missing-owned-group-intent')
    }
    if (group.cap.kind === 'assets') throw new parameters.adapterError('cash-capped-buy-group')
    return {
      groupId,
      marketIds: group.marketIds,
      state: group.indexed ? 'indexed-live' : 'reserved-pending',
      remainingAssets: remainingCap(group.cap, groupConsumed),
      remainingCashAssets: remainingBuyAssets(group.cap, groupConsumed, group.buyTicks)
    }
  })
  return {
    blockNumber: block.number,
    timestamp: block.timestamp,
    cashBalance: cash.cashBalance,
    allowance: cash.allowance,
    positions,
    groups
  }
}

const consumedAbi = [getAbiItem({ abi: midnightAbi, name: 'consumed' })]

/**
 * Builds the production snapshot reader over one viem client.
 * @param parameters - Public client, Midnight position reader, maker, contracts, and exposure markets.
 * @returns A reader pinning every position, loss factor, balance, allowance, and consumption read to
 * its block.
 */
export const createExposureSnapshotReader = (parameters: {
  client: Pick<
    PublicClient<HttpTransport, ReturnType<typeof supportedChain>>,
    'getBlock' | 'readContract' | 'multicall'
  >
  positions: {
    getPositionData(request: {
      marketId: Hex
      accountAddress: Address
      parameters: { blockNumber: bigint }
    }): Promise<{
      market: { lossFactor: bigint }
      accrueInterest(timestamp: bigint): { credit: bigint; debt: bigint }
    }>
  }
  maker: Address
  midnight: Address
  loanAsset: Address
  marketIds: readonly Hex[]
}): ExposureSnapshotReader => ({
  readLatestBlock: async () => {
    const block = await parameters.client.getBlock({ blockTag: 'latest' })
    return { number: block.number, timestamp: block.timestamp }
  },
  readPositions: block =>
    Promise.all(
      parameters.marketIds.map(async marketId => {
        const data = await parameters.positions.getPositionData({
          marketId,
          accountAddress: parameters.maker,
          parameters: { blockNumber: block.number }
        })
        const position = data.accrueInterest(block.timestamp)
        return {
          marketId,
          credit: position.credit,
          debt: position.debt,
          lossFactor: data.market.lossFactor
        }
      })
    ),
  readCash: async blockNumber => {
    const [cashBalance, allowance] = await Promise.all([
      parameters.client.readContract({
        address: parameters.loanAsset,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [parameters.maker],
        blockNumber
      }),
      parameters.client.readContract({
        address: parameters.loanAsset,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [parameters.maker, parameters.midnight],
        blockNumber
      })
    ])
    return { cashBalance, allowance }
  },
  readConsumed: (groupIds, blockNumber) =>
    parameters.client.multicall({
      contracts: groupIds.map(
        groupId =>
          ({
            address: parameters.midnight,
            abi: consumedAbi,
            functionName: 'consumed',
            args: [parameters.maker, groupId]
          }) as const
      ),
      allowFailure: false,
      blockNumber
    })
})
