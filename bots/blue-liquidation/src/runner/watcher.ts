import { ensureError } from '@repo/utils'

import type { Logger } from '../logger'

/** Default HTTP block-poll cadence. Operational tuning lives with the runner, not `constants.ts`. */
export const BLOCK_POLL_MS = 2_000

type BlockWatcher = {
  /**
   * One poll cycle: read the latest height and, if it advanced, drain it through `onBlock`. Exposed
   * for the interval loop and for tests / an explicit trigger.
   */
  poll: () => Promise<void>
  start: () => void
  stop: () => void
}

/**
 * HTTP block-number poll loop (no WebSocket / `eth_subscribe`). Every `intervalMs` it reads the
 * latest height and runs `onBlock` for any new height. If a run is in flight, later polls only raise
 * the target height and the in-flight drain picks up the **latest** when it finishes — intermediate
 * heights coalesce away (a coverage bot re-derives its work each block, so skipping is safe).
 * `onBlock` must not throw; the runner wraps it.
 */
export function createBlockWatcher(deps: {
  getBlockNumber: () => Promise<bigint>
  onBlock: (height: bigint) => Promise<void>
  intervalMs?: number
  logger: Logger
}): BlockWatcher {
  const { getBlockNumber, onBlock, logger } = deps
  const intervalMs = deps.intervalMs ?? BLOCK_POLL_MS
  let timer: ReturnType<typeof setInterval> | undefined
  let lastProcessed = 0n
  let target = 0n
  let draining = false

  async function drain(): Promise<void> {
    if (draining) return
    draining = true
    try {
      // Re-checks `target` after each `onBlock`: a poll that advanced it mid-run is picked up here,
      // coalescing any heights skipped while we were busy.
      while (target > lastProcessed) {
        lastProcessed = target
        await onBlock(lastProcessed)
      }
    } finally {
      draining = false
    }
  }

  async function poll(): Promise<void> {
    const height = await getBlockNumber()
    if (height > target) target = height
    await drain()
  }

  return {
    poll,
    start() {
      timer ??= setInterval(() => {
        void poll().catch(error =>
          logger.error('watcher.error', { error: ensureError(error).message })
        )
      }, intervalMs)
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
    }
  }
}
