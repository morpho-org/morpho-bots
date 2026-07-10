import type { LogLevel } from '@repo/bot-kit'
import type { Chain, Hex } from 'viem'

import type { ChainConfig, Env } from './config'

import {
  assertLiquidatorAddressMatchesKey,
  CHAIN_MAP,
  resolveBackoff,
  resolveCommon,
  resolveMaxFeeWei,
  resolvePrivateKey
} from './config'
import { OP } from './wire'

// The queue-policy surface, deliberately isolated from the core index so the CLI's `queue` command
// can import it WITHOUT pulling in the lens `sol``` templates or soltag (see the pipeline TIB). It
// imports only `./config` (env resolvers) and `./wire` (the `op` constant) — neither touches
// `state/lens.sol`. Exposed via the package's `"./queue"` subpath export.

/**
 * Everything the `queue` command needs to sign and broadcast — the resolved chain, its RPC
 * endpoint(s), the signer private key, and the fee ceiling. Blue has no dedicated broadcast endpoint
 * (no `SEND_RPC_URL`), so sends go to `rpcUrl`. Deliberately excludes discovery/swap/quoting config:
 * the queue neither discovers nor quotes.
 */
export type QueueConfig = {
  chainId: number
  chain: Chain
  rpcUrl: string
  rpcUrlFallback: string | undefined
  logLevel: LogLevel
  liquidatorPrivateKey: Hex
  maxFeeWei: bigint
  /** Per-position failure-backoff bounds; the queue is the sole writer of backoff state. */
  backoffBaseBlocks: bigint
  backoffMaxBlocks: bigint
}

type QueueLoadDeps = { chainMap?: Record<number, ChainConfig> }

/**
 * Reads the env table into the {@link QueueConfig}. Requires `LIQUIDATOR_PRIVATE_KEY` (the queue is
 * the sole key holder) and cross-checks it against `LIQUIDATOR_ADDRESS` when present — a mismatch
 * means `act` built calldata skimming to a wallet this signer does not control. Throws on any missing
 * required var, malformed value, or unknown `CHAIN_ID` (exit 2 at the CLI).
 */
export function loadQueueConfig(env: Env = Bun.env, deps: QueueLoadDeps = {}): QueueConfig {
  const common = resolveCommon(env, deps.chainMap ?? CHAIN_MAP)
  const liquidatorPrivateKey = resolvePrivateKey(env)
  assertLiquidatorAddressMatchesKey(env, liquidatorPrivateKey)
  const backoff = resolveBackoff(env)
  return {
    chainId: common.chainId,
    chain: common.chain,
    rpcUrl: common.rpcUrl,
    rpcUrlFallback: common.rpcUrlFallback,
    logLevel: common.logLevel,
    liquidatorPrivateKey,
    maxFeeWei: resolveMaxFeeWei(env),
    backoffBaseBlocks: backoff.baseBlocks,
    backoffMaxBlocks: backoff.maxBlocks
  }
}

/**
 * Per-domain queue behavior the generic `createPendingQueue` needs but cannot know: the wire `op`
 * for this domain's outcome records, the settled-cooldown window, and (when the protocol has custom
 * ABI errors) a revert decoder. Blue has no post-settle cooldown and reverts only with standard
 * Solidity shapes, so `settledCooldownBlocks` is `0n` and `revertReason` is omitted (the queue's
 * default decoder handles `Error`/`Panic`). Mirrors exactly what `tickOnce` wired.
 */
export type QueuePolicy = {
  op: string
  settledCooldownBlocks: bigint
  revertReason?: (error: unknown) => string
}

export const queuePolicy: QueuePolicy = {
  op: OP,
  settledCooldownBlocks: 0n
}
