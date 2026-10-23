import { getAddress, parseGwei } from 'viem'
import { describe, expect, it } from 'vitest'

import { loadConfig } from '../src/config'
import { InvalidConfigError } from '../src/errors'

const VAULT_A = getAddress(`0x${'11'.repeat(20)}`)
const VAULT_B = getAddress(`0x${'22'.repeat(20)}`)

const BASE_ENV = {
  CHAIN_ID: '8453',
  FINALITY_1: 'safe',
  FINALITY_8453: 'safe',
  RPC_URL: 'https://rpc.example',
  REALLOCATOR_PRIVATE_KEY: `0x${'aa'.repeat(32)}`,
  VAULT_WHITELIST: `${VAULT_A}, ${VAULT_B.toLowerCase()}`,
  KERNEL_STATE_DIR: '/data/kernel',
  KERNEL_ENROLLMENT: 'enrolling',
  MAX_FEE_GWEI: '250'
}

describe('loadConfig', () => {
  it('loads a minimal env with defaults', () => {
    const config = loadConfig(BASE_ENV)
    expect(config.chainId).toBe(8453)
    expect(config.chain.id).toBe(8453)
    expect(config.vaultWhitelist).toEqual([VAULT_A, VAULT_B])
    expect(config.strategy).toBe('apy-range')
    expect(config.reallocationIntervalMs).toBe(600_000)
    expect(config.minApyDeltaBips).toBe(25)
    expect(config.minUtilizationDeltaBips).toBe(250)
    expect(config.allowIdleReallocation).toBe(true)
    expect(config.dryRun).toBe(false)
    expect(config.maxFeePerGasWei).toBe(parseGwei('250'))
    expect(config.logLevel).toBe('info')
    expect(config.rpcUrlFallback).toBeUndefined()
    expect(config.kernel).toStrictEqual({ stateDirectory: '/data/kernel', enrollment: 'enrolling' })
  })

  it.each(['KERNEL_STATE_DIR', 'KERNEL_ENROLLMENT'])('requires %s', name => {
    expect(() => loadConfig({ ...BASE_ENV, [name]: '' })).toThrow(InvalidConfigError)
    expect(() => loadConfig({ ...BASE_ENV, [name]: '' })).toThrow(name)
  })

  it('rejects an unknown enrollment', () => {
    expect(() => loadConfig({ ...BASE_ENV, KERNEL_ENROLLMENT: 'maybe' })).toThrow(
      /KERNEL_ENROLLMENT/
    )
  })

  it('trims padding from required values', () => {
    const config = loadConfig({ ...BASE_ENV, RPC_URL: '  https://rpc.example \n' })
    expect(config.rpcUrl).toBe('https://rpc.example')
  })

  it('collapses case-variant duplicate whitelist entries', () => {
    const config = loadConfig({
      ...BASE_ENV,
      VAULT_WHITELIST: `${VAULT_A},${VAULT_A.toLowerCase()},${VAULT_B},${VAULT_A.toUpperCase().replace('0X', '0x')}`
    })
    expect(config.vaultWhitelist).toEqual([VAULT_A, VAULT_B])
  })

  it('honors explicit overrides', () => {
    const config = loadConfig({
      ...BASE_ENV,
      CHAIN_ID: '1',
      RPC_URL_FALLBACK: 'https://fallback.example',
      STRATEGY: 'equalize-utilizations',
      REALLOCATION_INTERVAL_MS: '60000',
      MIN_APY_DELTA_BIPS: '50',
      MIN_UTILIZATION_DELTA_BIPS: '100',
      ALLOW_IDLE_REALLOCATION: 'false',
      DRY_RUN: 'true',
      MAX_FEE_GWEI: '25.5',
      LOG_LEVEL: 'debug'
    })
    expect(config.chain.id).toBe(1)
    expect(config.rpcUrlFallback).toBe('https://fallback.example')
    expect(config.strategy).toBe('equalize-utilizations')
    expect(config.reallocationIntervalMs).toBe(60_000)
    expect(config.minApyDeltaBips).toBe(50)
    expect(config.minUtilizationDeltaBips).toBe(100)
    expect(config.allowIdleReallocation).toBe(false)
    expect(config.dryRun).toBe(true)
    expect(config.maxFeePerGasWei).toBe(parseGwei('25.5'))
    expect(config.logLevel).toBe('debug')
  })

  it.each([
    ['CHAIN_ID missing', { ...BASE_ENV, CHAIN_ID: undefined }, 'CHAIN_ID'],
    ['CHAIN_ID unsupported', { ...BASE_ENV, CHAIN_ID: '42' }, 'CHAIN_ID'],
    ['CHAIN_ID hex form', { ...BASE_ENV, CHAIN_ID: '0x1' }, 'CHAIN_ID'],
    ['RPC_URL missing', { ...BASE_ENV, RPC_URL: '' }, 'RPC_URL'],
    ['finality missing', { ...BASE_ENV, FINALITY_8453: undefined }, 'FINALITY_8453'],
    ['finality malformed', { ...BASE_ENV, FINALITY_8453: 'latest' }, 'FINALITY_8453'],
    [
      'private key malformed',
      { ...BASE_ENV, REALLOCATOR_PRIVATE_KEY: '0x1234' },
      'REALLOCATOR_PRIVATE_KEY'
    ],
    ['whitelist missing', { ...BASE_ENV, VAULT_WHITELIST: undefined }, 'VAULT_WHITELIST'],
    ['whitelist empty', { ...BASE_ENV, VAULT_WHITELIST: ' , ' }, 'VAULT_WHITELIST'],
    [
      'whitelist bad address',
      { ...BASE_ENV, VAULT_WHITELIST: `${VAULT_A},0x1234` },
      'VAULT_WHITELIST'
    ],
    ['unknown strategy', { ...BASE_ENV, STRATEGY: 'yolo' }, 'STRATEGY'],
    [
      'interval not integer',
      { ...BASE_ENV, REALLOCATION_INTERVAL_MS: '5m' },
      'REALLOCATION_INTERVAL_MS'
    ],
    ['interval zero', { ...BASE_ENV, REALLOCATION_INTERVAL_MS: '0' }, 'REALLOCATION_INTERVAL_MS'],
    [
      'interval over a week, which no read could stay valid for',
      { ...BASE_ENV, REALLOCATION_INTERVAL_MS: '4503599627370496' },
      'REALLOCATION_INTERVAL_MS'
    ],
    [
      'interval past 2^53',
      { ...BASE_ENV, REALLOCATION_INTERVAL_MS: '9'.repeat(400) },
      'REALLOCATION_INTERVAL_MS'
    ],
    ['bool malformed', { ...BASE_ENV, DRY_RUN: 'yes' }, 'DRY_RUN'],
    ['fee malformed', { ...BASE_ENV, MAX_FEE_GWEI: '-1' }, 'MAX_FEE_GWEI'],
    ['log level unknown', { ...BASE_ENV, LOG_LEVEL: 'trace' }, 'LOG_LEVEL']
  ] as const)('fails loud on %s, naming the variable', (_label, env, name) => {
    expect(() => loadConfig(env)).toThrow(InvalidConfigError)
    expect(() => loadConfig(env)).toThrow(name)
  })

  it.each([undefined, '', '  '])('refuses to start without MAX_FEE_GWEI (%j)', value => {
    expect(() => loadConfig({ ...BASE_ENV, MAX_FEE_GWEI: value })).toThrow(
      'Missing required env var: MAX_FEE_GWEI'
    )
  })
})
