import type { Address, Hex } from 'viem'

import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { bytesToHex, hexToBytes, isHex, keccak256, size, stringToHex } from 'viem'

import type { LadderQuoteSet, LadderRung } from '../../domain/ladder/ladder'

import { BASE_CHAIN_ID } from '../../config/supported-chains.utils'
import { LadderAdapterError } from './ladder-adapter.error'

/** Relationship between one protocol group and the quote-set rungs it caps. */
export type LadderGroupReference = {
  groupId: Hex
  side: 'lower' | 'higher'
  rungIndexes: readonly number[]
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
  strategyMarketIds: readonly Hex[]
}

type LadderOwnershipDependencies = {
  stateDirectory?: string
}

type PersistedRung = { index: number; rateBps: string; assets: string }
type PersistedGroup = { groupId: string; side: string; rungIndexes: number[] }
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
  }
  groups: PersistedGroup[]
}
type OwnershipState = {
  version: 1
  strategy: string
  publications: PersistedPublication[]
}

const canonicalId = (value: unknown) => {
  if (typeof value !== 'string' || !isHex(value, { strict: true }) || size(value) !== 32) {
    throw new LadderAdapterError('group-ownership-state')
  }
  return bytesToHex(hexToBytes(value))
}

const canonicalAmount = (value: unknown) => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new LadderAdapterError('group-ownership-state')
  }
  return BigInt(value)
}

const canonicalSignedAmount = (value: unknown) => {
  if (typeof value !== 'string' || !/^-?(0|[1-9]\d*)$/.test(value)) {
    throw new LadderAdapterError('group-ownership-state')
  }
  return BigInt(value)
}

const canonicalIndex = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new LadderAdapterError('group-ownership-state')
  }
  return value
}

const canonicalRung = (value: unknown): LadderRung => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LadderAdapterError('group-ownership-state')
  }
  const rung = value as Partial<PersistedRung>
  return {
    index: canonicalIndex(rung.index),
    rateBps: canonicalAmount(rung.rateBps),
    assets: canonicalAmount(rung.assets)
  }
}

const canonicalQuote = (value: unknown): LadderQuoteSet => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LadderAdapterError('group-ownership-state')
  }
  const quote = value as Record<string, unknown>
  if (
    (quote.groupMode !== 'shared-rung' && quote.groupMode !== 'per-book') ||
    (quote.referenceObservationId !== undefined &&
      typeof quote.referenceObservationId !== 'string') ||
    !Array.isArray(quote.lower) ||
    !Array.isArray(quote.higher)
  ) {
    throw new LadderAdapterError('group-ownership-state')
  }
  return {
    marketId: canonicalId(quote.marketId),
    centerRateBps: canonicalSignedAmount(quote.centerRateBps),
    ...(typeof quote.referenceObservationId === 'string'
      ? { referenceObservationId: quote.referenceObservationId }
      : {}),
    groupMode: quote.groupMode,
    lower: quote.lower.map(canonicalRung),
    higher: quote.higher.map(canonicalRung)
  }
}

const canonicalGroup = (value: unknown): LadderGroupReference => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LadderAdapterError('group-ownership-state')
  }
  const group = value as Partial<PersistedGroup>
  if ((group.side !== 'lower' && group.side !== 'higher') || !Array.isArray(group.rungIndexes)) {
    throw new LadderAdapterError('group-ownership-state')
  }
  return {
    groupId: canonicalId(group.groupId),
    side: group.side,
    rungIndexes: group.rungIndexes.map(canonicalIndex)
  }
}

const canonicalPublication = (value: unknown): OwnedLadderPublication => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LadderAdapterError('group-ownership-state')
  }
  const publication = value as Partial<PersistedPublication>
  if (
    (publication.status !== 'reserved' && publication.status !== 'confirmed') ||
    !Array.isArray(publication.groups)
  ) {
    throw new LadderAdapterError('group-ownership-state')
  }
  const marketId = canonicalId(publication.marketId)
  const quote = canonicalQuote(publication.quote)
  if (quote.marketId !== marketId) throw new LadderAdapterError('group-ownership-state')
  return {
    marketId,
    status: publication.status,
    quote,
    groups: publication.groups.map(canonicalGroup)
  }
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

/**
 * Rebuilds the chain-less strategy key used before the bot supported more than one chain.
 * @param maker - Maker whose ladder publications were persisted under the chain-less key.
 * @returns The pre-multi-chain strategy key for that maker.
 * @remarks Only Base could be configured while this key was in use, so state stored under it is
 * Base state by construction and is migrated forward on Base alone. Adopting it on another chain
 * would import foreign publications and cancel groups that never existed there.
 */
const preMultiChainStrategyId = (maker: Address) =>
  keccak256(
    stringToHex(
      JSON.stringify({
        strategy: 'ladder',
        maker
      })
    )
  )

const legacyStrategyId = (maker: Address, marketIds: readonly Hex[]) =>
  keccak256(
    stringToHex(
      JSON.stringify({
        strategy: 'ladder',
        maker,
        marketIds: marketIds.map(canonicalId).toSorted()
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
      assets: String(rung.assets)
    })),
    higher: publication.quote.higher.map(rung => ({
      index: rung.index,
      rateBps: String(rung.rateBps),
      assets: String(rung.assets)
    }))
  },
  groups: publication.groups.map(group => ({
    groupId: group.groupId,
    side: group.side,
    rungIndexes: [...group.rungIndexes]
  }))
})

/**
 * Creates durable, strategy-scoped ownership for ladder publication groups.
 * @param config - Chain, maker, and ladder-strategy market namespace.
 * @param dependencies - Optional isolated state directory for tests.
 * @returns Atomic publication reservation, confirmation, removal, and read operations.
 * @throws `LadderAdapterError` when persisted state is malformed, foreign, or insecure.
 * @remarks State contains no key, signature, URL, transaction, or maker address and is mode `0600`.
 * Legacy market-scoped state remains readable without mutation and is migrated only by writer paths.
 * State is namespaced per chain: the same maker running two chains against one state directory keeps
 * separate publications, so neither chain sees the other's groups as removed and cancels them.
 */
export const createLadderGroupOwnership = (
  config: LadderOwnershipConfig,
  dependencies: LadderOwnershipDependencies = {}
) => {
  const strategy = strategyId(config)
  const legacyStrategy = legacyStrategyId(config.maker, config.strategyMarketIds)
  const preMultiChainStrategy =
    config.chainId === BASE_CHAIN_ID ? preMultiChainStrategyId(config.maker) : undefined
  const directory =
    dependencies.stateDirectory ??
    join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'morpho-quoter-bot')
  const path = join(directory, `${strategy}.json`)
  const legacyPath = join(directory, `${legacyStrategy}.json`)
  const preMultiChainPath =
    preMultiChainStrategy === undefined
      ? undefined
      : join(directory, `${preMultiChainStrategy}.json`)

  const write = async (publications: readonly OwnedLadderPublication[]) => {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const legacyStates = await discoverLegacyStates()
    const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(
        temporary,
        JSON.stringify({
          version: 1,
          strategy,
          publications: publications.map(serializePublication)
        } satisfies OwnershipState),
        { encoding: 'utf8', mode: 0o600, flag: 'wx' }
      )
      await rename(temporary, path)
      await Promise.allSettled(legacyStates.map(state => rm(state.path, { force: true })))
    } finally {
      await rm(temporary, { force: true })
    }
  }

  const readPath = async (
    statePath: string,
    expectedStrategy: Hex,
    ignoreNonLadderState = false
  ): Promise<OwnedLadderPublication[] | undefined> => {
    let metadata
    try {
      metadata = await lstat(statePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new LadderAdapterError('group-ownership-state')
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
      throw new LadderAdapterError('group-ownership-state')
    }
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
      throw new LadderAdapterError('group-ownership-state')
    }
    try {
      const value = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>
      if (ignoreNonLadderState && !Array.isArray(value.publications)) return undefined
      if (
        value.version !== 1 ||
        value.strategy !== expectedStrategy ||
        !Array.isArray(value.publications)
      ) {
        throw new LadderAdapterError('group-ownership-state')
      }
      return value.publications.map(canonicalPublication)
    } catch (error) {
      if (error instanceof LadderAdapterError) throw error
      throw new LadderAdapterError('group-ownership-state')
    }
  }

  const discoverLegacyStates = async (verifiedGroupIds?: ReadonlySet<Hex>) => {
    let names: string[]
    try {
      names = await readdir(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new LadderAdapterError('group-ownership-state')
    }

    const states: { path: string; publications: OwnedLadderPublication[] }[] = []
    for (const name of names.toSorted()) {
      const match = /^(0x[0-9a-f]{64})\.json$/.exec(name)
      if (!match) continue
      const candidateStrategy = match[1] as Hex
      const candidatePath = join(directory, name)
      if (candidatePath === path) continue
      const publications = await readPath(candidatePath, candidateStrategy, true)
      if (publications === undefined) continue
      const marketIds = [...new Set(publications.map(publication => publication.marketId))]
      const attributableLegacyStrategy =
        marketIds.length > 0 ? legacyStrategyId(config.maker, marketIds) : undefined
      const verifiedLegacyState =
        verifiedGroupIds !== undefined &&
        publications.some(publication =>
          publication.groups.some(group => verifiedGroupIds.has(group.groupId))
        )
      if (
        candidatePath !== legacyPath &&
        candidatePath !== preMultiChainPath &&
        candidateStrategy !== attributableLegacyStrategy &&
        !verifiedLegacyState
      ) {
        continue
      }
      states.push({ path: candidatePath, publications })
    }
    return states
  }

  const hasCandidateLegacyState = async () => {
    try {
      return (await readdir(directory)).some(
        name => /^(0x[0-9a-f]{64})\.json$/.test(name) && join(directory, name) !== path
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw new LadderAdapterError('group-ownership-state')
    }
  }

  const legacyPublications = async (verifiedGroupIds?: ReadonlySet<Hex>) => {
    const publications = new Map<string, OwnedLadderPublication>()
    for (const state of await discoverLegacyStates(verifiedGroupIds)) {
      for (const publication of state.publications) {
        const key = publication.groups
          .map(group => group.groupId)
          .toSorted()
          .join(':')
        publications.set(key, publication)
      }
    }
    return [...publications.values()]
  }

  const read = async (): Promise<OwnedLadderPublication[]> => {
    const publications = await readPath(path, strategy)
    if (publications !== undefined) return publications
    return legacyPublications()
  }

  const publicationKey = (groups: readonly LadderGroupReference[]) =>
    groups
      .map(group => group.groupId)
      .toSorted()
      .join(':')

  return {
    /** Migrates valid legacy ownership into the stable namespace. @returns Completion after atomic durable migration. */
    migrate: async (verifyGroupIds?: () => Promise<readonly Hex[]>): Promise<void> => {
      const publications = await readPath(path, strategy)
      if (publications !== undefined) {
        for (const state of await discoverLegacyStates()) await rm(state.path, { force: true })
        return
      }
      let legacy = await legacyPublications()
      let verified: ReadonlySet<Hex> | undefined
      if (legacy.length === 0 && verifyGroupIds !== undefined) {
        if (!(await hasCandidateLegacyState())) return
        verified = new Set(await verifyGroupIds())
        legacy = await legacyPublications(verified)
      }
      if (legacy.length > 0) {
        await write(legacy)
        for (const state of await discoverLegacyStates(verified))
          await rm(state.path, { force: true })
      }
    },
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
