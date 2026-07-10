import type { LogLevel } from '@repo/bot-kit'
import type { Chain } from 'viem'

import type { ChainConfig, Env, SignerBackend } from './config'

import {
  CHAIN_MAP,
  resolveBackoff,
  resolveCommon,
  resolveMaxFeeWei,
  resolveSignerBackend
} from './config'

// The queue-policy surface, deliberately isolated from the core index so the CLI's `queue` command
// can import it WITHOUT pulling in the lens `sol``` templates or soltag (see the pipeline TIB). It
// imports only `./config` (env resolvers), which does not touch `state/lens.sol`. Exposed via the
// package's `"./queue"` subpath export.

/**
 * Everything the `queue` command needs to sign and broadcast — the resolved chain, its RPC
 * endpoint(s), the signer backend, and the fee ceiling. Blue has no dedicated broadcast endpoint
 * (no `SEND_RPC_URL`), so sends go to `rpcUrl`. Deliberately excludes discovery/swap/quoting config:
 * the queue neither discovers nor quotes.
 */
export type QueueConfig = {
  chainId: number
  chain: Chain
  rpcUrl: string
  rpcUrlFallback: string | undefined
  logLevel: LogLevel
  /** The local key or the signing-agent socket; see {@link SignerBackend}. */
  signer: SignerBackend
  maxFeeWei: bigint
  /** Per-position failure-backoff bounds; the queue is the sole writer of backoff state. */
  backoffBaseBlocks: bigint
  backoffMaxBlocks: bigint
}

type QueueLoadDeps = { chainMap?: Record<number, ChainConfig> }

/**
 * Reads the env table into the {@link QueueConfig}. Requires `LIQUIDATOR_PRIVATE_KEY` (the queue is
 * the sole key holder) — unless `SIGNER_SOCKET` selects the agent backend, in which case the key is
 * never read here — and cross-checks it against `LIQUIDATOR_ADDRESS` when present. Throws on any
 * missing required var, malformed value, or unknown `CHAIN_ID` (exit 2 at the CLI).
 */
export function loadQueueConfig(env: Env = Bun.env, deps: QueueLoadDeps = {}): QueueConfig {
  const common = resolveCommon(env, deps.chainMap ?? CHAIN_MAP)
  const signer = resolveSignerBackend(env)
  const backoff = resolveBackoff(env)
  return {
    chainId: common.chainId,
    chain: common.chain,
    rpcUrl: common.rpcUrl,
    rpcUrlFallback: common.rpcUrlFallback,
    logLevel: common.logLevel,
    signer,
    maxFeeWei: resolveMaxFeeWei(env),
    backoffBaseBlocks: backoff.baseBlocks,
    backoffMaxBlocks: backoff.maxBlocks
  }
}

/**
 * Per-domain queue behavior the generic `createPendingQueue` needs but cannot know: the
 * settled-cooldown window, and (when the protocol has custom ABI errors) a revert decoder. Blue has
 * no post-settle cooldown and reverts only with standard Solidity shapes, so `settledCooldownBlocks`
 * is `0n` and `revertReason` is omitted (the queue's default decoder handles `Error`/`Panic`). The
 * outcome records' `op` is not policy — the queue derives it from the id/label prefix. Mirrors
 * exactly what `tickOnce` wired.
 */
export type QueuePolicy = {
  settledCooldownBlocks: bigint
  revertReason?: (error: unknown) => string
}

export const queuePolicy: QueuePolicy = {
  settledCooldownBlocks: 0n
}
