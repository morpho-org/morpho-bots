import type { Logger, LogLevel } from '@repo/bot-kit'

import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, test, vi } from 'vitest'

import { createBotObservability, installProcessObservers } from '../src/bot-observability.utils'

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

const errorName = (error: unknown) => (error instanceof RangeError ? 'RangeError' : 'UnknownError')

const identity = { bot: 'test-bot', chainId: 8453, errorName }

describe('createBotObservability', () => {
  test('ships lifecycle, heartbeat, and record events without consuming CLI output', async () => {
    const { logger, records } = captureLogger()
    const heartbeat = { start: vi.fn(async () => undefined), stop: vi.fn(() => undefined) }
    const observability = createBotObservability({ ...identity, logger, heartbeat })
    const cycle = {
      event: 'quoter-bot.cycle',
      workflow: 'ladder',
      status: 'published',
      activePosition: { suppliedAssets: 12n },
      activeOffers: [{ side: 'buy', assets: 7n }],
      quotes: [{ rate: 123n }],
      action: 'recenter'
    }

    await observability.start()
    observability.record(cycle)
    observability.stop('completed')

    expect(heartbeat.start).toHaveBeenCalledTimes(1)
    expect(heartbeat.stop).toHaveBeenCalledTimes(1)
    expect(records).toEqual([
      { level: 'info', event: 'bot.started', fields: {} },
      {
        level: 'info',
        event: 'quoter-bot.cycle',
        fields: {
          workflow: 'ladder',
          status: 'published',
          activePosition: { suppliedAssets: 12n },
          activeOffers: [{ side: 'buy', assets: 7n }],
          quotes: [{ rate: 123n }],
          action: 'recenter'
        }
      },
      { level: 'info', event: 'bot.stopped', fields: { reason: 'completed' } }
    ])
    expect(cycle.event).toBe('quoter-bot.cycle')
  })

  test('ships each array item as its own info-level record for every success status', () => {
    const { logger, records } = captureLogger()
    const observability = createBotObservability({ ...identity, logger })

    observability.record([
      { marketId: 'market-a', action: 'recenter', status: 'published' },
      { marketId: 'market-b', action: 'resize', status: 'published' },
      { marketId: 'market-c', action: 'publish', status: 'published' },
      { marketId: 'market-d', action: 'rest', status: 'resting' },
      { marketId: 'market-e', action: 'bootstrap', status: 'applied' },
      { marketId: 'market-f', action: 'invalidation', status: 'confirmed' }
    ])

    expect(records.map(record => record.fields.action)).toEqual([
      'recenter',
      'resize',
      'publish',
      'rest',
      'bootstrap',
      'invalidation'
    ])
    expect(records.every(record => record.level === 'info' && record.event === 'bot.action')).toBe(
      true
    )
  })

  test('records a fresh lifecycle start after a clean stop so process restarts remain queryable', async () => {
    const { logger, records } = captureLogger()
    const heartbeat = { start: vi.fn(async () => undefined), stop: vi.fn(() => undefined) }
    const observability = createBotObservability({ ...identity, logger, heartbeat })

    await observability.start()
    observability.stop('restart')
    await observability.start()
    observability.stop('completed')

    expect(records.map(record => record.event)).toEqual([
      'bot.started',
      'bot.stopped',
      'bot.started',
      'bot.stopped'
    ])
    expect(heartbeat.start).toHaveBeenCalledTimes(2)
    expect(heartbeat.stop).toHaveBeenCalledTimes(2)
  })

  test('elevates nested failed, halted, and errorName outcomes to error level', () => {
    const { logger, records } = captureLogger()
    const observability = createBotObservability({ ...identity, logger })

    observability.record({
      event: 'bootstrap.cycle',
      markets: [{ status: 'failed', errorName: 'BootstrapAdapterError' }]
    })
    observability.record({ workflow: 'ladder', report: { status: 'halted' } })

    expect(records.map(record => [record.level, record.event])).toEqual([
      ['error', 'bootstrap.cycle'],
      ['error', 'bot.action']
    ])
  })

  test('logs unexpected failures through the injected sanitized projection only', () => {
    const { logger, records } = captureLogger()
    const observability = createBotObservability({ ...identity, logger })
    const error = new Error('provider secret raw response')
    error.name = 'ProviderTimeoutError'

    observability.unexpected(error, 'unhandledRejection')
    observability.unexpected(new RangeError('hostile raw text'), 'uncaughtException')

    expect(records).toEqual([
      {
        level: 'error',
        event: 'bot.unexpected-error',
        fields: { origin: 'unhandledRejection', errorName: 'UnknownError' }
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

  test('sanitizes heartbeat transport failures before logging', async () => {
    const { logger, records } = captureLogger()
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('heartbeat secret URL and raw network response'))
    try {
      const observability = createBotObservability({
        ...identity,
        logger,
        env: { BETTERSTACK_HEARTBEAT_URL: 'https://uptime.example/secret' }
      })

      await observability.start()
      await sleep(0)
      observability.stop('completed')

      expect(records).toContainEqual({
        level: 'warn',
        event: 'heartbeat.failed',
        fields: { errorName: 'HeartbeatRequestError' }
      })
      expect(JSON.stringify(records)).not.toContain('heartbeat secret')
      expect(JSON.stringify(records)).not.toContain('raw network')
    } finally {
      fetchSpy.mockRestore()
    }
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
