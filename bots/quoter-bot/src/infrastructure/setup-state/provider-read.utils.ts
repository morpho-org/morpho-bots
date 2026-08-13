import type { ProviderId, ProviderOperation, SafeProviderReadMetadata } from './provider-read.error'

import { SafeProviderError } from '../../application/setup/safe-provider.error'
import { ProviderReadError } from './provider-read.error'
import { ProviderResponseError } from './provider-response.error'

const SAFE_NAMES = new Set<NonNullable<SafeProviderReadMetadata['name']>>([
  'AbortError',
  'TimeoutError',
  'NetworkError',
  'HttpError'
])
const SAFE_CODES = new Set<NonNullable<SafeProviderReadMetadata['code']>>([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'ETIMEDOUT',
  'ABORT_ERR',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT'
])
const JSON_RPC_SERVER_ERROR_MINIMUM = -32_099
const JSON_RPC_SERVER_ERROR_MAXIMUM = -32_000

const isSafeNumericRpcCode = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= JSON_RPC_SERVER_ERROR_MINIMUM &&
  value <= JSON_RPC_SERVER_ERROR_MAXIMUM

const safeReadMetadata = (error: unknown): SafeProviderReadMetadata => {
  let candidate = error
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof candidate !== 'object' || candidate === null) break
    const record = candidate as Record<string, unknown>
    const name =
      typeof record.name === 'string' &&
      SAFE_NAMES.has(record.name as NonNullable<SafeProviderReadMetadata['name']>)
        ? (record.name as NonNullable<SafeProviderReadMetadata['name']>)
        : undefined
    const code =
      (typeof record.code === 'string' &&
        SAFE_CODES.has(record.code as NonNullable<SafeProviderReadMetadata['code']>)) ||
      isSafeNumericRpcCode(record.code)
        ? (record.code as NonNullable<SafeProviderReadMetadata['code']>)
        : undefined
    const status =
      typeof record.status === 'number' && Number.isSafeInteger(record.status)
        ? record.status
        : undefined
    if (name || code || status !== undefined) {
      return {
        ...(name ? { name } : {}),
        ...(code ? { code } : {}),
        ...(status === undefined ? {} : { status })
      }
    }
    candidate = record.cause
  }
  return {}
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
    throw new ProviderReadError(provider, operation, safeReadMetadata(error))
  }
}
