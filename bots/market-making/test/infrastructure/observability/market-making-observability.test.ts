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

  test('ships each array action as a searchable top-level record', () => {
    const { logger, records } = captureLogger()
    const observability = createMarketMakingObservability({ logger })

    observability.record([
      { marketId: 'market-a', action: 'resize', status: 'published' },
      { marketId: 'market-b', action: 'rest', status: 'resting' }
    ])

    expect(records).toEqual([
      {
        level: 'info',
        event: 'bot.action',
        fields: { marketId: 'market-a', action: 'resize', status: 'published' }
      },
      {
        level: 'info',
        event: 'bot.action',
        fields: { marketId: 'market-b', action: 'rest', status: 'resting' }
      }
    ])
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
        fields: { origin: 'unhandledRejection', errorName: 'ProviderTimeoutError' }
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

  test('observes fatal exceptions through the monitor hook without installing a swallowing handler', () => {
    const unexpected = mock(
      (_error: unknown, _origin: 'uncaughtException' | 'unhandledRejection') => undefined
    )
    let listener: ((error: Error, origin: string) => void) | undefined
    const target = {
      on: mock((event: string, value: typeof listener) => {
        expect(event).toBe('uncaughtExceptionMonitor')
        listener = value
      }),
      removeListener: mock((event: string, value: typeof listener) => {
        expect(event).toBe('uncaughtExceptionMonitor')
        expect(value).toBe(listener)
      })
    }

    const cleanup = installMarketMakingProcessObservers({ unexpected }, target)
    const error = new Error('must not be logged')
    listener?.(error, 'unhandledRejection')
    cleanup()

    expect(unexpected).toHaveBeenCalledWith(error, 'unhandledRejection')
    expect(target.on).toHaveBeenCalledTimes(1)
    expect(target.removeListener).toHaveBeenCalledTimes(1)
  })
})
