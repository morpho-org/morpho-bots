import type { Logger } from '@repo/bot-kit'

import { ensureError, tryCatch } from '@repo/utils'
import createClient, { type Client, type Middleware } from 'openapi-fetch'

import type { components, paths } from '../generated/midnight-api'

export type MidnightClient = Client<paths>

export type TransactionItem = components['schemas']['TransactionsResponse']['data'][number]

export type MidnightEventType = TransactionItem['event_type']

/** One market's book snapshot: market metadata plus the top ask/bid price levels. */
export type BookMarket = components['schemas']['BookCursorListResponse']['data'][number]

/** A single executable offer on one book side, with the signed offer payload attached. */
export type TakeableOffer = components['schemas']['ListBookTakeableOfferResponse']['data'][number]

export const REQUEST_TIMEOUT_MS = 5_000

/** Backstop on cursor-page walks so runaway pagination cannot stall a tick forever. */
export const MAX_PAGES = 20

/** Markets fetched in parallel per tick — bounded so 4 pollers stay polite to the alpha API. */
export const MARKET_CONCURRENCY = 8

type FetchLike = (request: Request) => Promise<Response>

type MidnightClientOptions = {
  fetchImpl?: FetchLike
  logger?: Logger
  /** Sent as `x-api-key` on every request when set. */
  apiKey?: string
  /**
   * Log a `midnight.response` line per response. Off by default because it costs a body clone +
   * parse per request; `PollingModule` enables it at LOG_LEVEL=debug. Request *failures* are
   * logged regardless — they matter most in production, where this is off.
   */
  verbose?: boolean
}

/** Shape shared by every list endpoint, used only to summarise a response without asserting it. */
type ListBody = { data?: unknown; cursor?: unknown }

/** Query strings can run to kilobytes (a 50-id `market_ids` batch), so cap what reaches a log. */
const MAX_LOGGED_QUERY = 200

/**
 * Logs responses and request failures. Every callback is wrapped in `tryCatch`: this middleware
 * runs inside the promise `fetchWithRetry` awaits, and that helper treats *any* throw as a
 * retryable network failure — so an error raised while logging would turn a successful 200 into
 * three phantom retries. Observability must never change a request's outcome.
 */
function responseLogger(logger: Logger, verbose: boolean): Middleware {
  return {
    async onResponse({ request, response, schemaPath }) {
      if (!verbose) return undefined
      await tryCatch(
        (async () => {
          const url = new URL(request.url)
          // `clone()` is mandatory: openapi-fetch does not clone for performance, so reading the
          // body here without it would consume the stream before the caller ever sees it.
          const body = (await response
            .clone()
            .json()
            .catch(() => null)) as ListBody | null
          logger.debug('midnight.response', {
            method: request.method,
            schemaPath,
            path: url.pathname,
            query: url.search.slice(1, MAX_LOGGED_QUERY) || null,
            status: response.status,
            // Item count rather than the payload: a takeable-offers page can carry 1000 offers,
            // and dumping those every tick would bury every other log line.
            items: Array.isArray(body?.data) ? body.data.length : null,
            cursor: typeof body?.cursor === 'string' ? body.cursor.slice(0, 12) : null
          })
        })()
      )
      return undefined
    },
    onError({ error, request }) {
      // Warn, and always attached — a network failure is the one thing worth seeing at the default
      // log level, so this must not be gated behind `verbose`.
      logger.warn('midnight.error', {
        method: request.method,
        path: new URL(request.url).pathname,
        error: ensureError(error).message
      })
      return undefined
    }
  }
}

export function createMidnightClient(
  baseUrl: string,
  options: MidnightClientOptions = {}
): MidnightClient {
  const client = createClient<paths>({
    baseUrl,
    fetch: options.fetchImpl ?? fetch,
    headers: options.apiKey ? { 'x-api-key': options.apiKey } : undefined
  })
  if (options.logger) client.use(responseLogger(options.logger, options.verbose ?? false))
  return client
}
