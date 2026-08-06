import type { Address, Hex } from 'viem'

import { describe, expect, test } from 'bun:test'

import { ConfigService } from '../../../src/config/config.service'
import { OfferInvalidationAdapterError } from '../../../src/infrastructure/invalidation/offer-invalidation-adapter.error'
import { createProductionOfferInvalidationPort } from '../../../src/infrastructure/invalidation/production-offer-invalidation'

const maker: Address = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const foreignMaker: Address = '0x1111111111111111111111111111111111111111'
const marketId: Hex = `0x${'55'.repeat(32)}`

const environment = {
  CHAIN_ID: '8453',
  RPC_URL: 'https://rpc.example',
  REFERENCE_RPC_URL: 'https://archive.example',
  MAKER_ADDRESS: maker,
  MIDNIGHT_ADDRESS: '0x2222222222222222222222222222222222222222',
  LOAN_ASSET_ADDRESS: '0x3333333333333333333333333333333333333333',
  RATIFIER_ADDRESS: '0x4444444444444444444444444444444444444444',
  MARKET_IDS: marketId,
  REFERENCE_MARKET_ID: `0x${'66'.repeat(32)}`,
  NATIVE_RESERVE_WEI: '10',
  MAXIMUM_LEND_EXPOSURE_ASSETS: '100',
  MORPHO_API_BASE_URL: 'https://api.example',
  ROUTER_API_BASE_URL: 'https://router.example'
}

describe('createProductionOfferInvalidationPort', () => {
  test('constructs a read-only port without loading a private key or starting provider reads', async () => {
    const config = ConfigService.from(environment, { readOnly: true })

    const port = await createProductionOfferInvalidationPort(config)

    expect(port.mode()).toBe('readonly')
  })

  test('rejects a write configuration whose key does not control the maker', async () => {
    const config = ConfigService.from({
      ...environment,
      MAKER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
      MAKER_ADDRESS: foreignMaker
    })

    await expect(
      Promise.resolve().then(() => createProductionOfferInvalidationPort(config))
    ).rejects.toBeInstanceOf(OfferInvalidationAdapterError)
  })
})
