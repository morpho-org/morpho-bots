import type { Address, Chain, Hex } from 'viem'

import { Executor } from '@repo/contracts'
import { addressSchema, tryCatch } from '@repo/utils'
import { readFileSync } from 'node:fs'
import { getAddress, isAddress, isHex, parseGwei } from 'viem'
import { base } from 'viem/chains'
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
export type ChainConfig = { chain: Chain; midnight: Address }

// Chains v0 supports, with the Midnight deployment address per chain. The deployless lens needs
// no per-chain deployer — soltag bakes the CREATE2 factory + factoryData into its compiled output
// (see the lens fetcher, CRTR-2580). On-chain validation of these addresses (getCode) lands in
// Phase 2 (CRTR-2582). loadConfig fails loud for any CHAIN_ID not present here.
const CHAIN_MAP: Record<number, ChainConfig> = {
  [base.id]: { chain: base, midnight: getAddress('0x3726353bCDDba7c29a17D46D8a35D1E8b2E51854') }
}

// ---------------------------------------------------------------------------
// Env table
// ---------------------------------------------------------------------------
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
const DEFAULT_MAX_FEE_GWEI = '300'
const DEFAULT_CACHE_DIR = '.cache'
const PRIVATE_KEY_HEX_LENGTH = 66 // '0x' + 32 bytes

type Env = Record<string, string | undefined>

export type Config = {
  chainId: number
  chain: Chain
  midnight: Address
  rpcUrl: string
  rpcUrlFallback: string | undefined
  liquidatorPrivateKey: Hex
  executooorAddress: Address
  /** Postgres connection string for the co-located rindexer instance (borrower discovery). */
  databaseUrl: string
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

  // The Executor singleton has a deterministic CREATE2 address (soltag bakes the canonical factory +
  // salt into `Executor.with()`), so EXECUTOOOR_ADDRESS is optional — we default to that derived
  // address, which the deploy script and the deployless lens also use (one source of truth). Set the
  // env only to override (e.g. a non-standard deployment).
  const executooorOverride = env.EXECUTOOOR_ADDRESS?.trim()
  if (executooorOverride && !isAddress(executooorOverride, { strict: false })) {
    throw new Error(`EXECUTOOOR_ADDRESS is not a valid address: ${executooorOverride}`)
  }
  const executooorAddress = executooorOverride
    ? getAddress(executooorOverride)
    : getAddress(Executor.with().address)

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
    rpcUrl,
    rpcUrlFallback: env.RPC_URL_FALLBACK?.trim() || undefined,
    liquidatorPrivateKey,
    executooorAddress,
    databaseUrl: required(env, 'DATABASE_URL'),
    swapConfig,
    maxFeeWei: parseGwei(maxFeeGwei),
    cacheDir: env.CACHE_DIR?.trim() || DEFAULT_CACHE_DIR,
    logLevel
  }
}
