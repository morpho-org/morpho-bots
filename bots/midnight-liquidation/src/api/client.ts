import type { Result } from '@repo/utils'

import { tryCatch } from '@repo/utils'
import createClient from 'openapi-fetch'

import type { components, paths } from './generated'

const USER_AGENT = 'midnight-liquidation/0.1.0'

/** Typed openapi-fetch client bound to the Midnight API's generated `paths`. */
export function createApiClient(baseUrl: string) {
  return createClient<paths>({
    baseUrl,
    headers: { 'User-Agent': USER_AGENT }
  })
}

export type MidnightApiClient = ReturnType<typeof createApiClient>

/** Normalized failure modes for a single Midnight API call. */
export type MidnightApiError =
  | {
      kind: 'api'
      status: number
      code: string
      message: string
      requestId: string
      details: unknown
    }
  | { kind: 'malformed'; status: number; message: string }
  | { kind: 'network'; message: string }

type ErrorEnvelope = components['schemas']['ErrorResponseDto']

// One openapi-fetch call result: the typed 2xx body in `data`, the typed error body in `error`,
// and the raw Response. `client.GET`/`.POST`/… all resolve to this shape.
type FetchOutcome<T> = { data?: T; error?: unknown; response: Response }

function asErrorEnvelope(value: unknown): ErrorEnvelope['error'] | null {
  if (typeof value !== 'object' || value === null || !('error' in value)) return null
  const inner = (value as { error: unknown }).error
  if (typeof inner !== 'object' || inner === null) return null
  const { code, message } = inner as Record<string, unknown>
  if (typeof code !== 'string' || typeof message !== 'string') return null
  return inner as ErrorEnvelope['error']
}

/**
 * Wraps one openapi-fetch call into a single {@link Result}, normalizing the `{ data, error,
 * response }` triple — and any thrown network/parse error — into a typed success or a
 * {@link MidnightApiError}. A non-JSON upstream response (e.g. an HTML 502 page) surfaces as
 * `malformed` rather than a silent success. Callers pass the typed call as a thunk:
 * `apiCall(() => client.GET('/v1/midnight/positions', { params }))`.
 */
export async function apiCall<T>(
  call: () => Promise<FetchOutcome<T>>
): Promise<Result<T, MidnightApiError>> {
  const settled = await tryCatch(call())
  if (settled.error) {
    return { data: null, error: { kind: 'network', message: settled.error.message } }
  }

  const { data, error, response } = settled.data
  if (data !== undefined) return { data, error: null }

  const envelope = asErrorEnvelope(error)
  if (envelope) {
    return {
      data: null,
      error: {
        kind: 'api',
        status: response.status,
        code: envelope.code,
        message: envelope.message,
        requestId: envelope.request_id,
        details: envelope.details
      }
    }
  }

  return {
    data: null,
    error: {
      kind: 'malformed',
      status: response.status,
      message: `Unexpected ${response.status} response (non-JSON or unrecognized error shape)`
    }
  }
}
