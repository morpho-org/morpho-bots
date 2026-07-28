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
 * Adapts the sanitized JSON transport to an SDK-compatible fetch implementation.
 * @param request - Existing provider-safe JSON transport.
 * @param provider - Fixed provider identifier used for sanitized failures.
 * @param timeoutMs - Explicit per-request timeout passed to the transport.
 * @returns A fetch-compatible function for SDK endpoint and response mapping reuse.
 * @throws The transport's sanitized provider error when the request fails.
 * @remarks The SDK still owns URL construction and mapping; this adapter only preserves the bot's
 * timeout and redaction boundary. It performs no request until the returned function is called.
 */
export const jsonRequestFetch = (
  request: JsonRequest,
  provider: ProviderId,
  timeoutMs: number
): typeof fetch => {
  const adapter = async (input: Parameters<typeof fetch>[0]) => {
    const url = input instanceof Request ? input.url : String(input)
    const value = await request(url, provider, timeoutMs)
    return Response.json(value)
  }
  return Object.assign(adapter, { preconnect: fetch.preconnect })
}
