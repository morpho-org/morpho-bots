import { SafeProviderError } from '../../application/safe-provider.error'

/** Stable HTTP provider identifiers safe to include in reports. */
export type ProviderId = 'morpho-api' | 'router-api'
/** Injectable read-only JSON transport used by the setup-state adapter. */
export type JsonRequest = (
  url: string,
  provider: ProviderId,
  timeoutMs?: number
) => Promise<unknown>

/**
 * Fetches and decodes JSON under a per-request timeout while redacting unsafe failure details.
 * @param url - Provider endpoint; it is used for the request but never copied into thrown metadata.
 * @param provider - Fixed provider identifier safe for reports.
 * @param timeoutMs - Abort timeout in milliseconds, defaulting to 10 seconds.
 * @returns Parsed JSON response value.
 * @throws `SafeProviderError` with allowlisted provider/status/context metadata on HTTP,
 * timeout, network, or JSON failures; raw URLs and response bodies are not exposed.
 * @remarks Performs one read-only HTTP GET and has no chain or filesystem side effects.
 */
export const requestJson = async (url: string, provider: ProviderId, timeoutMs = 10_000) => {
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal })
    if (!response.ok) {
      throw new SafeProviderError({
        kind: 'provider-error',
        provider,
        name: 'HttpError',
        status: response.status,
        context: 'request'
      })
    }
    return await response.json()
  } catch (error) {
    if (error instanceof SafeProviderError) throw error
    throw new SafeProviderError({
      kind: 'provider-error',
      provider,
      name: signal.aborted ? 'TimeoutError' : 'NetworkError',
      ...(signal.aborted ? { code: 'REQUEST_TIMEOUT' } : {}),
      context: 'request'
    })
  }
}

/**
 * Adapts the JSON transport for the SDK books endpoint while requiring curated listing evidence.
 * @param request - Existing provider-safe JSON transport.
 * @param timeoutMs - Explicit per-request timeout passed to the transport.
 * @returns A fetch-compatible function that requests the API's `listed=true` trust-layer filter.
 * @throws The transport's sanitized provider error when the filtered request fails.
 * @remarks The Midnight SDK continues to own endpoint construction and book mapping; this adapter
 * only adds the API's curated-listing filter before SDK mapping.
 */
export const listedBooksJsonRequestFetch = (
  request: JsonRequest,
  timeoutMs: number
): typeof fetch => {
  const adapter = async (input: Parameters<typeof fetch>[0]) => {
    const inputUrl = input instanceof Request ? input.url : String(input)
    const url = new URL(inputUrl)
    url.searchParams.set('listed', 'true')
    const value = await request(url.toString(), 'morpho-api', timeoutMs)
    return Response.json(value)
  }
  return Object.assign(adapter, { preconnect: fetch.preconnect })
}
