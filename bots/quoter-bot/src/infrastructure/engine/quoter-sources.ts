import type { KeyedWrite } from '@repo/engine'
import type { Hex } from 'viem'

import type { LiveView } from '../../application/engine/decision'
import type { Read, ReferenceReading } from '../../application/engine/readings'
import type {
  PreparationReading,
  WorldAccounting,
  WorldOwnership,
  WorldValue
} from '../../application/engine/world'
import type { OperatorAdapterErrorClass } from '../../application/monitoring/operator-error-name.utils'
import type { ReferenceMarket, ReferenceRates } from '../reference/reference-rates'
import type { WorldBlock, WorldReads } from './world-reads'

import { marketKey } from '../../application/engine/readings'
import {
  adapterOperationField,
  operatorErrorName
} from '../../application/monitoring/operator-error-name.utils'
import { BootstrapAdapterError, LadderAdapterError } from '../../errors'

/** A reading's validity, in polls: a market that misses this many withdraws its book. */
export const VALID_FOR_READS = 3

/** The kernel head a world read is pinned to, with the block timestamp positions accrue to. */
type WorldHeadAt = Readonly<{ number: number; hash: string; timestamp: bigint }>

/** The read point of one world read, which every chain value of it was read at. */
export type WorldBasis = Readonly<{
  block: number
  blockHash: string
  timestamp: bigint
  /** When the read started, on the runner's clock: how old a reference read beside it may be. */
  readAt: number
}>

/** A configured market, by strategy. */
type QuoterMarket = Readonly<{ strategy: 'ladder' | 'bootstrap'; marketId: Hex }>

const read = async <T>(operation: () => Promise<T>): Promise<Read<T>> => {
  try {
    return { ok: true, value: await operation() }
  } catch (error) {
    return { ok: false, errorName: operatorErrorName(error), ...adapterOperationField(error) }
  }
}

type BookRead = NonNullable<WorldValue['book']>

/** Observing third parties is best-effort: a malformed or timed-out book is no observation. */
const readBook = async (reads: WorldReads, marketId: Hex): Promise<BookRead> => {
  try {
    return { ok: true, value: await reads.readBook(marketId) }
  } catch (error) {
    if (
      error instanceof LadderAdapterError &&
      ['book-response', 'book-timeout'].includes(error.operation)
    )
      return { ok: true, value: null }
    return { ok: false, errorName: operatorErrorName(error), ...adapterOperationField(error) }
  }
}

/** Every group a read knows of: indexed, held by the kernel, or intended. */
const readSetOf = (groups: readonly { id: Hex }[], ownership: WorldOwnership) => [
  ...new Set([
    ...groups.map(group => group.id),
    ...ownership.ladderPublications.flatMap(publication =>
      publication.groups.map(group => group.groupId)
    ),
    ...ownership.bootstrapGroupIds,
    ...ownership.bootstrapOffers.map(offer => offer.groupId),
    ...ownership.heldBuyGroups.map(group => group.groupId)
  ])
]

/** Every group's consumption at one block, by group ID. */
const readConsumedAt = async (
  reads: WorldReads,
  groupIds: readonly Hex[],
  block: WorldBlock,
  adapterError: OperatorAdapterErrorClass
): Promise<Record<string, bigint>> => {
  if (groupIds.length === 0) return {}
  const values = await reads.readConsumed(groupIds, block)
  if (values.length !== groupIds.length) throw new adapterError('group-consumption-read')
  return Object.fromEntries(groupIds.map((groupId, index) => [groupId, values[index]!]))
}

/**
 * One world read, every chain value pinned to the kernel head `at`: the maker's offer groups and
 * each ladder market's book from the API, then every accounting market's position, the maker's
 * cash, and the consumption of every group it knows of, `ownership`'s included. It vouches for every
 * configured market, each with its own entry; a failed read is a failed value in it, and the head's
 * timestamp rides in the basis, never in a value.
 * @param parameters - The kernel head, read time, ownership, live views, readers, markets,
 * accounting, and the write's expiry.
 * @returns A keyed write covering every configured market; read failures are values, not throws.
 */
export const readWorld = async (parameters: {
  at: WorldHeadAt
  readAt: number
  ownership: WorldOwnership
  views: Readonly<Record<string, LiveView>>
  reads: WorldReads
  markets: readonly QuoterMarket[]
  accounting: WorldAccounting
  expiry: number
}): Promise<KeyedWrite<WorldValue, WorldBasis>> => {
  const { at, ownership, reads } = parameters
  const number = BigInt(at.number)
  const block: WorldBlock = { number, hash: at.hash as Hex, timestamp: at.timestamp }
  const ladderMarkets = [
    ...new Set(parameters.markets.filter(m => m.strategy === 'ladder').map(m => m.marketId))
  ]
  const [groups, books] = await Promise.all([
    read(() => reads.readGroups()),
    Promise.all(
      ladderMarkets.map(async marketId => [marketId, await readBook(reads, marketId)] as const)
    )
  ])
  const readSet = readSetOf(groups.ok ? groups.value : [], ownership)
  const [positions, cash, consumed] = await Promise.all([
    Promise.all(
      parameters.accounting.marketIds.map(
        async marketId => [marketId, await read(() => reads.readPosition(marketId, block))] as const
      )
    ),
    read(() => reads.readCash(block)),
    read(() => readConsumedAt(reads, readSet, block, LadderAdapterError))
  ])
  const bookOf = new Map(books)
  const shared = {
    ownership,
    groups,
    positions: Object.fromEntries(positions),
    cash,
    consumed
  }
  const entries = Object.fromEntries(
    parameters.markets.map(({ strategy, marketId }): [string, WorldValue] => [
      marketKey(strategy, marketId),
      {
        ...shared,
        strategy,
        marketId,
        view: parameters.views[marketKey(strategy, marketId)] ?? { live: [] },
        ...(strategy === 'ladder' ? { book: bookOf.get(marketId)! } : {})
      }
    ])
  )
  const basis: WorldBasis = {
    block: at.number,
    blockHash: at.hash,
    timestamp: at.timestamp,
    readAt: parameters.readAt
  }
  return {
    coverage: 'complete',
    entries,
    basis,
    expiry: parameters.expiry,
    ...(parameters.markets.length === 0 && { empty: true as const })
  }
}

/** An adapter failure as the preparing strategy names it, with its operation kept. */
const asStrategyError = (error: unknown, adapterError: OperatorAdapterErrorClass) =>
  error instanceof LadderAdapterError || error instanceof BootstrapAdapterError
    ? new adapterError(error.operation)
    : error

/**
 * One preparation's own read: the maker's holdings, then the latest head with the maker's offer
 * groups and the market's book, then the market and every known group's consumption pinned to
 * that head. Unlike a world read, a book that cannot be read fails the read.
 * @param parameters - The readers, ownership, market, the oldest acceptable head, and the
 * strategy's adapter error class.
 * @returns The preparation reading, every chain value pinned to one head.
 * @throws `adapterError` `head-behind-world` when the head is older than `atLeastBlock`, the world
 * block its decision read, `group-consumption-read` when consumption
 * cannot be read, and any other failed read, an adapter failure named as `adapterError`.
 */
export const readPreparation = async (parameters: {
  reads: WorldReads
  ownership: WorldOwnership
  marketId: Hex
  atLeastBlock: bigint
  adapterError: OperatorAdapterErrorClass
}): Promise<PreparationReading> => {
  const { reads, ownership, marketId, adapterError } = parameters
  const behind = (head: bigint) => head < parameters.atLeastBlock
  const [block, groups, book] = await Promise.all([
    reads.readLatestBlock(),
    reads.readGroups(),
    reads.readBook(marketId)
  ]).catch((error: unknown) => {
    throw asStrategyError(error, adapterError)
  })
  if (behind(block.number)) throw new adapterError('head-behind-world')
  const [market, consumed] = await Promise.all([
    reads.readMarket(marketId, block),
    readConsumedAt(reads, readSetOf(groups, ownership), block, adapterError).catch(
      (error: unknown) => {
        throw error instanceof adapterError ? error : new adapterError('group-consumption-read')
      }
    )
  ])
  if (behind(block.number)) throw new adapterError('head-behind-world')
  return { block, ownership, groups, book, market, consumed }
}

/**
 * Every market's reference observation due now: each ladder market every read, each bootstrap
 * market once its cadence has passed since it was last read, in one call so the markets on the
 * Blue average share its history. Only the markets read are carried.
 * @param parameters - The reference reader, ladder and bootstrap markets, whether bootstrap is due,
 * and the read time.
 * @returns A keyed write of the markets read now; markets not due are absent.
 */
export const readReferences = async (parameters: {
  rates: ReferenceRates
  ladder: readonly Hex[]
  bootstrap: readonly Hex[]
  bootstrapDue: boolean
  at: number
}): Promise<KeyedWrite<ReferenceReading>> => {
  const markets: ReferenceMarket[] = [
    ...parameters.ladder.map(marketId => ({ strategy: 'ladder' as const, marketId })),
    ...(parameters.bootstrapDue
      ? parameters.bootstrap.map(marketId => ({ strategy: 'bootstrap' as const, marketId }))
      : [])
  ]
  const readings = await parameters.rates(markets)
  return {
    coverage: 'carried',
    entries: Object.fromEntries(
      markets.map((market, index) => [
        marketKey(market.strategy, market.marketId),
        readings[index]!
      ])
    ),
    basis: { readAt: parameters.at }
  }
}
