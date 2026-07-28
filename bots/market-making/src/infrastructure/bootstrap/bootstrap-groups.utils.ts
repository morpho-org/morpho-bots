import type { Address, Hex } from 'viem'

import { bytesToHex, hexToBytes, isAddressEqual, isHex, size } from 'viem'

import type { JsonRequest } from '../setup-state/http-json.utils'

import { requestJson } from '../setup-state/http-json.utils'
import { BootstrapAdapterError } from './bootstrap-adapter.error'

const PAGE_SIZE = 100
const MAX_OFFER_PAGES = 100
const MAX_OFFER_ITEMS = 100_000

type BootstrapBookOffer = {
  marketId: Hex
  maker: Address
  buy: boolean
  tick: bigint
}

type BootstrapRawGroup = {
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
  if (typeof group.consumed !== 'string' || typeof group.max_assets !== 'string') {
    throw new BootstrapAdapterError('offer-groups-response')
  }
  let common: Pick<BootstrapRawGroup, 'id' | 'consumed' | 'maxAssets' | 'offers'>
  try {
    common = {
      id: bytes32(group.id),
      consumed: BigInt(group.consumed),
      maxAssets: BigInt(group.max_assets),
      offers
    }
  } catch (error) {
    if (error instanceof BootstrapAdapterError) throw error
    throw new BootstrapAdapterError('offer-groups-response')
  }
  const rawBuy = group.offers.find(item => (item as Record<string, unknown>).buy === true)
  if (!rawBuy) return common
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
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) })
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
      const rawOffers = (value as Record<string, unknown>)?.offers
      if (!Array.isArray(rawOffers)) throw new BootstrapAdapterError('offer-groups-response')
      itemCount += rawOffers.length
      if (itemCount > MAX_OFFER_ITEMS) throw new BootstrapAdapterError('offer-groups-item-limit')
      const parsed = parseGroup(value, config.maker)
      groups.push(parsed)
    }
    if (
      response.cursor !== null &&
      response.cursor !== undefined &&
      typeof response.cursor !== 'string'
    ) {
      throw new BootstrapAdapterError('offer-groups-cursor')
    }
    cursor = response.cursor ?? undefined
    if (cursor && seenCursors.has(cursor)) {
      throw new BootstrapAdapterError('offer-groups-repeated-cursor')
    }
    if (cursor) seenCursors.add(cursor)
  } while (cursor)
  return groups
}

/**
 * Re-derives strategy ownership from maker-authenticated offers on configured markets.
 * @param groups - Canonical groups read from the maker-scoped API endpoint.
 * @param marketIds - Markets owned by the configured V0 strategy.
 * @returns Active lend groups whose complete offer set remains inside the strategy allowlist.
 * @remarks This deterministic projection survives one-shot CLI process boundaries without local state.
 */
export const strategyBootstrapGroups = (
  groups: readonly BootstrapRawGroup[],
  marketIds: readonly Hex[]
) => {
  const configuredMarkets = new Set(marketIds)
  return groups.filter(
    group =>
      group.marketId !== undefined &&
      group.tick !== undefined &&
      group.maturity !== undefined &&
      group.offers.length > 0 &&
      group.offers.every(offer => configuredMarkets.has(offer.marketId))
  )
}
