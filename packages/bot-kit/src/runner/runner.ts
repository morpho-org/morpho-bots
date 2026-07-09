import { tryCatch } from '@repo/utils'

import type { Logger } from '../logger'

import { revertReason as defaultRevertReason } from '../tx-error'
import { BLOCK_POLL_MS, createBlockWatcher } from './watcher'

/** The long-running lifecycle handle {@link createRunner} returns. */
export type Runner = {
  /** Run one poll cycle now (delegates to the watcher) — for tests / an explicit boot trigger. */
  poll: () => Promise<void>
  start: () => void
  stop: () => Promise<void>
}

/**
 * Long-running lifecycle: a block-poll watcher drives `tick` once per new block height. Owns
 * start/stop, logs `block.new` per height, and swallows tick errors so one bad tick never kills the
 * loop. `stop()` is idempotent.
 */
export function createRunner(deps: {
  getBlockNumber: () => Promise<bigint>
  tick: (height: bigint) => Promise<unknown>
  intervalMs?: number
  logger: Logger
  /**
   * Formats a tick error for the `tick.error` log line. Defaults to the standard `Error`/`Panic`
   * revert decode; protocols with custom ABI errors pass a `revertReason` wrapped with their
   * `abiRevertDecoder`.
   */
  revertReason?: (error: unknown) => string
}): Runner {
  const { getBlockNumber, tick, logger } = deps
  const intervalMs = deps.intervalMs ?? BLOCK_POLL_MS
  const revertReason = deps.revertReason ?? defaultRevertReason
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
      logger.info('runner.shutdown', {})
      return Promise.resolve()
    }
  }
}
