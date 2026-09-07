import type { SpanProcessor } from '@opentelemetry/sdk-trace-node'

import { describe, expect, test, vi } from 'vitest'

import { withSpanSanitizer } from '../src/span-sanitizer.utils'

type EndedSpan = Parameters<SpanProcessor['onEnd']>[0]

const endedSpan = (overrides: {
  events: { name: string }[]
  status: EndedSpan['status']
  attributes?: Record<string, unknown>
}) => overrides as unknown as EndedSpan

describe('withSpanSanitizer', () => {
  test('drops exception events and the status message before delegating', () => {
    const seen: EndedSpan[] = []
    const inner = {
      forceFlush: vi.fn(async () => {}),
      onStart: vi.fn(),
      onEnd: (span: EndedSpan) => void seen.push(span),
      shutdown: vi.fn(async () => {})
    }
    const span = endedSpan({
      events: [{ name: 'exception' }, { name: 'harmless' }, { name: 'exception' }],
      status: { code: 2, message: 'connect ECONNREFUSED https://user:key@rpc.example/v2/secret' }
    })

    withSpanSanitizer(inner).onEnd(span)

    expect(seen).toEqual([span])
    expect(span.events.map(event => event.name)).toEqual(['harmless'])
    expect(span.status).toEqual({ code: 2 })
  })

  test('reduces a legacy http.url attribute to the redacted origin', () => {
    const inner = {
      forceFlush: vi.fn(async () => {}),
      onStart: vi.fn(),
      onEnd: vi.fn(),
      shutdown: vi.fn(async () => {})
    }
    const span = endedSpan({
      events: [],
      status: { code: 0 },
      attributes: {
        'url.full': 'https://rpc.example',
        'http.url': 'https://rpc.example/v2/secret-key?token=leak'
      }
    })
    withSpanSanitizer(inner).onEnd(span)
    expect(span.attributes['http.url']).toBe('https://rpc.example')

    const bare = endedSpan({
      events: [],
      status: { code: 0 },
      attributes: { 'http.url': 'https://rpc.example/v2/secret-key' }
    })
    withSpanSanitizer(inner).onEnd(bare)
    expect(bare.attributes['http.url']).toBe('[redacted]')
  })

  test('leaves a clean span untouched and delegates the lifecycle', async () => {
    const inner = {
      forceFlush: vi.fn(async () => {}),
      onStart: vi.fn(),
      onEnd: vi.fn(),
      shutdown: vi.fn(async () => {})
    }
    const sanitizer = withSpanSanitizer(inner)
    const span = endedSpan({ events: [], status: { code: 0 } })

    sanitizer.onEnd(span)
    await sanitizer.forceFlush()
    await sanitizer.shutdown()

    expect(span.status).toEqual({ code: 0 })
    expect(inner.onEnd).toHaveBeenCalledWith(span)
    expect(inner.forceFlush).toHaveBeenCalledOnce()
    expect(inner.shutdown).toHaveBeenCalledOnce()
  })
})
