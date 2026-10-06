import type { Address, Hex } from 'viem'

import { MAX_OFFER_CAP } from '@morpho-org/midnight-sdk'
import { bytesToHex, hexToBytes, isAddressEqual, isHex, size } from 'viem'

import type { OperatorAdapterErrorClass } from '../../application/monitoring/operator-error-name.utils'
import type { OfferCap } from '../../domain/offer-cap'
import type { JsonRequest } from './http-json.utils'

import { requestJson } from './http-json.utils'

const PAGE_SIZE = 100
const MAX_OFFER_PAGES = 100
const MAX_OFFER_ITEMS = 100_000

/** Canonical active maker-book offer projection used by spread guards. */
export type MakerBookOffer = {
  marketId: Hex
  maker: Address
  buy: boolean
  tick: bigint
  /** Market maturity when the provider included a valid embedded market projection. */
  maturity?: bigint
  /** Maximum market continuous fee accepted by this offer. */
  continuousFeeCap?: bigint
}

/** Canonical maker group with shared consumption and nested book offers. */
export type MakerOfferGroup = {
  id: Hex
  consumed: bigint
  cap: OfferCap
  marketId?: Hex
  tick?: bigint
  maturity?: bigint
  continuousFeeCap?: bigint
  offers: readonly MakerBookOffer[]
}

type MakerOfferGroupsConfig = {
  /** Strategy-owned error every read failure is reported as. */
  adapterError: OperatorAdapterErrorClass
  chainId: number
  maker: Address
  requestTimeoutMs: number
  morphoApiBaseUrl?: string
}

type MakerOfferGroupsDependencies = {
  request?: JsonRequest
  now?: () => number
}

const bytes32 = (value: unknown, config: Pick<MakerOfferGroupsConfig, 'adapterError'>) => {
  if (typeof value !== 'string' || !isHex(value, { strict: true }) || size(value) !== 32) {
    throw new config.adapterError('offer-groups-response')
  }
  return bytesToHex(hexToBytes(value))
}

const unsignedDecimal = (value: unknown, config: Pick<MakerOfferGroupsConfig, 'adapterError'>) => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new config.adapterError('offer-groups-response')
  }
  return BigInt(value)
}

const parseOffer = (value: unknown, config: MakerOfferGroupsConfig): MakerBookOffer => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new config.adapterError('offer-groups-response')
  }
  const offer = value as Record<string, unknown>
  const market =
    typeof offer.market === 'object' && offer.market !== null
      ? (offer.market as Record<string, unknown>)
      : undefined
  const maturity = market?.maturity
  if (
    typeof offer.maker !== 'string' ||
    typeof offer.buy !== 'boolean' ||
    typeof offer.tick !== 'number' ||
    !Number.isSafeInteger(offer.tick)
  ) {
    throw new config.adapterError('offer-groups-response')
  }
  try {
    // oxlint-disable-next-line repo/no-as-address
    if (!isAddressEqual(offer.maker as Address, config.maker)) {
      throw new config.adapterError('offer-groups-maker')
    }
  } catch (error) {
    if (error instanceof config.adapterError) throw error
    throw new config.adapterError('offer-groups-response')
  }
  return {
    marketId: bytes32(offer.market_id, config),
    maker: config.maker,
    buy: offer.buy,
    tick: BigInt(offer.tick),
    ...(typeof maturity === 'number' && Number.isSafeInteger(maturity)
      ? { maturity: BigInt(maturity) }
      : {}),
    continuousFeeCap: unsignedDecimal(offer.continuous_fee_cap, config)
  }
}

const groupCap = (
  group: Record<string, unknown>,
  config: Pick<MakerOfferGroupsConfig, 'adapterError'>
): OfferCap => {
  const maxAssets = unsignedDecimal(group.max_assets, config)
  const maxUnits = unsignedDecimal(group.max_units, config)
  if (
    (maxAssets === 0n) === (maxUnits === 0n) ||
    maxAssets > MAX_OFFER_CAP ||
    maxUnits > MAX_OFFER_CAP
  ) {
    throw new config.adapterError('offer-groups-response')
  }
  return maxUnits === 0n
    ? { kind: 'assets', maximum: maxAssets }
    : { kind: 'units', maximum: maxUnits }
}

const parseGroup = (value: unknown, config: MakerOfferGroupsConfig) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new config.adapterError('offer-groups-response')
  }
  const group = value as Record<string, unknown>
  if (!Array.isArray(group.offers)) throw new config.adapterError('offer-groups-response')
  const offers = group.offers.map(offer => parseOffer(offer, config))
  let common: Pick<MakerOfferGroup, 'id' | 'consumed' | 'cap' | 'offers'>
  try {
    const consumed = unsignedDecimal(group.consumed, config)
    const cap = groupCap(group, config)
    if (consumed > cap.maximum && consumed !== MAX_OFFER_CAP) {
      throw new config.adapterError('offer-groups-response')
    }
    common = {
      id: bytes32(group.id, config),
      consumed,
      cap,
      offers
    }
  } catch (error) {
    if (error instanceof config.adapterError) throw error
    throw new config.adapterError('offer-groups-response')
  }
  const rawBuys = group.offers.filter(item => (item as Record<string, unknown>).buy === true)
  if (rawBuys.length === 0) return [common]
  return rawBuys.map(rawBuy => {
    const buy = rawBuy as Record<string, unknown>
    if (typeof buy.tick !== 'number' || typeof buy.market !== 'object' || buy.market === null) {
      throw new config.adapterError('offer-groups-response')
    }
    const market = buy.market as Record<string, unknown>
    if (typeof market.maturity !== 'number' || !Number.isSafeInteger(market.maturity)) {
      throw new config.adapterError('offer-groups-response')
    }
    try {
      return {
        ...common,
        marketId: bytes32(buy.market_id, config),
        tick: BigInt(buy.tick),
        maturity: BigInt(market.maturity),
        continuousFeeCap: unsignedDecimal(buy.continuous_fee_cap, config)
      }
    } catch (error) {
      if (error instanceof config.adapterError) throw error
      throw new config.adapterError('offer-groups-response')
    }
  })
}

/**
 * Reads and strictly bounds the complete active maker offer-group set.
 * @param config - Maker, provider origin, and aggregate deadline.
 * @param dependencies - Injectable request and monotonic clock boundaries.
 * @returns Canonical groups and all nested offers.
 * @throws `config.adapterError` for malformed, unbounded, repeated, or timed-out pagination.
 */
// oxlint-disable-next-line complexity
export const readMakerOfferGroups = async (
  config: MakerOfferGroupsConfig,
  dependencies: MakerOfferGroupsDependencies = {}
): Promise<MakerOfferGroup[]> => {
  const groups: MakerOfferGroup[] = []
  const seenCursors = new Set<string>()
  const request = dependencies.request ?? requestJson
  const now = dependencies.now ?? performance.now.bind(performance)
  const deadline = now() + config.requestTimeoutMs
  let pageCount = 0
  let itemCount = 0
  let cursor: string | undefined
  do {
    if (pageCount >= MAX_OFFER_PAGES) {
      throw new config.adapterError('offer-groups-page-limit')
    }
    const remainingMs = Math.floor(deadline - now())
    if (remainingMs <= 0) throw new config.adapterError('offer-groups-timeout')
    pageCount += 1
    const query = new URLSearchParams({
      chain_ids: String(config.chainId),
      limit: String(PAGE_SIZE)
    })
    if (cursor) query.set('cursor', cursor)
    const rawResponse = await request(
      `${config.morphoApiBaseUrl ?? ''}/v0/midnight/users/${config.maker}/offer-groups?${query.toString()}`,
      'morpho-api',
      Math.min(config.requestTimeoutMs, remainingMs)
    )
    if (typeof rawResponse !== 'object' || rawResponse === null || Array.isArray(rawResponse)) {
      throw new config.adapterError('offer-groups-response')
    }
    const response = rawResponse as { data?: unknown; cursor?: unknown }
    if (!Array.isArray(response.data)) throw new config.adapterError('offer-groups-response')
    if (response.data.length > PAGE_SIZE) throw new config.adapterError('offer-groups-page-size')
    for (const value of response.data) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new config.adapterError('offer-groups-response')
      }
      const rawGroup = value as Record<string, unknown>
      if (typeof rawGroup.chain_id !== 'number' || !Number.isSafeInteger(rawGroup.chain_id)) {
        throw new config.adapterError('offer-groups-response')
      }
      if (rawGroup.chain_id !== config.chainId) continue
      const rawOffers = rawGroup.offers
      if (!Array.isArray(rawOffers)) throw new config.adapterError('offer-groups-response')
      itemCount += rawOffers.length
      if (itemCount > MAX_OFFER_ITEMS) throw new config.adapterError('offer-groups-item-limit')
      const parsed = parseGroup(value, config)
      groups.push(...parsed)
    }
    if (
      !Object.hasOwn(response, 'cursor') ||
      (response.cursor !== null &&
        (typeof response.cursor !== 'string' || response.cursor.trim().length === 0))
    ) {
      throw new config.adapterError('offer-groups-cursor')
    }
    cursor = response.cursor === null ? undefined : response.cursor
    if (cursor && seenCursors.has(cursor)) {
      throw new config.adapterError('offer-groups-repeated-cursor')
    }
    if (cursor) seenCursors.add(cursor)
  } while (cursor)
  return groups
}
