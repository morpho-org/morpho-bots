import createClient, { type Client } from 'openapi-fetch'

import type { components, paths } from '../generated/core-api'

/**
 * Client for the Morpho **core** API — a different service from the Midnight API the rest of this
 * bot talks to, with its own OpenAPI document (`bun run generate:core`), its own base URL, and
 * key-authenticated access (the docs' `x-api-key` header).
 */
export type CoreClient = Client<paths>

/** Its own timeout: a separate service from the Midnight API, with its own latency profile. */
export const CORE_REQUEST_TIMEOUT_MS = 5_000

/** ERC-20 identity as returned by `GET /v0/tokens/{chain_id}:{address}`. */
export type TokenResponse = components['schemas']['TokenRootResponse']['data']

type FetchLike = (request: Request) => Promise<Response>

type CoreClientOptions = {
  fetchImpl?: FetchLike
  /** Sent as `x-api-key` on every request when set. */
  apiKey?: string
}

export function createCoreClient(baseUrl: string, options: CoreClientOptions = {}): CoreClient {
  return createClient<paths>({
    baseUrl,
    fetch: options.fetchImpl ?? fetch,
    headers: options.apiKey ? { 'x-api-key': options.apiKey } : undefined
  })
}
