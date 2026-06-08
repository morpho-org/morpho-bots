import type { Address, Chain, Hex } from 'viem'

import { addressSchema, tryCatch } from '@repo/utils'
import { readFileSync } from 'node:fs'
import { getAddress, isAddress, isHex, parseGwei } from 'viem'
import { z } from 'zod'

import type { LogLevel } from './logger'

// ---------------------------------------------------------------------------
// Per-collateral swap routing config (the JSON file at SWAP_CONFIG_PATH)
// ---------------------------------------------------------------------------
// Shape: { "<chainId>": { "<collateralToken>": { router, fee, slippageBps } } }. A single file
// may describe several chains; the bot reads its own chain's entry at swap time (Phase 4).

const swapParamsSchema = z
  .object({
    router: addressSchema,
    fee: z.number().int().positive(),
    slippageBps: z.number().int().min(0).max(10_000)
  })
  .strict()

const swapConfigSchema = z.record(
  z.string().regex(/^\d+$/, 'Swap config keys must be numeric chain ids'),
  z.record(
    z
      .string()
      .refine(value => isAddress(value, { strict: false }), 'Invalid collateral token address'),
    swapParamsSchema
  )
)

export type SwapConfig = z.infer<typeof swapConfigSchema>

export function parseSwapConfig(raw: unknown): SwapConfig {
  return swapConfigSchema.parse(raw)
}

// ---------------------------------------------------------------------------
// Per-chain Midnight deployment map
// ---------------------------------------------------------------------------
export type ChainConfig = { chain: Chain; midnight: Address; deployer: Address }

// Real Midnight deployment + CREATE2 deployer addresses (and the set of chains v0 supports) are
// filled in once confirmed; on-chain validation of them (getCode) lands in Phase 2 (CRTR-2582).
// Until then the map is intentionally empty, so loadConfig fails loud for every CHAIN_ID — the
// correct behavior for an unconfigured chain.
const CHAIN_MAP: Record<number, ChainConfig> = {}

// ---------------------------------------------------------------------------
// Env table
// ---------------------------------------------------------------------------
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
const DEFAULT_API_URL = 'https://api.morpho.dev'
const DEFAULT_MAX_FEE_GWEI = '300'
const DEFAULT_CACHE_DIR = '.cache'
const PRIVATE_KEY_HEX_LENGTH = 66 // '0x' + 32 bytes

type Env = Record<string, string | undefined>

export type Config = {
  chainId: number
  chain: Chain
  midnight: Address
  deployer: Address
  rpcUrl: string
  rpcUrlFallback: string | undefined
  liquidatorPrivateKey: Hex
  executooorAddress: Address
  midnightApiUrl: string
  swapConfig: SwapConfig
  maxFeeWei: bigint
  cacheDir: string
  logLevel: LogLevel
}

function required(env: Env, name: string): string {
  const value = env[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required env var: ${name}`)
  }
  return value
}

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value)
}

/**
 * Reads the full env table into a typed, validated {@link Config}. Throws on any missing
 * required var, malformed value, or unknown `CHAIN_ID` — the bot must fail loud at startup
 * rather than run half-configured. On-chain checks (e.g. that `EXECUTOOOR_ADDRESS` holds code)
 * are deferred to Phase 2 once a public client exists.
 */
export function loadConfig(
  env: Env = Bun.env,
  deps: { chainMap?: Record<number, ChainConfig>; readFile?: (path: string) => string } = {}
): Config {
  const chainMap = deps.chainMap ?? CHAIN_MAP
  const readFile = deps.readFile ?? (path => readFileSync(path, 'utf8'))

  const chainIdRaw = required(env, 'CHAIN_ID')
  if (!/^\d+$/.test(chainIdRaw)) {
    // Plain decimal only — reject hex (Number('0x1')) and exponent (Number('1e3')) forms so this
    // agrees with the swap-config chain-id key validation below.
    throw new Error(`CHAIN_ID must be a positive integer, got: ${chainIdRaw}`)
  }
  const chainId = Number(chainIdRaw)
  const chainConfig = chainMap[chainId]
  if (!chainConfig) {
    const supported = Object.keys(chainMap).join(', ') || '(none configured)'
    throw new Error(`Unsupported CHAIN_ID ${chainId}; supported chain ids: ${supported}`)
  }

  const rpcUrl = required(env, 'RPC_URL')

  const liquidatorPrivateKey = required(env, 'LIQUIDATOR_PRIVATE_KEY')
  if (
    !isHex(liquidatorPrivateKey, { strict: true }) ||
    liquidatorPrivateKey.length !== PRIVATE_KEY_HEX_LENGTH
  ) {
    throw new Error('LIQUIDATOR_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string')
  }

  const executooorRaw = required(env, 'EXECUTOOOR_ADDRESS')
  if (!isAddress(executooorRaw, { strict: false })) {
    throw new Error(`EXECUTOOOR_ADDRESS is not a valid address: ${executooorRaw}`)
  }

  const logLevel = env.LOG_LEVEL?.trim() || 'info'
  if (!isLogLevel(logLevel)) {
    throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got: ${env.LOG_LEVEL}`)
  }

  const maxFeeGwei = env.MAX_FEE_GWEI?.trim() || DEFAULT_MAX_FEE_GWEI
  if (!/^\d+(\.\d+)?$/.test(maxFeeGwei) || Number(maxFeeGwei) <= 0) {
    throw new Error(`MAX_FEE_GWEI must be a positive number, got: ${env.MAX_FEE_GWEI}`)
  }

  const swapConfigPath = required(env, 'SWAP_CONFIG_PATH')
  const { data: swapConfig, error } = tryCatch(() =>
    parseSwapConfig(JSON.parse(readFile(swapConfigPath)))
  )
  if (error) {
    throw new Error(`Failed to load SWAP_CONFIG_PATH (${swapConfigPath}): ${error.message}`)
  }

  return {
    chainId,
    chain: chainConfig.chain,
    midnight: chainConfig.midnight,
    deployer: chainConfig.deployer,
    rpcUrl,
    rpcUrlFallback: env.RPC_URL_FALLBACK?.trim() || undefined,
    liquidatorPrivateKey,
    executooorAddress: getAddress(executooorRaw),
    midnightApiUrl: env.MIDNIGHT_API_URL?.trim() || DEFAULT_API_URL,
    swapConfig,
    maxFeeWei: parseGwei(maxFeeGwei),
    cacheDir: env.CACHE_DIR?.trim() || DEFAULT_CACHE_DIR,
    logLevel
  }
}
