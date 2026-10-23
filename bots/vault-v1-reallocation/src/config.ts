import type { Finality, LogLevel } from '@repo/kit'
import type { Address, Chain, Hex } from 'viem'

import { parseFinality } from '@repo/kit'
import { getAddress, isAddress, isHex, parseGwei } from 'viem'
import { base, mainnet } from 'viem/chains'

import { InvalidConfigError } from './errors'

// Chains this bot supports. Vault V1 addresses come from VAULT_WHITELIST and the Blue
// deployment addresses are resolved by chainId inside blue-sdk-viem's fetchers, so an entry here is
// just the viem chain. loadConfig fails loud for any CHAIN_ID not present here.
const CHAIN_MAP: Record<number, Chain> = {
  [mainnet.id]: mainnet,
  [base.id]: base
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
const PRIVATE_KEY_HEX_LENGTH = 66 // '0x' + 32 bytes

const STRATEGY_NAMES = ['apy-range', 'equalize-utilizations'] as const
export type StrategyName = (typeof STRATEGY_NAMES)[number]

const DEFAULT_REALLOCATION_INTERVAL_MS = 600_000
const MAX_REALLOCATION_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

/** A read holds two intervals: the next lands within one, so only a missed read expires it. */
const READ_HOLDS_INTERVALS = 2
/** Twice mainnet's longest gap between landed per-head reads, for an interval under a block. */
const MIN_READ_VALID_MS = 60_000
/** How long a vault read authorizes acts, at a read every `intervalMs`. */
export const readValidMs = (intervalMs: number) =>
  Math.max(READ_HOLDS_INTERVALS * intervalMs, MIN_READ_VALID_MS)
// ApyRange fires only when some market's implied borrow-APY move exceeds this (bips).
const DEFAULT_MIN_APY_DELTA_BIPS = 25
// EqualizeUtilizations fires only when some market's utilization deviates from the vault-wide
// target by more than this (bips).
const DEFAULT_MIN_UTILIZATION_DELTA_BIPS = 250

type Env = Record<string, string | undefined>

export type KernelStoreConfig = {
  stateDirectory: string
  enrollment: 'enrolling' | 'enrolled'
}

export type Config = {
  chainId: number
  finality: Finality
  chain: Chain
  rpcUrl: string
  rpcUrlFallback: string | undefined
  reallocatorPrivateKey: Hex
  /** Vaults this bot manages; also the signer policy's allowed tx-target set. Never empty. */
  vaultWhitelist: Address[]
  strategy: StrategyName
  /** Minimum wall-clock ms between reads of the whitelist. */
  reallocationIntervalMs: number
  minApyDeltaBips: number
  minUtilizationDeltaBips: number
  /** Whether ApyRange may park excess liquidity in the vault's idle market. */
  allowIdleReallocation: boolean
  /** Read, plan, and simulate as normal, but never submit — the operator ramp-up mode. */
  dryRun: boolean
  /** Where the kernel keeps the account's ledger, and whether that ledger must already exist. */
  kernel: KernelStoreConfig
  maxFeePerGasWei: bigint
  logLevel: LogLevel
}

const required = (env: Env, name: string): string => {
  const value = env[name]
  if (value === undefined || value.trim() === '') {
    throw new InvalidConfigError(`Missing required env var: ${name}`)
  }
  return value.trim()
}

// Parses an optional non-negative integer env var, with a default and optional min/max bounds.
const intEnv = (
  env: Env,
  name: string,
  def: number,
  bounds: { min?: number; max?: number } = {}
): number => {
  const raw = env[name]?.trim()
  if (!raw) return def
  if (!/^\d+$/.test(raw)) {
    throw new InvalidConfigError(`${name} must be a non-negative integer, got: ${env[name]}`)
  }
  const value = Number(raw)
  // A digit string may still overflow to Infinity or lose precision past 2^53, which would silently
  // distort the knob (e.g. an infinite interval freezes reallocation after the first pass).
  if (!Number.isSafeInteger(value)) {
    throw new InvalidConfigError(`${name} must be a safe integer, got: ${env[name]}`)
  }
  if (bounds.min !== undefined && value < bounds.min) {
    throw new InvalidConfigError(`${name} must be >= ${bounds.min}, got: ${env[name]}`)
  }
  if (bounds.max !== undefined && value > bounds.max) {
    throw new InvalidConfigError(`${name} must be <= ${bounds.max}, got: ${env[name]}`)
  }
  return value
}

// Parses an optional boolean env var (`true`/`false`, case-insensitive), with a default. Any other
// non-empty value is operator error and fails loud.
const boolEnv = (env: Env, name: string, def: boolean): boolean => {
  const raw = env[name]?.trim().toLowerCase()
  if (!raw) return def
  if (raw !== 'true' && raw !== 'false') {
    throw new InvalidConfigError(`${name} must be "true" or "false", got: ${env[name]}`)
  }
  return raw === 'true'
}

// Parses a required comma-separated list of addresses into deduplicated, checksummed `Address`es.
// Fails loud on any malformed element and on an empty result — an empty whitelist would silently
// no-op every read.
const addressListEnv = (env: Env, name: string): Address[] => {
  const parts = required(env, name)
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0)
  const addresses = parts.map(part => {
    if (!isAddress(part, { strict: false })) {
      throw new InvalidConfigError(`${name} contains an invalid address: ${part}`)
    }
    return getAddress(part)
  })
  if (addresses.length === 0) {
    throw new InvalidConfigError(`${name} must contain at least one address`)
  }
  // Checksumming first makes case-variant spellings of one address collapse here rather than
  // processing the same vault twice per pass.
  return [...new Set(addresses)]
}

/**
 * `KERNEL_STATE_DIR` holds the kernel's ledger and must survive a restart. `KERNEL_ENROLLMENT` is
 * `enrolling` for the first start of a fresh account and `enrolled` for every later one.
 */
const kernelConfig = (env: Env): KernelStoreConfig => {
  const stateDirectory = required(env, 'KERNEL_STATE_DIR')
  const enrollment = required(env, 'KERNEL_ENROLLMENT')
  if (enrollment !== 'enrolling' && enrollment !== 'enrolled') {
    throw new InvalidConfigError(
      `KERNEL_ENROLLMENT must be "enrolling" or "enrolled", got: ${env.KERNEL_ENROLLMENT}`
    )
  }
  return { stateDirectory, enrollment }
}

const isLogLevel = (value: string): value is LogLevel =>
  (LOG_LEVELS as readonly string[]).includes(value)

const isStrategyName = (value: string): value is StrategyName =>
  (STRATEGY_NAMES as readonly string[]).includes(value)

/**
 * Reads the full env table into a typed, validated {@link Config}. Throws {@link InvalidConfigError}
 * on any missing required var, malformed value, or unknown `CHAIN_ID` — the bot must fail loud at
 * startup rather than run half-configured. Onchain checks (that each whitelisted vault holds code
 * and answers the Vault V1 surface) are performed in `index.ts` once a client exists.
 */
export const loadConfig = (
  env: Env = process.env,
  deps: { chainMap?: Record<number, Chain> } = {}
): Config => {
  const chainMap = deps.chainMap ?? CHAIN_MAP

  const chainIdRaw = required(env, 'CHAIN_ID')
  if (!/^\d+$/.test(chainIdRaw)) {
    // Plain decimal only — reject hex (Number('0x1')) and exponent (Number('1e3')) forms.
    throw new InvalidConfigError(`CHAIN_ID must be a positive integer, got: ${chainIdRaw}`)
  }
  const chainId = Number(chainIdRaw)
  const chain = chainMap[chainId]
  if (!chain) {
    const supported = Object.keys(chainMap).join(', ') || '(none configured)'
    throw new InvalidConfigError(
      `Unsupported CHAIN_ID ${chainId}; supported chain ids: ${supported}`
    )
  }
  const finalityName = `FINALITY_${chainId}`
  const finality = parseFinality(required(env, finalityName).trim())
  if (finality === undefined) {
    throw new InvalidConfigError(
      `${finalityName} must be safe, finalized, or a positive block depth, got: ${env[finalityName]}`
    )
  }

  const rpcUrl = required(env, 'RPC_URL')

  const reallocatorPrivateKey = required(env, 'REALLOCATOR_PRIVATE_KEY')
  if (
    !isHex(reallocatorPrivateKey, { strict: true }) ||
    reallocatorPrivateKey.length !== PRIVATE_KEY_HEX_LENGTH
  ) {
    throw new InvalidConfigError('REALLOCATOR_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string')
  }

  const strategy = env.STRATEGY?.trim() || 'apy-range'
  if (!isStrategyName(strategy)) {
    throw new InvalidConfigError(
      `STRATEGY must be one of ${STRATEGY_NAMES.join(', ')}, got: ${env.STRATEGY}`
    )
  }

  const logLevel = env.LOG_LEVEL?.trim() || 'info'
  if (!isLogLevel(logLevel)) {
    throw new InvalidConfigError(
      `LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got: ${env.LOG_LEVEL}`
    )
  }

  const maxFeeGwei = required(env, 'MAX_FEE_GWEI')
  if (!/^\d+(\.\d+)?$/.test(maxFeeGwei) || Number(maxFeeGwei) <= 0) {
    throw new InvalidConfigError(`MAX_FEE_GWEI must be a positive number, got: ${env.MAX_FEE_GWEI}`)
  }

  return {
    chainId,
    finality,
    chain,
    rpcUrl,
    rpcUrlFallback: env.RPC_URL_FALLBACK?.trim() || undefined,
    reallocatorPrivateKey,
    vaultWhitelist: addressListEnv(env, 'VAULT_WHITELIST'),
    strategy,
    reallocationIntervalMs: intEnv(
      env,
      'REALLOCATION_INTERVAL_MS',
      DEFAULT_REALLOCATION_INTERVAL_MS,
      { min: 1, max: MAX_REALLOCATION_INTERVAL_MS }
    ),
    minApyDeltaBips: intEnv(env, 'MIN_APY_DELTA_BIPS', DEFAULT_MIN_APY_DELTA_BIPS, { min: 0 }),
    minUtilizationDeltaBips: intEnv(
      env,
      'MIN_UTILIZATION_DELTA_BIPS',
      DEFAULT_MIN_UTILIZATION_DELTA_BIPS,
      { min: 0 }
    ),
    allowIdleReallocation: boolEnv(env, 'ALLOW_IDLE_REALLOCATION', true),
    dryRun: boolEnv(env, 'DRY_RUN', false),
    kernel: kernelConfig(env),
    maxFeePerGasWei: parseGwei(maxFeeGwei),
    logLevel
  }
}
