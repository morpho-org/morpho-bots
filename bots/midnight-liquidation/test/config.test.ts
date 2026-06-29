import type { Address } from 'viem'

import { Executor } from '@repo/contracts'
import { describe, expect, it } from 'bun:test'
import { getAddress, parseGwei } from 'viem'
import { mainnet } from 'viem/chains'

import type { ChainConfig, Config, SwapConfig } from '../src/config'

import { loadConfig, parseSwapConfig } from '../src/config'

const MIDNIGHT = '0x1111111111111111111111111111111111111111' as Address
const EXECUTOOOR = '0x3333333333333333333333333333333333333333'
const COLLATERAL = '0x4444444444444444444444444444444444444444'
const ROUTER = '0x5555555555555555555555555555555555555555'
const PRIVATE_KEY = `0x${'a'.repeat(64)}`

const CHAIN_MAP: Record<number, ChainConfig> = {
  [mainnet.id]: { chain: mainnet, midnight: MIDNIGHT }
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
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    ...overrides
  }
}

describe('loadConfig', () => {
  it('parses a complete env into a typed config, applying defaults', () => {
    const config: Config = loadConfig(baseEnv(), deps)

    expect(config.chainId).toBe(mainnet.id)
    expect(config.chain).toBe(mainnet)
    expect(config.midnight).toBe(MIDNIGHT)
    expect(config.rpcUrl).toBe('https://rpc.example')
    expect(config.rpcUrlFallback).toBeUndefined()
    expect(config.executooorAddress).toBe(getAddress(EXECUTOOOR))
    expect(config.databaseUrl).toBe('postgresql://u:p@localhost:5432/db')
    expect(config.maxFeeWei).toBe(parseGwei('300'))
    expect(config.cacheDir).toBe('.cache')
    expect(config.logLevel).toBe('info')
    const entry = config.swapConfig[String(mainnet.id)]?.[COLLATERAL]
    expect(entry?.venue).toBe('uniswap-v3') // legacy entry (no `venue`) defaults to uniswap-v3
    if (entry?.venue === 'uniswap-v3') expect(entry.router).toBe(getAddress(ROUTER))
    // Quoting tunables apply their defaults.
    expect(config.quoting.quoteTimeoutMs).toBe(2500)
    expect(config.quoting.httpRps).toBe(2)
    expect(config.quoting.maxRouteImpactBps).toBe(500)
    expect(config.quoting.backoffBaseBlocks).toBe(2n)
  })

  it('honors optional overrides', () => {
    const config = loadConfig(
      baseEnv({
        RPC_URL_FALLBACK: 'https://rpc.fallback',
        MAX_FEE_GWEI: '42',
        CACHE_DIR: '/tmp/cache',
        LOG_LEVEL: 'debug'
      }),
      deps
    )

    expect(config.rpcUrlFallback).toBe('https://rpc.fallback')
    expect(config.maxFeeWei).toBe(parseGwei('42'))
    expect(config.cacheDir).toBe('/tmp/cache')
    expect(config.logLevel).toBe('debug')
  })

  it('resolves the built-in Base chain config from the default map', () => {
    // No chainMap injected → exercises the real CHAIN_MAP populated with Base.
    const config = loadConfig(baseEnv({ CHAIN_ID: '8453' }), { readFile: () => SWAP_JSON })
    expect(config.chainId).toBe(8453)
    expect(config.chain.id).toBe(8453)
    expect(config.midnight).toBe(getAddress('0x3726353bCDDba7c29a17D46D8a35D1E8b2E51854'))
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

  it('defaults to the Executor deterministic CREATE2 address when EXECUTOOOR_ADDRESS is unset', () => {
    const config = loadConfig(baseEnv({ EXECUTOOOR_ADDRESS: undefined }), deps)
    expect(config.executooorAddress).toBe(getAddress(Executor.with().address))
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

  it('loads an empty swap config (no routes) when SWAP_CONFIG_PATH is unset', () => {
    const config = loadConfig(baseEnv({ SWAP_CONFIG_PATH: undefined }), deps)
    expect(config.swapConfig).toEqual({})
  })

  it('loads an empty swap config when the file is absent (ENOENT), not fatal', () => {
    const absentDeps = {
      chainMap: CHAIN_MAP,
      readFile: () => {
        throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT' })
      }
    }
    const config = loadConfig(baseEnv(), absentDeps)
    expect(config.swapConfig).toEqual({})
  })

  it('throws on a non-ENOENT read failure (e.g. permissions)', () => {
    const eaccesDeps = {
      chainMap: CHAIN_MAP,
      readFile: () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      }
    }
    expect(() => loadConfig(baseEnv(), eaccesDeps)).toThrow(/Failed to read SWAP_CONFIG_PATH/)
  })

  it('throws when a referenced venue needs an API key that is not set', () => {
    const zeroxJson = JSON.stringify({
      [mainnet.id]: { [COLLATERAL]: { venue: '0x', slippageBps: 50 } }
    })
    expect(() => loadConfig(baseEnv(), { chainMap: CHAIN_MAP, readFile: () => zeroxJson })).toThrow(
      /venue '0x'.*ZEROX_API_KEY is not set/
    )
  })

  it('boots when the referenced venue API key is present', () => {
    const zeroxJson = JSON.stringify({
      [mainnet.id]: { [COLLATERAL]: { venue: '0x', slippageBps: 50 } }
    })
    const config = loadConfig(baseEnv({ ZEROX_API_KEY: 'key-123' }), {
      chainMap: CHAIN_MAP,
      readFile: () => zeroxJson
    })
    expect(config.swapConfig[String(mainnet.id)]?.[COLLATERAL]?.venue).toBe('0x')
  })

  it('parses quoting tunables from env, overriding defaults', () => {
    const config = loadConfig(baseEnv({ HTTP_RPS: '1', MAX_ROUTE_IMPACT_BPS: '250' }), deps)
    expect(config.quoting.httpRps).toBe(1)
    expect(config.quoting.maxRouteImpactBps).toBe(250)
  })

  it('throws on an out-of-range MAX_ROUTE_IMPACT_BPS', () => {
    expect(() => loadConfig(baseEnv({ MAX_ROUTE_IMPACT_BPS: '20000' }), deps)).toThrow(
      /MAX_ROUTE_IMPACT_BPS must be <= 10000/
    )
  })
})

describe('parseSwapConfig', () => {
  it('parses a legacy (no-venue) config, defaulting venue to uniswap-v3 and checksumming the router', () => {
    const parsed: SwapConfig = parseSwapConfig({
      [mainnet.id]: { [COLLATERAL]: { router: ROUTER, fee: 3000, slippageBps: 100 } }
    })
    expect(parsed[String(mainnet.id)]?.[COLLATERAL]).toEqual({
      venue: 'uniswap-v3',
      router: getAddress(ROUTER),
      fee: 3000,
      slippageBps: 100
    })
  })

  it('parses an explicit 0x venue entry (no router/fee)', () => {
    const parsed = parseSwapConfig({
      [mainnet.id]: { [COLLATERAL]: { venue: '0x', slippageBps: 100 } }
    })
    expect(parsed[String(mainnet.id)]?.[COLLATERAL]).toEqual({ venue: '0x', slippageBps: 100 })
  })

  it('rejects a 0x entry carrying uniswap-only fields (strict union arm)', () => {
    expect(() =>
      parseSwapConfig({
        [mainnet.id]: { [COLLATERAL]: { venue: '0x', router: ROUTER, fee: 500, slippageBps: 50 } }
      })
    ).toThrow()
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
