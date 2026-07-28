import type { Hex } from 'viem'

import { bytesToHex, getAddress, hexToBytes, isAddress, isHex, size } from 'viem'

import { SafeProviderError } from '../../application/safe-provider.error'
import { ProviderResponseError } from './provider-response.error'

export const BASE_CHAIN_ID = 8453
export const PAGE_SIZE = 100
export const MAX_OFFER_PAGES = 100
export const MAX_OFFER_ITEMS = 100_000
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
// morpho-org/deployments@24c04410 address-book.json, Base EcrecoverRatifier.
// The deployment-specific runtime hash includes the immutable Midnight target.
export const BASE_ECRECOVER_RATIFIER_RUNTIME_HASH =
  '0xcce1e0dd38ae831e81a9270627af2c24c208409ec03d5654a28a33ead53b1ac1'
const invalidProviderValue = (message: string) =>
  new ProviderResponseError('provider', 'decode', message)
const objectValue = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidProviderValue(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

/**
 * Validates an unknown provider value as an array.
 * @param value - Provider value to validate.
 * @param label - Safe field label for errors.
 * @returns The narrowed array.
 * @throws When the provider value is not an array.
 */
const arrayValue = (value: unknown, label: string) => {
  if (!Array.isArray(value)) throw invalidProviderValue(`${label} must be an array`)
  return value
}

/**
 * Validates and checksum-normalizes a provider address with viem.
 * @param value - Provider value to validate.
 * @param label - Safe field label for errors.
 * @returns The checksummed EVM address.
 * @throws When viem rejects the address syntax or mixed-case checksum.
 */
export const addressValue = (value: unknown, label: string) => {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw invalidProviderValue(`${label} must be an address`)
  }
  return getAddress(value)
}

/**
 * Validates a strict bytes32 provider value with viem.
 * @param value - Provider value to validate.
 * @param label - Safe field label for errors.
 * @returns The exact 32-byte hex value.
 * @throws When malformed or not exactly 32 bytes.
 */
const bytes32Value = (value: unknown, label: string): Hex => {
  if (typeof value !== 'string' || !isHex(value, { strict: true }) || size(value) !== 32) {
    throw invalidProviderValue(`${label} must be a 32-byte hex value`)
  }
  return bytesToHex(hexToBytes(value))
}

const integerValue = (value: unknown, label: string) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw invalidProviderValue(`${label} must be a safe integer`)
  }
  return value
}

const bigintValue = (value: unknown, label: string) => {
  if (typeof value !== 'bigint') throw invalidProviderValue(`${label} must be a bigint`)
  return value
}

/**
 * Parses the subset of a Midnight `toMarket` response required by setup checking.
 * @param value - ABI-decoded response from the SDK-owned `midnightAbi`.
 * @returns Normalized identity, asset, and maturity fields.
 * @throws When decoded fields do not match the expected ABI value types.
 */
export const marketFromContract = (value: unknown) => {
  const market = objectValue(value, 'Midnight.toMarket response')
  // midnight-sdk MarketParams requires non-empty collateral params; V0 setup identity checks do not,
  // so the minimal local projection preserves valid zero-collateral market responses.
  return {
    chainId: bigintValue(market.chainId, 'market.chainId'),
    midnight: addressValue(market.midnight, 'market.midnight'),
    loanToken: addressValue(market.loanToken, 'market.loanToken'),
    maturity: bigintValue(market.maturity, 'market.maturity')
  }
}

/**
 * Validates the SDK-mapped Midnight book projection used by setup checking.
 * @param value - One `MidnightApi.fetchBooks` result item.
 * @returns Canonical identity, chain, singleton, asset, and maturity fields.
 * @throws When the SDK-trusted response contains malformed runtime values.
 */
export const marketFromApi = (value: unknown) => {
  const market = objectValue(value, 'Midnight SDK book')
  return {
    id: bytes32Value(market.marketId, 'marketId'),
    chainId: integerValue(market.chainId, 'chainId'),
    midnight: addressValue(market.midnight, 'midnight'),
    loanToken: addressValue(market.loanToken, 'loanToken'),
    maturity: BigInt(integerValue(market.maturity, 'maturity'))
  }
}

/**
 * Parses one nested active offer needed for setup safety checks.
 * @param value - One untrusted active offer from an offer group.
 * @param group - Canonical parent offer-group ID.
 * @returns Canonical market, maker, group, side, and tick fields.
 * @throws When required Router fields are malformed.
 */
export const offerFromApi = (value: unknown, group: Hex) => {
  const offer = objectValue(value, 'Router active offer')
  return {
    marketId: bytes32Value(offer.market_id, 'offer market_id'),
    maker: addressValue(offer.maker, 'offer maker'),
    group,
    buy: offer.buy === true,
    tick: integerValue(offer.tick, 'offer tick')
  }
}

/**
 * Parses and flattens one active offer-group page from the Router endpoint.
 * @param value - Untrusted page data array.
 * @returns Canonical group IDs paired with every nested active offer.
 * @throws When a group ID, nested offer list, or offer field is malformed.
 */
export const offersFromGroups = (value: unknown) =>
  arrayValue(value, 'Router data').flatMap(groupValue => {
    const group = objectValue(groupValue, 'Router offer group')
    const groupId = bytes32Value(group.id, 'offer group id')
    return arrayValue(group.offers, 'Router active offers').map(offer =>
      offerFromApi(offer, groupId)
    )
  })

/**
 * Extracts Base Ecrecover ratifier addresses from Router configuration.
 * @param value - Untrusted Router config-contracts response.
 * @returns Checksummed Base Ecrecover ratifier addresses.
 * @throws When the response shape or selected contract fields are malformed.
 */
export const routerEcrecoverRatifiers = (value: unknown) => {
  const data = arrayValue(
    objectValue(value, 'Router config contracts response').data,
    'Router config contracts'
  )
  return data.flatMap(item => {
    const contract = objectValue(item, 'Router config contract')
    if (integerValue(contract.chain_id, 'config contract chain_id') !== BASE_CHAIN_ID) return []
    if (contract.name !== 'ecrecoverRatifier') return []
    return [addressValue(contract.address, 'config contract address')]
  })
}

/**
 * Detects every active market whose maker buy and sell ticks cross.
 * @param offers - All validated active maker offers, including unconfigured markets.
 * @returns Canonical IDs having a highest buy tick at or above the lowest sell tick.
 */
export const invertedMarketIds = (offers: readonly ReturnType<typeof offerFromApi>[]) =>
  [...new Set(offers.map(offer => offer.marketId))].filter(marketId => {
    const marketOffers = offers.filter(offer => offer.marketId === marketId)
    const buys = marketOffers.filter(offer => offer.buy).map(offer => offer.tick)
    const sells = marketOffers.filter(offer => !offer.buy).map(offer => offer.tick)
    return buys.length > 0 && sells.length > 0 && Math.max(...buys) >= Math.min(...sells)
  })

/**
 * Creates a sanitized aggregate Router deadline failure.
 * @returns A provider-safe timeout error without URL or response metadata.
 */
export const routerTimeout = () =>
  new SafeProviderError({
    kind: 'provider-error',
    provider: 'router-api',
    name: 'TimeoutError',
    code: 'REQUEST_TIMEOUT',
    context: 'request'
  })

/**
 * Validates an unknown provider response as a record.
 * @param value - Provider value to validate.
 * @param label - Safe field label for errors.
 * @returns The narrowed object record.
 * @throws When the provider value is null, an array, or not an object.
 */
export const objectRecord = (value: unknown, label: string) => objectValue(value, label)

/**
 * Validates an unknown provider response as bigint.
 * @param value - Provider value to validate.
 * @param label - Safe field label for errors.
 * @returns The narrowed bigint.
 * @throws When the provider value is not bigint.
 */
export const providerBigInt = (value: unknown, label: string) => bigintValue(value, label)
