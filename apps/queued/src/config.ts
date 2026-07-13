import type { LogLevel } from '@repo/evm-kit'
import type { Address, Chain } from 'viem'

import { assertSunPathLength, ConfigError, queuedSocketFile } from '@repo/home'
import { ensureError } from '@repo/utils'
import { defineChain } from 'viem'

import type { SignerBackend } from './env'

import { resolveLiquidatorAddress, resolveMaxFeeWei, resolveSignerBackend } from './env'

type Env = Record<string, string | undefined>

// The hoisted bot-kit resolvers throw plain `Error` (the cores' one-shot path wraps at its own
// layer). Here, operator misconfig must exit 2, so re-brand a plain throw as {@link ConfigError}
// while preserving the original message; a ConfigError already in flight passes through untouched.
function asConfigError<T>(resolve: () => T): T {
  try {
    return resolve()
  } catch (error) {
    if (error instanceof ConfigError) throw error
    throw new ConfigError(ensureError(error).message)
  }
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
// Default blocks a pending tx may sit unconfirmed before the daemon bumps its fee and replaces it —
// the per-chain knob the pending queue's `stuckBlocks` reads. Matches bot-kit's `STUCK_BLOCKS`.
const DEFAULT_STUCK_BLOCKS = 4n

/**
 * The fully resolved daemon config `createEngine` consumes. Domain-agnostic and per-chain: one EOA
 * (`signer`), one nonce cursor, one fee ceiling. `signer` is `undefined` in dry-run (the agent is never
 * read — the daemon never touches a signer when disarmed); `liquidatorAddress` is the optional EOA
 * used as the `from` for the re-sim `eth_call` when disarmed (no account to derive it from).
 */
export type QueuedConfig = {
  chainId: number
  chain: Chain
  rpcUrl: string
  logLevel: LogLevel
  maxFeeWei: bigint
  stuckBlocks: bigint
  dryRun: boolean
  socketPath: string
  /** The signer backend, resolved only when armed (`dryRun === false`); `undefined` when disarmed. */
  signer: SignerBackend | undefined
  /** `LIQUIDATOR_ADDRESS` when set — the disarmed re-sim `from`, checksum-normalized. */
  liquidatorAddress: Address
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

/** Build the minimal viem chain descriptor the generic queue needs from explicit runtime config. */
export function resolveChain(chainId: string, env: Env): Chain {
  if (!/^\d+$/.test(chainId) || Number(chainId) <= 0) {
    throw new ConfigError(`CHAIN_ID must be a positive integer, got: ${chainId}`)
  }
  const rpcUrl = required(env, 'RPC_URL')
  return defineChain({
    id: Number(chainId),
    name: `Chain ${chainId}`,
    nativeCurrency: { name: 'Native', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } }
  })
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
  assertSunPathLength(socketPath)
  return socketPath
}

function resolveDryRun(opts: QueuedOpts, env: Env): boolean {
  if (opts.dryRun) return true
  const raw = env.QUEUED_DRY_RUN?.trim().toLowerCase()
  return raw === '1' || raw === 'true'
}

/**
 * Reads the merged env + resolved chain into a {@link QueuedConfig}. `RPC_URL` is required; the signer
 * backend is resolved ONLY when armed — dry-run never touches the agent. Throws {@link ConfigError}
 * (exit 2) on any missing required var or malformed value.
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
  // The hoisted resolvers throw plain Error; wrap them so operator misconfig exits 2, not 1.
  return {
    chainId: Number(chainId),
    chain,
    rpcUrl: required(env, 'RPC_URL'),
    logLevel: resolveLogLevel(env),
    maxFeeWei: asConfigError(() => resolveMaxFeeWei(env)),
    stuckBlocks: resolveStuckBlocks(env),
    dryRun,
    socketPath: resolveSocketPath(opts, env, home, chainId),
    // Disarmed → never resolve a signer; armed → require the external signing agent.
    signer: dryRun ? undefined : asConfigError(() => resolveSignerBackend(env)),
    liquidatorAddress: asConfigError(() => resolveLiquidatorAddress(env))
  }
}
