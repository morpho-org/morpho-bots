import type { SafeProviderFailure } from '../../application/setup/safe-provider.error'
import type { ProviderId, ProviderOperation } from './provider-read.error'

import { SafeProviderError } from '../../application/setup/safe-provider.error'
import { ProviderReadError } from './provider-read.error'
import { ProviderResponseError } from './provider-response.error'

type CapturedTimeout<Result> =
  | { ok: true; value: Result }
  | { ok: false; error: SafeProviderFailure }

const isTimeoutError = (value: unknown) => {
  let current = value
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return false
    try {
      if ('name' in current && current.name === 'TimeoutError') return true
      current = 'cause' in current ? current.cause : undefined
    } catch {
      return false
    }
  }
  return false
}

/**
 * Executes one provider read and replaces unknown rejection data with safe fixed metadata.
 * @param provider - Fixed provider identifier suitable for operator-visible reports.
 * @param operation - Stable operation code containing no request or response data.
 * @param read - Deferred third-party read to execute.
 * @returns The provider result when the read succeeds.
 * @throws `ProviderReadError` without retaining a raw message, URL, body, stack, or cause.
 */
export const executeProviderRead = async <Result>(
  provider: ProviderId,
  operation: ProviderOperation,
  read: () => Promise<Result>
): Promise<Result> => {
  try {
    return await read()
  } catch (error) {
    if (error instanceof SafeProviderError || error instanceof ProviderResponseError) throw error
    throw new ProviderReadError(
      provider,
      operation,
      isTimeoutError(error) ? 'REQUEST_TIMEOUT' : 'PROVIDER_READ_FAILED'
    )
  }
}

/**
 * Captures only sanitized provider request timeouts while preserving every other rejection.
 * @param read - Deferred provider read whose timeout may be retained as partial setup evidence.
 * @returns The successful result or its sanitized `REQUEST_TIMEOUT` failure.
 * @throws The original rejection when it is not a recognized provider request timeout.
 */
export const captureRequestTimeout = async <Result>(
  read: () => Promise<Result>
): Promise<CapturedTimeout<Result>> => {
  try {
    return { ok: true, value: await read() }
  } catch (error) {
    const failure =
      error instanceof ProviderReadError
        ? error.failure
        : error instanceof SafeProviderError
          ? error.failure
          : undefined
    if (failure?.code !== 'REQUEST_TIMEOUT') throw error
    return { ok: false, error: failure as SafeProviderFailure }
  }
}
