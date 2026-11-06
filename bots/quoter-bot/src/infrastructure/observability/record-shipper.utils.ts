import type { Logger } from '@repo/kit'

import { operatorErrorName } from '../../application/monitoring/operator-error-name.utils'

type UnexpectedOrigin = 'entrypoint' | 'uncaughtException' | 'unhandledRejection'

const hasFailure = (value: unknown, seen = new WeakSet<object>(), depth = 0): boolean => {
  if (depth > 12 || value === null || typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) return value.some(item => hasFailure(item, seen, depth + 1))
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'status' && (nested === 'failed' || nested === 'halted')) return true
    if (key === 'errorName' && typeof nested === 'string' && nested.length > 0) return true
    if (hasFailure(nested, seen, depth + 1)) return true
  }
  return false
}

const ship = (logger: Logger, value: unknown) => {
  if (Array.isArray(value) && value.length > 0) {
    for (const item of value) ship(logger, item)
    return
  }
  const fields: Record<string, unknown> =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : { records: value }
  const event = typeof fields.event === 'string' ? fields.event : 'bot.action'
  delete fields.event
  const unclean = event === 'kernel.stopped' && fields.outcome !== 'clean'
  logger[unclean || hasFailure(value) ? 'error' : 'info'](event, fields)
}

/**
 * Ships already-sanitized monitoring records through the shipping logger, without touching CLI
 * output. Inert when `logger` is undefined, meaning shipping is off.
 * @param logger - The logger from `createMonitoringLogger`.
 * @returns Record and unexpected-error sinks for the process composition root.
 * @remarks Field names are a public interface: Better Stack alerts and dashboards parse them. A
 * record's `event` becomes the log message and its other fields ship unchanged; a nested `status`
 * of `failed`/`halted`, a non-empty `errorName`, or a `kernel.stopped` whose outcome is not `clean`
 * ships at error level, anything else at info.
 */
export const createRecordShipper = (logger: Logger | undefined) => ({
  /**
   * Ships one record, or one record per item of an array.
   * @param value - Sanitized record; never throws.
   */
  record(value: unknown) {
    if (logger) ship(logger, value)
  },
  /**
   * Logs one `bot.unexpected-error` classification without the message or cause.
   * @param error - Untrusted failure; only its sanitized operator name is logged.
   * @param origin - Where the failure surfaced.
   */
  unexpected(error: unknown, origin: UnexpectedOrigin) {
    logger?.error('bot.unexpected-error', { origin, errorName: operatorErrorName(error) })
  }
})

type ProcessObserverTarget = {
  on(event: 'uncaughtExceptionMonitor', listener: (error: Error, origin: string) => void): unknown
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown
  removeListener(
    event: 'uncaughtExceptionMonitor',
    listener: (error: Error, origin: string) => void
  ): unknown
  removeListener(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown
}

/**
 * Installs fatal exception and Node unhandled-rejection observers.
 * @param shipper - Sanitized unexpected-error sink.
 * @param target - Process-like event target.
 * @returns A cleanup callback that removes every installed listener.
 * @remarks The rejection listener rethrows after recording so the runtime keeps its fatal exit;
 * the monitor listener observes uncaught exceptions without swallowing them.
 */
export const installProcessObservers = (
  shipper: Pick<ReturnType<typeof createRecordShipper>, 'unexpected'>,
  target: ProcessObserverTarget = process
) => {
  const exceptionListener = (error: Error, origin: string) => {
    if (origin !== 'unhandledRejection') shipper.unexpected(error, 'uncaughtException')
  }
  const rejectionListener = (reason: unknown) => {
    shipper.unexpected(reason, 'unhandledRejection')
    throw reason
  }
  target.on('uncaughtExceptionMonitor', exceptionListener)
  target.on('unhandledRejection', rejectionListener)
  return () => {
    target.removeListener('uncaughtExceptionMonitor', exceptionListener)
    target.removeListener('unhandledRejection', rejectionListener)
  }
}
