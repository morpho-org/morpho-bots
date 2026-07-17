import type { LogLevel } from '@repo/bot-kit'
import type { Venue } from '@repo/swaps'
import type { Address, Chain, Hex } from 'viem'

import { Executor } from '@repo/contracts'
import { tryCatch } from '@repo/utils'
import { defineChain, getAddress, isAddress, isHex, parseGwei } from 'viem'
import { base } from 'viem/chains'

// Swap venues are no longer a per-collateral config file: candidates come from the Morpho GraphQL
// API (listed markets only), and the enabled venues are inferred from which venue API keys are
// present in env. The 0x/1inch/LiFi quoting adapters + the venue selector live in `@repo/swaps`.
const ZEROX_API_KEY_ENV = 'ZEROX_API_KEY'
const ONEINCH_API_KEY_ENV = 'ONEINCH_API_KEY'
const LIFI_API_KEY_ENV = 'LIFI_API_KEY'

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

export type ChainConfig = { chain: Chain; morpho: Address }

// Chains this bot supports, with the Morpho Blue singleton address per chain. The chain map is the
// one place a new chain is wired (add its `chain` + `morpho` here). Unlike Midnight, the Blue
// singleton is NOT at the same address on every chain (Base uses the canonical 0xBBBB…; Robinhood
// uses 0x9D53…), so `morpho` is genuinely per-chain. The deployless lens needs no per-chain deployer
// — soltag bakes the CREATE2 factory + factoryData into its compiled output (see the lens fetcher),
// but that factory must exist on-chain (canonical 0x4e59… is present on both Base and Robinhood).
// On-chain validation of the Morpho + Executor addresses (getCode) lands at startup. loadConfig
// fails loud for any CHAIN_ID not present here.
const CHAIN_MAP: Record<number, ChainConfig> = {
  [base.id]: {
    chain: base,
    morpho: getAddress('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb')
  },
  [robinhood.id]: {
    chain: robinhood,
    morpho: getAddress('0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010')
  }
}

// ---------------------------------------------------------------------------
// Env table
// ---------------------------------------------------------------------------
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
const DEFAULT_MAX_FEE_GWEI = '300'
const PRIVATE_KEY_HEX_LENGTH = 66 // '0x' + 32 bytes

// Borrower-candidate discovery defaults (the Morpho GraphQL API's `marketPositions` query). The URL
// is a public, unauthenticated endpoint, so it is safe to default in code (override via env
// per-env). The health-factor cutoff is intentionally tight — the lens re-checks everything
// on-chain, so it only tunes coverage/volume.
const DEFAULT_MORPHO_API_URL = 'https://api.morpho.org/graphql'
const DEFAULT_HEALTH_FACTOR_LTE = 1.02

// Quoting tunables, all optional with safe defaults so existing deployments are unaffected.
const DEFAULT_QUOTE_TIMEOUT_MS = 2500
const DEFAULT_HTTP_RPS = 2 // per-venue token-bucket refill; 1inch free tier is 1 RPS — set HTTP_RPS=1
const DEFAULT_HTTP_BURST = 5
const DEFAULT_HTTP_MAX_RETRIES = 2
const DEFAULT_MAX_ROUTE_IMPACT_BPS = 500 // reject an aggregator route >5% below the oracle reference
// Slippage for the Pendle PT → underlying unwrap hop; a property of the unwrapper, not of any venue
// entry (the underlying's entry isn't known until after resolution). Keep well under
// MAX_ROUTE_IMPACT_BPS — it also haircuts the amount the downstream venue sells.
const DEFAULT_PENDLE_SLIPPAGE_BPS = 50
const DEFAULT_BACKOFF_BASE_BLOCKS = 2n
const DEFAULT_BACKOFF_MAX_BLOCKS = 64n
// Opt-in per-position cooldown (ms) after a liquidation attempt fails to produce a submittable tx
// (no route / quote failure / sim revert). 0 disables it — the default, so existing deployments
// re-attempt every tick as before.
const DEFAULT_POSITION_LIQUIDATION_COOLDOWN_MS = 0

// Venue-probing defaults. The probe uses an ISOLATED rps budget (see index.ts) so its bursts never
// queue ahead of a time-sensitive firm quote; log-scaled ladder sizes are whole collateral tokens
// (converted per-collateral to base units). `PROBE_STALE_MS` caps probe cadence per pair; a pair is
// re-probed only when a liquidatable position touches it after the cache goes stale.
const DEFAULT_SLIPPAGE_BPS = 100
const DEFAULT_PROBE_STALE_MS = 600_000
const DEFAULT_PROBE_HTTP_RPS = 1
const DEFAULT_PROBE_LADDER = ['0.01', '0.1', '1', '10', '100']

type Env = Record<string, string | undefined>

/** Off-chain quoting and per-position failure-backoff tunables. */
export type QuotingConfig = {
  quoteTimeoutMs: number
  httpRps: number
  httpBurst: number
  httpMaxRetries: number
  maxRouteImpactBps: number
  /** Slippage (bps) for the Pendle PT → underlying unwrap hop (see the unwrapper). */
  pendleSlippageBps: number
  backoffBaseBlocks: bigint
  backoffMaxBlocks: bigint
}

/**
 * Borrower-candidate discovery: the Morpho GraphQL endpoint and the health-factor cutoff for its
 * `marketPositions` query. Discovery is over-inclusive by design — the on-chain lens is the source
 * of truth — so these only tune coverage/volume, never correctness.
 */
export type DiscoveryConfig = {
  /** Fully-qualified GraphQL endpoint. Validated as a URL at load (fail-loud). */
  apiUrl: string
  /**
   * Health-factor cutoff sent as `healthFactor_lte`: positions with HF at or below this are
   * returned. Min-bounded at 1.0 (throws below) so a misconfig can't drop soon-to-be-liquidatable
   * positions from the candidate set.
   */
  healthFactorLte: number
}

/**
 * Enabled swap venues + global routing knobs. Venues are enabled by the PRESENCE of their API key in
 * env (secrets themselves are read at the point of use in index.ts, never stored here). `slippageBps`
 * is global now that routing is not per-collateral; `baseUrl` overrides are optional per-venue hosts.
 */
export type VenueConfig = {
  enabled: Venue[]
  slippageBps: number
  zeroxBaseUrl: string | undefined
  oneinchBaseUrl: string | undefined
  lifiBaseUrl: string | undefined
  /** Collaterals the operator refuses to seize/hold — skipped (no quote) even in a listed market. */
  excludeCollaterals: Address[]
}

/**
 * Venue-probing knobs. The probe fetches indicative quotes across enabled venues at each log-scaled
 * `ladderWholeTokens` size, caches the best-first ranking per pair for `staleMs`, and runs on its own
 * `httpRps` budget (isolated from firm quotes). Sizes stay as raw strings until converted per-collateral.
 */
export type ProbeConfig = {
  staleMs: number
  httpRps: number
  ladderWholeTokens: string[]
}

export type Config = {
  chainId: number
  chain: Chain
  morpho: Address
  rpcUrl: string
  rpcUrlFallback: string | undefined
  liquidatorPrivateKey: Hex
  executooorAddress: Address
  /** Borrower-candidate discovery (the Morpho GraphQL `marketPositions` query). */
  discovery: DiscoveryConfig
  /** Enabled venues + global routing knobs. */
  venues: VenueConfig
  /** Venue-probing knobs. */
  probe: ProbeConfig
  quoting: QuotingConfig
  /**
   * Opt-in cooldown window (ms) before re-attempting a position whose last liquidation attempt failed
   * to produce a submittable tx. 0 disables it (re-attempt every tick). See
   * `POSITION_LIQUIDATION_COOLDOWN_MS`.
   */
  positionCooldownMs: number
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

// Parses an optional positive decimal env var, with a default and optional min bound. Decimal form
// only (same regex as MAX_FEE_GWEI) — rejects hex/exponent so it agrees with the other validators.
function numberEnv(env: Env, name: string, def: number, bounds: { min?: number } = {}): number {
  const raw = env[name]?.trim()
  if (!raw) return def
  if (!/^\d+(\.\d+)?$/.test(raw) || Number(raw) <= 0) {
    throw new Error(`${name} must be a positive number, got: ${env[name]}`)
  }
  const value = Number(raw)
  if (bounds.min !== undefined && value < bounds.min) {
    throw new Error(`${name} must be >= ${bounds.min}, got: ${env[name]}`)
  }
  return value
}

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value)
}

// Parses an optional boolean env var (`true`/`false`, case-insensitive), with a default. Any other
// non-empty value is operator error and fails loud.
function boolEnv(env: Env, name: string, def: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase()
  if (!raw) return def
  if (raw !== 'true' && raw !== 'false') {
    throw new Error(`${name} must be "true" or "false", got: ${env[name]}`)
  }
  return raw === 'true'
}

// Parses an optional comma-separated list of positive decimals (whole-token probe sizes) into raw
// string tokens, with a default. Fails loud on any empty/non-positive/malformed element rather than
// silently dropping it (a missing ladder point would skew the size buckets). Strings are kept raw so
// the selector converts them with `safeParseUnits` per-collateral (no lossy Number round-trip).
function ladderEnv(env: Env, name: string, def: string[]): string[] {
  const raw = env[name]?.trim()
  if (!raw) return def
  const sizes = raw.split(',').map(part => part.trim())
  for (const size of sizes) {
    if (!/^\d+(\.\d+)?$/.test(size) || Number(size) <= 0) {
      throw new Error(`${name} must be comma-separated positive numbers, got: ${env[name]}`)
    }
  }
  return sizes
}

// Parses an optional comma-separated list of addresses into checksummed `Address`es, with `[]` as the
// default. Fails loud on any malformed element (operator error).
function addressListEnv(env: Env, name: string): Address[] {
  const raw = env[name]?.trim()
  if (!raw) return []
  return raw
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0)
    .map(part => {
      if (!isAddress(part, { strict: false })) {
        throw new Error(`${name} contains an invalid address: ${part}`)
      }
      return getAddress(part)
    })
}

/**
 * Reads the full env table into a typed, validated {@link Config}. Throws on any missing
 * required var, malformed value, or unknown `CHAIN_ID` — the bot must fail loud at startup
 * rather than run half-configured. On-chain checks (that `EXECUTOOOR_ADDRESS` and the Morpho
 * singleton hold code) are performed in `index.ts` once a public client exists.
 */
export function loadConfig(
  env: Env = Bun.env,
  deps: { chainMap?: Record<number, ChainConfig> } = {}
): Config {
  const chainMap = deps.chainMap ?? CHAIN_MAP

  const chainIdRaw = required(env, 'CHAIN_ID')
  if (!/^\d+$/.test(chainIdRaw)) {
    // Plain decimal only — reject hex (Number('0x1')) and exponent (Number('1e3')) forms.
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

  // Enabled venues are inferred from which venue API keys are present — there is no per-collateral
  // routing file anymore. Blue has no swap-free liquidation path, so with no venue the bot can only
  // DETECT liquidatable positions, never act on them — that degraded posture must be opted into
  // explicitly (`ALLOW_DETECTION_ONLY=true`); otherwise fail loud rather than silently run unarmed
  // (a rotated/forgotten key must not quietly disable liquidations).
  const allowDetectionOnly = boolEnv(env, 'ALLOW_DETECTION_ONLY', false)
  const enabledVenues: Venue[] = []
  // LiFi first: broadest aggregator coverage, so it is the default cold-cache order before the probe
  // selector ranks by actual output. 0x and 1inch follow. LiFi works keyless, so it is enabled by
  // either a present LIFI_API_KEY (which also raises rate limits) or an explicit ENABLE_LIFI opt-in;
  // 0x/1inch have no keyless mode and are gated purely on their key.
  const enableLifi = boolEnv(env, 'ENABLE_LIFI', false) || Boolean(env[LIFI_API_KEY_ENV]?.trim())
  if (enableLifi) enabledVenues.push('lifi')
  if (env[ZEROX_API_KEY_ENV]?.trim()) enabledVenues.push('0x')
  if (env[ONEINCH_API_KEY_ENV]?.trim()) enabledVenues.push('1inch')
  if (enabledVenues.length === 0 && !allowDetectionOnly) {
    throw new Error(
      `No venues enabled (set ENABLE_LIFI=true or ${LIFI_API_KEY_ENV} / ${ZEROX_API_KEY_ENV} / ${ONEINCH_API_KEY_ENV}). Set at least one, or set ALLOW_DETECTION_ONLY=true to run detection-only.`
    )
  }
  const zeroxBaseUrl = env.ZEROX_BASE_URL?.trim() || undefined
  if (zeroxBaseUrl && tryCatch(() => new URL(zeroxBaseUrl)).error) {
    throw new Error(`ZEROX_BASE_URL is not a valid URL: ${zeroxBaseUrl}`)
  }
  const oneinchBaseUrl = env.ONEINCH_BASE_URL?.trim() || undefined
  if (oneinchBaseUrl && tryCatch(() => new URL(oneinchBaseUrl)).error) {
    throw new Error(`ONEINCH_BASE_URL is not a valid URL: ${oneinchBaseUrl}`)
  }
  const lifiBaseUrl = env.LIFI_BASE_URL?.trim() || undefined
  if (lifiBaseUrl && tryCatch(() => new URL(lifiBaseUrl)).error) {
    throw new Error(`LIFI_BASE_URL is not a valid URL: ${lifiBaseUrl}`)
  }
  const venues: VenueConfig = {
    enabled: enabledVenues,
    slippageBps: intEnv(env, 'SLIPPAGE_BPS', DEFAULT_SLIPPAGE_BPS, { min: 0, max: 10_000 }),
    zeroxBaseUrl,
    oneinchBaseUrl,
    lifiBaseUrl,
    excludeCollaterals: addressListEnv(env, 'EXCLUDE_COLLATERALS')
  }

  const probe: ProbeConfig = {
    staleMs: intEnv(env, 'PROBE_STALE_MS', DEFAULT_PROBE_STALE_MS, { min: 1 }),
    httpRps: intEnv(env, 'PROBE_HTTP_RPS', DEFAULT_PROBE_HTTP_RPS, { min: 1 }),
    ladderWholeTokens: ladderEnv(env, 'PROBE_LADDER', DEFAULT_PROBE_LADDER)
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
    pendleSlippageBps: intEnv(env, 'PENDLE_SLIPPAGE_BPS', DEFAULT_PENDLE_SLIPPAGE_BPS, {
      min: 0,
      max: 10_000
    }),
    backoffBaseBlocks: bigintEnv(env, 'BACKOFF_BASE_BLOCKS', DEFAULT_BACKOFF_BASE_BLOCKS),
    backoffMaxBlocks: bigintEnv(env, 'BACKOFF_MAX_BLOCKS', DEFAULT_BACKOFF_MAX_BLOCKS)
  }

  // Borrower-candidate discovery endpoint. Default to the public Morpho GraphQL API; fail loud at
  // startup on a malformed override rather than at the first tick's fetch.
  const apiUrl = env.MORPHO_API_URL?.trim() || DEFAULT_MORPHO_API_URL
  if (tryCatch(() => new URL(apiUrl)).error) {
    throw new Error(`MORPHO_API_URL is not a valid URL: ${apiUrl}`)
  }
  const discovery: DiscoveryConfig = {
    apiUrl,
    healthFactorLte: numberEnv(env, 'HEALTH_FACTOR_LTE', DEFAULT_HEALTH_FACTOR_LTE, { min: 1 })
  }

  return {
    chainId,
    chain: chainConfig.chain,
    morpho: chainConfig.morpho,
    rpcUrl,
    rpcUrlFallback: env.RPC_URL_FALLBACK?.trim() || undefined,
    liquidatorPrivateKey,
    executooorAddress,
    discovery,
    venues,
    probe,
    quoting,
    positionCooldownMs: intEnv(
      env,
      'POSITION_LIQUIDATION_COOLDOWN_MS',
      DEFAULT_POSITION_LIQUIDATION_COOLDOWN_MS,
      { min: 0 }
    ),
    maxFeeWei: parseGwei(maxFeeGwei),
    logLevel
  }
}
