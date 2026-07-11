// The queue-policy surface, deliberately isolated from the core index so consumers can import it
// WITHOUT pulling in the lens `sol``` templates or soltag (see the pipeline TIB). It imports nothing
// from `state/lens.sol`. Exposed via the package's `"./queue"` subpath export, consumed by the
// `queued` daemon (`services/queued`) — the CLI's thin `queue` client imports no core at all.

// Re-exported through the lens/soltag-free `./queue` subpath so the daemon can resolve the chain
// without importing the core index.
export { CHAIN_MAP } from './config'

/**
 * Per-domain queue behavior the generic `createPendingQueue` needs but cannot know: the
 * settled-cooldown window, and (when the protocol has custom ABI errors) a revert decoder. Blue has
 * no post-settle cooldown and reverts only with standard Solidity shapes, so `settledCooldownBlocks`
 * is `0n` and `revertReason` is omitted (the queue's default decoder handles `Error`/`Panic`). The
 * outcome records' `op` is not policy — the queue derives it from the id/label prefix.
 */
export type QueuePolicy = {
  settledCooldownBlocks: bigint
  revertReason?: (error: unknown) => string
}

export const queuePolicy: QueuePolicy = {
  settledCooldownBlocks: 0n
}
