import createClient, { type Client } from 'openapi-fetch'

import type { components, paths } from '../generated/core-api'

/**
 * Client for the Morpho **core** API — a different service from the Midnight API the rest of this
 * bot talks to, with its own OpenAPI document (`bun run generate:core`) and its own base URL.
 * Midnight exposes token addresses but no ERC-20 identity, so decimals and symbols come from here.
 */
export type CoreClient = Client<paths>

/** Its own timeout: a separate service from the Midnight API, with its own latency profile. */
export const CORE_REQUEST_TIMEOUT_MS = 5_000

/** ERC-20 identity as returned by `GET /v0/tokens/{chain_id}:{address}`. */
export type TokenResponse = components['schemas']['TokenRootResponse']['data']

export function createCoreClient(baseUrl: string, fetchImpl?: typeof fetch): CoreClient {
  return createClient<paths>({ baseUrl, fetch: fetchImpl })
}
