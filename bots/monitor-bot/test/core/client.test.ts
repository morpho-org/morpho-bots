import { describe, expect, it } from 'vitest'

import { createCoreClient } from '../../src/core/client'

function captureFetch(requests: Request[]) {
  return async (request: Request) => {
    requests.push(request)
    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }
}

describe('createCoreClient', () => {
  it('sends x-api-key on every request when apiKey is set', async () => {
    const requests: Request[] = []
    const client = createCoreClient('https://core.example.test', {
      fetchImpl: captureFetch(requests),
      apiKey: 'test-key'
    })

    await client.GET('/v0/tokens/{token-selector}', {
      params: { path: { 'token-selector': '8453:0x1111111111111111111111111111111111111111' } }
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers.get('x-api-key')).toBe('test-key')
  })

  it('omits the header when apiKey is unset', async () => {
    const requests: Request[] = []
    const client = createCoreClient('https://core.example.test', {
      fetchImpl: captureFetch(requests)
    })

    await client.GET('/v0/tokens/{token-selector}', {
      params: { path: { 'token-selector': '8453:0x1111111111111111111111111111111111111111' } }
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers.get('x-api-key')).toBeNull()
  })
})
