import type { Address } from 'viem'

import { describe, expect, it } from 'bun:test'
import { getAddress, parseGwei } from 'viem'
import { mainnet } from 'viem/chains'

import type { ChainConfig, Config, SwapConfig } from '../src/config'

import { loadConfig, parseSwapConfig } from '../src/config'

const MIDNIGHT = '0x1111111111111111111111111111111111111111' as Address
const DEPLOYER = '0x2222222222222222222222222222222222222222' as Address
const EXECUTOOOR = '0x3333333333333333333333333333333333333333'
const COLLATERAL = '0x4444444444444444444444444444444444444444'
const ROUTER = '0x5555555555555555555555555555555555555555'
const PRIVATE_KEY = `0x${'a'.repeat(64)}`

const CHAIN_MAP: Record<number, ChainConfig> = {
  [mainnet.id]: { chain: mainnet, midnight: MIDNIGHT, deployer: DEPLOYER }
}

const SWAP_JSON = JSON.stringify({
  [mainnet.id]: { [COLLATERAL]: { router: ROUTER, fee: 500, slippageBps: 50 } }
})

const deps = { chainMap: CHAIN_MAP, readFile: () => SWAP_JSON }

function baseEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    CHAIN_ID: String(mainnet.id),
    RPC_URL: 'https://rpc.example',
    LIQUIDATOR_PRIVATE_KEY: PRIVATE_KEY,
    EXECUTOOOR_ADDRESS: EXECUTOOOR,
    SWAP_CONFIG_PATH: '/swap.json',
    ...overrides
  }
}

describe('loadConfig', () => {
  it('parses a complete env into a typed config, applying defaults', () => {
    const config: Config = loadConfig(baseEnv(), deps)

    expect(config.chainId).toBe(mainnet.id)
    expect(config.chain).toBe(mainnet)
    expect(config.midnight).toBe(MIDNIGHT)
    expect(config.deployer).toBe(DEPLOYER)
    expect(config.rpcUrl).toBe('https://rpc.example')
    expect(config.rpcUrlFallback).toBeUndefined()
    expect(config.executooorAddress).toBe(getAddress(EXECUTOOOR))
    expect(config.midnightApiUrl).toBe('https://api.morpho.dev')
    expect(config.maxFeeWei).toBe(parseGwei('300'))
    expect(config.cacheDir).toBe('.cache')
    expect(config.logLevel).toBe('info')
    expect(config.swapConfig[String(mainnet.id)]?.[COLLATERAL]?.router).toBe(getAddress(ROUTER))
  })

  it('honors optional overrides', () => {
    const config = loadConfig(
      baseEnv({
        RPC_URL_FALLBACK: 'https://rpc.fallback',
        MIDNIGHT_API_URL: 'https://api.example',
        MAX_FEE_GWEI: '42',
        CACHE_DIR: '/tmp/cache',
        LOG_LEVEL: 'debug'
      }),
      deps
    )

    expect(config.rpcUrlFallback).toBe('https://rpc.fallback')
    expect(config.midnightApiUrl).toBe('https://api.example')
    expect(config.maxFeeWei).toBe(parseGwei('42'))
    expect(config.cacheDir).toBe('/tmp/cache')
    expect(config.logLevel).toBe('debug')
  })

  it('throws when a required var is missing', () => {
    expect(() => loadConfig(baseEnv({ RPC_URL: undefined }), deps)).toThrow(
      /Missing required env var: RPC_URL/
    )
  })

  it('throws on an unknown CHAIN_ID', () => {
    expect(() => loadConfig(baseEnv({ CHAIN_ID: '999999' }), deps)).toThrow(
      /Unsupported CHAIN_ID 999999/
    )
  })

  it('throws on a non-decimal CHAIN_ID', () => {
    expect(() => loadConfig(baseEnv({ CHAIN_ID: '0x1' }), deps)).toThrow(
      /CHAIN_ID must be a positive integer/
    )
  })

  it('normalizes EXECUTOOOR_ADDRESS to its EIP-55 checksum', () => {
    const lower = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
    const config = loadConfig(baseEnv({ EXECUTOOOR_ADDRESS: lower }), deps)
    expect(config.executooorAddress).toBe(getAddress(lower))
    expect(config.executooorAddress).not.toBe(lower) // proved normalization happened
  })

  it('throws on a too-short private key', () => {
    expect(() => loadConfig(baseEnv({ LIQUIDATOR_PRIVATE_KEY: '0xabc' }), deps)).toThrow(
      /32-byte hex/
    )
  })

  it('throws on a correct-length private key with a non-hex character', () => {
    const badKey = `0x${'a'.repeat(63)}g` // 66 chars, but 'g' is not hex → isHex branch must fire
    expect(() => loadConfig(baseEnv({ LIQUIDATOR_PRIVATE_KEY: badKey }), deps)).toThrow(
      /32-byte hex/
    )
  })

  it('throws on an invalid EXECUTOOOR_ADDRESS', () => {
    expect(() => loadConfig(baseEnv({ EXECUTOOOR_ADDRESS: 'not-an-address' }), deps)).toThrow(
      /not a valid address/
    )
  })

  it('throws on an unknown LOG_LEVEL', () => {
    expect(() => loadConfig(baseEnv({ LOG_LEVEL: 'verbose' }), deps)).toThrow(
      /LOG_LEVEL must be one of/
    )
  })

  it('throws on a non-numeric MAX_FEE_GWEI', () => {
    expect(() => loadConfig(baseEnv({ MAX_FEE_GWEI: 'abc' }), deps)).toThrow(
      /MAX_FEE_GWEI must be a positive number/
    )
  })

  it('throws when the swap config file is malformed', () => {
    const badDeps = { chainMap: CHAIN_MAP, readFile: () => '{ not json' }
    expect(() => loadConfig(baseEnv(), badDeps)).toThrow(/Failed to load SWAP_CONFIG_PATH/)
  })
})

describe('parseSwapConfig', () => {
  it('parses a valid config and checksums router addresses', () => {
    const parsed: SwapConfig = parseSwapConfig({
      [mainnet.id]: { [COLLATERAL]: { router: ROUTER, fee: 3000, slippageBps: 100 } }
    })
    expect(parsed[String(mainnet.id)]?.[COLLATERAL]).toEqual({
      router: getAddress(ROUTER),
      fee: 3000,
      slippageBps: 100
    })
  })

  it('rejects a slippage above 100%', () => {
    expect(() =>
      parseSwapConfig({
        [mainnet.id]: { [COLLATERAL]: { router: ROUTER, fee: 500, slippageBps: 10001 } }
      })
    ).toThrow()
  })

  it('rejects an unknown extra field', () => {
    expect(() =>
      parseSwapConfig({
        [mainnet.id]: { [COLLATERAL]: { router: ROUTER, fee: 500, slippageBps: 50, extra: true } }
      })
    ).toThrow()
  })

  it('rejects a non-address collateral key', () => {
    expect(() =>
      parseSwapConfig({
        [mainnet.id]: { 'not-a-token': { router: ROUTER, fee: 500, slippageBps: 50 } }
      })
    ).toThrow()
  })

  it('rejects a non-numeric chain id key', () => {
    expect(() =>
      parseSwapConfig({ base: { [COLLATERAL]: { router: ROUTER, fee: 500, slippageBps: 50 } } })
    ).toThrow()
  })
})
