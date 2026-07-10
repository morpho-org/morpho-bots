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
import { SETTLED_COOLDOWN_BLOCKS } from './constants'
import { revertReason } from './tx-error'

// The queue-policy surface, deliberately isolated from the core index so the CLI's `queue` command
// can import it WITHOUT pulling in the lens `sol``` templates or soltag (see the pipeline TIB). It
// imports only `./config`, `./constants`, and `./tx-error` — none touch `state/lens.sol`. Exposed
// via the package's `"./queue"` subpath export.

/**
 * Everything the `queue` command needs to sign and broadcast — the resolved chain, its RPC
 * endpoint(s), the optional dedicated broadcast endpoint (`SEND_RPC_URL`), the signer backend, and
 * the fee ceiling. Deliberately excludes discovery/venue/quoting config: the queue neither discovers
 * nor quotes.
 */
export type QueueConfig = {
  chainId: number
  chain: Chain
  rpcUrl: string
  rpcUrlFallback: string | undefined
  /**
   * Optional dedicated broadcast endpoint for `eth_sendRawTransaction` (and the signer's
   * nonce/receipt/base-fee reads). When set, the signer sends here instead of `rpcUrl` — needed
   * because read-optimized relays ack sends without relaying them, so txs never mine. Unset → the
   * signer falls back to `rpcUrl`.
   */
  sendRpcUrl: string | undefined
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
    sendRpcUrl: env.SEND_RPC_URL?.trim() || undefined,
    logLevel: common.logLevel,
    signer,
    maxFeeWei: resolveMaxFeeWei(env),
    backoffBaseBlocks: backoff.baseBlocks,
    backoffMaxBlocks: backoff.maxBlocks
  }
}

/**
 * Per-domain queue behavior the generic `createPendingQueue` needs but cannot know: the
 * settled-cooldown window and the protocol's ABI revert decoder. Midnight keeps a 20-block
 * post-settle cooldown (a liquidation confirms on the send RPC before the laggy read RPC reflects the
 * cleared position, so re-firing would land a doomed `NotBorrower` revert) and decodes its custom ABI
 * errors. The outcome records' `op` is not policy — the queue derives it from the id/label prefix.
 * Mirrors exactly what `tickOnce` wired.
 */
export type QueuePolicy = {
  settledCooldownBlocks: bigint
  revertReason?: (error: unknown) => string
}

export const queuePolicy: QueuePolicy = {
  settledCooldownBlocks: SETTLED_COOLDOWN_BLOCKS,
  revertReason
}
