import type { Address, Hex } from 'viem'

import { MAX_TICK } from '@morpho-org/midnight-sdk'
import { join } from 'node:path'
import { keccak256, stringToHex } from 'viem'

import type { LadderQuoteSet, LadderRung } from '../../domain/ladder'

import {
  canonicalBytes32,
  canonicalUnsignedDecimal,
  readStrategyStateFile,
  STRATEGY_STATE_VERSION,
  strategyStateDirectory,
  writeStrategyStateFile
} from '../strategy-state/strategy-state-file.utils'
import { LadderAdapterError } from './ladder-adapter.error'

/** Relationship between one protocol group, the quote-set rungs it caps, and its signed offers. */
export type LadderGroupReference = {
  groupId: Hex
  side: 'lower' | 'higher'
  rungIndexes: readonly number[]
  /** Exact tick of every offer the group was signed with, which a rung's `rateBps` cannot recover. */
  ticks: readonly bigint[]
}

/** Durable publication intent used to reconstruct active ladder state safely. */
export type OwnedLadderPublication = {
  marketId: Hex
  status: 'reserved' | 'confirmed'
  quote: LadderQuoteSet
  groups: readonly LadderGroupReference[]
}

type LadderOwnershipConfig = {
  chainId: number
  maker: Address
}

type LadderOwnershipDependencies = {
  stateDirectory?: string
}

type PersistedRung = { index: number; rateBps: string; units: string }
type PersistedGroup = { groupId: string; side: string; rungIndexes: number[]; ticks: string[] }
type PersistedPublication = {
  marketId: string
  status: string
  quote: {
    marketId: string
    centerRateBps: string
    referenceObservationId?: string
    groupMode: string
    lower: PersistedRung[]
    higher: PersistedRung[]
    higherSkewBps?: string
  }
  groups: PersistedGroup[]
}
type OwnershipState = {
  version: typeof STRATEGY_STATE_VERSION
  strategy: string
  publications: PersistedPublication[]
}

const invalidState = () => new LadderAdapterError('group-ownership-state')
const canonicalId = (value: unknown) => canonicalBytes32(value, invalidState)
const canonicalAmount = (value: unknown) => canonicalUnsignedDecimal(value, invalidState)

const canonicalSignedAmount = (value: unknown) => {
  if (typeof value !== 'string' || !/^-?(0|[1-9]\d*)$/.test(value)) {
    throw invalidState()
  }
  return BigInt(value)
}

const canonicalTick = (value: unknown) => {
  const tick = canonicalAmount(value)
  if (tick > MAX_TICK) throw invalidState()
  return tick
}

const canonicalIndex = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalidState()
  }
  return value
}

const canonicalRung = (value: unknown): LadderRung => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidState()
  }
  const rung = value as Partial<PersistedRung>
  return {
    index: canonicalIndex(rung.index),
    rateBps: canonicalAmount(rung.rateBps),
    assets: canonicalAmount(rung.units)
  }
}

const canonicalQuote = (value: unknown): LadderQuoteSet => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidState()
  }
  const quote = value as Record<string, unknown>
  if (
    (quote.groupMode !== 'shared-rung' && quote.groupMode !== 'per-book') ||
    (quote.referenceObservationId !== undefined &&
      typeof quote.referenceObservationId !== 'string') ||
    !Array.isArray(quote.lower) ||
    !Array.isArray(quote.higher)
  ) {
    throw invalidState()
  }
  return {
    marketId: canonicalId(quote.marketId),
    centerRateBps: canonicalSignedAmount(quote.centerRateBps),
    ...(typeof quote.referenceObservationId === 'string'
      ? { referenceObservationId: quote.referenceObservationId }
      : {}),
    groupMode: quote.groupMode,
    lower: quote.lower.map(canonicalRung),
    higher: quote.higher.map(canonicalRung),
    ...(quote.higherSkewBps === undefined
      ? {}
      : { higherSkewBps: canonicalAmount(quote.higherSkewBps) })
  }
}

const canonicalGroup = (value: unknown): LadderGroupReference => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidState()
  }
  const group = value as Partial<PersistedGroup>
  if (
    (group.side !== 'lower' && group.side !== 'higher') ||
    !Array.isArray(group.rungIndexes) ||
    !Array.isArray(group.ticks) ||
    group.ticks.length === 0
  ) {
    throw invalidState()
  }
  return {
    groupId: canonicalId(group.groupId),
    side: group.side,
    rungIndexes: group.rungIndexes.map(canonicalIndex),
    ticks: group.ticks.map(canonicalTick)
  }
}

const canonicalPublication = (value: unknown): OwnedLadderPublication => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidState()
  }
  const publication = value as Partial<PersistedPublication>
  if (
    (publication.status !== 'reserved' && publication.status !== 'confirmed') ||
    !Array.isArray(publication.groups)
  ) {
    throw invalidState()
  }
  const marketId = canonicalId(publication.marketId)
  const quote = canonicalQuote(publication.quote)
  const groups = publication.groups.map(canonicalGroup)
  if (
    quote.marketId !== marketId ||
    groups.some(
      group =>
        new Set(group.ticks).size !== group.ticks.length ||
        (quote.groupMode === 'shared-rung' && group.ticks.length !== 1)
    )
  ) {
    throw invalidState()
  }
  return { marketId, status: publication.status, quote, groups }
}

const strategyId = (config: LadderOwnershipConfig) =>
  keccak256(
    stringToHex(
      JSON.stringify({
        strategy: 'ladder',
        chainId: config.chainId,
        maker: config.maker
      })
    )
  )

const serializePublication = (publication: OwnedLadderPublication): PersistedPublication => ({
  marketId: publication.marketId,
  status: publication.status,
  quote: {
    marketId: publication.quote.marketId,
    centerRateBps: String(publication.quote.centerRateBps),
    ...(publication.quote.referenceObservationId
      ? { referenceObservationId: publication.quote.referenceObservationId }
      : {}),
    groupMode: publication.quote.groupMode,
    lower: publication.quote.lower.map(rung => ({
      index: rung.index,
      rateBps: String(rung.rateBps),
      units: String(rung.assets)
    })),
    higher: publication.quote.higher.map(rung => ({
      index: rung.index,
      rateBps: String(rung.rateBps),
      units: String(rung.assets)
    })),
    ...(publication.quote.higherSkewBps === undefined
      ? {}
      : { higherSkewBps: String(publication.quote.higherSkewBps) })
  },
  groups: publication.groups.map(group => ({
    groupId: group.groupId,
    side: group.side,
    rungIndexes: [...group.rungIndexes],
    ticks: group.ticks.map(String)
  }))
})

/**
 * Creates durable, strategy-scoped ownership for ladder publication groups.
 * @param config - Chain and maker the ladder strategy runs as.
 * @param dependencies - Optional isolated state directory for tests.
 * @returns Atomic publication reservation, confirmation, removal, and read operations.
 * @throws `LadderAdapterError` when persisted state is malformed, foreign, or insecure, and
 * `StrategyStateVersionError` when its state file predates this version.
 * @remarks State contains no key, signature, URL, transaction, or maker address and is mode `0600`.
 * State is namespaced per chain: the same maker running two chains against one state directory keeps
 * separate publications, so neither chain sees the other's groups as removed and cancels them.
 */
export const createLadderGroupOwnership = (
  config: LadderOwnershipConfig,
  dependencies: LadderOwnershipDependencies = {}
) => {
  const strategy = strategyId(config)
  const directory = strategyStateDirectory(dependencies.stateDirectory)
  const path = join(directory, `${strategy}.json`)

  const write = (publications: readonly OwnedLadderPublication[]) =>
    writeStrategyStateFile(directory, path, {
      version: STRATEGY_STATE_VERSION,
      strategy,
      publications: publications.map(serializePublication)
    } satisfies OwnershipState)

  const read = async (): Promise<OwnedLadderPublication[]> => {
    return (
      (await readStrategyStateFile(
        path,
        value => {
          if (value.strategy !== strategy || !Array.isArray(value.publications)) {
            throw invalidState()
          }
          return value.publications.map(canonicalPublication)
        },
        invalidState
      )) ?? []
    )
  }

  const publicationKey = (groups: readonly LadderGroupReference[]) =>
    groups
      .map(group => group.groupId)
      .toSorted()
      .join(':')

  return {
    /** Reads every reserved or confirmed publication. @returns Canonical durable publication intents. */
    read,
    /** Reads every explicitly owned group ID. @returns Distinct reserved and confirmed group IDs. */
    readGroupIds: async () => [
      ...new Set(
        (await read()).flatMap(publication => publication.groups.map(group => group.groupId))
      )
    ],
    /** Reserves a complete future publication before broadcast. @param publication - Quote and derived groups. @returns Completion after atomic storage. */
    reserve: async (publication: Omit<OwnedLadderPublication, 'status'>): Promise<void> => {
      const publications = await read()
      const key = publicationKey(publication.groups)
      await write([
        ...publications.filter(item => publicationKey(item.groups) !== key),
        { ...publication, status: 'reserved' }
      ])
    },
    /** Confirms one reserved publication after a successful receipt. @param groupIds - Complete publication group set. @returns Completion after atomic storage. */
    confirm: async (groupIds: readonly Hex[]): Promise<void> => {
      const key = [...groupIds].toSorted().join(':')
      const publications = await read()
      if (!publications.some(item => publicationKey(item.groups) === key)) {
        throw new LadderAdapterError('publication-reservation-missing')
      }
      await write(
        publications.map(item =>
          publicationKey(item.groups) === key ? { ...item, status: 'confirmed' } : item
        )
      )
    },
    /** Removes an unpublished reservation. @param groupIds - Complete reserved group set. @returns Completion after atomic storage. */
    release: async (groupIds: readonly Hex[]): Promise<void> => {
      const key = [...groupIds].toSorted().join(':')
      await write((await read()).filter(item => publicationKey(item.groups) !== key))
    },
    /** Removes successfully canceled groups and empty publication records. @param groupIds - Confirmed canceled group IDs. @returns Completion after atomic storage. */
    forget: async (groupIds: readonly Hex[]): Promise<void> => {
      const removed = new Set(groupIds)
      const publications = (await read()).flatMap(publication => {
        const groups = publication.groups.filter(group => !removed.has(group.groupId))
        return groups.length === 0 ? [] : [{ ...publication, groups }]
      })
      await write(publications)
    }
  }
}
