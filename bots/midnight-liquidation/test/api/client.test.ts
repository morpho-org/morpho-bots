import { describe, expect, it } from 'bun:test'

import type { MidnightApiClient, MidnightApiError } from '../../src/api/client'

import { apiCall, createApiClient } from '../../src/api/client'

describe('createApiClient', () => {
  it('returns a typed openapi-fetch client', () => {
    const client: MidnightApiClient = createApiClient('https://api.example')
    expect(typeof client.GET).toBe('function')
  })
})

describe('apiCall', () => {
  it('returns the typed body on success', async () => {
    const result = await apiCall(() =>
      Promise.resolve({ data: { hello: 'world' }, response: new Response(null, { status: 200 }) })
    )
    expect(result).toEqual({ data: { hello: 'world' }, error: null })
  })

  it('normalizes a typed error envelope into an api error', async () => {
    const result = await apiCall(() =>
      Promise.resolve({
        error: {
          error: {
            code: 'INVALID_CURSOR',
            message: 'bad cursor',
            details: null,
            request_id: 'req-1'
          }
        },
        response: new Response(null, { status: 400 })
      })
    )
    const error: MidnightApiError | null = result.error
    expect(error).toEqual({
      kind: 'api',
      status: 400,
      code: 'INVALID_CURSOR',
      message: 'bad cursor',
      requestId: 'req-1',
      details: null
    })
  })

  it('treats a non-JSON error body (e.g. HTML 502) as malformed', async () => {
    const result = await apiCall(() =>
      Promise.resolve({
        error: '<html>502 Bad Gateway</html>',
        response: new Response(null, { status: 502 })
      })
    )
    expect(result.error?.kind).toBe('malformed')
    expect(result.error && 'status' in result.error ? result.error.status : null).toBe(502)
  })

  it('reports a thrown fetch as a network error', async () => {
    const result = await apiCall(() => Promise.reject(new Error('connection refused')))
    expect(result.error).toEqual({ kind: 'network', message: 'connection refused' })
  })
})
