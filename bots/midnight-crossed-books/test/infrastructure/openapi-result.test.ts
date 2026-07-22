import { describe, expect, test } from 'bun:test'

import { MorphoApiError } from '../../src/infrastructure/openapi/error'
import {
  unwrapOpenApiResult,
  withOpenApiErrorBoundary
} from '../../src/infrastructure/openapi/result'

const ENDPOINT = '/v0/midnight/markets'

describe('OpenAPI result boundary', () => {
  test('returns a successful response body', () => {
    const data = { data: [] }
    const result = unwrapOpenApiResult(
      { data, response: new Response('{}', { status: 200 }) },
      ENDPOINT,
      MorphoApiError
    )

    expect(result).toBe(data)
  })

  test('preserves status and cause for an error response', () => {
    const cause = { code: 'SERVICE_UNAVAILABLE' }

    try {
      unwrapOpenApiResult(
        { error: cause, response: new Response('{}', { status: 503 }) },
        ENDPOINT,
        MorphoApiError
      )
      throw new Error('expected unwrap to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(MorphoApiError)
      expect((error as MorphoApiError).status).toBe(503)
      expect((error as Error).cause).toBe(cause)
    }
  })

  test('wraps mapping and fetch exceptions', async () => {
    const cause = new Error('network down')

    await expect(
      withOpenApiErrorBoundary(ENDPOINT, MorphoApiError, async () => {
        throw cause
      })
    ).rejects.toMatchObject({
      name: 'MorphoApiError',
      endpoint: ENDPOINT,
      cause
    })
  })

  test('does not double-wrap a typed upstream error', async () => {
    const typed = new MorphoApiError({ endpoint: ENDPOINT, status: 500 })

    try {
      await withOpenApiErrorBoundary(ENDPOINT, MorphoApiError, async () => {
        throw typed
      })
      throw new Error('expected boundary to throw')
    } catch (error) {
      expect(error).toBe(typed)
    }
  })
})
