import type { ReportCommand } from '@repo/kernel'
import type { JournalRunCap, Logger } from '@repo/kit'

import { GraphFailedError } from '@repo/engine'
import { tryCatch } from '@repo/utils'

import { revertReason } from './revert.utils'

const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const

/** Requests the kernel's clean stop on SIGINT, SIGTERM, or the journal's run cap, and resolves to the exit code. */
export async function superviseKernelBot(
  running: Readonly<{ stop: () => void; stopped: Promise<ReportCommand> }>,
  runCapReached: Promise<JournalRunCap>,
  logger: Logger,
  shutdownFields: () => Record<string, unknown>
): Promise<0 | 1> {
  let settled = false
  const shutdown = (signal: NodeJS.Signals) => {
    logger.info('shutdown', { signal, ...shutdownFields() })
    running.stop()
  }
  for (const signal of STOP_SIGNALS) process.on(signal, shutdown)
  void runCapReached.then(cap => {
    if (settled) return
    logger.info('journal.capped', { ...cap, ...shutdownFields() })
    running.stop()
  })
  const stopped = await tryCatch(running.stopped)
  settled = true
  for (const signal of STOP_SIGNALS) process.off(signal, shutdown)
  if (stopped.error) {
    const failed = stopped.error instanceof GraphFailedError ? stopped.error : undefined
    const report = failed?.stop as ReportCommand | undefined
    logger.error('runner.failed', {
      error: revertReason(failed ? failed.cause : stopped.error),
      ...(failed && { origin: failed.origin }),
      ...(report && { outcome: report.outcome, reason: report.reason, open: report.open })
    })
    return 1
  }
  const { outcome, reason, open } = stopped.data
  const level = outcome === 'clean' ? 'info' : 'error'
  logger[level]('kernel.stopped', { outcome, reason, open })
  return outcome === 'clean' ? 0 : 1
}
