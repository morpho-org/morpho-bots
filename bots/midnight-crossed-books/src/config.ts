import type { Finality } from '@repo/kit'
import type { Address, Chain, Hex } from 'viem'

import { CrossedBooksResolver } from '@repo/contracts'
import { feeCeiling, parseFinality, stepCap } from '@repo/kit'
import {
  getAddress,
  isAddress,
  isAddressEqual,
  isHex,
  parseEther,
  parseGwei,
  zeroAddress
} from 'viem'
import { base } from 'viem/chains'

import { DEFAULT_MAX_MATCHES } from './domain/matching.service'
import { InvalidConfigurationError } from './errors'

const MIDNIGHT = getAddress('0xAdedD8ab6dE832766Fedf0FaC4992E5C4D3EA18A')
const PRIVATE_KEY_HEX_LENGTH = 66
const DEFAULT_API_BASE_URL = 'https://api.morpho.org'
const DEFAULT_SCAN_INTERVAL_MS = '15000'
const GWEI = /^\d+(\.\d{1,9})?$/
const POSITIVE_DECIMAL = /^\d+(\.\d+)?$/
/** Below the intrinsic cost of any transaction, the signer policy would refuse every send. */
const MIN_GAS_LIMIT = 21_000n

type Env = Record<string, string | undefined>

export type KernelStoreConfig = Readonly<{
  stateDirectory: string
  enrollment: 'enrolling' | 'enrolled'
}>

/** Write mode: the key the kernel signs with, and what bounds what it signs. */
export type WriteConfig = Readonly<{
  readOnly: false
  privateKey: Hex
  finality: Finality
  kernel: KernelStoreConfig
  maxFeePerGasWei: bigint
  /** The ceiling on a signed transaction's gas limit. */
  maxGasLimit: bigint
  /** What one transaction may spend on fees, and so what the kernel reserves of the account's ETH. */
  maxSpendWei: bigint
}>

/** Readonly mode holds no key: it simulates as the public EOA that would execute. */
export type ReadonlyConfig = Readonly<{ readOnly: true; simulationCaller: Address }>

export type Config = Readonly<{
  chain: Chain
  chainId: number
  midnight: Address
  resolver: Address
  rpcUrl: string
  rpcUrlFallback: string | undefined
  apiBaseUrl: string
  routerApiBaseUrl: string
  scanIntervalMs: number
  /** How long a scan authorizes resolutions, from when it started: two scan intervals. */
  worldValidMs: number
  minimumProfit: bigint
  maxMatches: number
  mode: ReadonlyConfig | WriteConfig
}>

const required = (env: Env, name: string) => {
  const value = env[name]?.trim()
  if (!value) throw new InvalidConfigurationError(`Missing required env var: ${name}`)
  return value
}

const unsignedDecimal = (env: Env, name: string, fallback?: string) => {
  const value = env[name]?.trim() || fallback
  if (!value || !/^\d+$/.test(value))
    throw new InvalidConfigurationError(`${name} must be an unsigned decimal integer`)
  return value
}

const baseUrl = (env: Env, name: string, fallback: string) => {
  const value = (env[name]?.trim() || fallback).replace(/\/$/, '')
  if (!URL.canParse(value)) throw new InvalidConfigurationError(`${name} must be a valid URL`)
  return value
}

/** `true`/`1` is readonly and absent, empty, `false` or `0` is write mode, in any case. */
const parseReadonly = (value: string | undefined) => {
  const normalized = value?.trim().toLowerCase() || ''
  if (normalized === 'true' || normalized === '1') return true
  if (normalized === '' || normalized === 'false' || normalized === '0') return false
  throw new InvalidConfigurationError('READONLY must be one of: true, 1, false, 0')
}

const readonlyConfig = (env: Env): ReadonlyConfig => {
  const caller = env.SIMULATION_CALLER_ADDRESS?.trim()
  if (
    !caller ||
    !isAddress(caller, { strict: false }) ||
    isAddressEqual(getAddress(caller), zeroAddress)
  )
    throw new InvalidConfigurationError(
      'SIMULATION_CALLER_ADDRESS must be a public non-zero EVM address'
    )
  return { readOnly: true, simulationCaller: getAddress(caller) }
}

/**
 * `KERNEL_STATE_DIR` holds the kernel's ledger and must survive a restart. `KERNEL_ENROLLMENT` is
 * `enrolling` for the first start of a fresh account and `enrolled` for every later one.
 */
const kernelConfig = (env: Env): KernelStoreConfig => {
  const stateDirectory = required(env, 'KERNEL_STATE_DIR')
  const enrollment = required(env, 'KERNEL_ENROLLMENT')
  if (enrollment !== 'enrolling' && enrollment !== 'enrolled')
    throw new InvalidConfigurationError('KERNEL_ENROLLMENT must be "enrolling" or "enrolled"')
  return { stateDirectory, enrollment }
}

const writeConfig = (env: Env, chainId: number): WriteConfig => {
  const privateKey = required(env, 'RESOLVER_PRIVATE_KEY')
  if (!isHex(privateKey, { strict: true }) || privateKey.length !== PRIVATE_KEY_HEX_LENGTH)
    throw new InvalidConfigurationError(
      'RESOLVER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string'
    )
  const finalityName = `FINALITY_${chainId}`
  const finality = parseFinality(required(env, finalityName))
  if (finality === undefined)
    throw new InvalidConfigurationError(
      `${finalityName} must be safe, finalized, or a positive block depth`
    )
  const maxFeeGwei = required(env, 'MAX_FEE_GWEI')
  const maxFeePerGasWei = GWEI.test(maxFeeGwei) ? parseGwei(maxFeeGwei) : 0n
  if (maxFeePerGasWei === 0n)
    throw new InvalidConfigurationError('MAX_FEE_GWEI must be a gwei amount of at least one wei')
  const maxSpendEth = required(env, 'MAX_SPEND_ETH')
  if (!POSITIVE_DECIMAL.test(maxSpendEth) || parseEther(maxSpendEth) === 0n)
    throw new InvalidConfigurationError('MAX_SPEND_ETH must be a positive decimal')
  const maxSpendWei = parseEther(maxSpendEth)
  if (stepCap(feeCeiling(maxFeePerGasWei, maxSpendWei)) <= 0n)
    throw new InvalidConfigurationError(
      `MAX_FEE_GWEI (${maxFeeGwei}) and MAX_SPEND_ETH (${maxSpendEth}) cannot fund a nonce fill and a step bid below it`
    )
  const maxGasLimit = required(env, 'MAX_GAS_LIMIT')
  if (!/^\d+$/.test(maxGasLimit) || BigInt(maxGasLimit) < MIN_GAS_LIMIT)
    throw new InvalidConfigurationError(`MAX_GAS_LIMIT must be at least ${MIN_GAS_LIMIT}`)
  return {
    readOnly: false,
    privateKey,
    finality,
    kernel: kernelConfig(env),
    maxFeePerGasWei,
    maxGasLimit: BigInt(maxGasLimit),
    maxSpendWei
  }
}

/**
 * Reads and validates the bot's configuration, with no network access. Readonly mode neither reads
 * nor keeps `RESOLVER_PRIVATE_KEY`, and write mode ignores `SIMULATION_CALLER_ADDRESS`.
 * @throws InvalidConfigurationError - for any missing or malformed value.
 */
export const loadConfig = (env: Env = process.env): Config => {
  const chainId = Number(unsignedDecimal(env, 'CHAIN_ID'))
  if (chainId !== base.id)
    throw new InvalidConfigurationError(`Unsupported CHAIN_ID ${chainId}; supported: ${base.id}`)
  const mode = parseReadonly(env.READONLY) ? readonlyConfig(env) : writeConfig(env, chainId)

  const resolverOverride = env.RESOLVER_ADDRESS?.trim()
  if (resolverOverride && !isAddress(resolverOverride, { strict: false }))
    throw new InvalidConfigurationError('RESOLVER_ADDRESS must be an EVM address')

  const apiBaseUrl = baseUrl(env, 'API_BASE_URL', DEFAULT_API_BASE_URL)
  const routerApiBaseUrl = baseUrl(env, 'ROUTER_API_BASE_URL', apiBaseUrl)

  const scanIntervalMs = Number(unsignedDecimal(env, 'SCAN_INTERVAL_MS', DEFAULT_SCAN_INTERVAL_MS))
  if (!Number.isSafeInteger(scanIntervalMs) || scanIntervalMs <= 0)
    throw new InvalidConfigurationError('SCAN_INTERVAL_MS must be a positive integer')

  const maxMatches = Number(unsignedDecimal(env, 'MAX_MATCHES', String(DEFAULT_MAX_MATCHES)))
  if (!Number.isSafeInteger(maxMatches) || maxMatches <= 0)
    throw new InvalidConfigurationError('MAX_MATCHES must be a positive safe integer')

  return {
    chain: base,
    chainId,
    midnight: MIDNIGHT,
    resolver: resolverOverride
      ? getAddress(resolverOverride)
      : CrossedBooksResolver.with(MIDNIGHT).address,
    rpcUrl: required(env, 'RPC_URL'),
    rpcUrlFallback: env.RPC_URL_FALLBACK?.trim() || undefined,
    apiBaseUrl,
    routerApiBaseUrl,
    scanIntervalMs,
    worldValidMs: 2 * scanIntervalMs,
    minimumProfit: BigInt(unsignedDecimal(env, 'MIN_PROFIT_ASSETS', '1')),
    maxMatches,
    mode
  }
}
