import { isAddress, isAddressEqual } from 'viem'

import type { SafeProviderFailure } from './safe-provider.error'
import type {
  BookSetup,
  SetupCheck,
  SetupCheckConfig,
  SetupRemediation
} from './setup-check.service'

import { BASE_CHAIN_ID } from '../../config/config.utils'
import { SafeProviderError } from './safe-provider.error'

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
const SAFE_PROVIDER_IDS = new Set(['provider', 'rpc', 'archive-rpc', 'morpho-api', 'router-api'])

/** Fulfilled provider value or sanitized provider failure captured without short-circuiting peers. */
type Captured<T> = { ok: true; value: T } | { ok: false; error: SafeProviderFailure }

type SafeSignerFailure = {
  kind: 'signer-error'
  operation: 'maker-address' | 'keystore-read' | 'keystore-decrypt' | 'kms-public-key' | 'kms-sign'
}

const SAFE_SIGNER_OPERATIONS = new Set<SafeSignerFailure['operation']>([
  'maker-address',
  'keystore-read',
  'keystore-decrypt',
  'kms-public-key',
  'kms-sign'
])

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
export const capture = async <T>(
  read: () => Promise<T>,
  provider: SafeProviderFailure['provider'] = 'rpc'
): Promise<Captured<T>> => {
  try {
    return { ok: true, value: await read() }
  } catch (error) {
    return { ok: false, error: safeProviderFailure(error, provider) }
  }
}

/**
 * Captures signer derivation while preserving only an allowlisted signer operation.
 * @param read - Deferred signer-address derivation.
 * @returns A fulfilled capture containing the value, a sanitized signer operation, or a sanitized
 * RPC-shaped fallback for an unexpected rejection.
 * @throws Never; synchronous throws and promise rejections are converted to failure values.
 */
export const captureSigner = async <T>(
  read: () => Promise<T>
): Promise<
  { ok: true; value: T } | { ok: false; error: SafeSignerFailure | SafeProviderFailure }
> => {
  try {
    return { ok: true, value: await read() }
  } catch (error) {
    const candidate =
      typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : undefined
    if (
      candidate?.name === 'MakerAccountError' &&
      typeof candidate.operation === 'string' &&
      SAFE_SIGNER_OPERATIONS.has(candidate.operation as SafeSignerFailure['operation'])
    ) {
      return {
        ok: false,
        error: {
          kind: 'signer-error',
          operation: candidate.operation as SafeSignerFailure['operation']
        }
      }
    }
    return { ok: false, error: safeProviderFailure(error, 'rpc') }
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

/**
 * Builds the signer-identity check skipped by address-only read-only operation.
 * @returns A not-required maker identity check.
 * @remarks No provider reads, signing, or mutation side effects occur.
 */
export const readOnlyMakerCheck = (): SetupCheck => ({
  name: 'maker',
  status: 'not-required',
  observed: 'configured',
  required: 'maker address retained outside operator output'
})

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
  const deployed = midnightCode.value !== undefined && midnightCode.value !== '0x'
  const observed = {
    configured: config.chainId,
    connected: chainId.value,
    midnightCode: deployed ? 'deployed' : 'missing'
  }
  const ready = config.chainId === BASE_CHAIN_ID && chainId.value === BASE_CHAIN_ID && deployed
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
