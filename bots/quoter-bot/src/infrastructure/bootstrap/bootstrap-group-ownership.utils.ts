import type { Address, Hex } from 'viem'

import { MAX_TICK } from '@morpho-org/midnight-sdk'
import { mkdir, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { bytesToHex, hexToBytes, isHex, keccak256, size, stringToHex } from 'viem'

import type { BootstrapOffer } from '../../domain/bootstrap/position-bootstrap'

import { BASE_CHAIN_ID } from '../../config/supported-chains.utils'
import { BootstrapAdapterError } from './bootstrap-adapter.error'

type BootstrapGroupOwnershipConfig = {
  chainId: number
  maker: Address
  marketIds: readonly Hex[]
  configuredGroupIds: readonly Hex[]
}

type BootstrapGroupOwnershipDependencies = {
  stateDirectory?: string
}

type PersistedOffer = {
  groupId: string
  marketId: string
  assets: string
  rateBps: string
  referenceObservationId: string
  tick?: string
  continuousFeeCap?: string
}

type OwnershipState =
  | { version: 1; strategy: string; groupIds: string[] }
  | { version: 2; strategy: string; confirmedGroupIds: string[]; reservedGroupIds: string[] }
  | {
      version: 3
      strategy: string
      confirmedGroupIds: string[]
      reservedGroupIds: string[]
      offers: PersistedOffer[]
    }
  | {
      version: 4
      strategy: string
      confirmedGroupIds: string[]
      reservedGroupIds: string[]
      offers: PersistedOffer[]
    }
  | {
      version: 5
      strategy: string
      confirmedGroupIds: string[]
      reservedGroupIds: string[]
      offers: PersistedOffer[]
    }

type OwnedOffer = BootstrapOffer & { groupId: Hex; tick?: bigint; continuousFeeCap?: bigint }

type CanonicalOwnershipState = {
  confirmedGroupIds: Hex[]
  reservedGroupIds: Hex[]
  offers: OwnedOffer[]
}

const canonicalId = (value: unknown) => {
  if (typeof value !== 'string' || !isHex(value, { strict: true }) || size(value) !== 32) {
    throw new BootstrapAdapterError('group-ownership-state')
  }
  return bytesToHex(hexToBytes(value))
}

const canonicalAmount = (value: unknown) => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new BootstrapAdapterError('group-ownership-state')
  }
  return BigInt(value)
}

const protocolTick = (value: bigint) => {
  if (value < 0n || value > MAX_TICK) {
    throw new BootstrapAdapterError('group-ownership-state')
  }
  return value
}

const canonicalTick = (value: unknown) => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new BootstrapAdapterError('group-ownership-state')
  }
  return protocolTick(BigInt(value))
}

const canonicalOffer = (value: unknown): OwnedOffer => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BootstrapAdapterError('group-ownership-state')
  }
  const offer = value as Partial<PersistedOffer>
  if (typeof offer.referenceObservationId !== 'string') {
    throw new BootstrapAdapterError('group-ownership-state')
  }
  const canonical = {
    groupId: canonicalId(offer.groupId),
    marketId: canonicalId(offer.marketId),
    assets: canonicalAmount(offer.assets),
    rateBps: canonicalAmount(offer.rateBps),
    referenceObservationId: offer.referenceObservationId
  }
  return {
    ...canonical,
    ...(offer.tick === undefined ? {} : { tick: canonicalTick(offer.tick) }),
    ...(offer.continuousFeeCap === undefined
      ? {}
      : { continuousFeeCap: canonicalAmount(offer.continuousFeeCap) })
  }
}

const strategyId = (config: BootstrapGroupOwnershipConfig) =>
  keccak256(
    stringToHex(
      JSON.stringify({
        chainId: config.chainId,
        maker: config.maker,
        marketIds: config.marketIds.map(canonicalId).toSorted()
      })
    )
  )

/**
 * Rebuilds the chain-less strategy key used before the bot supported more than one chain.
 * @param config - Maker and configured markets defining one strategy.
 * @returns The pre-multi-chain strategy key for that maker and market set.
 * @remarks Only Base could be configured while this key was in use, so state stored under it is
 * Base state by construction and is adopted on Base alone.
 */
const preMultiChainStrategyId = (config: BootstrapGroupOwnershipConfig) =>
  keccak256(
    stringToHex(
      JSON.stringify({
        maker: config.maker,
        marketIds: config.marketIds.map(canonicalId).toSorted()
      })
    )
  )

/**
 * Creates the durable explicit ownership source shared by setup readiness, position reads, and writes.
 * @param config - Maker, configured markets, and operator-configured group IDs defining one strategy.
 * @param dependencies - Optional state directory override used by isolated tests.
 * @returns A source that reads explicit IDs and atomically remembers confirmed bot-issued IDs and offer intent.
 * @throws `BootstrapAdapterError` when persisted ownership state is malformed or insecurely permissioned.
 * @remarks State is namespaced by chain, maker, and configured markets, stored mode `0600`, and never infers ownership from market membership.
 */
export const createBootstrapGroupOwnership = (
  config: BootstrapGroupOwnershipConfig,
  dependencies: BootstrapGroupOwnershipDependencies = {}
) => {
  const strategy = strategyId(config)
  const directory =
    dependencies.stateDirectory ??
    join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'morpho-quoter-bot')
  const path = join(directory, `${strategy}.json`)
  // Pre-multi-chain state is Base state by construction, so only Base adopts it; writes always
  // land on the chain-scoped path, migrating it forward on first write.
  const preMultiChainPath =
    config.chainId === BASE_CHAIN_ID
      ? join(directory, `${preMultiChainStrategyId(config)}.json`)
      : undefined
  const configured = config.configuredGroupIds.map(canonicalId)

  const readPersistedFrom = async (
    statePath: string,
    expectedStrategy: Hex,
    fallback?: () => Promise<CanonicalOwnershipState>
  ): Promise<CanonicalOwnershipState> => {
    let metadata
    try {
      metadata = await lstat(statePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return fallback ? fallback() : { confirmedGroupIds: [], reservedGroupIds: [], offers: [] }
      }
      throw new BootstrapAdapterError('group-ownership-state')
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
      throw new BootstrapAdapterError('group-ownership-state')
    }
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
      throw new BootstrapAdapterError('group-ownership-state')
    }
    try {
      const value = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>
      if (value.strategy !== expectedStrategy) {
        throw new BootstrapAdapterError('group-ownership-state')
      }
      if (value.version === 1 && Array.isArray(value.groupIds)) {
        return {
          confirmedGroupIds: value.groupIds.map(canonicalId),
          reservedGroupIds: [],
          offers: []
        }
      }
      if (
        value.version === 2 &&
        Array.isArray(value.confirmedGroupIds) &&
        Array.isArray(value.reservedGroupIds)
      ) {
        return {
          confirmedGroupIds: value.confirmedGroupIds.map(canonicalId),
          reservedGroupIds: value.reservedGroupIds.map(canonicalId),
          offers: []
        }
      }
      if (
        (value.version === 3 || value.version === 4 || value.version === 5) &&
        Array.isArray(value.confirmedGroupIds) &&
        Array.isArray(value.reservedGroupIds) &&
        Array.isArray(value.offers)
      ) {
        return {
          confirmedGroupIds: value.confirmedGroupIds.map(canonicalId),
          reservedGroupIds: value.reservedGroupIds.map(canonicalId),
          offers: value.offers.map(canonicalOffer)
        }
      }
      throw new BootstrapAdapterError('group-ownership-state')
    } catch (error) {
      if (error instanceof BootstrapAdapterError) throw error
      throw new BootstrapAdapterError('group-ownership-state')
    }
  }

  const readPersisted = () =>
    readPersistedFrom(
      path,
      strategy,
      preMultiChainPath === undefined
        ? undefined
        : () => readPersistedFrom(preMultiChainPath, preMultiChainStrategyId(config))
    )

  const writePersisted = async (state: CanonicalOwnershipState) => {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(
        temporary,
        JSON.stringify({
          version: 5,
          strategy,
          confirmedGroupIds: state.confirmedGroupIds,
          reservedGroupIds: state.reservedGroupIds,
          offers: state.offers.map(({ tick, continuousFeeCap, ...offer }) => ({
            ...offer,
            assets: String(offer.assets),
            rateBps: String(offer.rateBps),
            ...(tick === undefined ? {} : { tick: String(tick) }),
            ...(continuousFeeCap === undefined
              ? {}
              : { continuousFeeCap: String(continuousFeeCap) })
          }))
        } satisfies OwnershipState),
        { encoding: 'utf8', mode: 0o600, flag: 'wx' }
      )
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  const read = async () => {
    const state = await readPersisted()
    return [...new Set([...configured, ...state.confirmedGroupIds, ...state.reservedGroupIds])]
  }

  const readPersistedGroupIds = async () => {
    const state = await readPersisted()
    return [...new Set([...state.confirmedGroupIds, ...state.reservedGroupIds])]
  }

  return {
    /** Reads configured, confirmed, and reserved group IDs as ownership candidates. @returns Canonical explicit ownership IDs. */
    read,
    /** Reads only confirmed and reserved bot-issued group IDs. @returns Persisted IDs that may still be active before API indexing. */
    readPersistedGroupIds,
    /** Reads persisted offer intent for safe live-offer comparison. @returns Confirmed or reserved offers with their group IDs. */
    readOffers: async () => (await readPersisted()).offers,
    /** Durably reserves a group ID and offer intent before publication. @param groupId - Prepared group ID. @param offer - Intended domain semantics plus optional exact protocol tick and fee cap. @returns Completion after atomic storage. */
    reserve: async (
      groupId: Hex,
      offer?: BootstrapOffer & { tick?: bigint; continuousFeeCap?: bigint }
    ) => {
      const state = await readPersisted()
      const id = canonicalId(groupId)
      const intendedOffer = offer
        ? {
            ...offer,
            ...(offer.tick === undefined ? {} : { tick: protocolTick(offer.tick) })
          }
        : undefined
      await writePersisted({
        ...state,
        reservedGroupIds: [...new Set([...state.reservedGroupIds, id])],
        offers: intendedOffer
          ? [...state.offers.filter(item => item.groupId !== id), { groupId: id, ...intendedOffer }]
          : state.offers
      })
    },
    /** Converts a reservation to confirmed ownership after publication. @param groupId - Published group ID. @returns Completion after atomic storage. */
    confirm: async (groupId: Hex) => {
      const state = await readPersisted()
      const id = canonicalId(groupId)
      await writePersisted({
        confirmedGroupIds: [...new Set([...state.confirmedGroupIds, id])],
        reservedGroupIds: state.reservedGroupIds.filter(value => value !== id),
        offers: state.offers
      })
    },
    /** Removes an unpublished group reservation and its offer intent. @param groupId - Prepared group ID. @returns Completion after atomic storage. */
    release: async (groupId: Hex) => {
      const state = await readPersisted()
      const id = canonicalId(groupId)
      await writePersisted({
        ...state,
        reservedGroupIds: state.reservedGroupIds.filter(value => value !== id),
        offers: state.offers.filter(value => value.groupId !== id)
      })
    },
    /** Removes canceled groups from persisted ownership and offer intent. @param groupIds - Confirmed canceled group IDs. @returns Completion after atomic storage; configured IDs remain configuration-owned. */
    forget: async (groupIds: readonly Hex[]) => {
      const state = await readPersisted()
      const removed = new Set(groupIds.map(canonicalId))
      await writePersisted({
        confirmedGroupIds: state.confirmedGroupIds.filter(value => !removed.has(value)),
        reservedGroupIds: state.reservedGroupIds.filter(value => !removed.has(value)),
        offers: state.offers.filter(value => !removed.has(value.groupId))
      })
    }
  }
}
