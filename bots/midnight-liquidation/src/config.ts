import type { LogLevel } from '@repo/bot-kit'
import type { Venue } from '@repo/swaps'
import type { Address, Chain, Hex } from 'viem'

import { hasBumpHeadroom } from '@repo/bot-kit'
import { Executor } from '@repo/contracts'
import { tryCatch } from '@repo/utils'
import { getAddress, isAddress, isHex, parseGwei } from 'viem'
import { base } from 'viem/chains'

// Swap venues are no longer a per-collateral config file: markets come from the Midnight markets API
// (the whitelist), and the enabled venues are inferred from which venue API keys are present in env.
// The 0x/1inch quoting adapters + the venue selector live in `@repo/swaps`.
const ZEROX_API_KEY_ENV = 'ZEROX_API_KEY'
const ONEINCH_API_KEY_ENV = 'ONEINCH_API_KEY'
const LIFI_API_KEY_ENV = 'LIFI_API_KEY'

// ---------------------------------------------------------------------------
// Per-chain Midnight deployment map
// ---------------------------------------------------------------------------
export type ChainConfig = { chain: Chain; midnight: Address }

// Chains v0 supports, with the Midnight deployment address per chain. The deployless lens needs
// no per-chain deployer — soltag bakes the CREATE2 factory + factoryData into its compiled output
// (see the lens fetcher). On-chain validation of these addresses (getCode) lands in Phase 2.
// loadConfig fails loud for any CHAIN_ID not present here.
const CHAIN_MAP: Record<number, ChainConfig> = {
  [base.id]: { chain: base, midnight: getAddress('0xAdedD8ab6dE832766Fedf0FaC4992E5C4D3EA18A') }
}

// ---------------------------------------------------------------------------
// Env table
// ---------------------------------------------------------------------------
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
const DEFAULT_MAX_FEE_GWEI = '300'
// Clears the in-block p95 tip in ~91% of Base blocks; escalation only adds 1.42x on top.
const DEFAULT_PRIORITY_FEE_GWEI = '0.1'
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
// Slippage for the Pendle PT → underlying unwrap hop; a property of the unwrapper, not of any venue
// entry (the underlying's entry isn't known until after resolution). Keep well under
// MAX_ROUTE_IMPACT_BPS — it also haircuts the amount the downstream venue sells.
const DEFAULT_PENDLE_SLIPPAGE_BPS = 50
// Lower bound on swap execution cost. Skips a plan whose incentive headroom `(lif - 1)/lif` cannot
// cover even the cheapest route, before it costs a quote, a simulation and a gas estimate. Kept LOW
// deliberately: the floor is a pure time gate (3 bps suppresses until ~t+25s post-maturity on a
// 438bps-maxLif tier), and blinding the earliest seconds of a maturity is far more costly than a
// wasted quote. The 31 Jul archive implies (8.52, 15.83] for that maturity's basis regime; that is one
// observation and deliberately NOT the default.
const DEFAULT_HEADROOM_FLOOR_BPS = 3
const DEFAULT_SEIZE_CAP_MARGIN_BPS = 30 // shave the repay cap when sizing a cap-binding seize — one-block oracle-drift headroom; calibratable
// Pure break-even by default: at 0 the profitability gate compares two contract-derived quantities and
// carries no tuned value, so it can only reject plans that would have reverted on-chain. Raising it
// trades captured liquidations for margin against gas and sim→exec drift, and wants a measured basis
// distribution rather than a guess — one maturity implies only a wide, unhelpful interval.
const DEFAULT_MIN_SURPLUS_BPS = 0
const DEFAULT_BACKOFF_BASE_BLOCKS = 2n
const DEFAULT_BACKOFF_MAX_BLOCKS = 64n
// Opt-in per-position cooldown (ms) after a liquidation attempt fails to produce a submittable tx
// (no route / quote failure / sim revert). 0 disables it — the default, so existing deployments
// re-attempt every tick as before.
const DEFAULT_POSITION_LIQUIDATION_COOLDOWN_MS = 0

// Market whitelist + venue-probing defaults. The markets API is Morpho's own (not a rate-limited
// venue), so it can be refreshed briskly. The probe uses an ISOLATED rps budget (see index.ts) so its
// bursts never queue ahead of a time-sensitive firm quote.
// The whitelist may read MORE THAN ONE markets endpoint (comma-separated), unioned per-source — see
// `MarketsConfig`. The default is the single public endpoint: an additional source widens what the bot
// will touch, so it must be opted into explicitly per deployment rather than shipped in the default.
const DEFAULT_MARKETS_API_URLS = ['https://api.morpho.org/v0/midnight/markets']
const DEFAULT_MARKETS_REFRESH_MS = 60_000

// The cached probe curve is a price LEVEL, so the route cost it yields decays with the pair's price.
// Post-maturity liquidation incentives are ~20bps and observed route cost is of the same order, so a
// multi-minute cache would decide candidate selection on a number that had moved further than the
// margin being decided. Venue ORDERING is drift-immune at any age (all venues share a refresh), so
// this bounds only the absolute cost term — see `createVenueSelector`.
const DEFAULT_PROBE_STALE_MS = 45_000
const DEFAULT_PROBE_HTTP_RPS = 1

// Decades of USD notional, converted per-collateral to base units against the token price (see
// `createVenueSelector`). Fixed and deliberately wide rather than fitted to observed seize sizes: a
// $0.01–$100k span brackets every real liquidation on any collateral, whereas the whole-token ladder
// it replaces put 90% of an 8-decimal, ~$80k/token collateral's seizes below its bottom rung.
const DEFAULT_PROBE_LADDER = ['0.01', '0.1', '1', '10', '100', '1000', '10000', '100000']

type Env = Record<string, string | undefined>

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
  /** Slippage (bps) for the Pendle PT → underlying unwrap hop (see the unwrapper). */
  pendleSlippageBps: number
  /** Headroom (bps) shaved off the on-chain repay cap when sizing a cap-binding seize-exact plan. */
  seizeCapMarginBps: number
  /** Surplus over the plan's contract-derived repay a quoted route must clear to be simulated. */
  minSurplusBps: number
  /** Lower bound (bps) on swap execution cost; skips plans whose incentive headroom cannot cover it. */
  headroomFloorBps: number
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
 * Enabled swap venues + their optional host overrides. Venues are enabled by the PRESENCE of their API
 * key in env (secrets themselves are read at the point of use in index.ts, never stored here). There is
 * no slippage knob: the quoting layer derives each venue's allowance from the liquidation's break-even
 * output, so the min-out floor is economic rather than operator-chosen.
 */
export type VenueConfig = {
  enabled: Venue[]
  zeroxBaseUrl: string | undefined
  oneinchBaseUrl: string | undefined
  lifiBaseUrl: string | undefined
  /** Collaterals the operator refuses to seize/hold — skipped (no quote) even in a listed market. */
  excludeCollaterals: Address[]
}

/**
 * The Midnight markets API(s) used as the market WHITELIST: only listed markets are discovered, probed,
 * and liquidated. Over-inclusion is impossible (fail-closed); the on-chain lens remains the
 * correctness boundary. `refreshMs` caps how often the (cheap, non-rate-limited) endpoints are polled.
 */
export type MarketsConfig = {
  /**
   * One or more markets endpoints, in `MARKETS_API_URL` order and de-duplicated. The effective
   * whitelist is the union across the sources that are still fresh, so a deployment can read an
   * additional list (e.g. one carrying extra shorter-maturity markets) without either endpoint
   * becoming a single point of failure. Each is validated as a URL at load (fail-loud).
   */
  apiUrls: string[]
  refreshMs: number
}

/**
 * Venue-probing knobs. The probe fetches indicative quotes across enabled venues at each log-scaled
 * `ladderSizes` rung, caches the per-venue rate curve for the pair for `staleMs`, and runs on its own
 * `httpRps` budget (isolated from firm quotes). Sizes stay as raw strings until converted
 * per-collateral; this bot wires a USD price source, so they are read as USD notional.
 */
export type ProbeConfig = {
  staleMs: number
  httpRps: number
  ladderSizes: string[]
}

export type Config = {
  chainId: number
  chain: Chain
  midnight: Address
  rpcUrl: string
  rpcUrlFallback: string | undefined
  liquidatorPrivateKey: Hex
  executooorAddress: Address
  /** Borrower-candidate discovery (the markets liquidation-candidates endpoint). */
  discovery: DiscoveryConfig
  /** Market whitelist (the Midnight markets API). */
  markets: MarketsConfig
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
  /** First-send `maxPriorityFeePerGas`. See `PRIORITY_FEE_GWEI`. */
  priorityFeeWei: bigint
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

// Parses an optional comma-separated list of endpoint URLs, with a default, de-duplicating while
// preserving order. Fails loud on any EMPTY entry (a leading/trailing/repeated comma is usually a
// misinterpolated env var, i.e. an intended source silently missing — a narrowed whitelist with no
// signal at all) and on any malformed element. De-duplication is on the PARSED URL with trailing path
// slashes canonicalized away, so trivially different spellings of one endpoint (a trailing slash, a
// default port) collapse instead of being polled twice and counted as two independent sources.
function urlListEnv(env: Env, name: string, def: string[]): string[] {
  const raw = env[name]?.trim()
  if (!raw) return def
  const urls = raw.split(',').map(part => part.trim())
  if (urls.some(part => part.length === 0)) {
    throw new Error(
      `${name} must not contain empty entries (leading, trailing, or repeated commas), got: ${env[name]}`
    )
  }
  const normalized = urls.map(url => {
    const parsed = tryCatch(() => new URL(url))
    if (parsed.error) {
      throw new Error(`${name} is not a valid URL: ${url}`)
    }
    parsed.data.pathname = parsed.data.pathname.replace(/\/+$/, '')
    return parsed.data.toString()
  })
  return [...new Set(normalized)]
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
 * rather than run half-configured. On-chain checks (e.g. that `EXECUTOOOR_ADDRESS` holds code)
 * run separately at startup in `index.ts` once a public client exists.
 */
export function loadConfig(
  env: Env = process.env,
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

  const priorityFeeGwei = env.PRIORITY_FEE_GWEI?.trim() || DEFAULT_PRIORITY_FEE_GWEI
  if (!/^\d+(\.\d+)?$/.test(priorityFeeGwei) || Number(priorityFeeGwei) <= 0) {
    throw new Error(`PRIORITY_FEE_GWEI must be a positive number, got: ${env.PRIORITY_FEE_GWEI}`)
  }
  const priorityFeeWei = parseGwei(priorityFeeGwei)
  if (priorityFeeWei <= 0n) {
    throw new Error(`PRIORITY_FEE_GWEI must be at least 1 wei, got: ${env.PRIORITY_FEE_GWEI}`)
  }
  const maxFeeWei = parseGwei(maxFeeGwei)
  if (!hasBumpHeadroom(priorityFeeWei, maxFeeWei)) {
    throw new Error(
      `PRIORITY_FEE_GWEI (${priorityFeeGwei}) leaves no room to bump under MAX_FEE_GWEI (${maxFeeGwei})`
    )
  }

  // Enabled venues are inferred from which venue API keys are present — there is no per-collateral
  // routing file anymore. With no key present the bot can only discover positions and realize pure
  // bad debt (which needs no swap), never actually swap-liquidate — so that degraded posture must be
  // opted into explicitly (`ALLOW_BAD_DEBT_ONLY=true`); otherwise fail loud rather than silently run
  // half-armed (a rotated/forgotten key must not quietly disable liquidations).
  const allowBadDebtOnly = boolEnv(env, 'ALLOW_BAD_DEBT_ONLY', false)
  const enabledVenues: Venue[] = []
  // LiFi first: broadest aggregator coverage, so it is the default cold-cache order before the probe
  // selector ranks by actual output. 0x and 1inch follow. LiFi works keyless, so it is enabled by
  // either a present LIFI_API_KEY (which also raises rate limits) or an explicit ENABLE_LIFI opt-in;
  // 0x/1inch have no keyless mode and are gated purely on their key.
  const enableLifi = boolEnv(env, 'ENABLE_LIFI', false) || Boolean(env[LIFI_API_KEY_ENV]?.trim())
  if (enableLifi) enabledVenues.push('lifi')
  if (env[ZEROX_API_KEY_ENV]?.trim()) enabledVenues.push('0x')
  if (env[ONEINCH_API_KEY_ENV]?.trim()) enabledVenues.push('1inch')
  if (enabledVenues.length === 0 && !allowBadDebtOnly) {
    throw new Error(
      `No venues enabled (set ENABLE_LIFI=true or ${LIFI_API_KEY_ENV} / ${ZEROX_API_KEY_ENV} / ${ONEINCH_API_KEY_ENV}). Set at least one, or set ALLOW_BAD_DEBT_ONLY=true to run in bad-debt-only mode.`
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
    zeroxBaseUrl,
    oneinchBaseUrl,
    lifiBaseUrl,
    excludeCollaterals: addressListEnv(env, 'EXCLUDE_COLLATERALS')
  }

  // Market whitelist endpoint(s) — one, or a comma-separated list that is unioned per-source. Default
  // to the public markets API; fail loud on any malformed entry.
  const markets: MarketsConfig = {
    apiUrls: urlListEnv(env, 'MARKETS_API_URL', DEFAULT_MARKETS_API_URLS),
    refreshMs: intEnv(env, 'MARKETS_REFRESH_MS', DEFAULT_MARKETS_REFRESH_MS, { min: 1 })
  }

  const probe: ProbeConfig = {
    staleMs: intEnv(env, 'PROBE_STALE_MS', DEFAULT_PROBE_STALE_MS, { min: 1 }),
    httpRps: intEnv(env, 'PROBE_HTTP_RPS', DEFAULT_PROBE_HTTP_RPS, { min: 1 }),
    ladderSizes: ladderEnv(env, 'PROBE_LADDER', DEFAULT_PROBE_LADDER)
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
    seizeCapMarginBps: intEnv(env, 'SEIZE_CAP_MARGIN_BPS', DEFAULT_SEIZE_CAP_MARGIN_BPS, {
      min: 0,
      max: 10_000
    }),
    minSurplusBps: intEnv(env, 'MIN_SURPLUS_BPS', DEFAULT_MIN_SURPLUS_BPS, {
      min: 0,
      max: 10_000
    }),
    headroomFloorBps: intEnv(env, 'HEADROOM_FLOOR_BPS', DEFAULT_HEADROOM_FLOOR_BPS, {
      min: 0,
      max: 10_000
    }),
    backoffBaseBlocks: bigintEnv(env, 'BACKOFF_BASE_BLOCKS', DEFAULT_BACKOFF_BASE_BLOCKS),
    backoffMaxBlocks: bigintEnv(env, 'BACKOFF_MAX_BLOCKS', DEFAULT_BACKOFF_MAX_BLOCKS)
  }

  // Borrower-candidate discovery endpoint. Default to the public markets API; fail loud at startup on
  // a malformed override rather than at the first tick's fetch.
  const apiUrl = env.LIQUIDATION_CANDIDATES_API_URL?.trim() || DEFAULT_CANDIDATES_API_URL
  if (tryCatch(() => new URL(apiUrl)).error) {
    throw new Error(`LIQUIDATION_CANDIDATES_API_URL is not a valid URL: ${apiUrl}`)
  }
  const discovery: DiscoveryConfig = {
    apiUrl,
    healthFactorLte: numberEnv(env, 'HEALTH_FACTOR_LTE', DEFAULT_HEALTH_FACTOR_LTE, { min: 1 })
  }

  return {
    chainId,
    chain: chainConfig.chain,
    midnight: chainConfig.midnight,
    rpcUrl,
    rpcUrlFallback: env.RPC_URL_FALLBACK?.trim() || undefined,
    liquidatorPrivateKey,
    executooorAddress,
    discovery,
    markets,
    venues,
    probe,
    quoting,
    positionCooldownMs: intEnv(
      env,
      'POSITION_LIQUIDATION_COOLDOWN_MS',
      DEFAULT_POSITION_LIQUIDATION_COOLDOWN_MS,
      { min: 0 }
    ),
    maxFeeWei,
    priorityFeeWei,
    logLevel
  }
}
