import type { Address, Hex } from 'viem'

import { isAddress, isAddressEqual } from 'viem'

type SetupCheckStatus = 'passed' | 'failed' | 'not-required'

type SetupRemediation = string | { to: Address; functionName: string; args: readonly unknown[] }

/** A single sanitized, read-only readiness observation and its optional operator remediation. */
export type SetupCheck = {
  /** Stable identifier for the setup surface being checked. */
  name:
    | 'chain'
    | 'maker'
    | 'native-balance'
    | 'loan-allowance'
    | 'ratifier'
    | 'books'
    | 'reference'
    | 'offers'
    | 'position-health'
  /** Whether the requirement passed, failed, or is intentionally outside the V0 scope. */
  status: SetupCheckStatus
  /** Sanitized provider-derived value; URLs, credentials, and raw provider messages are excluded. */
  observed: unknown
  /** Expected value or invariant used to evaluate the observation. */
  required: unknown
  /** Read-only transaction description or operator instruction; this service never executes it. */
  remediation?: SetupRemediation
}

/** Complete setup-check result returned even when one or more independent reads fail. */
export type SetupCheckReport = {
  /** True only when no check has the `failed` status. */
  ready: boolean
  /** All V0 checks in stable operator-facing order. */
  checks: SetupCheck[]
}

/** Error raised by the fail-fast readiness gate while retaining the complete sanitized report. */
export class SetupCheckError extends Error {
  /**
   * Creates an error naming every failed check.
   *
   * @param report - Complete read-only report that failed readiness.
   */
  constructor(readonly report: SetupCheckReport) {
    const failed = report.checks.filter(check => check.status === 'failed')
    super(`Setup check failed: ${failed.map(check => check.name).join(', ')}`)
    this.name = 'SetupCheckError'
  }
}

/** Validated configuration required to evaluate market-maker readiness on Base. */
export type SetupCheckConfig = {
  /** Configured EVM chain identifier; V0 requires Base (`8453`). */
  chainId: number
  /** Expected maker derived from the configured signing key. */
  maker: Address
  /** Expected Midnight singleton address. */
  midnight: Address
  /** Minimum native-token balance retained for transaction fees. */
  nativeReserve: bigint
  /** ERC-20 asset lent by every configured market. */
  loanAsset: Address
  /** Minimum allowance granted to Midnight. */
  maximumLendExposure: bigint
  /** Router-listed Ecrecover ratifier expected to authorize the maker. */
  ratifier: Address
  /** Non-empty set of Midnight market identifiers to validate concurrently. */
  marketIds: readonly Hex[]
  /** Morpho Blue market read through the archive-capable reference provider. */
  referenceMarketId: Hex
}

/** API and on-chain facts used to validate one configured Midnight market. */
export type BookSetup = {
  /** Market identifier returned by the provider. */
  id: Hex
  /** Whether the Morpho API lists the market. */
  allowlisted: boolean
  /** Whether the API reports the market as active. */
  active: boolean
  /** Loan asset returned by Midnight. */
  loanAsset: Address
  /** On-chain tick spacing; must be positive. */
  tickSpacing: number
  /** On-chain maturity timestamp. */
  maturity: bigint
}

/**
 * Consumer-owned, read-only port for every provider observation used by the setup gate.
 * Implementations may reject individual reads; {@link SetupCheckService.check} captures those
 * failures and continues collecting independent observations concurrently.
 */
export interface SetupStateService {
  /** @returns The connected RPC chain identifier. */
  getChainId(): Promise<number>
  /** @param address - Contract address to inspect. @returns Runtime bytecode, if deployed. */
  getCode(address: Address): Promise<Hex | undefined>
  /** @returns The maker derived from the configured signing key without signing or broadcasting. */
  getDerivedMaker(): Promise<Address>
  /** @param address - Account to inspect. @returns Its native-token balance. */
  getNativeBalance(address: Address): Promise<bigint>
  /**
   * @param owner - Token owner whose allowance is read.
   * @param loanAsset - ERC-20 contract queried.
   * @returns The configured spender and current allowance.
   */
  getLoanAllowance(
    owner: Address,
    loanAsset: Address
  ): Promise<{ spender: Address; amount: bigint }>
  /**
   * Reads Router registry, runtime-code, immutable-target, callable-surface, and authorization facts.
   * Independent provider and contract reads should run concurrently with `Promise.all`.
   * @param maker - Maker whose authorization is checked.
   * @param ratifier - Candidate Ecrecover ratifier.
   * @returns Sanitized ratifier readiness facts.
   */
  getRatifier(
    maker: Address,
    ratifier: Address
  ): Promise<{
    listed: boolean
    deployed: boolean
    midnightMatches: boolean
    ecrecoverSurface: boolean
    authorized: boolean
  }>
  /** @param id - Midnight market identifier. @returns Cross-checked API and on-chain market facts. */
  getBook(id: Hex): Promise<BookSetup>
  /** @returns Timestamp of the latest connected-chain block. */
  getLatestTimestamp(): Promise<bigint>
  /** @returns Archive-readability and exact reference-market identity facts. */
  checkReference(): Promise<{ marketId: Hex; referenceReadable: boolean; archiveReadable: boolean }>
  /**
   * Traverses all active offers under one absolute request deadline.
   * @param maker - Maker whose offers are inspected.
   * @returns Unknown namespaces and crossed/inverted configured markets.
   * @throws When pagination repeats a cursor, exceeds 100 pages or 100,000 items, or the deadline.
   */
  inspectOffers(maker: Address): Promise<{
    unknownNamespaces: readonly string[]
    invertedMarketIds: readonly Hex[]
  }>
  /** @returns The explicit V0 not-required result; performs no writes. */
  checkPositionHealth(): Promise<{ status: 'not-required'; reason: string }>
}

const BASE_CHAIN_ID = 8453

type SafeProviderFailure = {
  kind: 'provider-error'
  provider: 'rpc' | 'archive-rpc' | 'morpho-api' | 'router-api'
  name: string
  code?: string
  status?: number
  context?: 'read' | 'request'
}

/** Allowlisted provider failure safe to place in reports without leaking URLs or response bodies. */
export class SafeProviderError extends Error {
  /**
   * Creates a provider error from already-sanitized metadata.
   * @param failure - Provider ID and allowlisted status, code, name, and context only.
   */
  constructor(readonly failure: SafeProviderFailure) {
    super(failure.name)
    this.name = 'SafeProviderError'
  }
}

type Captured<T> = { ok: true; value: T } | { ok: false; error: SafeProviderFailure }

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

function safeProviderFailure(
  error: unknown,
  provider: SafeProviderFailure['provider']
): SafeProviderFailure {
  if (error instanceof SafeProviderError) {
    const safeProvider = SAFE_PROVIDER_IDS.has(error.failure.provider)
      ? error.failure.provider
      : provider
    const name = SAFE_ERROR_NAMES.has(error.failure.name) ? error.failure.name : 'ProviderError'
    const code =
      error.failure.code === 'REQUEST_TIMEOUT' ||
      (error.failure.code !== undefined && SAFE_ERROR_CODES.has(error.failure.code))
        ? error.failure.code
        : undefined
    const status = Number.isSafeInteger(error.failure.status) ? error.failure.status : undefined
    const context =
      error.failure.context === 'request' || error.failure.context === 'read'
        ? error.failure.context
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
  const candidate =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : undefined
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

function capture<T>(
  read: () => Promise<T>,
  provider: SafeProviderFailure['provider'] = 'rpc'
): Promise<Captured<T>> {
  try {
    return read().then(
      value => ({ ok: true, value }),
      error => ({ ok: false, error: safeProviderFailure(error, provider) })
    )
  } catch (error) {
    return Promise.resolve({ ok: false, error: safeProviderFailure(error, provider) })
  }
}

function sameAddress(left: string, right: string) {
  return isAddress(left) && isAddress(right) && isAddressEqual(left, right)
}

function result(
  name: SetupCheck['name'],
  passed: boolean,
  observed: unknown,
  required: unknown,
  remediation?: SetupRemediation
): SetupCheck {
  return {
    name,
    status: passed ? 'passed' : 'failed',
    observed,
    required,
    ...(passed || !remediation ? {} : { remediation })
  }
}

function providerFailure(name: SetupCheck['name'], error: SafeProviderFailure, required: unknown) {
  return result(name, false, { error }, required)
}

function bookProblems(
  requestedId: Hex,
  book: BookSetup,
  config: SetupCheckConfig,
  latestTimestamp: bigint
) {
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

function chainCheck(
  config: SetupCheckConfig,
  chainId: Captured<number>,
  midnightCode: Captured<Hex | undefined>
) {
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
  return result('chain', ready, observed, required)
}

function booksCheck(
  config: SetupCheckConfig,
  timestamp: Captured<bigint>,
  books: readonly { requestedId: Hex; response: Captured<BookSetup> }[]
) {
  const required = 'all configured books valid'
  if (config.marketIds.length === 0) {
    return result('books', false, [{ id: '(none)', reasons: ['no markets configured'] }], required)
  }
  const invalidBooks = books.flatMap(({ requestedId, response }) => {
    if (!response.ok) return [{ id: requestedId, reasons: [{ providerError: response.error }] }]
    if (!timestamp.ok) {
      return [{ id: requestedId, reasons: [{ timestampProviderError: timestamp.error }] }]
    }
    const problem = bookProblems(requestedId, response.value, config, timestamp.value)
    return problem.reasons.length === 0 ? [] : [problem]
  })
  return result('books', invalidBooks.length === 0, invalidBooks, required)
}

/** Application service that evaluates every V0 market-maker readiness requirement without writes. */
export class SetupCheckService {
  /**
   * Creates the setup readiness gate.
   * @param state - Read-only provider port.
   * @param config - Validated setup requirements.
   */
  constructor(
    private readonly state: SetupStateService,
    private readonly config: SetupCheckConfig
  ) {}

  /**
   * Evaluates the complete report and enforces readiness for downstream writers.
   * @returns The complete ready report.
   * @throws {@link SetupCheckError} when any check fails; the error retains every check result.
   * @remarks Read-only. Independent provider checks run concurrently through `Promise.all`.
   */
  async assertReady() {
    const report = await this.check()
    if (!report.ready) throw new SetupCheckError(report)
    return report
  }

  /**
   * Evaluates all setup surfaces while isolating provider failures into sanitized report entries.
   * @returns A complete report in stable check order; provider rejection does not short-circuit peers.
   * @remarks Read-only. All independent reads, including per-book reads, start before the outer
   * `Promise.all` is awaited so latency is bounded by the slowest check rather than their sum.
   */
  async check(): Promise<SetupCheckReport> {
    const bookReads = this.config.marketIds.map(requestedId => ({
      requestedId,
      response: capture(() => this.state.getBook(requestedId))
    }))
    const reads = await Promise.all([
      capture(() => this.state.getChainId()),
      capture(() => this.state.getCode(this.config.midnight)),
      capture(() => this.state.getDerivedMaker()),
      capture(() => this.state.getNativeBalance(this.config.maker)),
      capture(() => this.state.getLoanAllowance(this.config.maker, this.config.loanAsset)),
      capture(() => this.state.getRatifier(this.config.maker, this.config.ratifier)),
      capture(() => this.state.getLatestTimestamp()),
      Promise.all(bookReads.map(async book => ({ ...book, response: await book.response }))),
      capture(() => this.state.checkReference(), 'archive-rpc'),
      capture(() => this.state.inspectOffers(this.config.maker), 'router-api'),
      capture(() => this.state.checkPositionHealth())
    ])
    const [
      chainId,
      midnightCode,
      derivedMaker,
      nativeBalance,
      allowance,
      ratifier,
      latestTimestamp,
      books,
      reference,
      offers,
      positionHealth
    ] = reads

    const makerCheck = !derivedMaker.ok
      ? providerFailure('maker', derivedMaker.error, this.config.maker)
      : result(
          'maker',
          sameAddress(derivedMaker.value, this.config.maker),
          derivedMaker.value,
          this.config.maker
        )
    const nativeCheck = !nativeBalance.ok
      ? providerFailure('native-balance', nativeBalance.error, this.config.nativeReserve)
      : result(
          'native-balance',
          nativeBalance.value >= this.config.nativeReserve,
          nativeBalance.value,
          this.config.nativeReserve,
          `fund ${this.config.maker} with native token to at least ${this.config.nativeReserve}`
        )
    const allowanceRequired = {
      spender: this.config.midnight,
      minimum: this.config.maximumLendExposure
    }
    const allowanceCheck = !allowance.ok
      ? providerFailure('loan-allowance', allowance.error, allowanceRequired)
      : result(
          'loan-allowance',
          sameAddress(allowance.value.spender, this.config.midnight) &&
            allowance.value.amount >= this.config.maximumLendExposure,
          allowance.value,
          allowanceRequired,
          {
            to: this.config.loanAsset,
            functionName: 'approve',
            args: [this.config.midnight, this.config.maximumLendExposure]
          }
        )
    const ratifierRequired = {
      listed: true,
      deployed: true,
      midnightMatches: true,
      ecrecoverSurface: true,
      authorized: true
    }
    const ratifierCheck = !ratifier.ok
      ? providerFailure('ratifier', ratifier.error, ratifierRequired)
      : result(
          'ratifier',
          ratifier.value.listed &&
            ratifier.value.deployed &&
            ratifier.value.midnightMatches &&
            ratifier.value.ecrecoverSurface &&
            ratifier.value.authorized,
          ratifier.value,
          ratifierRequired,
          ratifier.value.listed &&
            ratifier.value.deployed &&
            ratifier.value.midnightMatches &&
            ratifier.value.ecrecoverSurface &&
            !ratifier.value.authorized
            ? {
                to: this.config.midnight,
                functionName: 'setIsAuthorized',
                args: [this.config.ratifier, true, this.config.maker]
              }
            : 'select a Router-listed Ecrecover ratifier with the expected deployed surface'
        )
    const referenceRequired = {
      marketId: this.config.referenceMarketId,
      referenceReadable: true,
      archiveReadable: true
    }
    const referenceCheck = !reference.ok
      ? providerFailure('reference', reference.error, referenceRequired)
      : result(
          'reference',
          reference.value.marketId === this.config.referenceMarketId &&
            reference.value.referenceReadable &&
            reference.value.archiveReadable,
          reference.value,
          referenceRequired
        )
    const offersRequired = { unknownNamespaces: [], invertedMarketIds: [] }
    const offersCheck = !offers.ok
      ? providerFailure('offers', offers.error, offersRequired)
      : result(
          'offers',
          offers.value.unknownNamespaces.length === 0 &&
            offers.value.invertedMarketIds.length === 0,
          offers.value,
          offersRequired
        )
    const positionCheck = !positionHealth.ok
      ? providerFailure('position-health', positionHealth.error, 'not-required for V0')
      : {
          name: 'position-health' as const,
          status: positionHealth.value.status,
          observed: positionHealth.value,
          required: 'not-required for V0'
        }

    const checks: SetupCheck[] = [
      chainCheck(this.config, chainId, midnightCode),
      makerCheck,
      nativeCheck,
      allowanceCheck,
      ratifierCheck,
      booksCheck(this.config, latestTimestamp, books),
      referenceCheck,
      offersCheck,
      positionCheck
    ]
    return { ready: checks.every(check => check.status !== 'failed'), checks }
  }
}
