import { SETTLED_COOLDOWN_BLOCKS } from './constants'
import { revertReason } from './tx-error'

// The queue-policy surface, deliberately isolated from the core index so consumers can import it
// WITHOUT pulling in the lens `sol``` templates or soltag (see the pipeline TIB). It imports only
// `./config` (via the re-export below), `./constants`, and `./tx-error` — none touch `state/lens.sol`.
// Exposed via the package's `"./queue"` subpath export, consumed by the `queued` daemon
// (`services/queued`) — the CLI's thin `queue` client imports no core at all.

// Re-exported through the lens/soltag-free `./queue` subpath so the daemon can resolve the chain
// without importing the core index.
export { CHAIN_MAP } from './config'

/**
 * Per-domain queue behavior the generic `createPendingQueue` needs but cannot know: the
 * settled-cooldown window and the protocol's ABI revert decoder. Midnight keeps a 20-block
 * post-settle cooldown (a liquidation confirms on the send RPC before the laggy read RPC reflects the
 * cleared position, so re-firing would land a doomed `NotBorrower` revert) and decodes its custom ABI
 * errors. The outcome records' `op` is not policy — the queue derives it from the id/label prefix.
 */
export type QueuePolicy = {
  settledCooldownBlocks: bigint
  revertReason?: (error: unknown) => string
}

export const queuePolicy: QueuePolicy = {
  settledCooldownBlocks: SETTLED_COOLDOWN_BLOCKS,
  revertReason
}
