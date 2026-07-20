import createClient, { type Client } from 'openapi-fetch'

import type { components, paths } from '../generated/midnight-api'

export type MidnightClient = Client<paths>

export type TransactionItem = components['schemas']['TransactionsResponse']['data'][number]

export type MidnightEventType = TransactionItem['event_type']

export const REQUEST_TIMEOUT_MS = 5_000

/** Backstop on cursor-page walks so runaway pagination cannot stall a tick forever. */
export const MAX_PAGES = 20

/** Markets fetched in parallel per tick — bounded so 4 pollers stay polite to the alpha API. */
export const MARKET_CONCURRENCY = 8

type FetchLike = (request: Request) => Promise<Response>

export function createMidnightClient(baseUrl: string, fetchImpl?: FetchLike): MidnightClient {
  return createClient<paths>({ baseUrl, fetch: fetchImpl ?? fetch })
}
