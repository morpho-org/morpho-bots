import { describe, expect, test } from 'vitest'

import { redactedUrlAttributes } from '../src/url-redaction.utils'

describe('redactedUrlAttributes', () => {
  test('keeps only a classified origin of a credentialed provider URL', () => {
    expect(
      redactedUrlAttributes({
        origin: 'https://base-mainnet.example.com',
        path: '/v2/super-secret-api-key?token=also-secret'
      })
    ).toEqual({
      'url.full': 'https://[redacted].example.com',
      'url.path': '[redacted]',
      'url.query': '',
      'server.address': '[redacted].example.com'
    })
  })

  test('redacts a token encoded as a hostname label', () => {
    const attributes = redactedUrlAttributes({
      origin: 'https://tenant-secret-token.rpc.example',
      path: '/'
    })
    expect(attributes['url.full']).toBe('https://[redacted].rpc.example')
    expect(attributes['server.address']).toBe('[redacted].rpc.example')
  })

  test('keeps two-label hosts, single-label hosts, and drops userinfo', () => {
    expect(
      redactedUrlAttributes({ origin: 'https://user:password@rpc.example', path: '/key' })
    ).toMatchObject({ 'url.full': 'https://rpc.example', 'server.address': 'rpc.example' })
    expect(redactedUrlAttributes({ origin: 'http://otel-lgtm:4318', path: '/' })).toMatchObject({
      'url.full': 'http://otel-lgtm:4318',
      'server.address': 'otel-lgtm'
    })
  })

  test('keeps IP literals with their port', () => {
    expect(redactedUrlAttributes({ origin: 'http://127.0.0.1:8545', path: '/' })).toEqual({
      'url.full': 'http://127.0.0.1:8545',
      'url.path': '[redacted]',
      'url.query': '',
      'server.address': '127.0.0.1'
    })
  })

  test('an unparseable request redacts to a fixed placeholder', () => {
    const attributes = redactedUrlAttributes({ origin: 'not a url', path: '//' })
    expect(attributes['url.full']).toBe('[invalid-url]')
    expect(attributes['server.address']).toBe('[invalid-url]')
  })
})
