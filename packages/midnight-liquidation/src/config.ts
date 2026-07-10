import type { LogLevel } from '@repo/bot-kit'
import type { Venue } from '@repo/swaps'
import type { Address, Chain, Hex } from 'viem'

import { Executor } from '@repo/contracts'
import { tryCatch } from '@repo/utils'
import { getAddress, isAddress, isAddressEqual, isHex, parseGwei } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'

// Swap venues are no longer a per-collateral config file: markets come from the Midnight markets API
// (the whitelist), and the enabled venues are inferred from which venue API keys are present in env.
// The 0x/1inch quoting adapters + the venue selector live in `@repo/swaps`.
const ZEROX_API_KEY_ENV = 'ZEROX_API_KEY'
const ONEINCH_API_KEY_ENV = 'ONEINCH_API_KEY'

// ---------------------------------------------------------------------------
// Per-chain Midnight deployment map
// ---------------------------------------------------------------------------
export type ChainConfig = { chain: Chain; midnight: Address }

// Chains v0 supports, with the Midnight deployment address per chain. The deployless lens needs
// no per-chain deployer — soltag bakes the CREATE2 factory + factoryData into its compiled output
// (see the lens fetcher). On-chain validation of these addresses (getCode) lands in Phase 2.
// loadConfig fails loud for any CHAIN_ID not present here.
export const CHAIN_MAP: Record<number, ChainConfig> = {
  [base.id]: { chain: base, midnight: getAddress('0xAdedD8ab6dE832766Fedf0FaC4992E5C4D3EA18A') }
}

// ---------------------------------------------------------------------------
// Env table
// ---------------------------------------------------------------------------
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
const DEFAULT_MAX_FEE_GWEI = '300'
const PRIVATE_KEY_HEX_LENGTH = 66 // '0x' + 32 bytes

// Borrower-candidate discovery defaults (the markets liquidation-candidates endpoint). The URL is a
// public, unauthenticated endpoint, so it is safe to default in code (override via env per-env). The
// health-factor cutoff is intentionally tight — matured positions are always included regardless.
const DEFAULT_CANDIDATES_API_URL = 'https://api.morpho.org/markets/midnight/liquidation-candidates'
const DEFAULT_HEALTH_FACTOR_LTE = 1.02

// Quoting tunables, all optional with safe defaults so existing deployments are unaffected.
const DEFAULT_QUOTE_TIMEOUT_MS = 2500
const DEFAULT_HTTP_RPS = 2 // per-venue token-bucket refill; 1inch free tier is 1 RPS — set HTTP_RPS=1
const DEFAULT_HTTP_BURST = 5
const DEFAULT_HTTP_MAX_RETRIES = 2
const DEFAULT_MAX_ROUTE_IMPACT_BPS = 500 // reject an aggregator route >5% below the oracle reference
const DEFAULT_SEIZE_CAP_MARGIN_BPS = 30 // shave the repay cap when sizing a cap-binding seize — one-block oracle-drift headroom; calibratable
const DEFAULT_BACKOFF_BASE_BLOCKS = 2n
const DEFAULT_BACKOFF_MAX_BLOCKS = 64n

// Market whitelist + venue-probing defaults. The markets API is Morpho's own (not a rate-limited
// venue), so it can be refreshed briskly. The probe uses an ISOLATED rps budget (see index.ts) so its
// bursts never queue ahead of a time-sensitive firm quote; log-scaled ladder sizes are whole
// collateral tokens (converted per-collateral to base units). `PROBE_STALE_MS` caps probe cadence per
// pair; a pair is re-probed only when a liquidatable position touches it after the cache goes stale.
const DEFAULT_MARKETS_API_URL = 'https://api.morpho.org/v0/midnight/markets'
const DEFAULT_MARKETS_REFRESH_MS = 60_000
const DEFAULT_SLIPPAGE_BPS = 100
const DEFAULT_PROBE_STALE_MS = 600_000
const DEFAULT_PROBE_HTTP_RPS = 1
const DEFAULT_PROBE_LADDER = ['0.01', '0.1', '1', '10', '100']

export type Env = Record<string, string | undefined>

/**
 * Off-chain quoting + failure-backoff tunables (the multi-venue swap layer), plus the seize-sizing
 * safety margin (`seizeCapMarginBps`). The margin is a *sizing* knob, not an HTTP/route one, but it
 * lives here because the tick already threads `config.quoting.*` into both quoting and planning.
 */
export type QuotingConfig = {
  quoteTimeoutMs: number
  httpRps: number
  httpBurst: number
  httpMaxRetries: number
  maxRouteImpactBps: number
  /** Headroom (bps) shaved off the on-chain repay cap when sizing a cap-binding seize-exact plan. */
  seizeCapMarginBps: number
  backoffBaseBlocks: bigint
  backoffMaxBlocks: bigint
}

/**
 * Borrower-candidate discovery: the markets liquidation-candidates endpoint and its health-factor
 * cutoff. Discovery is over-inclusive by design — the on-chain lens is the source of truth — so these
 * only tune coverage/volume, never correctness.
 */
export type DiscoveryConfig = {
  /** Fully-qualified liquidation-candidates endpoint. Validated as a URL at load (fail-loud). */
  apiUrl: string
  /**
   * Health-factor cutoff sent as `health_factor_lte`: positions with HF at or below this — plus every
   * matured position (`include_matured`) — are returned. Floored at 1.0 so a misconfig can't drop
   * soon-to-be-liquidatable positions from the HF-triggered set.
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
  /** Collaterals the operator refuses to seize/hold — skipped (no quote) even in a listed market. */
  excludeCollaterals: Address[]
}

/**
 * The Midnight markets API used as the market WHITELIST: only listed markets are discovered, probed,
 * and liquidated. Over-inclusion is impossible (fail-closed); the on-chain lens remains the
 * correctness boundary. `refreshMs` caps how often the (cheap, non-rate-limited) endpoint is polled.
 */
export type MarketsConfig = {
  apiUrl: string
  refreshMs: number
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

/** Fields common to every stage config: the resolved chain plus its RPC endpoints and log level. */
type CommonConfig = {
  chainId: number
  chain: Chain
  midnight: Address
  rpcUrl: string
  rpcUrlFallback: string | undefined
  logLevel: LogLevel
}

/**
 * Config for the read-only `sense` stage: discovery + the market whitelist + the lens read. Loadable
 * WITHOUT the signer private key and WITHOUT venue API keys — `sense` is secret-free. It still needs
 * `executooorAddress` because the Midnight lens checks the Executor's liquidator gate.
 */
export type SenseConfig = CommonConfig & {
  executooorAddress: Address
  discovery: DiscoveryConfig
  markets: MarketsConfig
}

/**
 * Config for the `act` stage: re-derive → quote (multi-venue) → simulate. Needs venue API keys (read
 * at the point of use in `actOnce`, never stored) but NOT the signer private key — `act` never signs.
 */
export type ActConfig = CommonConfig & {
  executooorAddress: Address
  /**
   * The operator EOA (`LIQUIDATOR_ADDRESS`) — the skim `recipient` in the exec calldata and the
   * simulate `from`. An address, not a key: `act` builds and simulates the exact bytes the queue
   * (the sole key holder) later signs, so this must be the queue's signer address. Skimming to any
   * other address — the ownerless Executor especially — strands seized funds where anyone can take
   * them.
   */
  liquidatorAddress: Address
  venues: VenueConfig
  probe: ProbeConfig
  quoting: QuotingConfig
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

// ---------------------------------------------------------------------------
// Shared resolvers — each stage loader composes the subset it needs, so the parsing/validation of a
// given env var lives in exactly one place regardless of which stage reads it.
// ---------------------------------------------------------------------------

type LoadDeps = { chainMap?: Record<number, ChainConfig> }

export function resolveCommon(env: Env, chainMap: Record<number, ChainConfig>): CommonConfig {
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

  const logLevel = env.LOG_LEVEL?.trim() || 'info'
  if (!isLogLevel(logLevel)) {
    throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got: ${env.LOG_LEVEL}`)
  }

  return {
    chainId,
    chain: chainConfig.chain,
    midnight: chainConfig.midnight,
    rpcUrl: required(env, 'RPC_URL'),
    rpcUrlFallback: env.RPC_URL_FALLBACK?.trim() || undefined,
    logLevel
  }
}

export function resolvePrivateKey(env: Env): Hex {
  const liquidatorPrivateKey = required(env, 'LIQUIDATOR_PRIVATE_KEY')
  if (
    !isHex(liquidatorPrivateKey, { strict: true }) ||
    liquidatorPrivateKey.length !== PRIVATE_KEY_HEX_LENGTH
  ) {
    throw new Error('LIQUIDATOR_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string')
  }
  return liquidatorPrivateKey
}

// The Executor singleton has a deterministic CREATE2 address (soltag bakes the canonical factory +
// salt into `Executor.with()`), so EXECUTOOOR_ADDRESS is optional — we default to that derived
// address, which the deploy script and the deployless lens also use (one source of truth).
function resolveExecutor(env: Env): Address {
  const override = env.EXECUTOOOR_ADDRESS?.trim()
  if (override && !isAddress(override, { strict: false })) {
    throw new Error(`EXECUTOOOR_ADDRESS is not a valid address: ${override}`)
  }
  return override ? getAddress(override) : getAddress(Executor.with().address)
}

// The operator EOA `act` targets: required (no derivable default — act has no key to derive from),
// checksum-normalized, fail-loud on a malformed value.
function resolveLiquidatorAddress(env: Env): Address {
  const raw = required(env, 'LIQUIDATOR_ADDRESS').trim()
  if (!isAddress(raw, { strict: false })) {
    throw new Error(`LIQUIDATOR_ADDRESS is not a valid address: ${raw}`)
  }
  return getAddress(raw)
}

// Full-config (tickOnce/queue path) cross-check: when the operator sets LIQUIDATOR_ADDRESS alongside
// the private key, the two must agree — a mismatch means act would skim seized funds to a wallet the
// queue doesn't sign for. When absent, the key remains the single source of truth (no new
// requirement on the tick path).
export function assertLiquidatorAddressMatchesKey(env: Env, privateKey: Hex): void {
  const raw = env.LIQUIDATOR_ADDRESS?.trim()
  if (!raw) return
  if (!isAddress(raw, { strict: false })) {
    throw new Error(`LIQUIDATOR_ADDRESS is not a valid address: ${raw}`)
  }
  const derived = privateKeyToAccount(privateKey).address
  if (!isAddressEqual(getAddress(raw), derived)) {
    throw new Error(
      `LIQUIDATOR_ADDRESS (${getAddress(raw)}) does not match the address derived from LIQUIDATOR_PRIVATE_KEY (${derived}) — act and queue would target different wallets`
    )
  }
}

export function resolveMaxFeeWei(env: Env): bigint {
  const maxFeeGwei = env.MAX_FEE_GWEI?.trim() || DEFAULT_MAX_FEE_GWEI
  if (!/^\d+(\.\d+)?$/.test(maxFeeGwei) || Number(maxFeeGwei) <= 0) {
    throw new Error(`MAX_FEE_GWEI must be a positive number, got: ${env.MAX_FEE_GWEI}`)
  }
  return parseGwei(maxFeeGwei)
}

function resolveDiscovery(env: Env): DiscoveryConfig {
  // Borrower-candidate discovery endpoint. Default to the public markets API; fail loud at startup on
  // a malformed override rather than at the first tick's fetch.
  const apiUrl = env.LIQUIDATION_CANDIDATES_API_URL?.trim() || DEFAULT_CANDIDATES_API_URL
  if (tryCatch(() => new URL(apiUrl)).error) {
    throw new Error(`LIQUIDATION_CANDIDATES_API_URL is not a valid URL: ${apiUrl}`)
  }
  return {
    apiUrl,
    healthFactorLte: numberEnv(env, 'HEALTH_FACTOR_LTE', DEFAULT_HEALTH_FACTOR_LTE, { min: 1 })
  }
}

function resolveMarkets(env: Env): MarketsConfig {
  // Market whitelist endpoint. Default to the public markets API; fail loud on a malformed override.
  const marketsApiUrl = env.MARKETS_API_URL?.trim() || DEFAULT_MARKETS_API_URL
  if (tryCatch(() => new URL(marketsApiUrl)).error) {
    throw new Error(`MARKETS_API_URL is not a valid URL: ${marketsApiUrl}`)
  }
  return {
    apiUrl: marketsApiUrl,
    refreshMs: intEnv(env, 'MARKETS_REFRESH_MS', DEFAULT_MARKETS_REFRESH_MS, { min: 1 })
  }
}

// Enabled venues are inferred from which venue API keys are present — there is no per-collateral
// routing file anymore. With no key present the bot can only discover positions and realize pure
// bad debt (which needs no swap), never actually swap-liquidate — so that degraded posture must be
// opted into explicitly (`ALLOW_BAD_DEBT_ONLY=true`); otherwise fail loud rather than silently run
// half-armed (a rotated/forgotten key must not quietly disable liquidations). This gate lives with
// the `act` stage — the only stage that quotes/swaps — but is also enforced by the full `loadConfig`.
function resolveVenues(env: Env): VenueConfig {
  const allowBadDebtOnly = boolEnv(env, 'ALLOW_BAD_DEBT_ONLY', false)
  const enabledVenues: Venue[] = []
  if (env[ZEROX_API_KEY_ENV]?.trim()) enabledVenues.push('0x')
  if (env[ONEINCH_API_KEY_ENV]?.trim()) enabledVenues.push('1inch')
  if (enabledVenues.length === 0 && !allowBadDebtOnly) {
    throw new Error(
      `No venue API keys set (${ZEROX_API_KEY_ENV} / ${ONEINCH_API_KEY_ENV}). Set at least one, or set ALLOW_BAD_DEBT_ONLY=true to run in bad-debt-only mode.`
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
  return {
    enabled: enabledVenues,
    slippageBps: intEnv(env, 'SLIPPAGE_BPS', DEFAULT_SLIPPAGE_BPS, { min: 0, max: 10_000 }),
    zeroxBaseUrl,
    oneinchBaseUrl,
    excludeCollaterals: addressListEnv(env, 'EXCLUDE_COLLATERALS')
  }
}

function resolveProbe(env: Env): ProbeConfig {
  return {
    staleMs: intEnv(env, 'PROBE_STALE_MS', DEFAULT_PROBE_STALE_MS, { min: 1 }),
    httpRps: intEnv(env, 'PROBE_HTTP_RPS', DEFAULT_PROBE_HTTP_RPS, { min: 1 }),
    ladderWholeTokens: ladderEnv(env, 'PROBE_LADDER', DEFAULT_PROBE_LADDER)
  }
}

// Per-position failure-backoff bounds. Shared by `act` (which filters via `shouldSkip`) and the
// `queue` command (the sole writer, which `record`s/`clear`s), so both read them from ONE resolver —
// the queue's `record()` computes the cooldown `until`, and act only compares against it.
export function resolveBackoff(env: Env): { baseBlocks: bigint; maxBlocks: bigint } {
  return {
    baseBlocks: bigintEnv(env, 'BACKOFF_BASE_BLOCKS', DEFAULT_BACKOFF_BASE_BLOCKS),
    maxBlocks: bigintEnv(env, 'BACKOFF_MAX_BLOCKS', DEFAULT_BACKOFF_MAX_BLOCKS)
  }
}

function resolveQuoting(env: Env): QuotingConfig {
  const backoff = resolveBackoff(env)
  return {
    quoteTimeoutMs: intEnv(env, 'QUOTE_TIMEOUT_MS', DEFAULT_QUOTE_TIMEOUT_MS, { min: 1 }),
    httpRps: intEnv(env, 'HTTP_RPS', DEFAULT_HTTP_RPS, { min: 1 }),
    httpBurst: intEnv(env, 'HTTP_BURST', DEFAULT_HTTP_BURST, { min: 1 }),
    httpMaxRetries: intEnv(env, 'HTTP_MAX_RETRIES', DEFAULT_HTTP_MAX_RETRIES, { min: 0 }),
    maxRouteImpactBps: intEnv(env, 'MAX_ROUTE_IMPACT_BPS', DEFAULT_MAX_ROUTE_IMPACT_BPS, {
      min: 0,
      max: 10_000
    }),
    seizeCapMarginBps: intEnv(env, 'SEIZE_CAP_MARGIN_BPS', DEFAULT_SEIZE_CAP_MARGIN_BPS, {
      min: 0,
      max: 10_000
    }),
    backoffBaseBlocks: backoff.baseBlocks,
    backoffMaxBlocks: backoff.maxBlocks
  }
}

/**
 * Reads the env table into the read-only {@link SenseConfig} — chain, RPC, discovery, market
 * whitelist, plus the Executor (the lens's gate `msg.sender`). Deliberately does NOT require
 * `LIQUIDATOR_PRIVATE_KEY` or any venue API key: `sense` is secret-free.
 */
export function loadSenseConfig(env: Env = Bun.env, deps: LoadDeps = {}): SenseConfig {
  const common = resolveCommon(env, deps.chainMap ?? CHAIN_MAP)
  return {
    ...common,
    executooorAddress: resolveExecutor(env),
    discovery: resolveDiscovery(env),
    markets: resolveMarkets(env)
  }
}

/**
 * Reads the env table into the {@link ActConfig} — chain, RPC, Executor, the operator EOA
 * (`LIQUIDATOR_ADDRESS`, required — the skim recipient and simulate `from`), venues, probe, quoting.
 * Needs venue API keys (enforced unless `ALLOW_BAD_DEBT_ONLY=true`; read at the point of use in
 * `actOnce`) but NOT the signer private key.
 */
export function loadActConfig(env: Env = Bun.env, deps: LoadDeps = {}): ActConfig {
  const common = resolveCommon(env, deps.chainMap ?? CHAIN_MAP)
  return {
    ...common,
    executooorAddress: resolveExecutor(env),
    liquidatorAddress: resolveLiquidatorAddress(env),
    venues: resolveVenues(env),
    probe: resolveProbe(env),
    quoting: resolveQuoting(env)
  }
}
