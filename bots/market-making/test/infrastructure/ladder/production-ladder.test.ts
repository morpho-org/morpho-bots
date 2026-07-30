import type { Address, Hex } from 'viem'

import { describe, expect, test } from 'bun:test'

import { ConfigService } from '../../../src/config/config.service'
import { LadderAdapterError } from '../../../src/infrastructure/ladder/ladder-adapter.error'
import { createProductionLadderAdapters } from '../../../src/infrastructure/ladder/production-ladder'

const maker: Address = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const foreignMaker: Address = '0x1111111111111111111111111111111111111111'
const midnight: Address = '0x2222222222222222222222222222222222222222'
const loanToken: Address = '0x3333333333333333333333333333333333333333'
const ratifier: Address = '0x4444444444444444444444444444444444444444'
const marketId: Hex = `0x${'55'.repeat(32)}`
const referenceMarketId: Hex = `0x${'66'.repeat(32)}`

const environment = {
  CHAIN_ID: '8453',
  RPC_URL: 'https://rpc.example',
  REFERENCE_RPC_URL: 'https://archive.example',
  MAKER_ADDRESS: maker,
  MIDNIGHT_ADDRESS: midnight,
  LOAN_ASSET_ADDRESS: loanToken,
  RATIFIER_ADDRESS: ratifier,
  MARKET_IDS: marketId,
  REFERENCE_MARKET_ID: referenceMarketId,
  NATIVE_RESERVE_WEI: '10',
  MAXIMUM_LEND_EXPOSURE_ASSETS: '100',
  MORPHO_API_BASE_URL: 'https://api.example',
  ROUTER_API_BASE_URL: 'https://router.example'
}

describe('createProductionLadderAdapters', () => {
  test('constructs read-only ports without loading a private key or starting provider reads', () => {
    const config = ConfigService.from(environment, { readOnly: true })

    const adapters = createProductionLadderAdapters(config)

    expect(Object.hasOwn(adapters.positions, 'readMarket')).toBe(true)
    expect(Object.hasOwn(adapters.rates, 'readRate')).toBe(true)
    expect(Object.hasOwn(adapters.make, 'readActive')).toBe(true)
  })

  test('rejects a write configuration whose key does not control the maker', () => {
    const config = ConfigService.from({
      ...environment,
      MAKER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
      MAKER_ADDRESS: foreignMaker
    })

    const error = (() => {
      try {
        createProductionLadderAdapters(config)
      } catch (value) {
        return value
      }
      return undefined
    })()

    expect(error).toBeInstanceOf(LadderAdapterError)
    expect((error as LadderAdapterError).operation).toBe('maker-private-key-mismatch')
  })
})
