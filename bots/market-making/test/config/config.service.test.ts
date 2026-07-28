import type { Address, Hex } from 'viem'

import { describe, expect, test } from 'bun:test'
import { bytesToHex, hexToBytes } from 'viem'

import { ConfigService } from '../../src/config/config.service'

const maker: Address = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const midnight: Address = '0x2222222222222222222222222222222222222222'
const loanAsset: Address = '0x3333333333333333333333333333333333333333'
const ratifier: Address = '0x4444444444444444444444444444444444444444'
const marketId: Hex = `0x${'55'.repeat(32)}`
const referenceMarketId: Hex = `0x${'77'.repeat(32)}`
const groupId: Hex = `0x${'66'.repeat(32)}`
const environment = {
  CHAIN_ID: '8453',
  RPC_URL: 'https://rpc.example',
  REFERENCE_RPC_URL: 'https://archive.example',
  MAKER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
  MAKER_ADDRESS: maker,
  MIDNIGHT_ADDRESS: midnight,
  LOAN_ASSET_ADDRESS: loanAsset,
  RATIFIER_ADDRESS: ratifier,
  MARKET_IDS: marketId,
  REFERENCE_MARKET_ID: referenceMarketId,
  NATIVE_RESERVE_WEI: '10',
  MAXIMUM_LEND_EXPOSURE_ASSETS: '100',
  MORPHO_API_BASE_URL: 'https://api.example',
  ROUTER_API_BASE_URL: 'https://router.example',
  V0_OFFER_GROUP_IDS: groupId
}

describe('ConfigService', () => {
  test('loads and normalizes setup-check configuration', () => {
    const config = ConfigService.from(environment)

    expect(config.setup).toEqual({
      chainId: 8453,
      maker: environment.MAKER_ADDRESS,
      midnight: environment.MIDNIGHT_ADDRESS,
      nativeReserve: 10n,
      loanAsset: environment.LOAN_ASSET_ADDRESS,
      maximumLendExposure: 100n,
      ratifier: environment.RATIFIER_ADDRESS,
      marketIds: [marketId],
      referenceMarketId
    })
    expect(config.v0OfferGroupIds).toEqual([groupId])
    expect(config.requestTimeoutMs).toBe(10_000)
  })

  test('canonicalizes equivalent mixed-case market, group, and reference IDs', () => {
    const mixedCase: Hex = `0x${'aB'.repeat(32)}`
    const canonical = bytesToHex(hexToBytes(mixedCase))
    const config = ConfigService.from({
      ...environment,
      MARKET_IDS: mixedCase,
      V0_OFFER_GROUP_IDS: mixedCase,
      REFERENCE_MARKET_ID: mixedCase
    })

    expect(config.setup.marketIds).toEqual([canonical])
    expect(config.v0OfferGroupIds).toEqual([canonical])
    expect(config.setup.referenceMarketId).toBe(canonical)
  })

  test.each([
    ['MAKER_ADDRESS', 'not-an-address', 'MAKER_ADDRESS must be an EVM address'],
    ['MIDNIGHT_ADDRESS', '0x12', 'MIDNIGHT_ADDRESS must be an EVM address'],
    ['MARKET_IDS', '0x1234', 'MARKET_IDS must contain 0x-prefixed 32-byte hex values'],
    [
      'V0_OFFER_GROUP_IDS',
      'group',
      'V0_OFFER_GROUP_IDS must contain 0x-prefixed 32-byte hex values'
    ]
  ])('rejects malformed %s', (name, value, message) => {
    expect(() => ConfigService.from({ ...environment, [name]: value })).toThrow(message)
  })

  test('rejects an empty market allowlist', () => {
    expect(() => ConfigService.from({ ...environment, MARKET_IDS: ' , ' })).toThrow(
      'MARKET_IDS must contain at least one market id'
    )
  })

  test('requires one exact Blue reference market id', () => {
    expect(() => ConfigService.from({ ...environment, REFERENCE_MARKET_ID: undefined })).toThrow(
      'Missing required env var: REFERENCE_MARKET_ID'
    )
    expect(() => ConfigService.from({ ...environment, REFERENCE_MARKET_ID: '0x1234' })).toThrow(
      'REFERENCE_MARKET_ID must be a 0x-prefixed 32-byte hex value'
    )
  })

  test('loads a bounded provider timeout and rejects unsafe values', () => {
    expect(
      ConfigService.from({ ...environment, REQUEST_TIMEOUT_MS: '2500' }).requestTimeoutMs
    ).toBe(2_500)
    expect(() => ConfigService.from({ ...environment, REQUEST_TIMEOUT_MS: '0' })).toThrow(
      'REQUEST_TIMEOUT_MS must be between 1 and 120000'
    )
  })

  test('rejects malformed private keys and unsigned integer settings', () => {
    expect(() => ConfigService.from({ ...environment, MAKER_PRIVATE_KEY: '0x12' })).toThrow(
      'MAKER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string'
    )
    expect(() => ConfigService.from({ ...environment, NATIVE_RESERVE_WEI: '-1' })).toThrow(
      'NATIVE_RESERVE_WEI must be an unsigned decimal integer'
    )
  })
})
