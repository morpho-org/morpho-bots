import { describe, expect, test } from 'vitest'

import { ConfigService } from '../../src/config/config.service'
import { InvalidConfigurationError } from '../../src/config/invalid-configuration.error'
import { InvalidSimulationCallerAddressError } from '../../src/config/invalid-simulation-caller-address.error'
import { ResolverPrivateKeyRequiredError } from '../../src/config/resolver-private-key-required.error'

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
    expect(config.maxMatches).toBe(10)
    expect(config.resolver).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(config.readOnly).toBe(false)
    expect(config.privateKey).toBe(KEY)
  })

  test('does not require a resolver private key in readonly mode', () => {
    const config = ConfigService.from({
      CHAIN_ID: '8453',
      RPC_URL: 'http://rpc.example',
      READONLY: 'true',
      SIMULATION_CALLER_ADDRESS: `0x${'33'.repeat(20)}`,
      RESOLVER_PRIVATE_KEY: 'ignored-in-readonly-mode'
    })

    expect(config.readOnly).toBe(true)
    expect(config.privateKey).toBeUndefined()
    expect(config.simulationCaller).toBe(`0x${'33'.repeat(20)}`)
  })

  test.each(['true', 'TRUE', '1'])('accepts READONLY=%s as readonly mode', value => {
    const config = ConfigService.from({
      CHAIN_ID: '8453',
      RPC_URL: 'http://rpc.example',
      READONLY: value,
      SIMULATION_CALLER_ADDRESS: `0x${'33'.repeat(20)}`
    })

    expect(config.readOnly).toBe(true)
  })

  test.each([undefined, '', 'false', 'FALSE', '0'])('accepts READONLY=%s as write mode', value => {
    expect(ConfigService.from({ ...REQUIRED, READONLY: value }).readOnly).toBe(false)
  })

  test.each([
    'not-an-address',
    '0x0000000000000000000000000000000000000000',
    `0x${'33'.repeat(20)}`
  ])('ignores stale SIMULATION_CALLER_ADDRESS=%s in write mode', simulationCaller => {
    const config = ConfigService.from({
      ...REQUIRED,
      SIMULATION_CALLER_ADDRESS: simulationCaller
    })

    expect(config.readOnly).toBe(false)
    expect(config.privateKey).toBe(KEY)
    expect(config.simulationCaller).toBeUndefined()
  })

  test.each(['yes', '2', 'truthy'])('rejects malformed READONLY=%s fail-closed', value => {
    expect(() => ConfigService.from({ ...REQUIRED, READONLY: value })).toThrow(
      InvalidConfigurationError
    )
  })

  test('requires a validated keyless simulation caller in readonly mode', () => {
    expect(() =>
      ConfigService.from({ CHAIN_ID: '8453', RPC_URL: 'http://rpc.example', READONLY: 'true' })
    ).toThrow(InvalidConfigurationError)
    expect(() =>
      ConfigService.from({
        CHAIN_ID: '8453',
        RPC_URL: 'http://rpc.example',
        READONLY: 'true',
        SIMULATION_CALLER_ADDRESS: 'not-an-address'
      })
    ).toThrow(InvalidConfigurationError)
  })

  test('rejects the zero simulation caller address with a named error', () => {
    expect(() =>
      ConfigService.from({
        CHAIN_ID: '8453',
        RPC_URL: 'http://rpc.example',
        READONLY: 'true',
        SIMULATION_CALLER_ADDRESS: '0x0000000000000000000000000000000000000000'
      })
    ).toThrow(InvalidSimulationCallerAddressError)
  })

  test('requires a resolver private key in normal mode with a named error', () => {
    expect(() => ConfigService.from({ CHAIN_ID: '8453', RPC_URL: 'http://rpc.example' })).toThrow(
      ResolverPrivateKeyRequiredError
    )
  })

  test('normalizes a trailing slash from the API URL', () => {
    expect(
      ConfigService.from({ ...REQUIRED, API_BASE_URL: 'https://api.example/' }).apiBaseUrl
    ).toBe('https://api.example')
  })

  test('accepts explicit resolver, fallback RPC, interval, profit, and fee values', () => {
    const config = ConfigService.from({
      ...REQUIRED,
      RPC_URL_FALLBACK: 'http://fallback.example',
      ROUTER_API_BASE_URL: 'https://router.example',
      RESOLVER_ADDRESS: `0x${'22'.repeat(20)}`,
      SCAN_INTERVAL_MS: '30000',
      MIN_PROFIT_ASSETS: '100',
      MAX_FEE_GWEI: '50',
      MAX_MATCHES: '4'
    })

    expect(config.rpcUrlFallback).toBe('http://fallback.example')
    expect(config.routerApiBaseUrl).toBe('https://router.example')
    expect(config.scanIntervalMs).toBe(30_000)
    expect(config.minimumProfit).toBe(100n)
    expect(config.maxMatches).toBe(4)
    expect(config.maxFeeWei).toBe(50_000_000_000n)
  })

  test.each([
    [{ ...REQUIRED, CHAIN_ID: '1' }, 'Unsupported CHAIN_ID'],
    [{ ...REQUIRED, CHAIN_ID: '0x2105' }, 'CHAIN_ID'],
    [{ ...REQUIRED, READONLY: 'treu' }, 'READONLY'],
    [{ ...REQUIRED, RESOLVER_PRIVATE_KEY: '0x12' }, 'RESOLVER_PRIVATE_KEY'],
    [{ ...REQUIRED, RESOLVER_ADDRESS: 'not-an-address' }, 'RESOLVER_ADDRESS'],
    [{ ...REQUIRED, API_BASE_URL: 'not-a-url' }, 'API_BASE_URL'],
    [{ ...REQUIRED, ROUTER_API_BASE_URL: 'not-a-url' }, 'ROUTER_API_BASE_URL'],
    [{ ...REQUIRED, SCAN_INTERVAL_MS: '0' }, 'SCAN_INTERVAL_MS'],
    [{ ...REQUIRED, MIN_PROFIT_ASSETS: '-1' }, 'MIN_PROFIT_ASSETS'],
    [{ ...REQUIRED, MAX_MATCHES: '0' }, 'MAX_MATCHES'],
    [{ ...REQUIRED, MAX_MATCHES: '9007199254740992' }, 'MAX_MATCHES']
  ])('rejects invalid configuration %#', (env, message) => {
    expect(() => ConfigService.from(env)).toThrow(message)
  })
})
