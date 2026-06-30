import { tryCatch } from '@repo/utils'

import type { Logger } from '../logger'

import { revertReason } from '../tx-error'
import { BLOCK_POLL_MS, createBlockWatcher } from './watcher'

type Runner = {
  /** Run one poll cycle now (delegates to the watcher) — for tests / an explicit boot trigger. */
  poll: () => Promise<void>
  start: () => void
  stop: () => Promise<void>
}

/**
 * Long-running lifecycle: a block-poll watcher drives `tick` once per new block height. Owns
 * start/stop, logs `block.new` per height, and swallows tick errors so one bad tick never kills the
 * loop. `stop()` is idempotent; the Phase-3 signed-send queue drain hooks in here.
 */
export function createRunner(deps: {
  getBlockNumber: () => Promise<bigint>
  tick: (height: bigint) => Promise<unknown>
  intervalMs?: number
  logger: Logger
}): Runner {
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
      // Log a compact, decoded reason — never `error.message`, whose viem request/calldata dump
      // bloats the line and gets truncated by log shippers. Per-tx context is logged by the queue.
      if (error) logger.error('tick.error', { reason: revertReason(error) })
    }
  })

  return {
    poll: watcher.poll,
    start() {
      if (started) return
      started = true
      logger.info('runner.start', { intervalMs })
      watcher.start()
    },
    stop() {
      if (stopped) return Promise.resolve()
      stopped = true
      watcher.stop()
      // Phase 3 adds a bounded drain of the pending-tx queue here before the process exits.
      logger.info('runner.shutdown', {})
      return Promise.resolve()
    }
  }
}
