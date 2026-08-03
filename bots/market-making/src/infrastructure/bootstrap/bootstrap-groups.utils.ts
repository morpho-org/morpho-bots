import type { Address, Hex } from 'viem'

import { bytesToHex, hexToBytes, isAddressEqual, isHex, size } from 'viem'

import type { JsonRequest } from '../setup-state/http-json.utils'

import { requestJson } from '../setup-state/http-json.utils'
import { BootstrapAdapterError } from './bootstrap-adapter.error'

const PAGE_SIZE = 100
const MAX_OFFER_PAGES = 100
const MAX_OFFER_ITEMS = 100_000

/** Canonical active maker-book offer projection used by spread guards. */
export type BootstrapBookOffer = {
  marketId: Hex
  maker: Address
  buy: boolean
  tick: bigint
}

/** Canonical maker group with shared consumption and nested book offers. */
export type BootstrapRawGroup = {
  id: Hex
  consumed: bigint
  maxAssets: bigint
  marketId?: Hex
  tick?: bigint
  maturity?: bigint
  offers: readonly BootstrapBookOffer[]
}

type BootstrapGroupsConfig = {
  maker: Address
  requestTimeoutMs: number
  morphoApiBaseUrl?: string
}

type BootstrapGroupsDependencies = {
  request?: JsonRequest
  now?: () => number
}

const bytes32 = (value: unknown) => {
  if (typeof value !== 'string' || !isHex(value, { strict: true }) || size(value) !== 32) {
    throw new BootstrapAdapterError('offer-groups-response')
  }
  return bytesToHex(hexToBytes(value))
}

const unsignedDecimal = (value: unknown) => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new BootstrapAdapterError('offer-groups-response')
  }
  return BigInt(value)
}

const parseOffer = (value: unknown, maker: Address): BootstrapBookOffer => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BootstrapAdapterError('offer-groups-response')
  }
  const offer = value as Record<string, unknown>
  if (
    typeof offer.maker !== 'string' ||
    typeof offer.buy !== 'boolean' ||
    typeof offer.tick !== 'number' ||
    !Number.isSafeInteger(offer.tick)
  ) {
    throw new BootstrapAdapterError('offer-groups-response')
  }
  try {
    if (!isAddressEqual(offer.maker as Address, maker)) {
      throw new BootstrapAdapterError('offer-groups-maker')
    }
  } catch (error) {
    if (error instanceof BootstrapAdapterError) throw error
    throw new BootstrapAdapterError('offer-groups-response')
  }
  return { marketId: bytes32(offer.market_id), maker, buy: offer.buy, tick: BigInt(offer.tick) }
}

const parseGroup = (value: unknown, maker: Address) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BootstrapAdapterError('offer-groups-response')
  }
  const group = value as Record<string, unknown>
  if (!Array.isArray(group.offers)) throw new BootstrapAdapterError('offer-groups-response')
  const offers = group.offers.map(offer => parseOffer(offer, maker))
  let common: Pick<BootstrapRawGroup, 'id' | 'consumed' | 'maxAssets' | 'offers'>
  try {
    const consumed = unsignedDecimal(group.consumed)
    const maxAssets = unsignedDecimal(group.max_assets)
    if (consumed > maxAssets) throw new BootstrapAdapterError('offer-groups-response')
    common = {
      id: bytes32(group.id),
      consumed,
      maxAssets,
      offers
    }
  } catch (error) {
    if (error instanceof BootstrapAdapterError) throw error
    throw new BootstrapAdapterError('offer-groups-response')
  }
  const rawBuys = group.offers.filter(item => (item as Record<string, unknown>).buy === true)
  if (rawBuys.length === 0) return [common]
  return rawBuys.map(rawBuy => {
    const buy = rawBuy as Record<string, unknown>
    if (typeof buy.tick !== 'number' || typeof buy.market !== 'object' || buy.market === null) {
      throw new BootstrapAdapterError('offer-groups-response')
    }
    const market = buy.market as Record<string, unknown>
    if (typeof market.maturity !== 'number' || !Number.isSafeInteger(market.maturity)) {
      throw new BootstrapAdapterError('offer-groups-response')
    }
    try {
      return {
        ...common,
        marketId: bytes32(buy.market_id),
        tick: BigInt(buy.tick),
        maturity: BigInt(market.maturity)
      }
    } catch (error) {
      if (error instanceof BootstrapAdapterError) throw error
      throw new BootstrapAdapterError('offer-groups-response')
    }
  })
}

/**
 * Reads and strictly bounds the complete active maker offer-group set.
 * @param config - Maker, provider origin, and aggregate deadline.
 * @param dependencies - Injectable request and monotonic clock boundaries.
 * @returns Canonical groups and all nested offers.
 * @throws `BootstrapAdapterError` for malformed, unbounded, repeated, or timed-out pagination.
 */
export const readBootstrapGroups = async (
  config: BootstrapGroupsConfig,
  dependencies: BootstrapGroupsDependencies = {}
): Promise<BootstrapRawGroup[]> => {
  const groups: BootstrapRawGroup[] = []
  const seenCursors = new Set<string>()
  const request = dependencies.request ?? requestJson
  const now = dependencies.now ?? performance.now.bind(performance)
  const deadline = now() + config.requestTimeoutMs
  let pageCount = 0
  let itemCount = 0
  let cursor: string | undefined
  do {
    if (pageCount >= MAX_OFFER_PAGES) {
      throw new BootstrapAdapterError('offer-groups-page-limit')
    }
    const remainingMs = Math.floor(deadline - now())
    if (remainingMs <= 0) throw new BootstrapAdapterError('offer-groups-timeout')
    pageCount += 1
    const query = new URLSearchParams({ chain_ids: '8453', limit: String(PAGE_SIZE) })
    if (cursor) query.set('cursor', cursor)
    const rawResponse = await request(
      `${config.morphoApiBaseUrl ?? ''}/v0/midnight/users/${config.maker}/offer-groups?${query.toString()}`,
      'morpho-api',
      Math.min(config.requestTimeoutMs, remainingMs)
    )
    if (typeof rawResponse !== 'object' || rawResponse === null || Array.isArray(rawResponse)) {
      throw new BootstrapAdapterError('offer-groups-response')
    }
    const response = rawResponse as { data?: unknown; cursor?: unknown }
    if (!Array.isArray(response.data)) throw new BootstrapAdapterError('offer-groups-response')
    if (response.data.length > PAGE_SIZE) throw new BootstrapAdapterError('offer-groups-page-size')
    for (const value of response.data) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new BootstrapAdapterError('offer-groups-response')
      }
      const rawGroup = value as Record<string, unknown>
      if (typeof rawGroup.chain_id !== 'number' || !Number.isSafeInteger(rawGroup.chain_id)) {
        throw new BootstrapAdapterError('offer-groups-response')
      }
      if (rawGroup.chain_id !== 8453) continue
      const rawOffers = rawGroup.offers
      if (!Array.isArray(rawOffers)) throw new BootstrapAdapterError('offer-groups-response')
      itemCount += rawOffers.length
      if (itemCount > MAX_OFFER_ITEMS) throw new BootstrapAdapterError('offer-groups-item-limit')
      const parsed = parseGroup(value, config.maker)
      groups.push(...parsed)
    }
    if (
      !Object.hasOwn(response, 'cursor') ||
      (response.cursor !== null &&
        (typeof response.cursor !== 'string' || response.cursor.trim().length === 0))
    ) {
      throw new BootstrapAdapterError('offer-groups-cursor')
    }
    cursor = response.cursor === null ? undefined : response.cursor
    if (cursor && seenCursors.has(cursor)) {
      throw new BootstrapAdapterError('offer-groups-repeated-cursor')
    }
    if (cursor) seenCursors.add(cursor)
  } while (cursor)
  return groups
}

/**
 * Selects strategy groups using durable explicit ownership evidence.
 * @param groups - Canonical groups read from the maker-scoped API endpoint.
 * @param ownedGroupIds - Configured or safely persisted group IDs issued for this strategy.
 * @returns Active lend groups whose IDs are explicitly owned and whose projections are complete.
 * @remarks Market membership is deliberately not ownership evidence; unknown same-market groups stay unknown.
 */
export const strategyBootstrapGroups = (
  groups: readonly BootstrapRawGroup[],
  ownedGroupIds: readonly Hex[]
) => {
  const ownedGroups = new Set(ownedGroupIds)
  return groups.filter(
    group =>
      ownedGroups.has(group.id) &&
      group.marketId !== undefined &&
      group.tick !== undefined &&
      group.maturity !== undefined &&
      group.offers.length > 0
  )
}

/**
 * Totals the unfilled cash reserve of every distinct explicitly owned buy group.
 * @param groups - Canonical maker groups, which may contain one projection per offer market.
 * @param ownedGroupIds - Durable explicit ownership candidates for this strategy.
 * @param excludedGroupIds - Groups being replaced and therefore not reserved alongside the new offer.
 * @returns Aggregate remaining loan assets reserved by distinct owned buy groups.
 */
export const bootstrapReservedLoanAssets = (
  groups: readonly BootstrapRawGroup[],
  ownedGroupIds: readonly Hex[],
  excludedGroupIds: ReadonlySet<Hex> = new Set()
) => {
  const ownedGroups = new Set(ownedGroupIds)
  return [
    ...new Map(
      groups
        .filter(
          group =>
            ownedGroups.has(group.id) &&
            !excludedGroupIds.has(group.id) &&
            group.offers.some(offer => offer.buy)
        )
        .map(group => [group.id, group])
    ).values()
  ]
    .map(group => group.maxAssets - group.consumed)
    .reduce((total, assets) => total + assets, 0n)
}

/**
 * Flattens the provider book without re-expanding each multi-market group projection.
 * @param groups - Canonical groups, potentially repeated once per buy-offer market.
 * @returns Distinct offers annotated with their owning group ID in linear space and time.
 */
export const bootstrapBookOffers = (groups: readonly BootstrapRawGroup[]) => {
  const visitedGroups = new Set<Hex>()
  const offers = new Map<string, BootstrapBookOffer & { groupId: Hex }>()
  for (const group of groups) {
    if (visitedGroups.has(group.id)) continue
    visitedGroups.add(group.id)
    for (const offer of group.offers) {
      const key = `${group.id}:${offer.marketId}:${offer.buy ? 'buy' : 'sell'}:${offer.tick}`
      offers.set(key, { ...offer, groupId: group.id })
    }
  }
  return [...offers.values()]
}
