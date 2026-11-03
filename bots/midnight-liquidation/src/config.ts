import type { Finality, LogLevel } from '@repo/kit'
import type { Venue } from '@repo/swaps'
import type { Address, Chain, Hex } from 'viem'

import { Executor } from '@repo/contracts'
import { blocksFor as blocksSpanning, feeCeiling, parseFinality, stepCap } from '@repo/kit'
import { tryCatch } from '@repo/utils'
import { getAddress, isAddress, isHex, parseEther, parseGwei } from 'viem'
import { base, mainnet } from 'viem/chains'

import { InvalidConfigError } from './errors'

// Swap markets come from the Midnight Markets API (the whitelist), and the enabled venues are
// inferred from which venue API keys are present in env.
// The 0x/1inch quoting adapters + the venue selector live in `@repo/swaps`.
const ZEROX_API_KEY_ENV = 'ZEROX_API_KEY'
const ONEINCH_API_KEY_ENV = 'ONEINCH_API_KEY'
const LIFI_API_KEY_ENV = 'LIFI_API_KEY'

/**
 * Nominal block time per supported chain. Every block-denominated tunable is derived from a
 * wall-clock intent through {@link blocksFor}, so these are the only place the chains' differing
 * cadence is encoded — an ~6x ratio between Base and Ethereum mainnet.
 */
const BASE_BLOCK_TIME_MS = 2_000
const MAINNET_BLOCK_TIME_MS = 12_000

/**
 * Converts a wall-clock intent into a block count at `blockTimeMs`, floored at one block (a target
 * shorter than one block must still wait a block, never zero).
 *
 * Block counts are expressed this way rather than as per-chain literals so the INTENT is the source
 * of truth: `blocksFor(8_000, …)` reads as "bump a stuck tx after ~8s" on every chain, whereas a bare
 * `4n` beside a `1n` is unauditable. Base's row reproduces the previous hard-coded values exactly by
 * construction, which `SHIPPED_ROWS` in `test/config.test.ts` asserts.
 */
const blocksFor = (ms: number, blockTimeMs: number) => Math.max(1, Math.round(ms / blockTimeMs))

/**
 * Wall-clock intent behind each block-denominated tunable, shared by every chain. Changing one of
 * these retimes that behaviour on all chains at once, which is the point: the value is a duration,
 * and only its expression in blocks is chain-specific.
 */
/** How long a sent transaction may wait for inclusion before the kernel re-bids it. */
export const STUCK_MS = 8_000
const BALANCE_LOG_MS = 60_000
const BACKOFF_BASE_MS = 4_000
const BACKOFF_MAX_MS = 128_000

/**
 * Chain-specific values threaded into the kernel and the balance monitor (see `index.ts`). NONE of
 * these has an env var — a deployment retunes them by editing the chain's row.
 *
 * Block-denominated fields are counts of BLOCKS derived from a shared wall-clock intent via
 * {@link blocksFor}, so one behaviour keeps roughly one timing on a ~2s and a ~12s chain.
 */
export type TuningConfig = {
  /** Blocks between EOA gas-balance metric emissions. */
  balanceEveryBlocks: bigint
}

/**
 * This chain's DEFAULTS for the knobs an operator overrides from the environment. Resolved inside
 * `loadConfig` and deliberately NOT re-exposed on {@link Config}: a resolved value is only ever read
 * from the field that holds it (`quoting.*`), so there is no
 * pre-override copy to read by mistake.
 */
type ChainDefaults = {
  /** `SEIZE_CAP_MARGIN_BPS` — headroom shaved off the onchain repay cap when sizing a seize. */
  seizeCapMarginBps: number
  /** `BACKOFF_BASE_BLOCKS` — first step of the per-position failure backoff. */
  backoffBaseBlocks: bigint
  /** `BACKOFF_MAX_BLOCKS` — ceiling of the per-position failure backoff. */
  backoffMaxBlocks: bigint
}

/** Per-chain deployment address, runtime {@link TuningConfig}, and env-overridable defaults. */
export type ChainConfig = {
  chain: Chain
  midnight: Address
  /** The wrapped native token, whose USD price turns a liquidation's profit into a fee ceiling. */
  wrappedNative: Address
  /** How long a world read authorizes acts: above this chain's slowest healthy read cadence. */
  worldValidMs: number
  /** The fewest stuck-nonce re-bids a send outlives before its quote ages out; see {@link sendLifeMs}. */
  rebids: number
  tuning: TuningConfig
  defaults: ChainDefaults
}

/**
 * How long a prepared liquidation's quote authorizes its send: `rebids + 1` spans of one block more
 * than the stuck threshold. The kernel re-bids every stuck threshold, not every span, so a send rides
 * more re-bids than `rebids`: about 4 on Base and 13 on mainnet.
 */
const sendLifeMs = ({ chain, rebids }: Pick<ChainConfig, 'chain' | 'rebids'>) =>
  (blocksSpanning(STUCK_MS, chain) + 1) * chain.blockTime! * (rebids + 1)

const tuningFor = (blockTimeMs: number): TuningConfig => ({
  balanceEveryBlocks: BigInt(blocksFor(BALANCE_LOG_MS, blockTimeMs))
})

const defaultsFor = (
  blockTimeMs: number,
  rest: Omit<ChainDefaults, 'backoffBaseBlocks' | 'backoffMaxBlocks'>
): ChainDefaults => ({
  backoffBaseBlocks: BigInt(blocksFor(BACKOFF_BASE_MS, blockTimeMs)),
  backoffMaxBlocks: BigInt(blocksFor(BACKOFF_MAX_MS, blockTimeMs)),
  ...rest
})

// Chains this bot supports, with the Midnight deployment address and calibration per chain. The chain
// map is the one place a new chain is wired (add its `chain`, `midnight`, `tuning`, and `defaults`).
// The deployment address is genuinely per-chain — mainnet and Base are DIFFERENT addresses — though
// the deployed bytecode is byte-identical, so the ABI, lens, and sizing math are shared. The
// deployless lens needs no per-chain deployer (soltag bakes the CREATE2 factory + factoryData into
// its compiled output), but that factory must exist onchain; the canonical 0x4e59… is present on
// both chains. Onchain validation of these addresses (getCode) runs at startup in `index.ts`.
// loadConfig fails loud for any CHAIN_ID not present here.
const CHAIN_MAP: Record<number, ChainConfig> = {
  [base.id]: {
    chain: base,
    midnight: getAddress('0xAdedD8ab6dE832766Fedf0FaC4992E5C4D3EA18A'),
    wrappedNative: getAddress('0x4200000000000000000000000000000000000006'),
    // Over four times the longest gap between landed world reads in a day of production.
    worldValidMs: 30_000,
    rebids: 3,
    tuning: tuningFor(BASE_BLOCK_TIME_MS),
    defaults: defaultsFor(BASE_BLOCK_TIME_MS, { seizeCapMarginBps: 30 })
  },
  [mainnet.id]: {
    chain: mainnet,
    midnight: getAddress('0x471686c42792F93528B000beF54bC10E3aa2045f'),
    wrappedNative: getAddress('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'),
    // Twice the longest gap between landed world reads in a day of production: a missed block.
    worldValidMs: 60_000,
    // Mainnet's base fee compounds 12.5% per block between re-bids, so a send rides more of them.
    rebids: 6,
    tuning: tuningFor(MAINNET_BLOCK_TIME_MS),
    defaults: defaultsFor(MAINNET_BLOCK_TIME_MS, {
      // One-block oracle-drift headroom, and a mainnet block is ~6x the drift window of a Base one.
      seizeCapMarginBps: 60
    })
  }
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const

// Floor for `MAX_GAS_LIMIT`. Below the intrinsic cost of the cheapest possible transaction, the
// signing policy denies every prepared tx (`policy.ts` rejects `tx.gas > maxGasLimit`) while the
// process stays up and healthy — a silent do-nothing bot. Fail at startup instead.
const MIN_GAS_LIMIT = 21_000n

const PRIVATE_KEY_HEX_LENGTH = 66 // '0x' + 32 bytes

// The public Morpho API, which needs no key. The health-factor cutoff is intentionally tight —
// matured positions are always included regardless.
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
// Pure break-even on both chains: at 0 the profitability gate compares two contract-derived
// quantities and carries no tuned value, so it can only reject plans that would have reverted
// onchain. Deliberately NOT a per-chain value — it does not encode gas.
const DEFAULT_MIN_SURPLUS_BPS = 0

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
 * Offchain quoting + failure-backoff tunables (the multi-venue swap layer), plus the seize-sizing
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
  /** Headroom (bps) shaved off the onchain repay cap when sizing a cap-binding seize-exact plan. */
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
 * cutoff. Discovery is over-inclusive by design — the onchain lens is the source of truth — so these
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
 * The Midnight Markets API(s) used as the market WHITELIST: only listed markets are discovered, probed,
 * and liquidated. Over-inclusion is impossible (fail-closed); the onchain lens remains the
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

export type KernelStoreConfig = {
  stateDirectory: string
  enrollment: 'enrolling' | 'enrolled'
}

export type Config = {
  chainId: number
  finality: Finality
  chain: Chain
  midnight: Address
  wrappedNative: Address
  worldValidMs: number
  /** How long a prepared liquidation may wait to be included, re-bids and all. */
  sendLifeMs: number
  /** Chain-specific runtime values threaded into the kernel and the balance monitor. */
  tuning: TuningConfig
  /** Ceiling on a signed tx's gas limit, enforced by the signing policy. See `maxSpendWei`. */
  maxGasLimit: bigint
  rpcUrl: string
  rpcUrlFallback: string | undefined
  liquidatorPrivateKey: Hex
  executooorAddress: Address
  /** When set, sent as `x-api-key` on every Morpho API request: candidates, tokens and markets. */
  morphoApiKey: string | undefined
  /** Borrower-candidate discovery (the markets liquidation-candidates endpoint). */
  discovery: DiscoveryConfig
  /** Market whitelist (the Midnight Markets API). */
  markets: MarketsConfig
  /** Enabled venues + global routing knobs. */
  venues: VenueConfig
  /** Venue-probing knobs. */
  probe: ProbeConfig
  quoting: QuotingConfig
  /** Where the kernel keeps the account's ledger, and whether that ledger must already exist. */
  kernel: KernelStoreConfig
  maxFeePerGasWei: bigint
  /**
   * `MAX_SPEND_ETH` in wei — the ceiling on `gas * maxFeePerGas` for one transaction, and the only
   * field here that bounds spend. `maxGasLimit` and `maxFeePerGasWei` bound its two factors.
   */
  maxSpendWei: bigint
  logLevel: LogLevel
}

function required(env: Env, name: string): string {
  const value = env[name]
  if (value === undefined || value.trim() === '') {
    throw new InvalidConfigError(`Missing required env var: ${name}`)
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
    throw new InvalidConfigError(`${name} must be a non-negative integer, got: ${env[name]}`)
  }
  const value = Number(raw)
  if (bounds.min !== undefined && value < bounds.min) {
    throw new InvalidConfigError(`${name} must be >= ${bounds.min}, got: ${env[name]}`)
  }
  if (bounds.max !== undefined && value > bounds.max) {
    throw new InvalidConfigError(`${name} must be <= ${bounds.max}, got: ${env[name]}`)
  }
  return value
}

// Parses an optional non-negative integer env var into a bigint, with a default and optional min
// bound. Zero stays legal by default — it is a meaningful value for the backoff knobs.
function bigintEnv(env: Env, name: string, def: bigint, bounds: { min?: bigint } = {}): bigint {
  const raw = env[name]?.trim()
  return raw ? bigintFrom(env, name, raw, bounds) : def
}

function bigintFrom(env: Env, name: string, raw: string, bounds: { min?: bigint }): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new InvalidConfigError(`${name} must be a non-negative integer, got: ${env[name]}`)
  }
  const value = BigInt(raw)
  if (bounds.min !== undefined && value < bounds.min) {
    throw new InvalidConfigError(`${name} must be at least ${bounds.min}, got: ${env[name]}`)
  }
  return value
}

// Parses an optional positive decimal env var, with a default and optional min bound. Decimal form
// only (same regex as MAX_FEE_GWEI) — rejects hex/exponent so it agrees with the other validators.
function numberEnv(env: Env, name: string, def: number, bounds: { min?: number } = {}): number {
  const raw = env[name]?.trim()
  if (!raw) return def
  if (!/^\d+(\.\d+)?$/.test(raw) || Number(raw) <= 0) {
    throw new InvalidConfigError(`${name} must be a positive number, got: ${env[name]}`)
  }
  const value = Number(raw)
  if (bounds.min !== undefined && value < bounds.min) {
    throw new InvalidConfigError(`${name} must be >= ${bounds.min}, got: ${env[name]}`)
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
    throw new InvalidConfigError(`${name} must be "true" or "false", got: ${env[name]}`)
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
      throw new InvalidConfigError(
        `${name} must be comma-separated positive numbers, got: ${env[name]}`
      )
    }
  }
  return sizes
}

const parseHttpUrl = (raw: string) => {
  const parsed = tryCatch(() => new URL(raw))
  return parsed.data?.protocol === 'http:' || parsed.data?.protocol === 'https:'
    ? parsed.data
    : undefined
}

// Endpoint errors name the variable but never echo its value, which may embed a credential.
function urlEnv(env: Env, name: string): string | undefined {
  const raw = env[name]?.trim()
  if (!raw) return undefined
  if (!parseHttpUrl(raw)) throw new InvalidConfigError(`${name} is not a valid http(s) URL`)
  return raw
}

// A Morpho API request may carry MORPHO_API_KEY, which must not cross the wire in plaintext.
function httpsOnly(name: string, url: string): string {
  if (new URL(url).protocol !== 'https:') throw new InvalidConfigError(`${name} must use https`)
  return url
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
    throw new InvalidConfigError(
      `${name} must not contain empty entries (leading, trailing, or repeated commas)`
    )
  }
  const normalized = urls.map((url, index) => {
    const parsed = parseHttpUrl(url)
    if (!parsed) {
      throw new InvalidConfigError(`${name} entry ${index + 1} is not a valid http(s) URL`)
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, '')
    return parsed.toString()
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
        throw new InvalidConfigError(`${name} contains an invalid address: ${part}`)
      }
      return getAddress(part)
    })
}

/**
 * `KERNEL_STATE_DIR` holds the kernel's ledger and must survive a restart. `KERNEL_ENROLLMENT` is
 * `enrolling` for the first start of a fresh account and `enrolled` for every later one.
 */
function kernelConfig(env: Env): KernelStoreConfig {
  const stateDirectory = required(env, 'KERNEL_STATE_DIR').trim()
  const enrollment = required(env, 'KERNEL_ENROLLMENT').trim()
  if (enrollment !== 'enrolling' && enrollment !== 'enrolled') {
    throw new InvalidConfigError(
      `KERNEL_ENROLLMENT must be "enrolling" or "enrolled", got: ${env.KERNEL_ENROLLMENT}`
    )
  }
  if (env.POSITION_LIQUIDATION_COOLDOWN_MS?.trim()) {
    throw new InvalidConfigError(
      'POSITION_LIQUIDATION_COOLDOWN_MS is no longer supported; failed positions back off by block'
    )
  }
  if (env.PRIORITY_FEE_GWEI?.trim()) {
    throw new InvalidConfigError(
      'PRIORITY_FEE_GWEI is no longer supported; the first tip derives from MAX_FEE_GWEI'
    )
  }
  return { stateDirectory, enrollment }
}

/**
 * Reads the full env table into a typed, validated {@link Config}. Throws on any missing
 * required var, malformed value, or unknown `CHAIN_ID` — the bot must fail loud at startup
 * rather than run half-configured. Onchain checks (e.g. that `EXECUTOOOR_ADDRESS` holds code)
 * run separately at startup in `index.ts` once a public client exists.
 */
// oxlint-disable-next-line complexity
export function loadConfig(
  env: Env = process.env,
  deps: { chainMap?: Record<number, ChainConfig> } = {}
): Config {
  const chainMap = deps.chainMap ?? CHAIN_MAP

  const chainIdRaw = required(env, 'CHAIN_ID')
  if (!/^\d+$/.test(chainIdRaw)) {
    // Plain decimal only — reject hex (Number('0x1')) and exponent (Number('1e3')) forms.
    throw new InvalidConfigError(`CHAIN_ID must be a positive integer, got: ${chainIdRaw}`)
  }
  const chainId = Number(chainIdRaw)
  const chainConfig = chainMap[chainId]
  if (!chainConfig) {
    const supported = Object.keys(chainMap).join(', ') || '(none configured)'
    throw new InvalidConfigError(
      `Unsupported CHAIN_ID ${chainId}; supported chain ids: ${supported}`
    )
  }
  // `tuning` is threaded to bot-kit as-is; `defaults` only ever appears in the `def` position of the
  // env parsers below, so an explicitly-set env var always wins.
  const { tuning, defaults } = chainConfig
  const finalityName = `FINALITY_${chainId}`
  const finality = parseFinality(required(env, finalityName).trim())
  if (finality === undefined) {
    throw new InvalidConfigError(
      `${finalityName} must be safe, finalized, or a positive block depth, got: ${env[finalityName]}`
    )
  }

  const rpcUrl = required(env, 'RPC_URL')

  const liquidatorPrivateKey = required(env, 'LIQUIDATOR_PRIVATE_KEY')
  if (
    !isHex(liquidatorPrivateKey, { strict: true }) ||
    liquidatorPrivateKey.length !== PRIVATE_KEY_HEX_LENGTH
  ) {
    throw new InvalidConfigError('LIQUIDATOR_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string')
  }

  // The Executor singleton has a deterministic CREATE2 address (soltag bakes the canonical factory +
  // salt into `Executor.with()`), so EXECUTOOOR_ADDRESS is optional — we default to that derived
  // address, which the deploy script and the deployless lens also use (one source of truth). Set the
  // env only to override (e.g. a non-standard deployment).
  const executooorOverride = env.EXECUTOOOR_ADDRESS?.trim()
  if (executooorOverride && !isAddress(executooorOverride, { strict: false })) {
    throw new InvalidConfigError(`EXECUTOOOR_ADDRESS is not a valid address: ${executooorOverride}`)
  }
  const executooorAddress = executooorOverride
    ? getAddress(executooorOverride)
    : getAddress(Executor.with().address)

  const logLevel = env.LOG_LEVEL?.trim() || 'info'
  if (!isLogLevel(logLevel)) {
    throw new InvalidConfigError(
      `LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got: ${env.LOG_LEVEL}`
    )
  }

  const maxFeeGwei = required(env, 'MAX_FEE_GWEI').trim()
  if (!/^\d+(\.\d+)?$/.test(maxFeeGwei) || Number(maxFeeGwei) <= 0) {
    throw new InvalidConfigError(`MAX_FEE_GWEI must be a positive number, got: ${env.MAX_FEE_GWEI}`)
  }

  const maxFeePerGasWei = parseGwei(maxFeeGwei)

  const maxSpendEth = required(env, 'MAX_SPEND_ETH').trim()
  if (!/^\d+(\.\d+)?$/.test(maxSpendEth) || Number(maxSpendEth) <= 0) {
    throw new InvalidConfigError(
      `MAX_SPEND_ETH must be a positive decimal, got: ${env.MAX_SPEND_ETH}`
    )
  }
  const maxSpendWei = parseEther(maxSpendEth)
  if (stepCap(feeCeiling(maxFeePerGasWei, maxSpendWei)) <= 0n) {
    throw new InvalidConfigError(
      `MAX_FEE_GWEI (${maxFeeGwei}) and MAX_SPEND_ETH (${maxSpendEth}) cannot fund a nonce fill and a step bid below it`
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
    throw new InvalidConfigError(
      `No venues enabled (set ENABLE_LIFI=true or ${LIFI_API_KEY_ENV} / ${ZEROX_API_KEY_ENV} / ${ONEINCH_API_KEY_ENV}). Set at least one, or set ALLOW_BAD_DEBT_ONLY=true to run in bad-debt-only mode.`
    )
  }
  const venues: VenueConfig = {
    enabled: enabledVenues,
    zeroxBaseUrl: urlEnv(env, 'ZEROX_BASE_URL'),
    oneinchBaseUrl: urlEnv(env, 'ONEINCH_BASE_URL'),
    lifiBaseUrl: urlEnv(env, 'LIFI_BASE_URL'),
    excludeCollaterals: addressListEnv(env, 'EXCLUDE_COLLATERALS')
  }

  // Market whitelist endpoint(s) — one, or a comma-separated list that is unioned per-source. Fail
  // loud on any malformed entry.
  const markets: MarketsConfig = {
    apiUrls: urlListEnv(env, 'MARKETS_API_URL', DEFAULT_MARKETS_API_URLS).map(url =>
      httpsOnly('MARKETS_API_URL', url)
    ),
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
    seizeCapMarginBps: intEnv(env, 'SEIZE_CAP_MARGIN_BPS', defaults.seizeCapMarginBps, {
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
    backoffBaseBlocks: bigintEnv(env, 'BACKOFF_BASE_BLOCKS', defaults.backoffBaseBlocks),
    backoffMaxBlocks: bigintEnv(env, 'BACKOFF_MAX_BLOCKS', defaults.backoffMaxBlocks)
  }

  // Fail loud at startup on a malformed override rather than at the first tick's fetch.
  const discovery: DiscoveryConfig = {
    apiUrl: httpsOnly(
      'LIQUIDATION_CANDIDATES_API_URL',
      urlEnv(env, 'LIQUIDATION_CANDIDATES_API_URL') ?? DEFAULT_CANDIDATES_API_URL
    ),
    healthFactorLte: numberEnv(env, 'HEALTH_FACTOR_LTE', DEFAULT_HEALTH_FACTOR_LTE, { min: 1 })
  }

  return {
    chainId,
    finality,
    chain: chainConfig.chain,
    midnight: chainConfig.midnight,
    wrappedNative: chainConfig.wrappedNative,
    worldValidMs: chainConfig.worldValidMs,
    sendLifeMs: sendLifeMs(chainConfig),
    tuning,
    maxGasLimit: bigintFrom(env, 'MAX_GAS_LIMIT', required(env, 'MAX_GAS_LIMIT').trim(), {
      min: MIN_GAS_LIMIT
    }),
    rpcUrl,
    rpcUrlFallback: env.RPC_URL_FALLBACK?.trim() || undefined,
    liquidatorPrivateKey,
    executooorAddress,
    morphoApiKey: env.MORPHO_API_KEY?.trim() || undefined,
    discovery,
    markets,
    venues,
    probe,
    quoting,
    kernel: kernelConfig(env),
    maxFeePerGasWei,
    maxSpendWei,
    logLevel
  }
}
