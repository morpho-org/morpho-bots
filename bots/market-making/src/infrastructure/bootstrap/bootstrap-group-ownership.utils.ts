import type { Address, Hex } from 'viem'

import { mkdir, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { bytesToHex, hexToBytes, isHex, keccak256, size, stringToHex } from 'viem'

import type { BootstrapOffer } from '../../domain/bootstrap/position-bootstrap'

import { BootstrapAdapterError } from './bootstrap-adapter.error'

type BootstrapGroupOwnershipConfig = {
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

type OwnedOffer = BootstrapOffer & { groupId: Hex }

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

const canonicalOffer = (value: unknown): OwnedOffer => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BootstrapAdapterError('group-ownership-state')
  }
  const offer = value as Partial<PersistedOffer>
  if (typeof offer.referenceObservationId !== 'string') {
    throw new BootstrapAdapterError('group-ownership-state')
  }
  return {
    groupId: canonicalId(offer.groupId),
    marketId: canonicalId(offer.marketId),
    assets: canonicalAmount(offer.assets),
    rateBps: canonicalAmount(offer.rateBps),
    referenceObservationId: offer.referenceObservationId
  }
}

const strategyId = (config: BootstrapGroupOwnershipConfig) =>
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
 * @remarks State is namespaced by maker and configured markets, stored mode `0600`, and never infers ownership from market membership.
 */
export const createBootstrapGroupOwnership = (
  config: BootstrapGroupOwnershipConfig,
  dependencies: BootstrapGroupOwnershipDependencies = {}
) => {
  const strategy = strategyId(config)
  const directory =
    dependencies.stateDirectory ??
    join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'morpho-market-making')
  const path = join(directory, `${strategy}.json`)
  const configured = config.configuredGroupIds.map(canonicalId)

  const readPersisted = async (): Promise<CanonicalOwnershipState> => {
    let metadata
    try {
      metadata = await lstat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { confirmedGroupIds: [], reservedGroupIds: [], offers: [] }
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
      const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      if (value.strategy !== strategy) throw new BootstrapAdapterError('group-ownership-state')
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
        value.version === 3 &&
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

  const writePersisted = async (state: CanonicalOwnershipState) => {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(
        temporary,
        JSON.stringify({
          version: 3,
          strategy,
          confirmedGroupIds: state.confirmedGroupIds,
          reservedGroupIds: state.reservedGroupIds,
          offers: state.offers.map(offer => ({
            ...offer,
            assets: String(offer.assets),
            rateBps: String(offer.rateBps)
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

  return {
    /** Reads configured, confirmed, and reserved group IDs as ownership candidates. @returns Canonical explicit ownership IDs. */
    read,
    /** Reads persisted offer intent for safe live-offer comparison. @returns Confirmed or reserved offers with their group IDs. */
    readOffers: async () => (await readPersisted()).offers,
    /** Durably reserves a group ID and offer intent before publication. @param groupId - Prepared group ID. @param offer - Intended offer semantics. @returns Completion after atomic storage. */
    reserve: async (groupId: Hex, offer?: BootstrapOffer) => {
      const state = await readPersisted()
      const id = canonicalId(groupId)
      await writePersisted({
        ...state,
        reservedGroupIds: [...new Set([...state.reservedGroupIds, id])],
        offers: offer
          ? [...state.offers.filter(item => item.groupId !== id), { groupId: id, ...offer }]
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
    }
  }
}
