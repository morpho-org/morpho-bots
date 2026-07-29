import type { Address, Hex } from 'viem'

import { describe, expect, test } from 'bun:test'

import { ConfigValidationError } from '../../src/config/config-validation.error'
import { ConfigService } from '../../src/config/config.service'

const environment = {
  CHAIN_ID: '8453',
  RPC_URL: 'https://rpc.example',
  REFERENCE_RPC_URL: 'https://archive.example',
  MAKER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
  MAKER_ADDRESS: '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A' as Address,
  MIDNIGHT_ADDRESS: '0x2222222222222222222222222222222222222222' as Address,
  LOAN_ASSET_ADDRESS: '0x3333333333333333333333333333333333333333' as Address,
  RATIFIER_ADDRESS: '0x4444444444444444444444444444444444444444' as Address,
  MARKET_IDS: `0x${'55'.repeat(32)}`,
  REFERENCE_MARKET_ID: `0x${'77'.repeat(32)}`,
  NATIVE_RESERVE_WEI: '10',
  MAXIMUM_LEND_EXPOSURE_ASSETS: '100',
  MORPHO_API_BASE_URL: 'https://api.example',
  ROUTER_API_BASE_URL: 'https://router.example',
  V0_OFFER_GROUP_IDS: `0x${'66'.repeat(32)}`
}

describe('ConfigService private-key validation', () => {
  test.each([
    [`0x${'00'.repeat(32)}`, 'zero'],
    ['0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141', 'curve order']
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
})
