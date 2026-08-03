import type { Logger } from '@repo/bot-kit'

import { createHeartbeatMonitor, createLogger, railwayContext } from '@repo/bot-kit'

const BASE_CHAIN_ID = 8453

type Environment = Record<string, string | undefined>
type HeartbeatMonitor = { start: () => Promise<void>; stop: () => void }
type UnexpectedOrigin = 'entrypoint' | 'uncaughtException' | 'unhandledRejection'

const hasShippingConfig = (env: Environment) =>
  Boolean(env.BETTERSTACK_SOURCE_TOKEN?.trim() && env.BETTERSTACK_INGESTING_HOST?.trim())

/** Enables the existing safe verbose event stream only when BetterStack shipping is fully configured. */
export const enhanceMarketMakingArgv = (
  argv: readonly string[],
  env: Environment = process.env
): readonly string[] => {
  if (!hasShippingConfig(env) || argv.includes('--verbose')) return [...argv]
  if (
    !argv.some(
      argument => argument === 'start' || argument === 'bootstrap' || argument === 'ladder'
    )
  ) {
    return [...argv]
  }
  return [...argv, '--verbose']
}

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

const safeErrorName = (error: unknown) => {
  if (!(error instanceof Error)) return 'UnknownError'
  return /^[A-Za-z][A-Za-z0-9_$]{0,79}$/.test(error.name) ? error.name : 'UnknownError'
}

/** Mirrors the CLI's already-sanitized records into bot-kit observability without consuming output. */
export const createMarketMakingObservability = (
  options: {
    env?: Environment
    logger?: Logger
    heartbeat?: HeartbeatMonitor
  } = {}
) => {
  const env = options.env ?? process.env
  const shippingEnabled = options.logger !== undefined || hasShippingConfig(env)
  const logger =
    options.logger ??
    createLogger('info', {
      env,
      context: { bot: 'market-making', chainId: BASE_CHAIN_ID, ...railwayContext(env) }
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
    async start() {
      if (shippingEnabled) logger.info('bot.started')
      void heartbeat
        .start()
        .catch(error => logger.warn('heartbeat.failed', { errorName: safeErrorName(error) }))
    },
    stop(reason: string) {
      heartbeat.stop()
      if (shippingEnabled) logger.info('bot.stopped', { reason })
    },
    record(value: unknown) {
      if (!shippingEnabled) return
      emitRecord(value)
    },
    unexpected(error: unknown, origin: UnexpectedOrigin) {
      if (shippingEnabled) {
        logger.error('bot.unexpected-error', { origin, errorName: safeErrorName(error) })
      }
    }
  }
}

export type MarketMakingObservability = ReturnType<typeof createMarketMakingObservability>

type ProcessObserverTarget = {
  on(event: 'uncaughtExceptionMonitor', listener: (error: Error, origin: string) => void): unknown
  removeListener(
    event: 'uncaughtExceptionMonitor',
    listener: (error: Error, origin: string) => void
  ): unknown
}

/** Uses Node's monitor-only fatal hook, which observes both exceptions and escalated rejections. */
export const installMarketMakingProcessObservers = (
  observability: Pick<MarketMakingObservability, 'unexpected'>,
  target: ProcessObserverTarget = process
) => {
  const listener = (error: Error, origin: string) =>
    observability.unexpected(
      error,
      origin === 'unhandledRejection' ? 'unhandledRejection' : 'uncaughtException'
    )
  target.on('uncaughtExceptionMonitor', listener)
  return () => target.removeListener('uncaughtExceptionMonitor', listener)
}
