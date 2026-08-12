import type { Hex } from 'viem'

import { bytesToHex, getAddress, hexToBytes, isAddress, isHex, size } from 'viem'

import type { OwnedOverlapBookOffer } from '../intentional-overlap.utils'

import { SafeProviderError } from '../../application/setup/safe-provider.error'
import { BASE_CHAIN_ID } from '../../config/config.utils'
import { hasInvalidOwnedBootstrapLadderSpread } from '../intentional-overlap.utils'
import { ProviderResponseError } from './provider-response.error'

export const PAGE_SIZE = 100
export const MAX_OFFER_PAGES = 100
export const MAX_OFFER_ITEMS = 100_000
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
// morpho-org/deployments@24c04410 address-book.json, Base EcrecoverRatifier.
// The deployment-specific runtime hash includes the immutable Midnight target.
export const BASE_ECRECOVER_RATIFIER_RUNTIME_HASH =
  '0xcce1e0dd38ae831e81a9270627af2c24c208409ec03d5654a28a33ead53b1ac1'
export const BASE_SETTER_RATIFIER_RUNTIME_HASH =
  '0xace63c5b7c1b611d0b9c04df3993ce0cf24a172287c9e0755d18606b7465c235'
const invalidProviderValue = (message: string) =>
  new ProviderResponseError('provider', 'decode', message)
/**
 * Validates an unknown provider response as a record.
 * @param value - Provider value to validate.
 * @param label - Safe field label for errors.
 * @returns The narrowed object record.
 * @throws When the provider value is null, an array, or not an object.
 */
export const objectValue = (value: unknown, label: string): Record<string, unknown> => {
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

/**
 * Validates an unknown provider response as bigint.
 * @param value - Provider value to validate.
 * @param label - Safe field label for errors.
 * @returns The narrowed bigint.
 * @throws When the provider value is not bigint.
 */
export const bigintValue = (value: unknown, label: string) => {
  if (typeof value !== 'bigint') throw invalidProviderValue(`${label} must be a bigint`)
  return value
}

const booleanValue = (value: unknown, label: string) => {
  if (typeof value !== 'boolean') throw invalidProviderValue(`${label} must be a boolean`)
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
 * Extracts canonical Base market IDs proven listed by the documented markets endpoint.
 * @param value - Untrusted `listed=true` markets response.
 * @returns Canonical IDs whose rows explicitly identify Base and `listed: true`.
 * @throws When the response envelope or any listing identity field is malformed.
 */
export const listedBaseMarketIds = (value: unknown) => {
  const response = objectValue(value, 'Morpho API markets response')
  return arrayValue(response.data, 'Morpho API markets data').flatMap(item => {
    const market = objectValue(item, 'Morpho API listed market')
    const id = bytes32Value(market.market_id, 'listed market_id')
    const chainId = integerValue(market.chain_id, 'listed market chain_id')
    const listed = booleanValue(market.listed, 'listed market flag')
    return chainId === BASE_CHAIN_ID && listed ? [id] : []
  })
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
    buy: booleanValue(offer.buy, 'offer buy'),
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
    const chainId = integerValue(group.chain_id, 'offer group chain_id')
    if (chainId !== BASE_CHAIN_ID) return []
    const groupId = bytes32Value(group.id, 'offer group id')
    return arrayValue(group.offers, 'Router active offers').map(offer =>
      offerFromApi(offer, groupId)
    )
  })

/**
 * Extracts supported Base ratifier addresses and kinds from Router configuration.
 * @param value - Untrusted Router config-contracts response.
 * @returns Checksummed Base ratifier addresses paired with their canonical kinds.
 * @throws When the response shape or selected contract fields are malformed.
 */
export const routerRatifiers = (value: unknown) => {
  const data = arrayValue(
    objectValue(value, 'Router config contracts response').data,
    'Router config contracts'
  )
  return data.flatMap(item => {
    const contract = objectValue(item, 'Router config contract')
    if (integerValue(contract.chain_id, 'config contract chain_id') !== BASE_CHAIN_ID) return []
    const type =
      contract.name === 'ecrecoverRatifier'
        ? ('ecrecover' as const)
        : contract.name === 'setterRatifier'
          ? ('setter' as const)
          : undefined
    return type
      ? [{ type, address: addressValue(contract.address, 'config contract address') }]
      : []
  })
}

type OverlapOwnership = {
  bootstrapBuyGroupIds?: ReadonlySet<Hex>
  ladderSellGroupIds?: ReadonlySet<Hex>
}

const ownedOverlapRole = (offer: ReturnType<typeof offerFromApi>, ownership: OverlapOwnership) => {
  if (offer.buy && ownership.bootstrapBuyGroupIds?.has(offer.group)) {
    return 'bootstrap-buy' as const
  }
  if (!offer.buy && ownership.ladderSellGroupIds?.has(offer.group)) {
    return 'ladder-sell' as const
  }
  return undefined
}

/**
 * Detects every active market whose maker buy and sell ticks cross.
 * @param offers - All validated active maker offers, including unconfigured markets.
 * @param ownership - Strategy-owned bootstrap buys and ladder sells allowed to overlap.
 * @returns Canonical IDs having a highest buy tick at or above the lowest sell tick.
 */
export const invertedMarketIds = (
  offers: readonly ReturnType<typeof offerFromApi>[],
  ownership: OverlapOwnership = {}
) => {
  const offersByMarket = new Map<Hex, OwnedOverlapBookOffer[]>()
  for (const offer of offers) {
    const overlapOwner = ownedOverlapRole(offer, ownership)
    const projected = {
      marketId: offer.marketId,
      buy: offer.buy,
      tick: BigInt(offer.tick),
      ...(overlapOwner === undefined ? {} : { overlapOwner })
    }
    const marketOffers = offersByMarket.get(offer.marketId)
    if (marketOffers) marketOffers.push(projected)
    else offersByMarket.set(offer.marketId, [projected])
  }
  return [...offersByMarket]
    .filter(([, marketOffers]) => hasInvalidOwnedBootstrapLadderSpread(marketOffers))
    .map(([marketId]) => marketId)
}

/**
 * Creates a sanitized aggregate Morpho API deadline failure.
 * @returns A provider-safe timeout error without URL or response metadata.
 */
export const morphoApiTimeout = () =>
  new SafeProviderError({
    kind: 'provider-error',
    provider: 'morpho-api',
    name: 'TimeoutError',
    code: 'REQUEST_TIMEOUT',
    context: 'request'
  })
