import type { LogLevel } from '@repo/bot-kit'
import type { SwapConfig } from '@repo/swaps'
import type { Address, Chain, Hex } from 'viem'

import { Executor } from '@repo/contracts'
import { parseSwapConfig, VENUE_API_KEY_ENV } from '@repo/swaps'
import { tryCatch } from '@repo/utils'
import { readFileSync } from 'node:fs'
import { defineChain, getAddress, isAddress, isHex, parseGwei } from 'viem'
import { base } from 'viem/chains'

// The per-collateral swap routing config (SWAP_CONFIG_PATH JSON) — schemas, `parseSwapConfig`, and
// `VENUE_API_KEY_ENV` — lives in `@repo/swaps`; this module only reads/validates the file and env.

// ---------------------------------------------------------------------------
// Per-chain Morpho Blue deployment map
// ---------------------------------------------------------------------------
// Robinhood (chainId 4663, an Arbitrum Orbit chain) is not in `viem/chains`, so define it here. The
// bot always reads its RPC from `RPC_URL` (config.rpcUrl), so `rpcUrls.default` is a cosmetic
// fallback only; it points at the canonical public mainnet RPC per Robinhood's docs. Its Morpho Blue
// singleton lives at a DIFFERENT address than Base's canonical one — hence the per-chain `morpho`.
const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } }
})

// The rindexer network name for a chain — the value rindexer writes into the shared Postgres table's
// `network` column and the discriminator the bot filters discovery on (see discovery/borrowers.ts).
// A closed union (not `string`) so a typo in the chain map vs. rindexer.yaml is a compile error, not
// a silent empty-discovery at runtime.
const NETWORKS = ['base', 'robinhood'] as const
export type Network = (typeof NETWORKS)[number]

export type ChainConfig = { chain: Chain; morpho: Address; network: Network }

// Chains this bot supports, with the Morpho Blue singleton address and rindexer network name per
// chain. The chain map is the one place a new chain is wired (add its `chain` + `morpho` + `network`
// here, plus a matching entry in rindexer.yaml). Unlike Midnight, the Blue singleton is NOT at the
// same address on every chain (Base uses the canonical 0xBBBB…; Robinhood uses 0x9D53…), so `morpho`
// is genuinely per-chain. The deployless lens needs no per-chain deployer — soltag bakes the CREATE2
// factory + factoryData into its compiled output (see the lens fetcher), but that factory must exist
// on-chain (canonical 0x4e59… is present on both Base and Robinhood). On-chain validation of the
// Morpho + Executor addresses (getCode) lands at startup. loadConfig fails loud for any CHAIN_ID not
// present here.
const CHAIN_MAP: Record<number, ChainConfig> = {
  [base.id]: {
    chain: base,
    morpho: getAddress('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb'),
    network: 'base'
  },
  [robinhood.id]: {
    chain: robinhood,
    morpho: getAddress('0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010'),
    network: 'robinhood'
  }
}

// ---------------------------------------------------------------------------
// Env table
// ---------------------------------------------------------------------------
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
const DEFAULT_MAX_FEE_GWEI = '300'
const PRIVATE_KEY_HEX_LENGTH = 66 // '0x' + 32 bytes

// Quoting tunables, all optional with safe defaults so existing deployments are unaffected.
const DEFAULT_QUOTE_TIMEOUT_MS = 2500
const DEFAULT_HTTP_RPS = 2 // per-venue token-bucket refill; 1inch free tier is 1 RPS — set HTTP_RPS=1
const DEFAULT_HTTP_BURST = 5
const DEFAULT_HTTP_MAX_RETRIES = 2
const DEFAULT_MAX_ROUTE_IMPACT_BPS = 500 // reject an aggregator route >5% below the oracle reference
const DEFAULT_BACKOFF_BASE_BLOCKS = 2n
const DEFAULT_BACKOFF_MAX_BLOCKS = 64n

type Env = Record<string, string | undefined>

/** Off-chain quoting and per-position failure-backoff tunables. */
export type QuotingConfig = {
  quoteTimeoutMs: number
  httpRps: number
  httpBurst: number
  httpMaxRetries: number
  maxRouteImpactBps: number
  backoffBaseBlocks: bigint
  backoffMaxBlocks: bigint
}

export type Config = {
  chainId: number
  chain: Chain
  /** rindexer network name for this chain; the discovery SQL filters candidates on it. */
  network: Network
  morpho: Address
  rpcUrl: string
  rpcUrlFallback: string | undefined
  liquidatorPrivateKey: Hex
  executooorAddress: Address
  /** Postgres connection string for the co-located rindexer instance (borrower discovery). */
  databaseUrl: string
  swapConfig: SwapConfig
  quoting: QuotingConfig
  maxFeeWei: bigint
  logLevel: LogLevel
}

function required(env: Env, name: string): string {
  const value = env[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required env var: ${name}`)
  }
  return value
}

// Parses an optional non-negative integer env var, with a default and optional min/max bounds.
function intEnv(
  env: Env,
  name: string,
  def: number,
  bounds: { min?: number; max?: number } = {}
): number {
  const raw = env[name]?.trim()
  if (!raw) return def
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a non-negative integer, got: ${env[name]}`)
  }
  const value = Number(raw)
  if (bounds.min !== undefined && value < bounds.min) {
    throw new Error(`${name} must be >= ${bounds.min}, got: ${env[name]}`)
  }
  if (bounds.max !== undefined && value > bounds.max) {
    throw new Error(`${name} must be <= ${bounds.max}, got: ${env[name]}`)
  }
  return value
}

// Parses an optional non-negative integer env var into a bigint, with a default.
function bigintEnv(env: Env, name: string, def: bigint): bigint {
  const raw = env[name]?.trim()
  if (!raw) return def
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a non-negative integer, got: ${env[name]}`)
  }
  return BigInt(raw)
}

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value)
}

// A genuinely absent swap config file (path set, file not there yet — e.g. a volume not seeded on
// first deploy) is non-fatal: the bot runs with no routes (skips routed liquidations). Any other
// read error (permissions, etc.) and any malformed/invalid content stay fatal. Narrows the Node
// `ENOENT` error code.
function isFileNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/**
 * Reads the full env table into a typed, validated {@link Config}. Throws on any missing
 * required var, malformed value, or unknown `CHAIN_ID` — the bot must fail loud at startup
 * rather than run half-configured. On-chain checks (that `EXECUTOOOR_ADDRESS` and the Morpho
 * singleton hold code) are performed in `index.ts` once a public client exists.
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

  // Swap routing is OPTIONAL. With no path set, or a path whose file does not exist yet (e.g. a
  // volume not seeded on first deploy), the bot still boots: discovery identifies liquidatable
  // borrowers and routed liquidations are skipped for want of a swap path (`config.no_swap_path`).
  // A file that IS present but malformed/invalid stays fatal (operator error, not absence). This
  // removes the first-deploy bootstrap deadlock: the bot can't host the volume upload until it
  // boots, and it couldn't boot without the file.
  const swapConfigPath = env.SWAP_CONFIG_PATH?.trim()
  let swapConfig: SwapConfig = {}
  if (swapConfigPath) {
    const read = tryCatch(() => readFile(swapConfigPath))
    if (read.error && !isFileNotFound(read.error)) {
      throw new Error(`Failed to read SWAP_CONFIG_PATH (${swapConfigPath}): ${read.error.message}`)
    }
    const contents = read.data
    if (contents != null) {
      const parsed = tryCatch(() => parseSwapConfig(JSON.parse(contents)))
      if (parsed.error) {
        throw new Error(
          `Failed to load SWAP_CONFIG_PATH (${swapConfigPath}): ${parsed.error.message}`
        )
      }
      swapConfig = parsed.data ?? {}
    }
  }

  // Fail loud if a venue referenced on THIS chain needs an API key that isn't set — half-configured
  // is worse than not configured. Uniswap-direct needs no key, so a key-free deployment still boots.
  for (const entry of Object.values(swapConfig[String(chainId)] ?? {})) {
    if (!entry) continue
    const keyEnv = VENUE_API_KEY_ENV[entry.venue]
    if (keyEnv && !env[keyEnv]?.trim()) {
      throw new Error(
        `Swap config uses venue '${entry.venue}' for chain ${chainId} but ${keyEnv} is not set`
      )
    }
  }

  const quoting: QuotingConfig = {
    quoteTimeoutMs: intEnv(env, 'QUOTE_TIMEOUT_MS', DEFAULT_QUOTE_TIMEOUT_MS, { min: 1 }),
    httpRps: intEnv(env, 'HTTP_RPS', DEFAULT_HTTP_RPS, { min: 1 }),
    httpBurst: intEnv(env, 'HTTP_BURST', DEFAULT_HTTP_BURST, { min: 1 }),
    httpMaxRetries: intEnv(env, 'HTTP_MAX_RETRIES', DEFAULT_HTTP_MAX_RETRIES, { min: 0 }),
    maxRouteImpactBps: intEnv(env, 'MAX_ROUTE_IMPACT_BPS', DEFAULT_MAX_ROUTE_IMPACT_BPS, {
      min: 0,
      max: 10_000
    }),
    backoffBaseBlocks: bigintEnv(env, 'BACKOFF_BASE_BLOCKS', DEFAULT_BACKOFF_BASE_BLOCKS),
    backoffMaxBlocks: bigintEnv(env, 'BACKOFF_MAX_BLOCKS', DEFAULT_BACKOFF_MAX_BLOCKS)
  }

  return {
    chainId,
    chain: chainConfig.chain,
    network: chainConfig.network,
    morpho: chainConfig.morpho,
    rpcUrl,
    rpcUrlFallback: env.RPC_URL_FALLBACK?.trim() || undefined,
    liquidatorPrivateKey,
    executooorAddress,
    databaseUrl: required(env, 'DATABASE_URL'),
    swapConfig,
    quoting,
    maxFeeWei: parseGwei(maxFeeGwei),
    logLevel
  }
}
