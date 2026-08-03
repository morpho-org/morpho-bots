import type { Logger } from '@repo/bot-kit'

import { createHeartbeatMonitor, createLogger, railwayContext } from '@repo/bot-kit'

import { operatorErrorName } from '../../application/operator-error-name.utils'

const BASE_CHAIN_ID = 8453

type Environment = Record<string, string | undefined>
type HeartbeatMonitor = { start: () => Promise<void>; stop: () => void }
type UnexpectedOrigin = 'entrypoint' | 'uncaughtException' | 'unhandledRejection'

const hasShippingConfig = (env: Environment) =>
  Boolean(env.BETTERSTACK_SOURCE_TOKEN?.trim() && env.BETTERSTACK_INGESTING_HOST?.trim())

const marketMakingCommand = (argv: readonly string[]) => {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--config' || argument === '-c') {
      index += 1
      continue
    }
    if (argument?.startsWith('--config=') || argument?.startsWith('-')) continue
    return argument
  }
  return undefined
}

/**
 * Enables the existing safe verbose event stream only when BetterStack shipping is fully configured.
 * @param argv - CLI arguments without runtime or executable prefixes.
 * @param env - Environment used only to detect complete BetterStack shipping configuration.
 * @returns A copied argument list, with `--verbose` added for supported writer commands when needed.
 * @remarks Pure argument transformation; it performs no logging, shipping, or process mutation.
 */
export const enhanceMarketMakingArgv = (
  argv: readonly string[],
  env: Environment = process.env
): readonly string[] => {
  if (!hasShippingConfig(env) || argv.includes('--verbose')) return [...argv]
  const command = marketMakingCommand(argv)
  if (command !== 'start' && command !== 'bootstrap' && command !== 'ladder') {
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

/**
 * Mirrors the CLI's already-sanitized records into bot-kit observability without consuming output.
 * @param options - Optional environment and testable logger or heartbeat overrides.
 * @returns Lifecycle, record, and unexpected-error observers for the process composition root.
 * @remarks Starting begins best-effort heartbeat delivery; stopping ends it. Record shipping is
 * best-effort and never consumes or changes the CLI stdout/stderr stream.
 */
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
    /** Starts lifecycle logging and best-effort heartbeat delivery. */
    async start() {
      if (shippingEnabled) logger.info('bot.started')
      void heartbeat
        .start()
        .catch(error => logger.warn('heartbeat.failed', { errorName: operatorErrorName(error) }))
    },
    /** Stops heartbeat delivery and records the sanitized lifecycle reason. */
    stop(reason: string) {
      heartbeat.stop()
      if (shippingEnabled) logger.info('bot.stopped', { reason })
    },
    /** Ships one already-sanitized CLI record without changing terminal output. */
    record(value: unknown) {
      if (!shippingEnabled) return
      emitRecord(value)
    },
    /** Classifies an unexpected failure without shipping its message or cause. */
    unexpected(error: unknown, origin: UnexpectedOrigin) {
      if (shippingEnabled) {
        logger.error('bot.unexpected-error', { origin, errorName: operatorErrorName(error) })
      }
    }
  }
}

type MarketMakingObservability = ReturnType<typeof createMarketMakingObservability>

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
export const installMarketMakingProcessObservers = (
  observability: Pick<MarketMakingObservability, 'unexpected'>,
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
