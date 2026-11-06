import type { Address, Hex } from 'viem'

import { isAddress, isAddressEqual } from 'viem'

import type { LadderDebtConfig } from '../../domain/debt-ceiling'
import type { SafeProviderFailure } from '../../errors'
import type {
  BookSetup,
  LoanCollateralSetup,
  SetupCheck,
  SetupCheckConfig,
  SetupCheckReport,
  SetupRemediation
} from './setup-check.service'

import { isSupportedChainId } from '../../config/supported-chains.utils'
import { debtCeilingUnits } from '../../domain/debt-ceiling'
import { SafeProviderError } from '../../errors'

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
  operation: 'signer-address' | 'keystore-read' | 'keystore-decrypt' | 'kms-public-key' | 'kms-sign'
}

const SAFE_SIGNER_OPERATIONS = new Set<SafeSignerFailure['operation']>([
  'signer-address',
  'keystore-read',
  'keystore-decrypt',
  'kms-public-key',
  'kms-sign'
])

// oxlint-disable-next-line complexity
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
 * signer operation or a sanitized RPC-shaped fallback for an unexpected rejection.
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
      candidate?.name === 'SignerAccountError' &&
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
 * Grades inspected maker offers, separating unsafe books from unattributable groups.
 * @param offers - Unknown namespaces, unconfigured markets, and crossed markets from one traversal.
 * @returns `failed` for offers outside the bot's exposure model, `warning` for live groups it merely
 * cannot attribute to itself, `passed` otherwise.
 * @remarks Only markets drive readiness. Group ownership is a local durable record, so a redeploy
 * onto a fresh filesystem orphans the bot's own live groups; halting on that cannot self-heal until
 * every orphan expires. Downgrading to a warning is only safe because reservations count every live
 * maker buy group rather than only attributed ones — see `readExposureSnapshot` in
 * `infrastructure/exposure/exposure-snapshot.utils.ts`.
 */
export const unsafeOffersStatus = (offers: {
  unknownNamespaces: readonly string[]
  unknownMarketIds: readonly Hex[]
  invertedMarketIds: readonly Hex[]
}): SetupCheck['status'] => {
  if (offers.unknownMarketIds.length > 0 || offers.invertedMarketIds.length > 0) return 'failed'
  return offers.unknownNamespaces.length > 0 ? 'warning' : 'passed'
}

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
export const readOnlySignerCheck = (): SetupCheck => ({
  name: 'signer',
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
    const configured = check.observed.configured
    const configuredMatches = typeof configured === 'number' && isSupportedChainId(configured)
    const connectedMatches =
      check.observed.connected === undefined || check.observed.connected === configured
    const referenceMatches =
      check.observed.referenceConnected === undefined ||
      check.observed.referenceConnected === configured
    const deploymentMatches =
      check.observed.midnightCode === undefined || check.observed.midnightCode === 'deployed'
    return (
      configuredMatches &&
      connectedMatches &&
      referenceMatches &&
      deploymentMatches &&
      check.observed.errors.length > 0 &&
      check.observed.errors.every(isTransientProviderFailure)
    )
  }

  // Compound checks can mask a successful peer read that already proved invariant drift, so they
  // fail closed instead of retrying based only on their provider error.
  if (
    check.name === 'ratifier' ||
    check.name === 'reference' ||
    check.name === 'offers' ||
    check.name === 'books'
  ) {
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

/**
 * Consecutive transient-only unready cycles tolerated before the monitor halts.
 * @remarks Halting runs shutdown cleanup, which cancels every live offer, so a provider outage must
 * not cost the whole book. Ten cycles is ten minutes at the default interval. Invariant failures
 * ignore this budget and halt on the first cycle.
 */
const SETUP_CHECK_TRANSIENT_CYCLES = 10

/**
 * Whether a monitoring cycle's report halts the quoter, given how many transient-only cycles came
 * just before it.
 * @param transientCycles - Consecutive transient-only unready cycles before this one.
 * @param report - This cycle's report.
 * @returns The count including this cycle, and whether this report halts.
 */
export const readinessVerdict = (transientCycles: number, report: SetupCheckReport) => {
  const transientOnly = hasOnlyTransientProviderFailures(report)
  const counted = transientOnly ? transientCycles + 1 : 0
  return {
    transientCycles: counted,
    halting: !report.ready && (!transientOnly || counted >= SETUP_CHECK_TRANSIENT_CYCLES)
  }
}

const bookProblems = (requestedId: Hex, book: BookSetup, config: SetupCheckConfig) => {
  const reasons: unknown[] = []
  if (book.id !== requestedId) reasons.push(`provider returned ${book.id}`)
  if (!book.allowlisted) reasons.push('not allowlisted')
  if (!book.active) reasons.push('inactive')
  if (!sameAddress(book.loanAsset, config.loanAsset)) {
    reasons.push(`unexpected loan asset ${book.loanAsset}`)
  }
  if (book.tickSpacing <= 0) reasons.push('tick spacing is inaccessible')
  return { id: requestedId, reasons }
}

/**
 * Evaluates chain identity and Midnight deployment bytecode without performing writes.
 * @param config - Validated setup requirements.
 * @param chainId - Captured connected-chain response.
 * @param midnightCode - Captured Midnight runtime bytecode.
 * @param referenceChainId - Captured archive-provider chain response, when a variable-rate strategy
 * makes the archive provider load-bearing; `undefined` when no such strategy is active.
 * @returns The normalized chain setup check.
 * @remarks The archive provider is gated here because nothing else observes its chain identity: a
 * stale endpoint for another chain would otherwise let the variable-rate strategy derive quotes
 * from foreign Blue state and submit them on the configured chain.
 */
export const chainCheck = (
  config: SetupCheckConfig,
  chainId: Captured<number>,
  midnightCode: Captured<Hex | undefined>,
  referenceChainId?: Captured<number>
) => {
  const required = { chainId: config.chainId, midnightCode: 'deployed' }
  const deployed = midnightCode.ok
    ? midnightCode.value !== undefined && midnightCode.value !== '0x'
    : undefined
  const errors = [
    ...(!chainId.ok ? [chainId.error] : []),
    ...(referenceChainId !== undefined && !referenceChainId.ok ? [referenceChainId.error] : []),
    ...(!midnightCode.ok ? [midnightCode.error] : [])
  ]
  const observed = {
    configured: config.chainId,
    ...(chainId.ok ? { connected: chainId.value } : {}),
    ...(referenceChainId?.ok ? { referenceConnected: referenceChainId.value } : {}),
    ...(deployed === undefined ? {} : { midnightCode: deployed ? 'deployed' : 'missing' }),
    ...(errors.length === 0 ? {} : { errors })
  }
  const ready =
    errors.length === 0 &&
    isSupportedChainId(config.chainId) &&
    chainId.ok &&
    chainId.value === config.chainId &&
    (referenceChainId === undefined ||
      (referenceChainId.ok && referenceChainId.value === config.chainId)) &&
    deployed === true
  return setupResult('chain', ready, observed, required)
}

/**
 * Evaluates all configured books from already-concurrent captured reads without writes.
 * @param config - Validated market requirements.
 * @param books - Captured per-market API/chain observations.
 * @returns The normalized aggregate books check.
 */
export const booksCheck = (
  config: SetupCheckConfig,
  books: readonly { requestedId: Hex; response: Captured<BookSetup> }[]
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
      : bookProblems(requestedId, response.value, config)

    return problem.reasons.length === 0 ? [] : [problem]
  })
  return setupResult('books', invalidBooks.length === 0, invalidBooks, required)
}

/**
 * Runtime hash of the only oracle a loan-asset collateral may borrow against: a Morpho Chainlink
 * oracle whose feeds and vaults are all unset and whose `SCALE_FACTOR` is `1e36`, so `price()` is a
 * constant `1e36` held in immutables. Read from `0x4429…DC1d` on Base and `0x8d1A…f6ca` on Ethereum,
 * the oracle of every listed loan-asset slot as of 2026-10-07; both chains deploy identical code.
 */
const CONSTANT_LOAN_COLLATERAL_ORACLE_RUNTIME_HASH =
  '0x6c5b423bbd32a1bc423d3992fe58a905f055fd2173a97b69f0468bc3ce51e2df'

type DebtPositionRead = {
  requestedId: Hex
  debt: Captured<bigint>
  loanCollateral?: Captured<LoanCollateralSetup | undefined>
}

type DebtPositionFinding =
  | 'debt-not-configured'
  | 'loan-collateral-missing'
  | 'loan-collateral-oracle'
  | 'enter-gate-closed'
  | 'debt-over-maximum'
  | 'matured-with-debt'

const BLOCKING_DEBT_FINDINGS: ReadonlySet<DebtPositionFinding> = new Set([
  'debt-not-configured',
  'loan-collateral-missing',
  'loan-collateral-oracle',
  'enter-gate-closed'
])

const debtPositionFindings = (
  debt: bigint,
  limits: LadderDebtConfig | undefined,
  loanCollateral: DebtPositionRead['loanCollateral']
): DebtPositionFinding[] => {
  if (limits === undefined) return debt > 0n ? ['debt-not-configured'] : []
  if (!loanCollateral?.ok) return []
  const slot = loanCollateral.value
  if (slot === undefined) return ['loan-collateral-missing']
  return [
    ...(slot.oracleRuntimeHash === CONSTANT_LOAN_COLLATERAL_ORACLE_RUNTIME_HASH
      ? []
      : ['loan-collateral-oracle' as const]),
    ...(slot.enterGateOpen ? [] : ['enter-gate-closed' as const]),
    ...(debt > limits.maximumDebtUnits ? ['debt-over-maximum' as const] : []),
    ...(slot.matured && debt > 0n ? ['matured-with-debt' as const] : [])
  ]
}

/**
 * Grades the maker's debt across every allowlisted market against its ladder `debt` configuration.
 * @param config - Allowlisted markets and the ladder markets configured to borrow.
 * @param reads - Each market's debt and, for configured markets, its loan-asset collateral slot.
 * @returns `failed` when a market carries debt the configuration does not cover, or a configured
 * market cannot borrow safely (no loan-asset collateral, an oracle other than the pinned constant
 * one, or a closed enter gate); `warning` for debt above `maximumDebtUnits` or past maturity; `not-required` with no
 * configured market and no debt.
 * @remarks Proven findings outrank provider failures, so a lost read cannot mask one; without a
 * finding, the first provider failure is reported in the shape transient retries recognize.
 */
export const positionHealthCheck = (
  config: Pick<SetupCheckConfig, 'debt'>,
  reads: readonly DebtPositionRead[]
): SetupCheck => {
  const required =
    'debt only in markets configuring ladder debt, each listing its loan asset as collateral behind the pinned constant 1e36 oracle with an open enter gate'
  const observed = reads.flatMap(read => {
    if (!read.debt.ok) return []
    const limits = config.debt?.get(read.requestedId)
    const findings = debtPositionFindings(read.debt.value, limits, read.loanCollateral)
    const slot = read.loanCollateral?.ok ? read.loanCollateral.value : undefined
    if (findings.length === 0 && limits === undefined) return []
    return [
      {
        id: read.requestedId,
        debt: read.debt.value,
        ...(limits === undefined
          ? {}
          : {
              maximumDebtUnits: limits.maximumDebtUnits,
              debtCeilingUnits: debtCeilingUnits(limits, slot)
            }),
        ...(slot === undefined ? {} : { loanCollateral: slot }),
        findings
      }
    ]
  })
  const findings = new Set(observed.flatMap(item => item.findings))
  if ([...findings].some(finding => BLOCKING_DEBT_FINDINGS.has(finding))) {
    return {
      name: 'position-health',
      status: 'failed',
      observed,
      required,
      remediation: findings.has('debt-not-configured')
        ? 'configure ladder debt for every market carrying debt, or repay that debt before removing it'
        : 'borrow only on markets listing the loan asset as collateral behind the pinned constant 1e36 oracle whose enter gate admits the maker'
    }
  }
  const failure = reads.flatMap(read => [
    ...(read.debt.ok ? [] : [read.debt.error]),
    ...(read.loanCollateral === undefined || read.loanCollateral.ok
      ? []
      : [read.loanCollateral.error])
  ])[0]
  if (failure) return providerFailure('position-health', failure, required)
  if (findings.size > 0) {
    return {
      name: 'position-health',
      status: 'warning',
      observed,
      required,
      remediation: findings.has('matured-with-debt')
        ? 'after maturity, repay the debt and withdraw the loan-asset collateral; nothing settles it otherwise'
        : 'debt above maximumDebtUnits: sells stop borrowing until buys repay it below the cap'
    }
  }
  return {
    name: 'position-health',
    status: observed.length === 0 ? 'not-required' : 'passed',
    observed,
    required
  }
}

/**
 * Grades the maker's loan-token approval to Midnight.
 * @param allowance - Observed spender and remaining allowance.
 * @param config - Midnight address and the full-deployment allowance from `calculateRequiredAllowance`.
 * @param startup - Whether this is the one-time startup check rather than a monitoring cycle.
 * @returns `failed` for a different spender, or for a zero allowance at startup when any buy is
 * configured; otherwise `warning` below `requiredAllowance` and `passed` at or above it.
 * @remarks Monitoring never fails on the amount: both writers size buys by the lesser of balance and
 * allowance, so fills that draw a finite approval down shrink the book instead of halting it.
 */
export const loanAllowanceCheck = (
  allowance: { spender: Address; amount: bigint },
  config: Pick<SetupCheckConfig, 'midnight' | 'requiredAllowance'>,
  startup: boolean
): SetupCheck => {
  const requiresApproval = startup && config.requiredAllowance > 0n
  const required = requiresApproval
    ? { spender: config.midnight, minimum: 1n, fullDeployment: config.requiredAllowance }
    : { spender: config.midnight, fullDeployment: config.requiredAllowance }
  const status = !sameAddress(allowance.spender, config.midnight)
    ? 'failed'
    : requiresApproval && allowance.amount === 0n
      ? 'failed'
      : allowance.amount < config.requiredAllowance
        ? 'warning'
        : 'passed'
  return {
    name: 'loan-allowance',
    status,
    observed: allowance,
    required,
    ...(status === 'passed'
      ? {}
      : {
          remediation: `approve Midnight to spend the loan asset; buys shrink to the remaining allowance, ${config.requiredAllowance} funds one full deployment of the configured buy exposure, and every buy fill, including rebuys after sells, draws a finite approval down`
        })
  }
}
