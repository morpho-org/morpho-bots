import type { Address, Hex } from 'viem'

import { MAX_CONTINUOUS_FEE } from '@morpho-org/midnight-sdk'
import { bytesToHex, hexToBytes } from 'viem'
import { describe, expect, test } from 'vitest'

import { ConfigService } from '../../src/config/config.service'
import { ConfigValidationError } from '../../src/errors'

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
  MAX_FEE_GWEI: '100',
  MAX_TRANSACTION_SPEND_WEI: '100000000000000000',
  MAX_CONTINUOUS_FEE_CAP: '0',
  KERNEL_ENROLLMENT: 'enrolling',
  MAX_PUBLICATION_GAS: '5000000',
  MAX_PUBLICATION_DATA_BYTES: '65536',
  MAX_CANCELLATION_GAS: '100000',
  MAX_BATCH_CANCELLATION_GAS: '1000000',
  MAX_BATCH_CANCELLATION_DATA_BYTES: '65536',
  MAX_RATIFICATION_GAS: '100000',
  MORPHO_API_BASE_URL: 'https://api.example',
  ROUTER_API_BASE_URL: 'https://router.example',
  V0_OFFER_GROUP_IDS: groupId
}

describe('ConfigService', () => {
  test.each([
    ['8453', 8453],
    ['0008453', 8453],
    ['  0008453\t', 8453],
    ['1', 1],
    ['0001', 1],
    ['  1\t', 1],
    ['+8453', undefined],
    ['8453.0', undefined],
    ['8.453e3', undefined],
    ['-8453', undefined],
    ['+1', undefined],
    ['0', undefined],
    ['8454', undefined],
    ['10', undefined],
    ['9007199254740992', undefined]
  ] as const)(
    'parses CHAIN_ID=%j with exact supported-chain decimal semantics',
    (value, expected) => {
      const load = () => ConfigService.from({ ...environment, CHAIN_ID: value })
      if (expected !== undefined) expect(load().setup.chainId).toBe(expected)
      else expect(load).toThrow('Unsupported CHAIN_ID; supported: 1, 8453')
    }
  )

  test('loads and normalizes setup-check configuration', () => {
    const config = ConfigService.from(environment)

    expect(config.setup).toEqual({
      chainId: 8453,
      maker: environment.MAKER_ADDRESS,
      signerMode: 'private-key',
      signerNativeReserve: undefined,
      midnight: environment.MIDNIGHT_ADDRESS,
      nativeReserve: 10n,
      loanAsset: environment.LOAN_ASSET_ADDRESS,
      ratifier: environment.RATIFIER_ADDRESS,
      marketIds: [marketId],
      referenceMarketId,
      requiredAllowance: 0n,
      acceptedLossFactor: new Map(),
      debt: new Map()
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

  test('defaults the reference window to three days and accepts an override', () => {
    expect(ConfigService.from({ ...environment }).referenceLookbackSeconds).toBe(259_200n)
    expect(
      ConfigService.from({ ...environment, REFERENCE_LOOKBACK_SECONDS: '21600' })
        .referenceLookbackSeconds
    ).toBe(21_600n)
    expect(() => ConfigService.from({ ...environment, REFERENCE_LOOKBACK_SECONDS: '60' })).toThrow(
      'REFERENCE_LOOKBACK_SECONDS must be between 3600 and 2592000'
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

  test('reads the kernel finality rule, safe unless it says otherwise', () => {
    expect(ConfigService.from(environment).finality).toBe('safe')
    expect(ConfigService.from({ ...environment, FINALITY: 'finalized' }).finality).toBe('finalized')
    expect(ConfigService.from({ ...environment, FINALITY: '12' }).finality).toEqual({ depth: 12 })
    for (const FINALITY of ['latest', '0', '-1', '1.5'])
      expect(() => ConfigService.from({ ...environment, FINALITY })).toThrow(
        'FINALITY must be safe, finalized, or a positive block depth'
      )
  })

  test('requires the kernel enrollment, and a continuous-fee cap within the protocol maximum', () => {
    expect(ConfigService.from(environment).writePolicy).toMatchObject({
      enrollment: 'enrolling',
      maxContinuousFeeCap: 0n
    })
    expect(() => ConfigService.from({ ...environment, KERNEL_ENROLLMENT: undefined })).toThrow(
      'KERNEL_ENROLLMENT'
    )
    expect(() => ConfigService.from({ ...environment, KERNEL_ENROLLMENT: 'yes' })).toThrow(
      'KERNEL_ENROLLMENT must be enrolling or enrolled'
    )
    for (const unset of [undefined, '', ' '])
      expect(
        ConfigService.from({ ...environment, MAX_CONTINUOUS_FEE_CAP: unset }).writePolicy
          ?.maxContinuousFeeCap
      ).toBe(MAX_CONTINUOUS_FEE)
    expect(() => ConfigService.from({ ...environment, MAX_CONTINUOUS_FEE_CAP: '-1' })).toThrow(
      'MAX_CONTINUOUS_FEE_CAP'
    )
    expect(() =>
      ConfigService.from({ ...environment, MAX_CONTINUOUS_FEE_CAP: '317097920' })
    ).toThrow('MAX_CONTINUOUS_FEE_CAP must not exceed the protocol maximum continuous fee')
  })

  test('rejects malformed private keys and unsigned integer settings', () => {
    expect(() => ConfigService.from({ ...environment, MAKER_PRIVATE_KEY: '0x12' })).toThrow(
      'MAKER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string'
    )
    expect(() => ConfigService.from({ ...environment, NATIVE_RESERVE_WEI: '-1' })).toThrow(
      'NATIVE_RESERVE_WEI must be an unsigned decimal integer'
    )
    expect(() => ConfigService.from({ ...environment, NATIVE_RESERVE_WEI: '0' })).toThrow(
      'NATIVE_RESERVE_WEI must be greater than zero'
    )
  })

  test.each([
    ['0.005', 5_000_000n],
    ['1', 1_000_000_000n],
    ['  0.005\t', 5_000_000n],
    ['0.000000001', 1n]
  ] as const)('parses MAX_FEE_GWEI=%j as decimal gwei', (value, expected) => {
    const config = ConfigService.from({ ...environment, MAX_FEE_GWEI: value })

    expect(config.writePolicy?.maxFeePerGasWei).toBe(expected)
  })

  test.each([
    ['5e-7', 'invalid-decimal'],
    ['+1', 'invalid-decimal'],
    ['-0.005', 'invalid-decimal'],
    ['.005', 'invalid-decimal'],
    ['0.0000000005', 'invalid-decimal'],
    ['1.0000000005', 'invalid-decimal'],
    ['0', 'out-of-range'],
    ['0.000000000', 'out-of-range']
  ] as const)('rejects MAX_FEE_GWEI=%j', (value, reason) => {
    let error: unknown
    try {
      ConfigService.from({ ...environment, MAX_FEE_GWEI: value })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(ConfigValidationError)
    expect(error).toMatchObject({ field: 'MAX_FEE_GWEI', reason })
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

describe('ConfigService private-key validation', () => {
  test.each([
    [`0x${'00'.repeat(32)}`, 'zero'],
    ['0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141', 'curve order'],
    [`0x${'1'.repeat(63)}`, 'odd length']
  ])('rejects an unusable secp256k1 private key (%s, %s)', privateKey => {
    let error: unknown
    try {
      ConfigService.from({ ...environment, MAKER_PRIVATE_KEY: privateKey })
    } catch (value) {
      error = value
    }
    expect(error).toBeInstanceOf(ConfigValidationError)
    expect(error).toMatchObject({ field: 'MAKER_PRIVATE_KEY', reason: 'invalid-private-key' })
    expect(JSON.stringify(error)).not.toContain(privateKey)
  })

  test('accepts a usable secp256k1 private key', () => {
    expect(ConfigService.from(environment).privateKey).toBe(environment.MAKER_PRIVATE_KEY as Hex)
  })

  test('uses only the maker address in read-only mode', () => {
    const config = ConfigService.from(
      { ...environment, MAKER_PRIVATE_KEY: 'ignored-private-key' },
      { readOnly: true }
    )

    expect(config.readOnly).toBe(true)
    expect(config.identity).toEqual({ readOnly: true, maker: environment.MAKER_ADDRESS })
    expect(config.privateKey).toBeUndefined()
  })

  test('still requires the private key when read-only mode is absent', () => {
    expect(() => ConfigService.from({ ...environment, MAKER_PRIVATE_KEY: undefined })).toThrow(
      'Missing required env var: MAKER_PRIVATE_KEY'
    )
  })
})
