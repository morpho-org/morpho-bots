import type { Logger, LogLevel } from '@repo/kit'

import { afterEach, describe, expect, test, vi } from 'vitest'

import type { MonitoringEvent } from '../../../src/application/monitoring/monitoring-event'

import { createMonitoringLogger } from '../../../src/infrastructure/observability/monitoring-logger.utils'
import {
  createRecordShipper,
  installProcessObservers
} from '../../../src/infrastructure/observability/record-shipper.utils'

vi.mock('@repo/kit', async importOriginal => {
  const original = await importOriginal<typeof import('@repo/kit')>()
  return {
    ...original,
    createLogger: (...[level, options]: Parameters<typeof original.createLogger>) =>
      original.createLogger(level, { ...options, env: {} })
  }
})

const captureLogger = () => {
  const records: { level: LogLevel; event: string; fields: Record<string, unknown> }[] = []
  const logger = Object.fromEntries(
    (['debug', 'info', 'warn', 'error'] as const).map(level => [
      level,
      (event: string, fields: Record<string, unknown> = {}) => {
        records.push({ level, event, fields })
      }
    ])
  ) as Logger
  return { logger, records }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createRecordShipper', () => {
  test('ships cycle.completed with the fields the Better Stack liveness alert parses', () => {
    const lines: unknown[] = []
    vi.spyOn(console, 'error').mockImplementation(line => void lines.push(JSON.parse(String(line))))
    const logger = createMonitoringLogger({
      bot: 'quoter-bot',
      chainId: 8453,
      env: {
        BETTERSTACK_SOURCE_TOKEN: 'source-token',
        BETTERSTACK_INGESTING_HOST: 's1.betterstackdata.com'
      }
    })
    const shipper = createRecordShipper(logger)
    const completed = {
      event: 'cycle.completed',
      workflow: 'ladder',
      status: 'published',
      action: 'recenter'
    } satisfies MonitoringEvent
    const failed = {
      event: 'cycle.completed',
      workflow: 'bootstrap',
      status: 'failed',
      errorName: 'BootstrapAdapterError'
    } satisfies MonitoringEvent

    shipper.record(completed)
    shipper.record(failed)

    expect(lines).toEqual([
      {
        level: 'info',
        time: expect.any(String),
        event: 'cycle.completed',
        bot: 'quoter-bot',
        chainId: 8453,
        schemaVersion: 5,
        workflow: 'ladder',
        status: 'published',
        action: 'recenter'
      },
      {
        level: 'error',
        time: expect.any(String),
        event: 'cycle.completed',
        bot: 'quoter-bot',
        chainId: 8453,
        schemaVersion: 5,
        workflow: 'bootstrap',
        status: 'failed',
        errorName: 'BootstrapAdapterError'
      }
    ])
  })

  test('ships nothing without a shipping logger', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const shipper = createRecordShipper(
      createMonitoringLogger({ bot: 'quoter-bot', chainId: 1, env: {} })
    )

    shipper.record({ event: 'cycle.completed', workflow: 'ladder', status: 'failed' })
    shipper.unexpected(new Error('boom'), 'entrypoint')

    expect(error).not.toHaveBeenCalled()
  })

  test('ships each array item as its own record and keeps unnamed values under bot.action', () => {
    const { logger, records } = captureLogger()
    const shipper = createRecordShipper(logger)

    shipper.record([
      { event: 'offer.consumed', status: 'confirmed', assets: 7n },
      { marketId: 'market-b', status: 'resting' }
    ])

    expect(records).toEqual([
      { level: 'info', event: 'offer.consumed', fields: { status: 'confirmed', assets: 7n } },
      { level: 'info', event: 'bot.action', fields: { marketId: 'market-b', status: 'resting' } }
    ])
  })

  test('elevates nested failed, halted, and errorName outcomes to error level', () => {
    const { logger, records } = captureLogger()
    const shipper = createRecordShipper(logger)

    shipper.record({ event: 'bootstrap.progress', markets: [{ status: 'failed' }] })
    shipper.record({ event: 'guardrail.halted', report: { status: 'halted' } })
    shipper.record({
      event: 'bot.failed',
      reason: 'signer-account',
      errorName: 'SignerAccountError'
    })
    shipper.record({ event: 'cycle.completed', status: 'resting', errorName: '' })

    expect(records.map(record => [record.level, record.event])).toEqual([
      ['error', 'bootstrap.progress'],
      ['error', 'guardrail.halted'],
      ['error', 'bot.failed'],
      ['info', 'cycle.completed']
    ])
  })

  test('logs unexpected failures by sanitized name only', () => {
    const { logger, records } = captureLogger()
    const shipper = createRecordShipper(logger)
    const error = new Error('provider secret raw response')
    error.name = 'ProviderTimeoutError'

    shipper.unexpected(error, 'entrypoint')
    shipper.unexpected(new RangeError('hostile raw text'), 'uncaughtException')

    expect(records).toEqual([
      {
        level: 'error',
        event: 'bot.unexpected-error',
        fields: { origin: 'entrypoint', errorName: 'UnknownError' }
      },
      {
        level: 'error',
        event: 'bot.unexpected-error',
        fields: { origin: 'uncaughtException', errorName: 'RangeError' }
      }
    ])
    expect(JSON.stringify(records)).not.toContain('provider secret')
    expect(JSON.stringify(records)).not.toContain('hostile raw text')
  })
})

describe('installProcessObservers', () => {
  test('observes fatal exceptions and rethrows unhandled rejections after recording', () => {
    const unexpected = vi.fn(
      (_error: unknown, _origin: 'uncaughtException' | 'unhandledRejection') => undefined
    )
    let exceptionListener: ((error: Error, origin: string) => void) | undefined
    let rejectionListener: ((reason: unknown) => void) | undefined
    const target = {
      on: vi.fn((event: string, value: (...args: never[]) => void) => {
        if (event === 'uncaughtExceptionMonitor') {
          exceptionListener = value as typeof exceptionListener
        } else {
          rejectionListener = value as typeof rejectionListener
        }
      }),
      removeListener: vi.fn((_event: string, _value: (...args: never[]) => void) => undefined)
    }

    const cleanup = installProcessObservers({ unexpected }, target)
    const error = new Error('must not be logged')
    exceptionListener?.(error, 'uncaughtException')
    exceptionListener?.(error, 'unhandledRejection')
    expect(() => rejectionListener?.(error)).toThrow(error)
    cleanup()

    expect(unexpected.mock.calls).toEqual([
      [error, 'uncaughtException'],
      [error, 'unhandledRejection']
    ])
    expect(target.on).toHaveBeenCalledTimes(2)
    expect(target.removeListener).toHaveBeenCalledTimes(2)
  })
})
