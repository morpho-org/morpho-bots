import type { Address, Hex } from 'viem'

import { MAX_TICK } from '@morpho-org/midnight-sdk'
import { join } from 'node:path'
import { keccak256, stringToHex } from 'viem'

import type { BootstrapOffer } from '../../domain/position-bootstrap'

import {
  canonicalBytes32,
  canonicalUnsignedDecimal,
  readStrategyStateFile,
  STRATEGY_STATE_VERSION,
  strategyStateDirectory,
  writeStrategyStateFile
} from '../strategy-state/strategy-state-file.utils'
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
  units: string
  rateBps: string
  referenceObservationId: string
  tick?: string
  continuousFeeCap?: string
}

type OwnershipState = {
  version: typeof STRATEGY_STATE_VERSION
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

const invalidState = () => new BootstrapAdapterError('group-ownership-state')
const canonicalId = (value: unknown) => canonicalBytes32(value, invalidState)
const canonicalAmount = (value: unknown) => canonicalUnsignedDecimal(value, invalidState)

const protocolTick = (value: bigint) => {
  if (value < 0n || value > MAX_TICK) throw invalidState()
  return value
}

const canonicalTick = (value: unknown) => protocolTick(canonicalAmount(value))

const canonicalOffer = (value: unknown): OwnedOffer => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidState()
  const offer = value as Partial<PersistedOffer>
  if (typeof offer.referenceObservationId !== 'string') throw invalidState()
  const canonical = {
    groupId: canonicalId(offer.groupId),
    marketId: canonicalId(offer.marketId),
    assets: canonicalAmount(offer.units),
    rateBps: canonicalAmount(offer.rateBps),
    referenceObservationId: offer.referenceObservationId
  }
  if (canonical.assets === 0n) throw invalidState()
  return {
    ...canonical,
    ...(offer.tick === undefined ? {} : { tick: canonicalTick(offer.tick) }),
    ...(offer.continuousFeeCap === undefined
      ? {}
      : { continuousFeeCap: canonicalAmount(offer.continuousFeeCap) })
  }
}

const uniqueOffers = (offers: OwnedOffer[]) => {
  if (new Set(offers.map(offer => offer.groupId)).size !== offers.length) {
    throw invalidState()
  }
  return offers
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
 * Creates the durable explicit ownership source shared by setup readiness, position reads, and writes.
 * @param config - Maker, configured markets, and operator-configured group IDs defining one strategy.
 * @param dependencies - Optional state directory override used by isolated tests.
 * @returns A source that reads explicit IDs and atomically remembers confirmed bot-issued IDs and offer intent.
 * @throws `BootstrapAdapterError` when persisted ownership state is malformed or insecurely
 * permissioned, and `StrategyStateVersionError` when its state file predates this version.
 * @remarks State is namespaced by chain, maker, and configured markets, stored mode `0600`, and never infers ownership from market membership.
 */
export const createBootstrapGroupOwnership = (
  config: BootstrapGroupOwnershipConfig,
  dependencies: BootstrapGroupOwnershipDependencies = {}
) => {
  const strategy = strategyId(config)
  const directory = strategyStateDirectory(dependencies.stateDirectory)
  const path = join(directory, `${strategy}.json`)
  const configured = config.configuredGroupIds.map(canonicalId)

  const parseState = (value: Record<string, unknown>): CanonicalOwnershipState => {
    if (
      value.strategy !== strategy ||
      !Array.isArray(value.confirmedGroupIds) ||
      !Array.isArray(value.reservedGroupIds) ||
      !Array.isArray(value.offers)
    ) {
      throw invalidState()
    }
    return {
      confirmedGroupIds: value.confirmedGroupIds.map(canonicalId),
      reservedGroupIds: value.reservedGroupIds.map(canonicalId),
      offers: uniqueOffers(value.offers.map(canonicalOffer))
    }
  }

  const readPersisted = async (): Promise<CanonicalOwnershipState> => {
    return (
      (await readStrategyStateFile(path, parseState, invalidState)) ?? {
        confirmedGroupIds: [],
        reservedGroupIds: [],
        offers: []
      }
    )
  }

  const writePersisted = (state: CanonicalOwnershipState) =>
    writeStrategyStateFile(directory, path, {
      version: STRATEGY_STATE_VERSION,
      strategy,
      confirmedGroupIds: state.confirmedGroupIds,
      reservedGroupIds: state.reservedGroupIds,
      offers: state.offers.map(({ tick, continuousFeeCap, assets, ...offer }) => ({
        ...offer,
        units: String(assets),
        rateBps: String(offer.rateBps),
        ...(tick === undefined ? {} : { tick: String(tick) }),
        ...(continuousFeeCap === undefined ? {} : { continuousFeeCap: String(continuousFeeCap) })
      }))
    } satisfies OwnershipState)

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
