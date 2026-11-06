import { describe, expect, test } from 'vitest'

import { loadConfig } from '../src/config'
import { InvalidConfigurationError } from '../src/errors'

const KEY = `0x${'11'.repeat(32)}`
const CALLER = `0x${'33'.repeat(20)}`
const WRITE = {
  CHAIN_ID: '8453',
  RPC_URL: 'http://rpc.example',
  RESOLVER_PRIVATE_KEY: KEY,
  FINALITY_8453: 'safe',
  KERNEL_STATE_DIR: '/state',
  KERNEL_ENROLLMENT: 'enrolled',
  MAX_FEE_GWEI: '0.5',
  MAX_SPEND_ETH: '0.01',
  MAX_GAS_LIMIT: '15000000'
}
const READONLY = {
  CHAIN_ID: '8453',
  RPC_URL: 'http://rpc.example',
  READONLY: 'true',
  SIMULATION_CALLER_ADDRESS: CALLER
}

describe('loadConfig', () => {
  test('loads defaults, derives the resolver address, and takes the fee bounds as given', () => {
    const config = loadConfig(WRITE)

    expect(config.chainId).toBe(8453)
    expect(config.apiBaseUrl).toBe('https://api.morpho.org')
    expect(config.routerApiBaseUrl).toBe('https://api.morpho.org')
    expect(config.scanIntervalMs).toBe(15_000)
    expect(config.worldValidMs).toBe(30_000)
    expect(config.minimumProfit).toBe(1n)
    expect(config.maxMatches).toBe(10)
    expect(config.resolver).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(config.mode).toStrictEqual({
      readOnly: false,
      privateKey: KEY,
      finality: 'safe',
      kernel: { stateDirectory: '/state', enrollment: 'enrolled' },
      maxFeePerGasWei: 500_000_000n,
      maxGasLimit: 15_000_000n,
      maxSpendWei: 10_000_000_000_000_000n
    })
  })

  test('needs neither a key nor kernel settings in readonly mode, and keeps no key', () => {
    const config = loadConfig({ ...READONLY, RESOLVER_PRIVATE_KEY: 'ignored-in-readonly-mode' })

    expect(config.mode).toStrictEqual({ readOnly: true, simulationCaller: CALLER })
  })

  test.each(['true', 'TRUE', '1'])('accepts READONLY=%s as readonly mode', value => {
    expect(loadConfig({ ...READONLY, READONLY: value }).mode.readOnly).toBe(true)
  })

  test.each([undefined, '', 'false', 'FALSE', '0'])('accepts READONLY=%s as write mode', value => {
    expect(loadConfig({ ...WRITE, READONLY: value }).mode.readOnly).toBe(false)
  })

  test.each(['not-an-address', '0x0000000000000000000000000000000000000000', CALLER])(
    'ignores SIMULATION_CALLER_ADDRESS=%s in write mode',
    simulationCaller => {
      expect(loadConfig({ ...WRITE, SIMULATION_CALLER_ADDRESS: simulationCaller }).mode).toEqual(
        expect.objectContaining({ readOnly: false, privateKey: KEY })
      )
    }
  )

  test('normalizes a trailing slash from the API URL', () => {
    expect(loadConfig({ ...WRITE, API_BASE_URL: 'https://api.example/' }).apiBaseUrl).toBe(
      'https://api.example'
    )
  })

  test('accepts explicit resolver, fallback RPC, interval, profit, and fee values', () => {
    const config = loadConfig({
      ...WRITE,
      RPC_URL_FALLBACK: 'http://fallback.example',
      ROUTER_API_BASE_URL: 'https://router.example',
      RESOLVER_ADDRESS: `0x${'22'.repeat(20)}`,
      SCAN_INTERVAL_MS: '30000',
      MIN_PROFIT_ASSETS: '100',
      MAX_FEE_GWEI: '50',
      MAX_MATCHES: '4',
      FINALITY_8453: '12'
    })

    expect(config.rpcUrlFallback).toBe('http://fallback.example')
    expect(config.routerApiBaseUrl).toBe('https://router.example')
    expect(config.resolver).toBe(`0x${'22'.repeat(20)}`)
    expect(config.scanIntervalMs).toBe(30_000)
    expect(config.worldValidMs).toBe(60_000)
    expect(config.minimumProfit).toBe(100n)
    expect(config.maxMatches).toBe(4)
    expect(config.mode).toEqual(
      expect.objectContaining({ maxFeePerGasWei: 50_000_000_000n, finality: { depth: 12 } })
    )
  })

  test.each([
    [{ ...WRITE, CHAIN_ID: '1' }, 'Unsupported CHAIN_ID'],
    [{ ...WRITE, CHAIN_ID: '0x2105' }, 'CHAIN_ID'],
    [{ ...WRITE, READONLY: 'treu' }, 'READONLY'],
    [{ ...WRITE, RESOLVER_PRIVATE_KEY: undefined }, 'RESOLVER_PRIVATE_KEY'],
    [{ ...WRITE, RESOLVER_PRIVATE_KEY: '0x12' }, 'RESOLVER_PRIVATE_KEY'],
    [{ ...WRITE, FINALITY_8453: undefined }, 'FINALITY_8453'],
    [{ ...WRITE, FINALITY_8453: 'latest' }, 'FINALITY_8453'],
    [{ ...WRITE, KERNEL_STATE_DIR: undefined }, 'KERNEL_STATE_DIR'],
    [{ ...WRITE, KERNEL_ENROLLMENT: undefined }, 'KERNEL_ENROLLMENT'],
    [{ ...WRITE, KERNEL_ENROLLMENT: 'enroled' }, 'KERNEL_ENROLLMENT'],
    [{ ...WRITE, MAX_FEE_GWEI: undefined }, 'MAX_FEE_GWEI'],
    [{ ...WRITE, MAX_FEE_GWEI: '0' }, 'MAX_FEE_GWEI'],
    [{ ...WRITE, MAX_FEE_GWEI: '0.0000000001' }, 'MAX_FEE_GWEI'],
    [{ ...WRITE, MAX_FEE_GWEI: '0.000000001' }, 'cannot fund'],
    [{ ...WRITE, MAX_SPEND_ETH: '0.0000000000000001' }, 'cannot fund'],
    [{ ...WRITE, MAX_SPEND_ETH: undefined }, 'MAX_SPEND_ETH'],
    [{ ...WRITE, MAX_SPEND_ETH: '0' }, 'MAX_SPEND_ETH'],
    [{ ...WRITE, MAX_SPEND_ETH: '-1' }, 'MAX_SPEND_ETH'],
    [{ ...WRITE, MAX_SPEND_ETH: '1e18' }, 'MAX_SPEND_ETH'],
    [{ ...WRITE, MAX_GAS_LIMIT: undefined }, 'MAX_GAS_LIMIT'],
    [{ ...WRITE, MAX_GAS_LIMIT: '20999' }, 'MAX_GAS_LIMIT'],
    [{ ...WRITE, MAX_GAS_LIMIT: '0x5208' }, 'MAX_GAS_LIMIT'],
    [{ ...WRITE, RESOLVER_ADDRESS: 'not-an-address' }, 'RESOLVER_ADDRESS'],
    [{ ...WRITE, API_BASE_URL: 'not-a-url' }, 'API_BASE_URL'],
    [{ ...WRITE, ROUTER_API_BASE_URL: 'not-a-url' }, 'ROUTER_API_BASE_URL'],
    [{ ...WRITE, SCAN_INTERVAL_MS: '0' }, 'SCAN_INTERVAL_MS'],
    [{ ...WRITE, MIN_PROFIT_ASSETS: '-1' }, 'MIN_PROFIT_ASSETS'],
    [{ ...WRITE, MAX_MATCHES: '0' }, 'MAX_MATCHES'],
    [{ ...WRITE, MAX_MATCHES: '9007199254740992' }, 'MAX_MATCHES'],
    [{ ...WRITE, RPC_URL: undefined }, 'RPC_URL'],
    [{ ...READONLY, SIMULATION_CALLER_ADDRESS: undefined }, 'SIMULATION_CALLER_ADDRESS'],
    [{ ...READONLY, SIMULATION_CALLER_ADDRESS: 'not-an-address' }, 'SIMULATION_CALLER_ADDRESS'],
    [
      { ...READONLY, SIMULATION_CALLER_ADDRESS: '0x0000000000000000000000000000000000000000' },
      'SIMULATION_CALLER_ADDRESS'
    ]
  ])('refuses invalid configuration %#, naming it', (env, message) => {
    expect(() => loadConfig(env)).toThrow(InvalidConfigurationError)
    expect(() => loadConfig(env)).toThrow(message)
  })

  test('never echoes the private key it refuses', () => {
    const malformed = `0x${'ab'.repeat(31)}`
    expect(() => loadConfig({ ...WRITE, RESOLVER_PRIVATE_KEY: malformed })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(malformed.slice(2)) })
    )
  })
})
