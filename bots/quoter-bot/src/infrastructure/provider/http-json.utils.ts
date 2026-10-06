import { SafeProviderError } from '../../application/setup/safe-provider.error'
import { retryTransientProviderRead } from './provider-retry.utils'

/** Stable HTTP provider identifiers safe to include in reports. */
export type ProviderId = 'morpho-api' | 'router-api'
/** Injectable read-only JSON transport used by the setup-state adapter. */
export type JsonRequest = (
  url: string,
  provider: ProviderId,
  timeoutMs?: number
) => Promise<unknown>

const attemptJson = async (url: string, provider: ProviderId, timeoutMs: number) => {
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
 * Fetches and decodes JSON under a per-attempt timeout while redacting unsafe failure details.
 * @param url - Provider endpoint; it is used for the request but never copied into thrown metadata.
 * @param provider - Fixed provider identifier safe for reports.
 * @param timeoutMs - Abort timeout applied to each attempt, defaulting to 10 seconds.
 * @returns Parsed JSON response value.
 * @throws `SafeProviderError` with allowlisted provider/status/context metadata on HTTP,
 * timeout, network, or JSON failures; raw URLs and response bodies are not exposed.
 * @remarks Performs read-only HTTP GETs and has no chain or filesystem side effects, so transient
 * failures are retried by {@link retryTransientProviderRead} before the error reaches the caller.
 */
export const requestJson = async (url: string, provider: ProviderId, timeoutMs = 10_000) =>
  retryTransientProviderRead(
    remainingMs => attemptJson(url, provider, remainingMs ?? timeoutMs),
    timeoutMs
  )
