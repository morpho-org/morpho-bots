import type { AddressInfo } from 'node:net'

import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { startBotTelemetry } from '../src/bot-telemetry.utils'
import { withActiveSpan } from '../src/with-active-span.utils'

type JsonRecord = Record<string, any>

const listen = async (handler: Parameters<typeof createServer>[1]) => {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve()))
  }
}

const startCollector = async () => {
  const requests: { path: string; body: JsonRecord }[] = []
  const server = await listen((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk as Buffer))
    request.on('end', () => {
      requests.push({
        path: request.url ?? '',
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonRecord
      })
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
  })
  return { ...server, requests }
}

const exportedSpans = (requests: { path: string; body: JsonRecord }[]) =>
  requests
    .filter(request => request.path.endsWith('/v1/traces'))
    .flatMap(request => request.body.resourceSpans ?? [])
    .flatMap((resourceSpans: JsonRecord) =>
      (resourceSpans.scopeSpans ?? []).flatMap((scopeSpans: JsonRecord) =>
        (scopeSpans.spans ?? []).map((span: JsonRecord) => ({
          ...span,
          resourceAttributes: Object.fromEntries(
            (resourceSpans.resource?.attributes ?? []).map((attribute: JsonRecord) => [
              attribute.key,
              Object.values(attribute.value ?? {})[0]
            ])
          ),
          attributeMap: Object.fromEntries(
            (span.attributes ?? []).map((attribute: JsonRecord) => [
              attribute.key,
              Object.values(attribute.value ?? {})[0]
            ])
          )
        }))
      )
    )

describe('startBotTelemetry', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('is a no-op without an export opt-in', async () => {
    const events: string[] = []
    const logger = {
      info: (event: string) => void events.push(event),
      warn: (event: string) => void events.push(event)
    }
    const telemetry = startBotTelemetry({ serviceName: 'test-bot', env: {}, logger })
    expect(telemetry.enabled).toBe(false)
    await expect(telemetry.shutdown()).resolves.toBeUndefined()
    expect(events).toEqual([])
  })

  test('exports redacted, cycle-parented spans and metrics over OTLP', async () => {
    const collector = await startCollector()
    const upstream = await listen((request, response) => {
      response.writeHead(200).end('pong')
      void request
    })
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', collector.origin)
    const events: { event: string; fields?: Record<string, unknown> }[] = []
    const logger = {
      info: (event: string, fields?: Record<string, unknown>) =>
        void events.push({ event, fields }),
      warn: (event: string, fields?: Record<string, unknown>) => void events.push({ event, fields })
    }

    const telemetry = startBotTelemetry({
      serviceName: 'test-bot',
      serviceVersion: '1.2.3',
      attributes: { chainId: 8453 },
      logger
    })
    try {
      expect(telemetry.enabled).toBe(true)
      expect(events).toEqual([
        { event: 'otel.started', fields: { serviceName: 'test-bot', traces: true, metrics: true } }
      ])

      await withActiveSpan({ name: 'quoter-bot.cycle', attributes: { workflow: 'ladder' } }, () =>
        fetch(`${upstream.origin}/v2/super-secret-key?token=leak`, {
          headers: { connection: 'close' }
        }).then(response => response.text())
      )
    } finally {
      await telemetry.shutdown()
      await upstream.close()
      await collector.close()
    }

    const spans = exportedSpans(collector.requests)
    const cycleSpan = spans.find(span => span.name === 'quoter-bot.cycle')
    const requestSpan = spans.find(span => span.name === 'GET')
    expect(cycleSpan?.attributeMap).toMatchObject({ workflow: 'ladder' })
    expect(cycleSpan?.resourceAttributes).toMatchObject({
      'service.name': 'test-bot',
      'service.version': '1.2.3',
      chainId: 8453
    })
    expect(requestSpan?.traceId).toBe(cycleSpan?.traceId)
    expect(requestSpan?.parentSpanId).toBe(cycleSpan?.spanId)
    expect(requestSpan?.attributeMap['url.full']).toBe(upstream.origin)
    expect(requestSpan?.attributeMap['url.path']).toBe('[redacted]')
    expect(requestSpan?.attributeMap['url.query']).toBe('')
    expect(JSON.stringify(collector.requests)).not.toContain('super-secret-key')
    expect(JSON.stringify(collector.requests)).not.toContain('token=leak')

    const metricNames = collector.requests
      .filter(request => request.path.endsWith('/v1/metrics'))
      .flatMap(request => request.body.resourceMetrics ?? [])
      .flatMap((resourceMetrics: JsonRecord) =>
        (resourceMetrics.scopeMetrics ?? []).flatMap((scopeMetrics: JsonRecord) =>
          (scopeMetrics.metrics ?? []).map((metric: JsonRecord) => metric.name)
        )
      )
    expect(metricNames).toContain('http.client.request.duration')
  })

  test('a failed request exports no exception payload or status text', async () => {
    const collector = await startCollector()
    // Accepts the connection and destroys the socket, so undici fails mid-request: a plain
    // closed port would not do — fetch rejects some low ports at spec level before undici
    // dispatches, and then no request span exists at all.
    const broken = createNetServer(socket => socket.destroy())
    await new Promise<void>(resolve => broken.listen(0, '127.0.0.1', resolve))
    const { port } = broken.address() as AddressInfo
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', collector.origin)
    const telemetry = startBotTelemetry({ serviceName: 'test-bot' })
    try {
      await expect(
        withActiveSpan({ name: 'quoter-bot.cycle', attributes: { workflow: 'ladder' } }, () =>
          fetch(`http://127.0.0.1:${port}/super-secret-key?token=leak`)
        )
      ).rejects.toThrow()
    } finally {
      await telemetry.shutdown()
      await new Promise<void>(resolve => broken.close(() => resolve()))
      await collector.close()
    }

    const requestSpan = exportedSpans(collector.requests).find(span => span.name === 'GET')
    expect(requestSpan).toBeDefined()
    expect(requestSpan?.status?.code).toBe(2)
    expect(requestSpan?.status?.message).toBeUndefined()
    expect(requestSpan?.events ?? []).toEqual([])
    expect(requestSpan?.attributeMap['url.full']).toBe(`http://127.0.0.1:${port}`)
    const payload = JSON.stringify(collector.requests)
    expect(payload).not.toContain('exception')
    expect(payload).not.toContain('SocketError')
    expect(payload).not.toContain('super-secret-key')
  })

  test('a handled cycle failure flips the span status through the failed predicate', async () => {
    const collector = await startCollector()
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', collector.origin)
    const telemetry = startBotTelemetry({ serviceName: 'test-bot' })
    try {
      await withActiveSpan(
        { name: 'quoter-bot.cycle', failed: result => result === 'halted' },
        async () => 'halted'
      )
    } finally {
      await telemetry.shutdown()
      await collector.close()
    }
    const cycleSpan = exportedSpans(collector.requests).find(
      span => span.name === 'quoter-bot.cycle'
    )
    expect(cycleSpan?.status?.code).toBe(2)
    expect(cycleSpan?.status?.message).toBeUndefined()
  })

  test('shutdown is idempotent', async () => {
    const collector = await startCollector()
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', collector.origin)
    const telemetry = startBotTelemetry({ serviceName: 'test-bot' })
    try {
      expect(telemetry.enabled).toBe(true)
    } finally {
      await telemetry.shutdown()
      await telemetry.shutdown()
      await collector.close()
    }
  })
})
