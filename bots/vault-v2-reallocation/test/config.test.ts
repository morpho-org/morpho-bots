import { getAddress, parseGwei } from 'viem'
import { describe, expect, it } from 'vitest'

import { loadConfig } from '../src/config'
import { InvalidConfigError } from '../src/invalid-config.error'

const VAULT_A = getAddress(`0x${'11'.repeat(20)}`)
const VAULT_B = getAddress(`0x${'22'.repeat(20)}`)

const BASE_ENV = {
  CHAIN_ID: '8453',
  RPC_URL: 'https://rpc.example',
  REALLOCATOR_PRIVATE_KEY: `0x${'aa'.repeat(32)}`,
  VAULT_WHITELIST: `${VAULT_A}, ${VAULT_B.toLowerCase()}`
}

describe('loadConfig', () => {
  it('loads a minimal env with defaults', () => {
    const config = loadConfig(BASE_ENV)
    expect(config.chainId).toBe(8453)
    expect(config.chain.id).toBe(8453)
    expect(config.vaultWhitelist).toEqual([VAULT_A, VAULT_B])
    expect(config.strategy).toBe('equalize-utilizations')
    // Case-variant and exact duplicates collapse to one entry after checksumming.
    expect(
      loadConfig({ ...BASE_ENV, VAULT_WHITELIST: `${VAULT_A},${VAULT_A.toLowerCase()},${VAULT_A}` })
        .vaultWhitelist
    ).toEqual([VAULT_A])
    expect(config.reallocationIntervalMs).toBe(600_000)
    expect(config.minApyDeltaBips).toBe(25)
    expect(config.minUtilizationDeltaBips).toBe(250)
    expect(config.allowIdleReallocation).toBe(true)
    expect(config.dryRun).toBe(false)
    expect(config.maxFeeWei).toBe(parseGwei('300'))
    expect(config.logLevel).toBe('info')
    expect(config.rpcUrlFallback).toBeUndefined()
  })

  it('honors explicit overrides', () => {
    const config = loadConfig({
      ...BASE_ENV,
      CHAIN_ID: '1',
      RPC_URL_FALLBACK: 'https://fallback.example',
      STRATEGY: 'apy-range',
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
    expect(config.strategy).toBe('apy-range')
    expect(config.reallocationIntervalMs).toBe(60_000)
    expect(config.minApyDeltaBips).toBe(50)
    expect(config.minUtilizationDeltaBips).toBe(100)
    expect(config.allowIdleReallocation).toBe(false)
    expect(config.dryRun).toBe(true)
    expect(config.maxFeeWei).toBe(parseGwei('25.5'))
    expect(config.logLevel).toBe('debug')
  })

  it('trims required values so padded env vars never reach the transport', () => {
    const config = loadConfig({ ...BASE_ENV, RPC_URL: '  https://rpc.example  ' })
    expect(config.rpcUrl).toBe('https://rpc.example')
  })

  it.each([
    ['CHAIN_ID missing', { ...BASE_ENV, CHAIN_ID: undefined }],
    ['CHAIN_ID unsupported', { ...BASE_ENV, CHAIN_ID: '42' }],
    ['CHAIN_ID hex form', { ...BASE_ENV, CHAIN_ID: '0x1' }],
    ['RPC_URL missing', { ...BASE_ENV, RPC_URL: '' }],
    ['private key malformed', { ...BASE_ENV, REALLOCATOR_PRIVATE_KEY: '0x1234' }],
    ['whitelist missing', { ...BASE_ENV, VAULT_WHITELIST: undefined }],
    ['whitelist empty', { ...BASE_ENV, VAULT_WHITELIST: ' , ' }],
    ['whitelist bad address', { ...BASE_ENV, VAULT_WHITELIST: `${VAULT_A},0x1234` }],
    ['unknown strategy', { ...BASE_ENV, STRATEGY: 'yolo' }],
    ['interval not integer', { ...BASE_ENV, REALLOCATION_INTERVAL_MS: '5m' }],
    ['interval zero', { ...BASE_ENV, REALLOCATION_INTERVAL_MS: '0' }],
    ['interval beyond 2^53', { ...BASE_ENV, REALLOCATION_INTERVAL_MS: '9007199254740993' }],
    ['bool malformed', { ...BASE_ENV, DRY_RUN: 'yes' }],
    ['fee malformed', { ...BASE_ENV, MAX_FEE_GWEI: '-1' }],
    ['log level unknown', { ...BASE_ENV, LOG_LEVEL: 'trace' }]
  ] as const)('fails loud on %s', (_label, env) => {
    expect(() => loadConfig(env)).toThrow(InvalidConfigError)
  })
})
