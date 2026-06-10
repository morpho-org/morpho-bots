import { tryCatch } from '@repo/utils'

import type { Logger } from '../logger'

import { BLOCK_POLL_MS, createBlockWatcher } from './watcher'

type Daemon = {
  /** Run one poll cycle now (delegates to the watcher) — for tests / an explicit boot trigger. */
  poll: () => Promise<void>
  start: () => void
  stop: () => Promise<void>
}

/**
 * Long-running lifecycle: a block-poll watcher drives `tick` once per new block height. Owns
 * start/stop, logs `block.new` per height, and swallows tick errors so one bad tick never kills the
 * loop. `stop()` is idempotent; the Phase-3 signed-send queue drain (CRTR-2585) hooks in here.
 */
export function createDaemon(deps: {
  getBlockNumber: () => Promise<bigint>
  tick: (height: bigint) => Promise<unknown>
  intervalMs?: number
  logger: Logger
}): Daemon {
  const { getBlockNumber, tick, logger } = deps
  const intervalMs = deps.intervalMs ?? BLOCK_POLL_MS
  let started = false
  let stopped = false

  const watcher = createBlockWatcher({
    getBlockNumber,
    intervalMs,
    logger,
    onBlock: async height => {
      logger.info('block.new', { height })
      const { error } = await tryCatch(tick(height))
      if (error) logger.error('tick.error', { error: error.message })
    }
  })

  return {
    poll: watcher.poll,
    start() {
      if (started) return
      started = true
      logger.info('daemon.start', { intervalMs })
      watcher.start()
    },
    stop() {
      if (stopped) return Promise.resolve()
      stopped = true
      watcher.stop()
      // CRTR-2585 adds a bounded drain of the pending-tx queue here before the process exits.
      logger.info('daemon.shutdown', {})
      return Promise.resolve()
    }
  }
}
