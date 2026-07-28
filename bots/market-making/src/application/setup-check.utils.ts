import { isAddress, isAddressEqual } from 'viem'

import type { SafeProviderFailure } from './safe-provider.error'
import type {
  BookSetup,
  SetupCheck,
  SetupCheckConfig,
  SetupRemediation
} from './setup-check.service'

import { SafeProviderError } from './safe-provider.error'

const BASE_CHAIN_ID = 8453
const SAFE_ERROR_NAMES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'AbortError',
  'TimeoutError',
  'NetworkError',
  'HttpError',
  'ProviderError'
])
const SAFE_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'ETIMEDOUT',
  'ABORT_ERR',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT'
])
const SAFE_PROVIDER_IDS = new Set(['rpc', 'archive-rpc', 'morpho-api', 'router-api'])

/** Fulfilled provider value or sanitized provider failure captured without short-circuiting peers. */
type Captured<T> = { ok: true; value: T } | { ok: false; error: SafeProviderFailure }

const safeProviderFailure = (
  error: unknown,
  provider: SafeProviderFailure['provider']
): SafeProviderFailure => {
  const errorRecord =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : undefined
  const typedFailure =
    error instanceof SafeProviderError
      ? error.failure
      : typeof errorRecord?.failure === 'object' && errorRecord.failure !== null
        ? (errorRecord.failure as Record<string, unknown>)
        : undefined
  if (typedFailure) {
    const safeProvider =
      typeof typedFailure.provider === 'string' && SAFE_PROVIDER_IDS.has(typedFailure.provider)
        ? (typedFailure.provider as SafeProviderFailure['provider'])
        : provider
    const name =
      typeof typedFailure.name === 'string' && SAFE_ERROR_NAMES.has(typedFailure.name)
        ? typedFailure.name
        : 'ProviderError'
    const code =
      typedFailure.code === 'REQUEST_TIMEOUT' ||
      (typeof typedFailure.code === 'string' && SAFE_ERROR_CODES.has(typedFailure.code))
        ? typedFailure.code
        : undefined
    const status = Number.isSafeInteger(typedFailure.status)
      ? (typedFailure.status as number)
      : undefined
    const context =
      typedFailure.context === 'request' || typedFailure.context === 'read'
        ? typedFailure.context
        : undefined
    return {
      kind: 'provider-error',
      provider: safeProvider,
      name,
      ...(code ? { code } : {}),
      ...(status ? { status } : {}),
      ...(context ? { context } : {})
    }
  }
  const candidate = errorRecord
  const name =
    typeof candidate?.name === 'string' && SAFE_ERROR_NAMES.has(candidate.name)
      ? candidate.name
      : 'ProviderError'
  const code =
    typeof candidate?.code === 'string' && SAFE_ERROR_CODES.has(candidate.code)
      ? candidate.code
      : undefined
  const status =
    typeof candidate?.status === 'number' && Number.isSafeInteger(candidate.status)
      ? candidate.status
      : undefined
  return {
    kind: 'provider-error',
    provider,
    name,
    ...(code ? { code } : {}),
    ...(status ? { status } : {}),
    context: 'read'
  }
}

/**
 * Captures one provider read as a sanitized success/failure union.
 * @param read - Deferred provider operation.
 * @param provider - Stable provider identifier used when sanitizing rejection metadata.
 * @returns A promise that always fulfills with the captured result.
 * @throws Never; synchronous throws and promise rejections are converted to failure values.
 */
export const capture = <T>(
  read: () => Promise<T>,
  provider: SafeProviderFailure['provider'] = 'rpc'
): Promise<Captured<T>> => {
  try {
    return read().then(
      value => ({ ok: true, value }),
      error => ({ ok: false, error: safeProviderFailure(error, provider) })
    )
  } catch (error) {
    return Promise.resolve({ ok: false, error: safeProviderFailure(error, provider) })
  }
}

/**
 * Compares two validated-or-untrusted address strings with viem checksum semantics.
 * @param left - First address candidate.
 * @param right - Second address candidate.
 * @returns Whether both values are valid EVM addresses representing the same account.
 */
export const sameAddress = (left: string, right: string) =>
  isAddress(left) && isAddress(right) && isAddressEqual(left, right)

/**
 * Builds one stable setup-check result and emits remediation only for failures.
 * @param name - Stable setup check name.
 * @param passed - Whether the observed requirement passed.
 * @param observed - Sanitized observed value.
 * @param required - Expected value or invariant.
 * @param remediation - Optional read-only operator instruction.
 * @returns A normalized setup-check entry.
 */
export const setupResult = (
  name: SetupCheck['name'],
  passed: boolean,
  observed: unknown,
  required: unknown,
  remediation?: SetupRemediation
): SetupCheck => ({
  name,
  status: passed ? 'passed' : 'failed',
  observed,
  required,
  ...(passed || !remediation ? {} : { remediation })
})

/**
 * Builds a failed check from sanitized provider metadata.
 * @param name - Stable setup check name.
 * @param error - Sanitized provider failure.
 * @param required - Expected value or invariant.
 * @returns A failed setup-check entry.
 */
export const providerFailure = (
  name: SetupCheck['name'],
  error: SafeProviderFailure,
  required: unknown
) => setupResult(name, false, { error }, required)

const bookProblems = (
  requestedId: `0x${string}`,
  book: BookSetup,
  config: SetupCheckConfig,
  latestTimestamp: bigint
) => {
  const reasons: unknown[] = []
  if (book.id !== requestedId) reasons.push(`provider returned ${book.id}`)
  if (!book.allowlisted) reasons.push('not allowlisted')
  if (!book.active) reasons.push('inactive')
  if (!sameAddress(book.loanAsset, config.loanAsset)) {
    reasons.push(`unexpected loan asset ${book.loanAsset}`)
  }
  if (book.tickSpacing <= 0) reasons.push('tick spacing is inaccessible')
  if (book.maturity <= latestTimestamp) reasons.push(`matured at ${book.maturity}`)
  return { id: requestedId, reasons }
}

/**
 * Evaluates chain identity and Midnight deployment bytecode without performing writes.
 * @param config - Validated setup requirements.
 * @param chainId - Captured connected-chain response.
 * @param midnightCode - Captured Midnight runtime bytecode.
 * @returns The normalized chain setup check.
 */
export const chainCheck = (
  config: SetupCheckConfig,
  chainId: Captured<number>,
  midnightCode: Captured<`0x${string}` | undefined>
) => {
  const required = { chainId: BASE_CHAIN_ID, midnightCode: 'deployed' }
  if (!chainId.ok) return providerFailure('chain', chainId.error, required)
  if (!midnightCode.ok) return providerFailure('chain', midnightCode.error, required)
  const observed = {
    configured: config.chainId,
    connected: chainId.value,
    midnightCode: midnightCode.value
  }
  const ready =
    config.chainId === BASE_CHAIN_ID &&
    chainId.value === BASE_CHAIN_ID &&
    midnightCode.value !== undefined &&
    midnightCode.value !== '0x'
  return setupResult('chain', ready, observed, required)
}

/**
 * Evaluates all configured books from already-concurrent captured reads without writes.
 * @param config - Validated market requirements.
 * @param timestamp - Captured latest block timestamp.
 * @param books - Captured per-market API/chain observations.
 * @returns The normalized aggregate books check.
 */
export const booksCheck = (
  config: SetupCheckConfig,
  timestamp: Captured<bigint>,
  books: readonly { requestedId: `0x${string}`; response: Captured<BookSetup> }[]
) => {
  const required = 'all configured books valid'
  if (config.marketIds.length === 0) {
    return setupResult(
      'books',
      false,
      [{ id: '(none)', reasons: ['no markets configured'] }],
      required
    )
  }
  const invalidBooks = books.flatMap(({ requestedId, response }) => {
    if (!response.ok) return [{ id: requestedId, reasons: [{ providerError: response.error }] }]
    if (!timestamp.ok) {
      return [{ id: requestedId, reasons: [{ timestampProviderError: timestamp.error }] }]
    }
    const problem = bookProblems(requestedId, response.value, config, timestamp.value)
    return problem.reasons.length === 0 ? [] : [problem]
  })
  return setupResult('books', invalidBooks.length === 0, invalidBooks, required)
}
