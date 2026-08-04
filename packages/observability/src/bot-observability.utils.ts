import type { Logger } from '@repo/bot-kit'

import { createHeartbeatMonitor, createLogger, railwayContext } from '@repo/bot-kit'

import type { Environment } from './shipping-config.utils'

import { hasShippingConfig } from './shipping-config.utils'

type HeartbeatMonitor = { start: () => Promise<void>; stop: () => void }
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

/**
 * Mirrors a bot's already-sanitized records into bot-kit observability without consuming output.
 * @param options - Bot identity, sanitized error-name projection, and testable overrides.
 * @returns Lifecycle, record, and unexpected-error observers for the process composition root.
 * @remarks Starting begins best-effort heartbeat delivery; stopping ends it. Record shipping is
 * best-effort and never consumes or changes the bot's stdout/stderr stream. The error-name
 * projection must already be sanitized: it is logged verbatim.
 */
export const createBotObservability = (options: {
  bot: string
  chainId: number
  errorName: (error: unknown) => string
  env?: Environment
  logger?: Logger
  heartbeat?: HeartbeatMonitor
}) => {
  const env = options.env ?? process.env
  const shippingEnabled = options.logger !== undefined || hasShippingConfig(env)
  const logger =
    options.logger ??
    createLogger('info', {
      env,
      context: { bot: options.bot, chainId: options.chainId, ...railwayContext(env) }
    })
  const heartbeatLogger: Logger = {
    ...logger,
    warn(event, fields) {
      if (event === 'heartbeat.failed' && fields && 'detail' in fields) {
        logger.warn(event, { errorName: 'HeartbeatRequestError' })
        return
      }
      logger.warn(event, fields)
    }
  }
  const heartbeat =
    options.heartbeat ??
    createHeartbeatMonitor({ url: env.BETTERSTACK_HEARTBEAT_URL, logger: heartbeatLogger })
  const emitRecord = (value: unknown) => {
    if (Array.isArray(value) && value.length > 0) {
      for (const item of value) emitRecord(item)
      return
    }
    const fields: Record<string, unknown> =
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? { ...(value as Record<string, unknown>) }
        : { records: value }
    const event = typeof fields.event === 'string' ? fields.event : 'bot.action'
    delete fields.event
    logger[hasFailure(value) ? 'error' : 'info'](event, fields)
  }

  return {
    /** Starts lifecycle logging and best-effort heartbeat delivery. */
    async start() {
      if (shippingEnabled) logger.info('bot.started')
      void heartbeat
        .start()
        .catch(error => logger.warn('heartbeat.failed', { errorName: options.errorName(error) }))
    },
    /** Stops heartbeat delivery and records the sanitized lifecycle reason. */
    stop(reason: string) {
      heartbeat.stop()
      if (shippingEnabled) logger.info('bot.stopped', { reason })
    },
    /** Ships one already-sanitized record without changing terminal output. */
    record(value: unknown) {
      if (!shippingEnabled) return
      emitRecord(value)
    },
    /** Classifies an unexpected failure without shipping its message or cause. */
    unexpected(error: unknown, origin: UnexpectedOrigin) {
      if (shippingEnabled) {
        logger.error('bot.unexpected-error', { origin, errorName: options.errorName(error) })
      }
    }
  }
}

/** Lifecycle, record, and unexpected-error observers created for one bot process. */
export type BotObservability = ReturnType<typeof createBotObservability>

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
 * Installs fatal exception and Bun unhandled-rejection observers.
 * @param observability - Sanitized unexpected-error sink.
 * @param target - Process-like event target; injectable for isolated verification.
 * @returns A cleanup callback that removes every installed listener.
 * @remarks The rejection listener rethrows after recording so the runtime retains its fatal exit
 * behavior; the monitor listener observes uncaught exceptions without swallowing them.
 */
export const installProcessObservers = (
  observability: Pick<BotObservability, 'unexpected'>,
  target: ProcessObserverTarget = process
) => {
  const exceptionListener = (error: Error, origin: string) => {
    if (origin !== 'unhandledRejection') observability.unexpected(error, 'uncaughtException')
  }
  const rejectionListener = (reason: unknown) => {
    observability.unexpected(reason, 'unhandledRejection')
    throw reason
  }
  target.on('uncaughtExceptionMonitor', exceptionListener)
  target.on('unhandledRejection', rejectionListener)
  return () => {
    target.removeListener('uncaughtExceptionMonitor', exceptionListener)
    target.removeListener('unhandledRejection', rejectionListener)
  }
}
