import type { Hex } from 'viem'

import { bytesToHex, hexToBytes, isHex, size } from 'viem'

import type { JsonRequest } from '../setup-state/http-json.utils'

import { requestJson } from '../setup-state/http-json.utils'
import { LadderAdapterError } from './ladder-adapter.error'

const MAX_ITEMS = 1_000

const bytes32 = (value: unknown) => {
  if (typeof value !== 'string' || !isHex(value, { strict: true }) || size(value) !== 32) {
    throw new LadderAdapterError('book-response')
  }
  return bytesToHex(hexToBytes(value))
}

/**
 * Reads both takeable sides of every configured market through the Router whole-book boundary.
 * The read is side-effect free apart from concurrent, read-only HTTP requests. Provider and timeout
 * failures from the injected or default request boundary are forwarded unchanged.
 * @param parameters - Router origin, configured market IDs, aggregate deadline, cleanup-tombstone
 *   group IDs to omit, and optional request boundary.
 * @returns Every active market offer required for negative-spread validation.
 * @throws `LadderAdapterError` when a response is malformed, exceeds the endpoint bound, or the
 *   aggregate deadline expires before a side can be requested.
 */
export const readLadderBookOffers = async (parameters: {
  baseUrl: string
  marketIds: readonly Hex[]
  timeoutMs: number
  ignoredOfferGroupIds?: readonly Hex[]
  request?: JsonRequest
}) => {
  const request = parameters.request ?? requestJson
  const deadline = performance.now() + parameters.timeoutMs
  const readSide = async (marketId: Hex, side: 'asks' | 'bids') => {
    const remainingMs = Math.floor(deadline - performance.now())
    if (remainingMs <= 0) throw new LadderAdapterError('book-timeout')
    const rawResponse = await request(
      `${parameters.baseUrl}/v0/midnight/books/${marketId}/${side}/takeable-offers`,
      'morpho-api',
      Math.min(parameters.timeoutMs, remainingMs)
    )
    if (typeof rawResponse !== 'object' || rawResponse === null || Array.isArray(rawResponse)) {
      throw new LadderAdapterError('book-response')
    }
    const response = rawResponse as { data?: unknown }
    if (!Array.isArray(response.data) || response.data.length > MAX_ITEMS) {
      throw new LadderAdapterError('book-response')
    }
    return { marketId, side, values: response.data }
  }
  const pages = await Promise.all(
    parameters.marketIds.flatMap(marketId =>
      (['asks', 'bids'] as const).map(side => readSide(marketId, side))
    )
  )
  const ignoredOfferGroupIds = new Set(parameters.ignoredOfferGroupIds)
  return pages.flatMap(({ marketId, side, values }) =>
    values.flatMap(value => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new LadderAdapterError('book-response')
      }
      const row = value as Record<string, unknown>
      const offer = row.offer
      if (typeof offer !== 'object' || offer === null || Array.isArray(offer)) {
        throw new LadderAdapterError('book-response')
      }
      const raw = offer as Record<string, unknown>
      if (typeof raw.tick !== 'number' || !Number.isSafeInteger(raw.tick)) {
        throw new LadderAdapterError('book-response')
      }
      const expectedBuy = side === 'bids'
      if (typeof raw.buy !== 'boolean' || raw.buy !== expectedBuy) {
        throw new LadderAdapterError('book-response')
      }
      const returnedMarketId = bytes32(row.market_id)
      if (returnedMarketId !== marketId) throw new LadderAdapterError('book-response')
      const groupId = bytes32(raw.group)
      if (ignoredOfferGroupIds.has(groupId)) return []
      return [
        {
          groupId,
          marketId: returnedMarketId,
          buy: expectedBuy,
          tick: BigInt(raw.tick)
        }
      ]
    })
  )
}
