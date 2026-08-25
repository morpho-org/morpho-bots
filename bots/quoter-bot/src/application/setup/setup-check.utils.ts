import { isAddress, isAddressEqual } from 'viem'

import type { SafeProviderFailure } from './safe-provider.error'
import type {
  BookSetup,
  SetupCheck,
  SetupCheckConfig,
  SetupCheckReport,
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
const TRANSIENT_PROVIDER_CODES = new Set([
  'REQUEST_TIMEOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'ETIMEDOUT',
  'ABORT_ERR',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT'
])
const TRANSIENT_PROVIDER_NAMES = new Set(['AbortError', 'TimeoutError', 'NetworkError'])
const TRANSIENT_PROVIDER_STATUSES = new Set([408, 425, 429])
const SERVER_ERROR_STATUS_MINIMUM = 500
const SERVER_ERROR_STATUS_MAXIMUM = 599
const TRANSIENT_JSON_RPC_CODES = new Set([
  -32_005, // Limit exceeded.
  -32_002 // Resource unavailable.
])

const isTransientRpcCode = (value: unknown): value is number =>
  typeof value === 'number' && TRANSIENT_JSON_RPC_CODES.has(value)

/** Fulfilled provider value or sanitized provider failure captured without short-circuiting peers. */
type Captured<T> = { ok: true; value: T } | { ok: false; error: SafeProviderFailure }

type SafeSignerFailure = {
  kind: 'signer-error'
  operation:
    | 'maker-address'
    | 'keystore-read'
    | 'keystore-decrypt'
    | 'kms-public-key'
    | 'kms-sign'
    | 'middleware-unsupported'
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
      (typeof typedFailure.code === 'string' && SAFE_ERROR_CODES.has(typedFailure.code)) ||
      isTransientRpcCode(typedFailure.code)
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
 * @returns A fulfilled capture containing the value, a sanitized signer operation — including the
 * fixed `middleware-unsupported` observation for the fail-closed middleware identity — or a
 * sanitized RPC-shaped fallback for an unexpected rejection.
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
    if (candidate?.name === 'MiddlewareSigningUnsupportedError') {
      return { ok: false, error: { kind: 'signer-error', operation: 'middleware-unsupported' } }
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isTransientProviderFailure = (value: unknown) => {
  if (!isRecord(value) || value.kind !== 'provider-error') return false

  const transientCode =
    (typeof value.code === 'string' && TRANSIENT_PROVIDER_CODES.has(value.code)) ||
    isTransientRpcCode(value.code)
  const transientName = typeof value.name === 'string' && TRANSIENT_PROVIDER_NAMES.has(value.name)
  const transientStatus =
    typeof value.status === 'number' &&
    (TRANSIENT_PROVIDER_STATUSES.has(value.status) ||
      (value.status >= SERVER_ERROR_STATUS_MINIMUM && value.status <= SERVER_ERROR_STATUS_MAXIMUM))

  return transientCode || transientName || transientStatus
}

const isTransientFailedCheck = (check: SetupCheck) => {
  if (check.status !== 'failed') return true

  if (check.name === 'chain') {
    if (!isRecord(check.observed) || !Array.isArray(check.observed.errors)) return false
    const configuredMatches = check.observed.configured === BASE_CHAIN_ID
    const connectedMatches =
      check.observed.connected === undefined || check.observed.connected === BASE_CHAIN_ID
    const deploymentMatches =
      check.observed.midnightCode === undefined || check.observed.midnightCode === 'deployed'
    return (
      configuredMatches &&
      connectedMatches &&
      deploymentMatches &&
      check.observed.errors.length > 0 &&
      check.observed.errors.every(isTransientProviderFailure)
    )
  }

  if (check.name === 'books') {
    return (
      Array.isArray(check.observed) &&
      check.observed.length > 0 &&
      check.observed.every(
        book =>
          isRecord(book) &&
          Array.isArray(book.reasons) &&
          book.reasons.length > 0 &&
          book.reasons.every(
            reason =>
              isRecord(reason) &&
              Object.keys(reason).length === 1 &&
              isTransientProviderFailure(reason.timestampProviderError)
          )
      )
    )
  }

  // Compound checks can mask a successful peer read that already proved invariant drift, so they
  // fail closed instead of retrying based only on their provider error.
  if (check.name === 'ratifier' || check.name === 'reference' || check.name === 'offers') {
    return false
  }

  return isRecord(check.observed) && isTransientProviderFailure(check.observed.error)
}

/**
 * Identifies a failed readiness report caused exclusively by explicitly transient provider errors.
 * @param report - Complete sanitized setup-check report.
 * @returns Whether every failed check is a timeout, network failure, rate limit, or server error.
 * @remarks Unknown provider failures and mixed provider/invariant failures remain fail-closed.
 */
export const hasOnlyTransientProviderFailures = (report: SetupCheckReport) =>
  !report.ready && report.checks.every(isTransientFailedCheck)

const bookProblems = (
  requestedId: `0x${string}`,
  book: BookSetup,
  config: SetupCheckConfig,
  latestTimestamp?: bigint
) => {
  const reasons: unknown[] = []
  if (book.id !== requestedId) reasons.push(`provider returned ${book.id}`)
  if (!book.allowlisted) reasons.push('not allowlisted')
  if (!book.active) reasons.push('inactive')
  if (!sameAddress(book.loanAsset, config.loanAsset)) {
    reasons.push(`unexpected loan asset ${book.loanAsset}`)
  }
  if (book.tickSpacing <= 0) reasons.push('tick spacing is inaccessible')
  if (latestTimestamp !== undefined && book.maturity <= latestTimestamp) {
    reasons.push(`matured at ${book.maturity}`)
  }
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
  const deployed = midnightCode.ok
    ? midnightCode.value !== undefined && midnightCode.value !== '0x'
    : undefined
  const errors = [
    ...(!chainId.ok ? [chainId.error] : []),
    ...(!midnightCode.ok ? [midnightCode.error] : [])
  ]
  const observed = {
    configured: config.chainId,
    ...(chainId.ok ? { connected: chainId.value } : {}),
    ...(deployed === undefined ? {} : { midnightCode: deployed ? 'deployed' : 'missing' }),
    ...(errors.length === 0 ? {} : { errors })
  }
  const ready =
    errors.length === 0 &&
    config.chainId === BASE_CHAIN_ID &&
    chainId.ok &&
    chainId.value === BASE_CHAIN_ID &&
    deployed === true
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
    const problem = !response.ok
      ? { id: requestedId, reasons: [{ providerError: response.error }] as unknown[] }
      : bookProblems(
          requestedId,
          response.value,
          config,
          timestamp.ok ? timestamp.value : undefined
        )
    if (!timestamp.ok) problem.reasons.push({ timestampProviderError: timestamp.error })

    return problem.reasons.length === 0 ? [] : [problem]
  })
  return setupResult('books', invalidBooks.length === 0, invalidBooks, required)
}
