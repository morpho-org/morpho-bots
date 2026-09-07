import { describe, expect, test } from 'vitest'

import { redactedUrlAttributes } from '../src/url-redaction.utils'

describe('redactedUrlAttributes', () => {
  test('keeps only the origin of a credentialed provider URL', () => {
    expect(
      redactedUrlAttributes({
        origin: 'https://base-mainnet.example.com',
        path: '/v2/super-secret-api-key?token=also-secret'
      })
    ).toEqual({
      'url.full': 'https://base-mainnet.example.com',
      'url.path': '[redacted]',
      'url.query': ''
    })
  })

  test('drops URL userinfo', () => {
    expect(
      redactedUrlAttributes({ origin: 'https://user:password@rpc.example', path: '/key' })[
        'url.full'
      ]
    ).toBe('https://rpc.example')
  })

  test('keeps a non-default port', () => {
    expect(redactedUrlAttributes({ origin: 'http://127.0.0.1:8545', path: '/' })).toEqual({
      'url.full': 'http://127.0.0.1:8545',
      'url.path': '[redacted]',
      'url.query': ''
    })
  })

  test('an unparseable request redacts to a fixed placeholder', () => {
    expect(redactedUrlAttributes({ origin: 'not a url', path: '//' })['url.full']).toBe(
      '[invalid-url]'
    )
  })
})
