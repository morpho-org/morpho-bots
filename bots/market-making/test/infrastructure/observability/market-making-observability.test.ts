import type { Logger, LogLevel } from '@repo/bot-kit'

import { describe, expect, mock, spyOn, test } from 'bun:test'

import {
  createMarketMakingObservability,
  enhanceMarketMakingArgv,
  installMarketMakingProcessObservers
} from '../../../src/infrastructure/observability/market-making-observability'

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

describe('enhanceMarketMakingArgv', () => {
  const full = {
    BETTERSTACK_SOURCE_TOKEN: 'source-token',
    BETTERSTACK_INGESTING_HOST: 's1.betterstackdata.com'
  }

  test.each(['start', 'bootstrap', 'ladder'])(
    'enables safe diagnostics for %s with full shipping config',
    command => {
      expect(enhanceMarketMakingArgv([command], full)).toEqual([command, '--verbose'])
    }
  )

  test('does not duplicate an explicit verbose flag', () => {
    expect(enhanceMarketMakingArgv(['start', '--verbose'], full)).toEqual(['start', '--verbose'])
  })

  test('recognizes the command without mistaking a config path for one', () => {
    expect(enhanceMarketMakingArgv(['--config', 'start', 'setup-check'], full)).toEqual([
      '--config',
      'start',
      'setup-check'
    ])
    expect(enhanceMarketMakingArgv(['--config=market-making.yaml', 'ladder'], full)).toEqual([
      '--config=market-making.yaml',
      'ladder',
      '--verbose'
    ])
  })

  test.each([
    ['unset', {}],
    ['token only', { BETTERSTACK_SOURCE_TOKEN: 'source-token' }],
    ['host only', { BETTERSTACK_INGESTING_HOST: 's1.betterstackdata.com' }]
  ])('is inert when shipping config is %s', (_name, env) => {
    expect(enhanceMarketMakingArgv(['start'], env)).toEqual(['start'])
  })
})

describe('market-making observability', () => {
  test('ships lifecycle, heartbeat, actions, positions, and offers without consuming CLI output', async () => {
    const { logger, records } = captureLogger()
    const heartbeat = { start: mock(async () => undefined), stop: mock(() => undefined) }
    const observability = createMarketMakingObservability({ logger, heartbeat })
    const cycle = {
      event: 'market-making.cycle',
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
        event: 'market-making.cycle',
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
    expect(cycle.event).toBe('market-making.cycle')
  })

  test('ships recenter, resize, publish, rest, bootstrap, and invalidation actions as records', () => {
    const { logger, records } = captureLogger()
    const observability = createMarketMakingObservability({ logger })

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
    const heartbeat = { start: mock(async () => undefined), stop: mock(() => undefined) }
    const observability = createMarketMakingObservability({ logger, heartbeat })

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
    const observability = createMarketMakingObservability({ logger })

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

  test('logs unexpected failures by allowlisted error name only', () => {
    const { logger, records } = captureLogger()
    const observability = createMarketMakingObservability({ logger })
    const error = new Error('provider secret raw response')
    error.name = 'ProviderTimeoutError'

    observability.unexpected(error, 'unhandledRejection')
    observability.unexpected({ message: 'hostile raw text' }, 'uncaughtException')

    expect(records).toEqual([
      {
        level: 'error',
        event: 'bot.unexpected-error',
        fields: { origin: 'unhandledRejection', errorName: 'UnknownError' }
      },
      {
        level: 'error',
        event: 'bot.unexpected-error',
        fields: { origin: 'uncaughtException', errorName: 'UnknownError' }
      }
    ])
    expect(JSON.stringify(records)).not.toContain('provider secret')
    expect(JSON.stringify(records)).not.toContain('hostile raw text')
  })

  test('sanitizes heartbeat transport failures before logging', async () => {
    const { logger, records } = captureLogger()
    const fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('heartbeat secret URL and raw network response')
    )
    try {
      const observability = createMarketMakingObservability({
        logger,
        env: { BETTERSTACK_HEARTBEAT_URL: 'https://uptime.example/secret' }
      })

      await observability.start()
      await Bun.sleep(0)
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

  test('observes fatal exceptions and rethrows unhandled rejections after recording', () => {
    const unexpected = mock(
      (_error: unknown, _origin: 'uncaughtException' | 'unhandledRejection') => undefined
    )
    let exceptionListener: ((error: Error, origin: string) => void) | undefined
    let rejectionListener: ((reason: unknown) => void) | undefined
    const target = {
      on: mock((event: string, value: (...args: never[]) => void) => {
        if (event === 'uncaughtExceptionMonitor') {
          exceptionListener = value as typeof exceptionListener
        } else {
          rejectionListener = value as typeof rejectionListener
        }
      }),
      removeListener: mock((_event: string, _value: (...args: never[]) => void) => undefined)
    }

    const cleanup = installMarketMakingProcessObservers({ unexpected }, target)
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
