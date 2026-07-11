import type { LogLevel, SignerBackend } from '@repo/bot-kit'
import type { BotSection } from '@repo/home'
import type { Address, Chain } from 'viem'

import {
  optionalLiquidatorAddress,
  resolveBackoff,
  resolveMaxFeeWei,
  resolveSignerBackend
} from '@repo/bot-kit'
import { ConfigError, configFile, queuedSocketFile, readSettings, secretsFile } from '@repo/home'

type Env = Record<string, string | undefined>

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
// The kernel caps a Unix socket path (`sun_path`) at ~104 bytes on macOS / 108 on Linux; stay well
// under so the daemon fails loud with a clear message instead of a cryptic bind error.
const MAX_SUN_PATH_BYTES = 100
// Default blocks a pending tx may sit unconfirmed before the daemon bumps its fee and replaces it —
// the per-chain knob the pending queue's `stuckBlocks` reads. Matches bot-kit's `STUCK_BLOCKS`.
const DEFAULT_STUCK_BLOCKS = 4n

/**
 * The fully resolved daemon config `createEngine` consumes. Domain-agnostic and per-chain: one EOA
 * (`signer`), one nonce cursor, one fee ceiling. `signer` is `undefined` in dry-run (the key is never
 * read — the daemon never touches a signer when disarmed); `liquidatorAddress` is the optional EOA
 * used as the `from` for the re-sim `eth_call` when disarmed (no account to derive it from).
 */
export type QueuedConfig = {
  chainId: number
  chain: Chain
  rpcUrl: string
  rpcUrlFallback: string | undefined
  sendRpcUrl: string | undefined
  logLevel: LogLevel
  maxFeeWei: bigint
  backoffBaseBlocks: bigint
  backoffMaxBlocks: bigint
  stuckBlocks: bigint
  dryRun: boolean
  socketPath: string
  /** The signer backend, resolved only when armed (`dryRun === false`); `undefined` when disarmed. */
  signer: SignerBackend | undefined
  /** `LIQUIDATOR_ADDRESS` when set — the disarmed re-sim `from`, checksum-normalized. */
  liquidatorAddress: Address | undefined
}

/** The daemon's CLI/env options, before config resolution. */
export type QueuedOpts = {
  chain?: string | undefined
  socket?: string | undefined
  dryRun?: boolean | undefined
}

function required(env: Env, name: string): string {
  const value = env[name]
  if (value === undefined || value.trim() === '') {
    throw new ConfigError(`Missing required env var: ${name}`)
  }
  return value
}

// Reads the `queued` section from a settings file. The section is `{ defaults, chains }`-shaped like a
// bot section (chain overlays by id), but the key sits alongside the bot keys, not inside the typed
// `BotName` map — so it is read positionally here.
function queuedSection(settings: ReturnType<typeof readSettings>): BotSection | undefined {
  if (!settings) return undefined
  return (settings as Record<string, unknown>).queued as BotSection | undefined
}

function overlay(section: BotSection | undefined, chainId: string): Record<string, string> {
  return { ...section?.defaults, ...section?.chains?.[chainId] }
}

// Only keys the caller actually set — spreading raw process.env would inject `undefined` values that
// clobber file-sourced settings under exactOptionalPropertyTypes-style merges.
function definedOnly(env: Env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}

/**
 * Resolves the daemon's chain id. EXPLICIT only: `--chain` flag > `CHAIN_ID` env. Unlike the source/
 * transform ops there is no sole-configured-chain inference — the daemon owns one chain's nonce cursor,
 * so a second source of chain truth (a `queued.chains` key) is a footgun, not a convenience. Throws
 * {@link ConfigError} (exit 2) when neither is set.
 */
export function resolveChainId(opts: QueuedOpts, processEnv: Env = process.env): string {
  const chainId = opts.chain?.trim() || processEnv.CHAIN_ID?.trim()
  if (!chainId) {
    throw new ConfigError(
      'no chain configured — pass --chain <id> or set CHAIN_ID (the queue daemon serves exactly one chain)'
    )
  }
  return chainId
}

/**
 * Builds the env-shaped table the daemon's resolvers read, from the `queued` section. Sources, later
 * wins: `config.json` `queued.defaults` → its `chains[chainId]` overlay → `secrets.json`
 * `queued.defaults` → its `chains[chainId]` overlay → the process env (so an env-only deployment and
 * ad-hoc shell overrides beat files) → the resolved `CHAIN_ID`.
 */
export function mergedQueuedEnv(args: { home: string; chainId: string; processEnv?: Env }): Env {
  const processEnv = args.processEnv ?? process.env
  const config = queuedSection(readSettings(configFile(args.home)))
  const secrets = queuedSection(readSettings(secretsFile(args.home)))
  return {
    ...overlay(config, args.chainId),
    ...overlay(secrets, args.chainId),
    ...definedOnly(processEnv),
    CHAIN_ID: args.chainId
  }
}

function resolveLogLevel(env: Env): LogLevel {
  const level = env.LOG_LEVEL?.trim()
  if (!level) return 'info'
  const match = LOG_LEVELS.find(candidate => candidate === level)
  if (!match) {
    throw new ConfigError(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}; got '${level}'`)
  }
  return match
}

function resolveStuckBlocks(env: Env): bigint {
  const raw = env.STUCK_BLOCKS?.trim()
  if (!raw) return DEFAULT_STUCK_BLOCKS
  if (!/^\d+$/.test(raw) || BigInt(raw) <= 0n) {
    throw new ConfigError(`STUCK_BLOCKS must be a positive integer, got: ${env.STUCK_BLOCKS}`)
  }
  return BigInt(raw)
}

function resolveSocketPath(opts: QueuedOpts, env: Env, home: string, chainId: string): string {
  const socketPath =
    opts.socket?.trim() || env.QUEUED_SOCKET?.trim() || queuedSocketFile(home, chainId)
  const bytes = Buffer.byteLength(socketPath)
  if (bytes > MAX_SUN_PATH_BYTES) {
    throw new ConfigError(
      `queued socket path is ${bytes} bytes; a Unix socket path is capped at ~${MAX_SUN_PATH_BYTES}. ` +
        'Pass --socket or set QUEUED_SOCKET to a shorter path (or move MORPHO_BOTS_HOME closer to root).'
    )
  }
  return socketPath
}

function resolveDryRun(opts: QueuedOpts, env: Env): boolean {
  if (opts.dryRun) return true
  const raw = env.QUEUED_DRY_RUN?.trim().toLowerCase()
  return raw === '1' || raw === 'true'
}

/**
 * Reads the merged env + resolved chain into a {@link QueuedConfig}. `RPC_URL` is required; the signer
 * backend is resolved (and thus the key/`SIGNER_SOCKET` read) ONLY when armed — dry-run never touches
 * a key. Throws {@link ConfigError} (exit 2) on any missing required var or malformed value.
 */
export function resolveConfig(args: {
  env: Env
  chain: Chain
  chainId: string
  opts: QueuedOpts
  home: string
}): QueuedConfig {
  const { env, chain, chainId, opts, home } = args
  const dryRun = resolveDryRun(opts, env)
  return {
    chainId: Number(chainId),
    chain,
    rpcUrl: required(env, 'RPC_URL'),
    rpcUrlFallback: env.RPC_URL_FALLBACK?.trim() || undefined,
    sendRpcUrl: env.SEND_RPC_URL?.trim() || undefined,
    logLevel: resolveLogLevel(env),
    maxFeeWei: resolveMaxFeeWei(env),
    backoffBaseBlocks: resolveBackoff(env).baseBlocks,
    backoffMaxBlocks: resolveBackoff(env).maxBlocks,
    stuckBlocks: resolveStuckBlocks(env),
    dryRun,
    socketPath: resolveSocketPath(opts, env, home, chainId),
    // Disarmed → never resolve a signer (no key read); armed → local key or agent socket.
    signer: dryRun ? undefined : resolveSignerBackend(env),
    liquidatorAddress: optionalLiquidatorAddress(env)
  }
}
