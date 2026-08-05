import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Logger, LogLevel } from '../src/logger'

import { createHeartbeatMonitor } from '../src/heartbeat'
import { parseHttpHeartbeatUrl } from '../src/heartbeat-url'

function captureLogger() {
  const events: { level: LogLevel; event: string; fields?: Record<string, unknown> }[] = []
  const make = (level: LogLevel) => (event: string, fields?: Record<string, unknown>) => {
    events.push({ level, event, fields })
  }
  const logger: Logger = {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error')
  }
  return { logger, events }
}

describe('createHeartbeatMonitor', () => {
  afterEach(() => vi.restoreAllMocks())

  it('is inert when the URL is unset', async () => {
    const { logger } = captureLogger()
    let pings = 0
    const monitor = createHeartbeatMonitor({
      logger,
      ping: async () => {
        pings += 1
        return { ok: true, status: 200 }
      }
    })

    await monitor.start()
    expect(pings).toBe(0)
  })

  it('is inert without warning or scheduling when the URL contains only whitespace', async () => {
    const { logger, events } = captureLogger()
    const setIntervalSpy = spyOn(globalThis, 'setInterval')
    let pings = 0
    const monitor = createHeartbeatMonitor({
      url: ' \t\r\n ',
      logger,
      ping: async () => {
        pings += 1
        return { ok: true, status: 200 }
      }
    })

    await monitor.start()
    monitor.stop()

    expect(events).toEqual([])
    expect(pings).toBe(0)
    expect(setIntervalSpy).not.toHaveBeenCalled()
  })

  it('pings immediately and then on a wall-clock interval', async () => {
    const { logger } = captureLogger()
    const urls: string[] = []
    let callback: (() => void) | undefined
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((
      ...args: Parameters<typeof setInterval>
    ) => {
      const [handler, delay] = args
      callback = handler as () => void
      expect(delay).toBe(60_000)
      return 1 as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval)
    const monitor = createHeartbeatMonitor({
      url: 'https://uptime.betterstack.com/api/v1/heartbeat/secret',
      logger,
      ping: async url => {
        urls.push(url)
        return { ok: true, status: 200 }
      }
    })

    await monitor.start()
    callback?.()
    await Promise.resolve()
    expect(urls).toEqual([
      'https://uptime.betterstack.com/api/v1/heartbeat/secret',
      'https://uptime.betterstack.com/api/v1/heartbeat/secret'
    ])
    expect(setIntervalSpy).toHaveBeenCalledTimes(1)
    monitor.stop()
  })

  it('logs a failed ping without throwing', async () => {
    const { logger, events } = captureLogger()
    const monitor = createHeartbeatMonitor({
      url: 'https://uptime.betterstack.com/api/v1/heartbeat/secret',
      logger,
      ping: async () => {
        throw new Error('network unavailable')
      }
    })

    await monitor.start()
    expect(events).toEqual([
      {
        level: 'warn',
        event: 'heartbeat.failed',
        fields: { detail: 'network unavailable' }
      }
    ])
    monitor.stop()
  })

  it.each([
    [
      '  https://uptime.betterstack.com:443/api/v1/heartbeat/secret?source=maker#status  ',
      'https://uptime.betterstack.com:443/api/v1/heartbeat/secret?source=maker#status'
    ],
    ['http://example.test:8080/heartbeat', 'http://example.test:8080/heartbeat']
  ])('uses the exact trimmed HTTP(S) URL %s', async (url, expectedUrl) => {
    const { logger } = captureLogger()
    const setIntervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(
      (() => 1 as unknown as ReturnType<typeof setInterval>) as typeof setInterval
    )
    const urls: string[] = []
    const monitor = createHeartbeatMonitor({
      url,
      logger,
      ping: async endpoint => {
        urls.push(endpoint)
        return { ok: true, status: 200 }
      }
    })

    await monitor.start()
    monitor.stop()

    expect(urls).toEqual([expectedUrl])
    expect(setIntervalSpy).toHaveBeenCalledTimes(1)
  })

  it.each([
    'ftp://example.test/heartbeat',
    'file:///tmp/heartbeat',
    'ws://example.test/heartbeat',
    'wss://example.test/heartbeat',
    'javascript:alert(1)',
    'not a URL',
    'https://example.test:bad-port/heartbeat'
  ])('warns once and stays inert for invalid URL %s', async url => {
    const { logger, events } = captureLogger()
    const setIntervalSpy = spyOn(globalThis, 'setInterval')
    let pings = 0
    const monitor = createHeartbeatMonitor({
      url,
      logger,
      ping: async () => {
        pings += 1
        return { ok: true, status: 200 }
      }
    })

    await monitor.start()
    monitor.stop()

    expect(pings).toBe(0)
    expect(setIntervalSpy).not.toHaveBeenCalled()
    expect(events).toEqual([
      {
        level: 'warn',
        event: 'heartbeat.misconfigured',
        fields: {
          detail: 'BETTERSTACK_HEARTBEAT_URL must be an HTTP(S) URL — heartbeat disabled'
        }
      }
    ])
  })
})

describe('parseHttpHeartbeatUrl', () => {
  const cases = [
    ['https://uptime.betterstack.com/api/v1/heartbeat/secret', true],
    ['http://example.test/heartbeat?source=maker#status', true],
    ['  HTTPS://user:pass@example.test:8443/heartbeat  ', true],
    ['ftp://example.test/heartbeat', false],
    ['file:///tmp/heartbeat', false],
    ['ws://example.test/heartbeat', false],
    ['wss://example.test/heartbeat', false],
    ['javascript:alert(1)', false],
    ['not a URL', false],
    ['https://example.test:bad-port/heartbeat', false],
    ['', false]
  ] as const

  it.each(cases)('classifies %s as HTTP(S)=%s', (value, accepted) => {
    expect(Boolean(parseHttpHeartbeatUrl(value))).toBe(accepted)
  })
})
