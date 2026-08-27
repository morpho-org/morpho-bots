import type { Logger } from '@repo/bot-kit'
import type { Address } from 'viem'

import { delay, fetchWithRetry, mulDivDown, tryCatch } from '@repo/utils'
import createClient from 'openapi-fetch'
import { getAddress, isAddress, parseUnits } from 'viem'

import type { paths } from '../generated/markets-api'

/** The `fetch` shape `openapi-fetch` calls — a single `Request`. The global `fetch` satisfies it. */
type FetchLike = (request: Request) => Promise<Response>

const REQUEST_TIMEOUT_MS = 5_000

/**
 * Fixed-point scale for USD figures: `1e8`, matching the `USD_PRICE_SCALE` the Blue profitability-gate
 * design settled on for this same endpoint, so the two can converge without a rescale.
 */
export const USD_PRICE_SCALE_DECIMALS = 8

/**
 * The tokens operation path — a literal key of the generated {@link paths}, so `client.GET(PATH)` is
 * type-checked against the spec. Shares a base with the liquidation-candidates endpoint, so the base
 * URL is derived from the configured candidates URL rather than a second env var: pointing the bot at
 * a staging host moves both endpoints together.
 */
const PATH = '/markets/midnight/tokens'

/** A token's price, normalized once at the API boundary so no float arithmetic survives it. */
type PricedToken = { priceE8: bigint; decimals: number }

type TokenPriceSource = {
  /**
   * USD value of `loanUnits` of `token`, scaled by `10 ** USD_PRICE_SCALE_DECIMALS`; `null` when the
   * token has no usable price or decimals in the last snapshot. Synchronous and side-effect free — it
   * reads the in-memory snapshot and never performs I/O, so a tick can call it per candidate without
   * adding latency.
   *
   * `null` means "unrankable", never "worthless": callers must order unpriced candidates last rather
   * than treating them as zero-value. This is a RANKING input only — the price is the API's latest
   * indexed value with no freshness guarantee, so it must not gate whether a liquidation is attempted.
   */
  usdValueOf: (token: Address, loanUnits: bigint) => bigint | null
  /**
   * Refetches the snapshot. **Contractually non-throwing**: an API failure is reported as
   * `prices.refresh_failed` and the previous snapshot is retained, because ranking degrades to
   * discovery order rather than failing closed. Callers therefore never need to handle a rejection.
   */
  refresh: () => Promise<void>
  snapshot: () => { source: string; tokens: number; updatedAt: number | null }
}

// A JSON-number USD price converted to 1e8 fixed point, or null when it carries no usable precision.
// `toFixed` first so viem never sees exponential notation (which `parseUnits` rejects) and no float
// multiply happens; a price below 1e-8 rounds to zero, which is absence of precision rather than a
// zero valuation, so it reads as unpriced.
const toPriceE8 = (usd: number): bigint | null => {
  if (!Number.isFinite(usd) || usd <= 0) return null
  const scaled = parseUnits(usd.toFixed(USD_PRICE_SCALE_DECIMALS), USD_PRICE_SCALE_DECIMALS)
  return scaled > 0n ? scaled : null
}

// ERC-20 decimals are nullable in the spec and unbounded in principle; 36 is far above any real token
// and keeps `10n ** decimals` from becoming an absurd bigint on a malformed row.
const MAX_TOKEN_DECIMALS = 36

/**
 * Builds a {@link TokenPriceSource} over `GET /markets/midnight/tokens`, via a typed `openapi-fetch`
 * client generated from the Markets API spec — the same spec `discovery/borrowers.ts` consumes.
 * Mirrors {@link createListedMarketFilter}: last-known-good on failure, `fetchWithRetry`'s
 * 429/5xx/network policy, a {@link REQUEST_TIMEOUT_MS} deadline, and injectable
 * `fetchImpl`/`sleep`/`now` for tests.
 *
 * Deliberately has **no max-age ceiling**, unlike the listed-markets whitelist. A stale whitelist is a
 * safety problem — it can keep a delisted market in scope — whereas a stale price only misorders work,
 * so this fails **open** and `snapshot().updatedAt` makes the age observable instead.
 *
 * Queried by `chain_ids` alone: not by `markets` (its 100-id cap is a truncation risk and it would
 * couple pricing to the whitelist) and not by `listed` (the whitelist already decides which markets
 * are acted on). Token cardinality is small and the response is unpaginated.
 */
export const createTokenPriceSource = (deps: {
  /** The configured liquidation-candidates URL; only its base is used. */
  apiUrl: string
  chainId: number
  logger: Logger
  fetchImpl?: FetchLike
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}): TokenPriceSource => {
  const sleep = deps.sleep ?? delay
  const now = deps.now ?? (() => Date.now())
  const url = new URL(deps.apiUrl)
  const baseUrl = deps.apiUrl.endsWith(PATH) ? deps.apiUrl.slice(0, -PATH.length) : url.origin
  const client = createClient<paths>({ baseUrl, fetch: deps.fetchImpl ?? fetch })
  // Host + path only; the query string is excluded so nothing can ride along into a log line.
  const source = `${url.host}${PATH}`

  // Last-known-good: replaced only by a fully-successful refresh. Keyed by checksummed address so a
  // lookup cannot miss on casing.
  let priced = new Map<Address, PricedToken>()
  let updatedAt: number | null = null

  const fetchTokens = async () => {
    const body = await fetchWithRetry(
      () =>
        client.GET(PATH, {
          params: { query: { chain_ids: [deps.chainId] } },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        }),
      { label: 'tokens', sleep }
    )
    return Array.isArray(body.data) ? body.data : []
  }

  const refresh = async () => {
    // Validation runs strictly AFTER the fetch: `fetchWithRetry` treats every throw from its callback
    // as retryable, so a parse error inside it would be retried as though it were a network blip.
    const fetched = await tryCatch(fetchTokens())
    if (fetched.error) {
      deps.logger.warn('prices.refresh_failed', {
        chainId: deps.chainId,
        source,
        detail: fetched.error.message
      })
      return
    }

    const next = new Map<Address, PricedToken>()
    for (const token of fetched.data) {
      if (token.chain_id !== deps.chainId) continue
      if (typeof token.address !== 'string' || !isAddress(token.address, { strict: false }))
        continue
      const { decimals } = token
      if (
        typeof decimals !== 'number' ||
        !Number.isInteger(decimals) ||
        decimals < 0 ||
        decimals > MAX_TOKEN_DECIMALS
      ) {
        continue
      }
      const priceE8 = token.price ? toPriceE8(token.price.usd) : null
      if (priceE8 === null) continue
      next.set(getAddress(token.address), { priceE8, decimals })
    }

    // A successful-but-empty response is not a transient failure, so it legitimately replaces
    // last-known-good — but it silently un-ranks every candidate. Schema drift looks exactly like this,
    // so a nonempty→empty transition is called out rather than left to be inferred from a count.
    if (priced.size > 0 && next.size === 0) {
      deps.logger.warn('prices.tokens_empty', {
        chainId: deps.chainId,
        source,
        previous: priced.size,
        detail: 'tokens source returned zero usable prices where it previously returned some'
      })
    }
    priced = next
    updatedAt = now()
    deps.logger.info('prices.tokens', { chainId: deps.chainId, source, tokens: priced.size })
  }

  return {
    usdValueOf: (token, loanUnits) => {
      const entry = priced.get(getAddress(token))
      if (!entry) return null
      return mulDivDown(loanUnits, entry.priceE8, 10n ** BigInt(entry.decimals))
    },
    refresh,
    snapshot: () => ({ source, tokens: priced.size, updatedAt })
  }
}
