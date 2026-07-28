import type { Hex } from 'viem'

import { getAddress, isAddress, isHex, parseAbi, size } from 'viem'

import { SafeProviderError } from '../../application/safe-provider.error'

export const BASE_CHAIN_ID = 8453
export const PAGE_SIZE = 1_000
export const MAX_OFFER_PAGES = 100
export const MAX_OFFER_ITEMS = PAGE_SIZE * MAX_OFFER_PAGES
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
// morpho-org/deployments@24c04410 address-book.json, Base EcrecoverRatifier.
// The deployment-specific runtime hash includes the immutable Midnight target.
export const BASE_ECRECOVER_RATIFIER_RUNTIME_HASH =
  '0xcce1e0dd38ae831e81a9270627af2c24c208409ec03d5654a28a33ead53b1ac1'
// morpho-ts 2.8.0 exposes chain addresses but no Morpho Blue ABI, and midnight-sdk 1.2.0
// intentionally covers Midnight only. Keep the minimal read-only Blue surface local.
export const MORPHO_BLUE_SETUP_ABI = parseAbi([
  'function idToMarketParams(bytes32 id) view returns ((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv))',
  'function market(bytes32 id) view returns ((uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee))'
])

const objectValue = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
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
export const arrayValue = (value: unknown, label: string) => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
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
  if (typeof value !== 'string' || !isAddress(value)) throw new Error(`${label} must be an address`)
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
    throw new Error(`${label} must be a 32-byte hex value`)
  }
  return value
}

const integerValue = (value: unknown, label: string) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer`)
  }
  return value
}

const bigintValue = (value: unknown, label: string) => {
  if (typeof value !== 'bigint') throw new Error(`${label} must be a bigint`)
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
 * Parses the Morpho API Midnight market projection used by setup checking.
 * @param value - One untrusted API market object.
 * @returns Normalized identity, listing, asset, and maturity fields.
 * @throws When required API fields are malformed.
 */
export const marketFromApi = (value: unknown) => {
  const market = objectValue(value, 'Morpho API market')
  return {
    id: bytes32Value(market.market_id, 'market_id'),
    listed: market.listed === true,
    loanToken: addressValue(market.loan_token, 'loan_token'),
    maturity: BigInt(integerValue(market.maturity, 'maturity'))
  }
}

/**
 * Parses one Router offer item needed for setup safety checks.
 * @param value - One untrusted Router offer item.
 * @returns Normalized market, maker, group, side, and tick fields.
 * @throws When required Router fields are malformed.
 */
export const offerFromApi = (value: unknown) => {
  const item = objectValue(value, 'Router offer item')
  const offer = objectValue(item.offer, 'Router offer')
  return {
    marketId: bytes32Value(item.market_id, 'offer market_id'),
    maker: addressValue(offer.maker, 'offer maker'),
    group: bytes32Value(offer.group, 'offer group'),
    buy: offer.buy === true,
    tick: integerValue(offer.tick, 'offer tick')
  }
}

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
 * Detects configured markets whose maker buy and sell ticks cross.
 * @param offers - Validated maker offers.
 * @param configuredMarkets - Market IDs within setup-check scope.
 * @returns Configured IDs having a highest buy tick at or above the lowest sell tick.
 */
export const invertedMarketIds = (
  offers: readonly ReturnType<typeof offerFromApi>[],
  configuredMarkets: readonly Hex[]
) =>
  configuredMarkets.filter(marketId => {
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
