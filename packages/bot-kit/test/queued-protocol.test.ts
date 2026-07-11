import { describe, expect, it } from 'bun:test'

import {
  errorResponse,
  ingestRecord,
  isQueuedResponse,
  MAX_LINE_BYTES,
  okResponse,
  parseRequestLine,
  QUEUED_PROTOCOL_VERSION,
  QueuedProtocolError,
  serializeResponse
} from '../src/queued-protocol'

const V = QUEUED_PROTOCOL_VERSION

describe('parseRequestLine', () => {
  it('parses a well-formed ping/status/ingest request', () => {
    expect(parseRequestLine(JSON.stringify({ v: V, id: '1', method: 'ping' }))).toEqual({
      v: V,
      id: '1',
      method: 'ping',
      params: undefined
    })
    const ingest = parseRequestLine(
      JSON.stringify({ v: V, id: '2', method: 'ingest', params: { record: { kind: 'tx' } } })
    )
    expect(ingest.method).toBe('ingest')
    expect(ingest.params).toEqual({ record: { kind: 'tx' } })
  })

  it('rejects non-JSON and non-object lines as bad_request', () => {
    expect(() => parseRequestLine('not json')).toThrow(QueuedProtocolError)
    expect(() => parseRequestLine('[1,2,3]')).toThrow(/JSON object/)
  })

  it('rejects a skewed protocol version as unsupported_version, echoing the id', () => {
    try {
      parseRequestLine(JSON.stringify({ v: 999, id: 'x', method: 'ping' }))
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(QueuedProtocolError)
      expect((error as QueuedProtocolError).code).toBe('unsupported_version')
      expect((error as QueuedProtocolError).id).toBe('x')
    }
  })

  it('rejects a missing id and an unknown method as bad_request', () => {
    expect(() => parseRequestLine(JSON.stringify({ v: V, method: 'ping' }))).toThrow(/'id'/)
    expect(() => parseRequestLine(JSON.stringify({ v: V, id: '1', method: 'frobnicate' }))).toThrow(
      /unknown method/
    )
  })
})

describe('ingestRecord', () => {
  it('unwraps params.record', () => {
    expect(ingestRecord({ record: { kind: 'tx', id: 'a' } })).toEqual({ kind: 'tx', id: 'a' })
  })

  it('rejects params that are not { record: … }', () => {
    expect(() => ingestRecord({}, 'z')).toThrow(QueuedProtocolError)
    expect(() => ingestRecord(null)).toThrow(/record/)
    expect(() => ingestRecord([{ record: 1 }])).toThrow(/record/)
  })
})

describe('response builders and serialization', () => {
  it('builds ok/error envelopes at the current version', () => {
    expect(okResponse('1', { pong: true })).toEqual({ v: V, id: '1', result: { pong: true } })
    expect(errorResponse('2', 'retry', 'send_aborted')).toEqual({
      v: V,
      id: '2',
      error: { code: 'retry', message: 'send_aborted' }
    })
  })

  it('serializes to exactly one newline-terminated line', () => {
    const line = serializeResponse(okResponse('1', { pong: true }))
    expect(line.endsWith('\n')).toBe(true)
    expect(line.trimEnd().includes('\n')).toBe(false)
    expect(JSON.parse(line)).toEqual({ v: V, id: '1', result: { pong: true } })
  })
})

describe('isQueuedResponse', () => {
  it('accepts a valid result and a valid error envelope', () => {
    expect(isQueuedResponse({ v: V, id: '1', result: {} })).toBe(true)
    expect(isQueuedResponse({ v: V, id: '1', error: { code: 'bad_request', message: 'x' } })).toBe(
      true
    )
  })

  it('rejects a skewed version, a both-branches line, and an unknown error code', () => {
    expect(isQueuedResponse({ v: 2, id: '1', result: {} })).toBe(false)
    expect(
      isQueuedResponse({ v: V, id: '1', result: {}, error: { code: 'internal', message: 'x' } })
    ).toBe(false)
    expect(isQueuedResponse({ v: V, id: '1', error: { code: 'nope', message: 'x' } })).toBe(false)
  })
})

describe('MAX_LINE_BYTES', () => {
  it('is larger than a bare sign request (records carry calldata)', () => {
    expect(MAX_LINE_BYTES).toBe(262_144)
  })
})
