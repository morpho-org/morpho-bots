import type { Address, Hex } from 'viem'

import { bytesToHex, hexToBytes, isAddress, isHex, size } from 'viem'

import type { JsonRequest } from '../setup-state/http-json.utils'

import { requestJson } from '../setup-state/http-json.utils'
import { LadderAdapterError } from './ladder-adapter.error'

type LadderApiOffer = {
  marketId: Hex
  maker: Address
  buy: boolean
  tick: bigint
  maturity: bigint
}

type LadderApiGroup = {
  id: Hex
  consumed: bigint
  maxAssets: bigint
  maxUnits: bigint
  offers: readonly LadderApiOffer[]
  rungIndex?: number
  intendedRungs?: readonly {
    side: 'lower' | 'higher'
    rungIndex: number
    rateBps: bigint
  }[]
}

const PAGE_SIZE = 100
const MAX_PAGES = 100
const MAX_ITEMS = 100_000

const bytes32 = (value: unknown) => {
  if (typeof value !== 'string' || !isHex(value, { strict: true }) || size(value) !== 32) {
    throw new LadderAdapterError('offer-groups-response')
  }
  return bytesToHex(hexToBytes(value))
}

const decimal = (value: unknown) => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new LadderAdapterError('offer-groups-response')
  }
  return BigInt(value)
}

/**
 * Reads active maker groups through the Router HTTP boundary.
 * @param parameters - API origin, maker, timeout, and optional request implementation.
 * @returns Strictly parsed active group projections.
 * @throws `LadderAdapterError` for malformed or failed provider responses.
 */
export const readLadderGroups = async (parameters: {
  baseUrl: string
  maker: Address
  timeoutMs: number
  request?: JsonRequest
}) => {
  const request = parameters.request ?? requestJson
  const deadline = performance.now() + parameters.timeoutMs
  const values: unknown[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  let pages = 0
  do {
    if (pages >= MAX_PAGES) throw new LadderAdapterError('offer-groups-page-limit')
    const remainingMs = Math.floor(deadline - performance.now())
    if (remainingMs <= 0) throw new LadderAdapterError('offer-groups-timeout')
    pages += 1
    const query = new URLSearchParams({ chain_ids: '8453', limit: String(PAGE_SIZE) })
    if (cursor) query.set('cursor', cursor)
    const raw = await request(
      `${parameters.baseUrl}/v0/midnight/users/${parameters.maker}/offer-groups?${query.toString()}`,
      'morpho-api',
      Math.min(parameters.timeoutMs, remainingMs)
    )
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new LadderAdapterError('offer-groups-response')
    }
    const response = raw as { data?: unknown; cursor?: unknown }
    if (!Array.isArray(response.data) || response.data.length > PAGE_SIZE) {
      throw new LadderAdapterError('offer-groups-response')
    }
    values.push(...response.data)
    if (values.length > MAX_ITEMS) throw new LadderAdapterError('offer-groups-item-limit')
    if (
      !Object.hasOwn(response, 'cursor') ||
      (response.cursor !== null &&
        (typeof response.cursor !== 'string' || response.cursor.trim().length === 0))
    ) {
      throw new LadderAdapterError('offer-groups-response')
    }
    cursor = response.cursor === null ? undefined : response.cursor
    if (cursor && seen.has(cursor)) throw new LadderAdapterError('offer-groups-repeated-cursor')
    if (cursor) seen.add(cursor)
  } while (cursor)

  return values.map(value => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new LadderAdapterError('offer-groups-response')
    }
    const group = value as Record<string, unknown>
    if (group.chain_id !== 8453 || !Array.isArray(group.offers)) {
      throw new LadderAdapterError('offer-groups-response')
    }
    const offers = group.offers.map(value => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new LadderAdapterError('offer-groups-response')
      }
      const offer = value as Record<string, unknown>
      const market = offer.market as Record<string, unknown> | undefined
      if (
        typeof offer.maker !== 'string' ||
        !isAddress(offer.maker) ||
        typeof offer.buy !== 'boolean' ||
        typeof offer.tick !== 'number' ||
        !Number.isSafeInteger(offer.tick) ||
        !market ||
        typeof market.maturity !== 'number' ||
        !Number.isSafeInteger(market.maturity)
      ) {
        throw new LadderAdapterError('offer-groups-response')
      }
      return {
        marketId: bytes32(offer.market_id),
        maker: offer.maker,
        buy: offer.buy,
        tick: BigInt(offer.tick),
        maturity: BigInt(market.maturity)
      }
    })
    const parsed: LadderApiGroup = {
      id: bytes32(group.id),
      consumed: decimal(group.consumed),
      maxAssets: decimal(group.max_assets ?? '0'),
      maxUnits: decimal(group.max_units ?? '0'),
      offers
    }
    const maximum = parsed.maxAssets === 0n ? parsed.maxUnits : parsed.maxAssets
    if (maximum === 0n || parsed.consumed > maximum) {
      throw new LadderAdapterError('offer-groups-response')
    }
    return parsed
  })
}
