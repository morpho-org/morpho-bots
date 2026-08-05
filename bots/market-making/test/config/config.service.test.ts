import type { Address, Hex } from 'viem'

import { bytesToHex, hexToBytes } from 'viem'
import { describe, expect, test } from 'vitest'

import { ConfigValidationError } from '../../src/config/config-validation.error'
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
  test.each([
    ['8453', true],
    ['0008453', true],
    ['  0008453\t', true],
    ['+8453', false],
    ['8453.0', false],
    ['8.453e3', false],
    ['-8453', false],
    ['0', false],
    ['8454', false],
    ['9007199254740992', false]
  ] as const)('parses CHAIN_ID=%j with exact Base decimal semantics', (value, accepted) => {
    const load = () => ConfigService.from({ ...environment, CHAIN_ID: value })
    if (accepted) expect(load().setup.chainId).toBe(8453)
    else expect(load).toThrow('Unsupported CHAIN_ID; supported: 8453')
  })

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
    expect(config.transactionReceiptTimeoutMs).toBe(180_000)
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

  test('accepts an empty market allowlist', () => {
    expect(ConfigService.from({ ...environment, MARKET_IDS: ' , ' }).setup.marketIds).toEqual([])
  })

  test('loads optional Blue configuration and validates it when provided', () => {
    expect(
      ConfigService.from({
        ...environment,
        REFERENCE_MARKET_ID: undefined,
        REFERENCE_RPC_URL: undefined
      }).setup.referenceMarketId
    ).toBeUndefined()
    expect(() => ConfigService.from({ ...environment, REFERENCE_MARKET_ID: '0x1234' })).toThrow(
      'REFERENCE_MARKET_ID must be a 0x-prefixed 32-byte hex value'
    )
  })

  test('trims optional Blue configuration and treats blank values as absent', () => {
    const normalized = ConfigService.from({
      ...environment,
      REFERENCE_MARKET_ID: `  ${referenceMarketId}  `,
      REFERENCE_RPC_URL: '  https://archive.example/path/  '
    })
    const absent = ConfigService.from({
      ...environment,
      REFERENCE_MARKET_ID: '  ',
      REFERENCE_RPC_URL: ''
    })

    expect(normalized.setup.referenceMarketId).toBe(referenceMarketId)
    expect(normalized.referenceRpcUrl).toBe('https://archive.example/path')
    expect(absent.setup.referenceMarketId).toBeUndefined()
    expect(absent.referenceRpcUrl).toBeUndefined()
  })

  test('loads a bounded provider timeout and rejects unsafe values', () => {
    expect(
      ConfigService.from({ ...environment, REQUEST_TIMEOUT_MS: '2500' }).requestTimeoutMs
    ).toBe(2_500)
    expect(() => ConfigService.from({ ...environment, REQUEST_TIMEOUT_MS: '0' })).toThrow(
      'REQUEST_TIMEOUT_MS must be between 1 and 120000'
    )
  })

  test('loads a separate bounded transaction receipt timeout', () => {
    expect(
      ConfigService.from({
        ...environment,
        REQUEST_TIMEOUT_MS: '2500',
        TRANSACTION_RECEIPT_TIMEOUT_MS: '300000'
      }).transactionReceiptTimeoutMs
    ).toBe(300_000)
    expect(() =>
      ConfigService.from({ ...environment, TRANSACTION_RECEIPT_TIMEOUT_MS: '900001' })
    ).toThrow('TRANSACTION_RECEIPT_TIMEOUT_MS must be between 1 and 900000')
  })

  test('rejects malformed private keys and unsigned integer settings', () => {
    expect(() => ConfigService.from({ ...environment, MAKER_PRIVATE_KEY: '0x12' })).toThrow(
      'MAKER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string'
    )
    expect(() => ConfigService.from({ ...environment, NATIVE_RESERVE_WEI: '-1' })).toThrow(
      'NATIVE_RESERVE_WEI must be an unsigned decimal integer'
    )
  })

  test('rejects a 32-byte value that is not a valid secp256k1 private key', () => {
    let error: unknown
    try {
      ConfigService.from({ ...environment, MAKER_PRIVATE_KEY: `0x${'00'.repeat(32)}` })
    } catch (value) {
      error = value
    }

    expect(error).toBeInstanceOf(ConfigValidationError)
    expect(error).toMatchObject({ field: 'MAKER_PRIVATE_KEY', reason: 'invalid-private-key' })
  })

  test('uses a stable typed config error with safe field and reason metadata', () => {
    let error: unknown
    try {
      ConfigService.from({ ...environment, MAKER_PRIVATE_KEY: 'private-secret' })
    } catch (value) {
      error = value
    }

    expect(error).toBeInstanceOf(ConfigValidationError)
    expect(error).toMatchObject({
      name: 'ConfigValidationError',
      field: 'MAKER_PRIVATE_KEY',
      reason: 'invalid-bytes32'
    })
    expect(JSON.stringify(error)).not.toContain('private-secret')
  })
})
