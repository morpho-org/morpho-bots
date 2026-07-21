import { describe, expect, test } from 'bun:test'

import { ConfigService } from '../../src/config/config.service'

const KEY = `0x${'11'.repeat(32)}`
const REQUIRED = {
  CHAIN_ID: '8453',
  RPC_URL: 'http://rpc.example',
  RESOLVER_PRIVATE_KEY: KEY
}

describe('ConfigService', () => {
  test('loads defaults and derives the resolver address', () => {
    const config = ConfigService.from(REQUIRED)

    expect(config.chainId).toBe(8453)
    expect(config.apiBaseUrl).toBe('https://api.morpho.org')
    expect(config.routerApiBaseUrl).toBe('https://api.morpho.org')
    expect(config.scanIntervalMs).toBe(15_000)
    expect(config.minimumProfit).toBe(1n)
    expect(config.resolver).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  test('normalizes a trailing slash from the API URL', () => {
    expect(ConfigService.from({ ...REQUIRED, API_BASE_URL: 'https://api.example/' }).apiBaseUrl).toBe(
      'https://api.example'
    )
  })

  test('accepts explicit resolver, fallback RPC, interval, profit, and fee values', () => {
    const config = ConfigService.from({
      ...REQUIRED,
      RPC_URL_FALLBACK: 'http://fallback.example',
      RESOLVER_ADDRESS: `0x${'22'.repeat(20)}`,
      SCAN_INTERVAL_MS: '30000',
      MIN_PROFIT_ASSETS: '100',
      MAX_FEE_GWEI: '50'
    })

    expect(config.rpcUrlFallback).toBe('http://fallback.example')
    expect(config.routerApiBaseUrl).toBe('https://router.example')
    expect(config.scanIntervalMs).toBe(30_000)
    expect(config.minimumProfit).toBe(100n)
    expect(config.maxFeeWei).toBe(50_000_000_000n)
  })

  test.each([
    [{ ...REQUIRED, CHAIN_ID: '1' }, 'Unsupported CHAIN_ID'],
    [{ ...REQUIRED, CHAIN_ID: '0x2105' }, 'CHAIN_ID'],
    [{ ...REQUIRED, RESOLVER_PRIVATE_KEY: '0x12' }, 'RESOLVER_PRIVATE_KEY'],
    [{ ...REQUIRED, RESOLVER_ADDRESS: 'not-an-address' }, 'RESOLVER_ADDRESS'],
    [{ ...REQUIRED, API_BASE_URL: 'not-a-url' }, 'API_BASE_URL'],
    [{ ...REQUIRED, ROUTER_API_BASE_URL: 'not-a-url' }, 'ROUTER_API_BASE_URL'],
    [{ ...REQUIRED, SCAN_INTERVAL_MS: '0' }, 'SCAN_INTERVAL_MS'],
    [{ ...REQUIRED, MIN_PROFIT_ASSETS: '-1' }, 'MIN_PROFIT_ASSETS']
  ])('rejects invalid configuration %#', (env, message) => {
    expect(() => ConfigService.from(env)).toThrow(message)
  })
})
