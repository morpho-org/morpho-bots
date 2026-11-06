import type { Hex } from 'viem'

import {
  bytesToHex,
  getAddress,
  hexToBytes,
  isAddress,
  isAddressEqual,
  isHex,
  size,
  maxUint128
} from 'viem'

import type { OwnedOverlapBookOffer } from '../../domain/intentional-overlap'

import { hasInvalidOwnedBootstrapLadderSpread } from '../../domain/intentional-overlap'
import { ProviderResponseError } from '../../errors'

export const PAGE_SIZE = 100
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
// Per-chain ratifier runtime hashes live in config/supported-chains.utils.ts, beside the chain's
// Midnight addresses, because the ratifier runtime embeds its immutable Midnight target.
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
 * Projects the terms a maker borrows under from a `Midnight.toMarket` response.
 * @param value - Untrusted `toMarket` response.
 * @returns The index, LLTV, and oracle of the collateral slot whose token is the loan token (absent
 * when the market lists none), plus the market's enter gate and maturity.
 * @throws When the response or any collateral entry is malformed.
 */
export const borrowTermsFromContract = (value: unknown) => {
  const market = objectValue(value, 'Midnight.toMarket response')
  const loanToken = addressValue(market.loanToken, 'market.loanToken')
  const slots = arrayValue(market.collateralParams, 'market.collateralParams').map(item => {
    const slot = objectValue(item, 'market.collateralParams item')
    return {
      token: addressValue(slot.token, 'collateral token'),
      lltv: bigintValue(slot.lltv, 'collateral lltv'),
      oracle: addressValue(slot.oracle, 'collateral oracle')
    }
  })
  const index = slots.findIndex(slot => isAddressEqual(slot.token, loanToken))
  return {
    ...(index === -1
      ? {}
      : {
          loanSlot: { index: BigInt(index), lltv: slots[index]!.lltv, oracle: slots[index]!.oracle }
        }),
    enterGate: addressValue(market.enterGate, 'market.enterGate'),
    maturity: bigintValue(market.maturity, 'market.maturity')
  }
}

/**
 * Extracts canonical market rows from the documented markets endpoint.
 * @param value - Untrusted markets response.
 * @param chainId - Configured chain every accepted row must identify.
 * @returns Identity, curated listing, loan asset, and maturity for every row identifying the
 * configured chain.
 * @throws When the response envelope or any market identity field is malformed.
 * @remarks Rows naming any other chain are dropped rather than rejected, so a provider that widens
 * its response to further chains cannot promote a foreign market into the configured chain's set.
 * This endpoint is the market registry used instead of the books endpoint, which documents that it
 * excludes past maturities even when specific IDs are requested.
 */
export const apiMarkets = (value: unknown, chainId: number) => {
  const response = objectValue(value, 'Morpho API markets response')
  return arrayValue(response.data, 'Morpho API markets data').flatMap(item => {
    const market = objectValue(item, 'Morpho API market')
    const rowChainId = integerValue(market.chain_id, 'market chain_id')
    if (rowChainId !== chainId) return []
    return [
      {
        id: bytes32Value(market.market_id, 'market_id'),
        listed: booleanValue(market.listed, 'market listed flag'),
        loanToken: addressValue(market.loan_token, 'market loan_token'),
        maturity: BigInt(integerValue(market.maturity, 'market maturity'))
      }
    ]
  })
}

type OverlapOwnership = {
  bootstrapBuyGroupIds?: ReadonlySet<Hex>
  ladderSellGroupIds?: ReadonlySet<Hex>
}

type SetupOffer = Readonly<{ marketId: Hex; group: Hex; buy: boolean; tick: bigint }>

const ownedOverlapRole = (offer: SetupOffer, ownership: OverlapOwnership) => {
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
  offers: readonly SetupOffer[],
  ownership: OverlapOwnership = {}
) => {
  const offersByMarket = new Map<Hex, OwnedOverlapBookOffer[]>()
  for (const offer of offers) {
    const overlapOwner = ownedOverlapRole(offer, ownership)
    const projected = {
      marketId: offer.marketId,
      buy: offer.buy,
      tick: offer.tick,
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
 * Validates a protocol position balance at the setup provider boundary.
 * @param value - Untrusted RPC result.
 * @param operation - Safe operation identifier for a malformed response.
 * @returns The balance when it fits the protocol's uint128 storage.
 * @throws `ProviderResponseError` with safe operation metadata when the balance is malformed.
 */
export const uint128Value = (value: unknown, operation: string) => {
  if (typeof value !== 'bigint' || value < 0n || value > maxUint128) {
    throw new ProviderResponseError('rpc', operation, `${operation} response must be a uint128`)
  }
  return value
}
