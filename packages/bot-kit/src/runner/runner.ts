import { tryCatch } from '@repo/utils'

import type { Logger } from '../logger'

import { revertReason as defaultRevertReason } from '../tx-error'
import { BLOCK_POLL_MS, createBlockWatcher } from './watcher'

/** The long-running lifecycle handle {@link createRunner} returns. */
type Runner = {
  /** Run one poll cycle now (delegates to the watcher) — for tests / an explicit boot trigger. */
  poll: () => Promise<void>
  start: () => void
  stop: () => Promise<void>
}

/**
 * Long-running lifecycle: a block-poll watcher drives `tick` once per new block height. Owns
 * start/stop, logs `block.new` per height, and swallows tick errors so one bad tick never kills the
 * loop. `stop()` is idempotent.
 *
 * When a `maintain` phase is given it runs once per block BEFORE the tick, in its own try/catch, so
 * block-lifecycle upkeep (pending-queue receipt checks, fee replacement, nonce reconciliation, latch
 * clearing) is driven even when the tick's discovery/lens/quote work throws. Ordering before the tick
 * makes the guarantee structural — the tick can never starve maintenance — and a maintenance failure
 * (`queue.maintenance_failed`) is isolated so it never kills the tick.
 */
export function createRunner(deps: {
  getBlockNumber: () => Promise<bigint>
  tick: (height: bigint) => Promise<unknown>
  /**
   * Optional per-block upkeep phase run BEFORE the tick and independently of it. Its failure is
   * logged (`queue.maintenance_failed`) and swallowed so neither phase can starve the other.
   */
  maintain?: (height: bigint) => Promise<unknown>
  intervalMs?: number
  logger: Logger
  /**
   * Formats a tick error for the `tick.error` log line. Defaults to the standard `Error`/`Panic`
   * revert decode; protocols with custom ABI errors pass a `revertReason` wrapped with their
   * `abiRevertDecoder`.
   */
  revertReason?: (error: unknown) => string
}): Runner {
  const { getBlockNumber, tick, maintain, logger } = deps
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
      // Maintenance first, isolated: even if the tick throws below, the queue was already driven this
      // block. A maintenance failure is logged and swallowed so it never blocks the tick.
      if (maintain) {
        const maintained = await tryCatch(maintain(height))
        if (maintained.error) {
          logger.error('queue.maintenance_failed', { reason: revertReason(maintained.error) })
        }
      }
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
