import type { Address, Hex } from 'viem'

import { waitForMonitorInterval } from '@repo/monitoring'

import { operatorErrorName } from '../operator-error-name.utils'
import {
  booksCheck,
  capture,
  chainCheck,
  providerFailure,
  readOnlyMakerCheck,
  sameAddress,
  setupResult
} from './setup-check.utils'
import { SetupFailedError } from './setup-failed.error'
import { SetupMonitorConfigurationError } from './setup-monitor-configuration.error'

const SETUP_CHECK_MONITOR_INTERVAL_MS = 60_000
type SetupCheckStatus = 'passed' | 'failed' | 'not-required'

/** Read-only operator instruction or exact transaction description; never executed by the checker. */
export type SetupRemediation =
  | string
  | {
      to: Address
      functionName: string
      args: readonly unknown[]
    }

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

/** Final lifecycle report emitted after continuous setup monitoring stops. */
export type SetupCheckMonitorReport =
  | {
      /** Monitoring stopped normally after the runtime signal. */
      status: 'stopped'
      /** Stable signal-based terminal reason. */
      reason: 'signal'
      /** Number of complete readiness reports emitted to the monitoring writer. */
      cycles: number
    }
  | {
      /** Monitoring halted because a cycle could not produce or emit a report. */
      status: 'halted'
      /** Stable unexpected-cycle terminal reason. */
      reason: 'cycle-error'
      /** Number of complete readiness reports emitted before the failed cycle. */
      cycles: number
      /** Sanitized unexpected error classification. */
      cycleErrorName: string
    }
  | {
      /** Monitoring halted because the latest complete readiness report failed. */
      status: 'halted'
      /** Stable readiness-failure terminal reason. */
      reason: 'setup-failed'
      /** Number of complete readiness reports emitted through the failed cycle. */
      cycles: number
      /** Complete sanitized readiness evidence from the failed terminal cycle. */
      lastReport: SetupCheckReport
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
  /** Router-listed Ecrecover or Setter ratifier expected to authorize the maker. */
  ratifier: Address
  /** Non-empty set of Midnight market identifiers to validate concurrently. */
  marketIds: readonly Hex[]
  /** Morpho Blue market read through the archive-capable reference provider when required. */
  referenceMarketId?: Hex
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
  /** Reads the connected RPC chain identifier. @returns The connected RPC chain identifier. */
  getChainId(): Promise<number>
  /** Reads deployed runtime bytecode. @param address - Contract address to inspect. @returns Runtime bytecode, if deployed. */
  getCode(address: Address): Promise<Hex | undefined>
  /** Derives the configured maker locally. @returns The maker derived from the configured signing key, or `undefined` when no key was loaded. */
  getDerivedMaker(): Promise<Address | undefined>
  /** Reads an account native-token balance. @param address - Account to inspect. @returns Its native-token balance. */
  getNativeBalance(address: Address): Promise<bigint>
  /**
   * Reads the configured ERC-20 allowance without writes.
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
   * @param ratifier - Candidate Ecrecover or Setter ratifier.
   * @returns Sanitized ratifier readiness facts.
   */
  getRatifier(
    maker: Address,
    ratifier: Address
  ): Promise<{
    type?: 'ecrecover' | 'setter'
    listed: boolean
    deployed: boolean
    midnightMatches: boolean
    surfaceMatches: boolean
    authorized: boolean
  }>
  /** Cross-checks one Midnight market. @param id - Midnight market identifier. @returns Cross-checked API and on-chain market facts. */
  getBook(id: Hex): Promise<BookSetup>
  /** Reads the latest connected-chain block timestamp. @returns Timestamp of the latest connected-chain block. */
  getLatestTimestamp(): Promise<bigint>
  /** Checks historical reference-market readability. @returns Archive-readability and exact reference-market identity facts. */
  checkReference(): Promise<{ marketId: Hex; referenceReadable: boolean; archiveReadable: boolean }>
  /**
   * Traverses all active offer groups under one absolute request deadline.
   * @param maker - Maker whose offers are inspected.
   * @returns Unknown namespaces, unconfigured markets, and every crossed/inverted active market.
   * @throws When pagination repeats a cursor, exceeds safe page/item bounds, or the deadline.
   */
  inspectOffers(maker: Address): Promise<{
    unknownNamespaces: readonly string[]
    unknownMarketIds: readonly Hex[]
    invertedMarketIds: readonly Hex[]
  }>
  /** Reports the intentionally excluded V0 health surface. @returns The explicit V0 not-required result; performs no writes. */
  checkPositionHealth(): Promise<{ status: 'not-required'; reason: string }>
}

/** Application service that evaluates every V0 market-maker readiness requirement without writes. */
export class SetupCheckService {
  /**
   * Creates the setup readiness gate.
   * @param state - Read-only provider port.
   * @param config - Validated setup requirements.
   * @param readOnly - Whether signer-only readiness reads must be skipped.
   * @param referenceRequired - Whether an active target-rate strategy requires Blue history.
   */
  constructor(
    private readonly state: SetupStateService,
    private readonly config: SetupCheckConfig,
    private readonly readOnly = false,
    private readonly referenceRequired = true
  ) {}

  /**
   * Evaluates the complete report and enforces readiness for downstream writers.
   * @returns The complete ready report.
   * @throws `SetupFailedError` when any check fails; the error retains every check result.
   * @remarks Read-only. Independent provider checks run concurrently through `Promise.all`.
   */
  async assertReady() {
    const report = await this.check()
    if (!report.ready) throw new SetupFailedError(report)
    return report
  }

  /**
   * Repeats complete read-only readiness observations until shutdown is requested.
   * @param parameters - Shutdown signal, optional report writer, and testable positive interval.
   * @returns A terminal report containing the number of emitted setup observations.
   * @throws `SetupMonitorConfigurationError` when the requested interval is not a positive safe integer.
   * @remarks Cycles never overlap. Failed readiness is emitted once and halts monitoring so the CLI
   * exits nonzero; no remediation, signing, transaction submission, or cleanup write is performed.
   */
  async runContinuously(parameters: {
    signal: AbortSignal
    onCycle?: (report: SetupCheckReport) => void | Promise<void>
    intervalMs?: number
  }): Promise<SetupCheckMonitorReport> {
    const intervalMs = parameters.intervalMs ?? SETUP_CHECK_MONITOR_INTERVAL_MS
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new SetupMonitorConfigurationError()
    }

    let cycles = 0
    let cycleErrorName: string | undefined

    while (!parameters.signal.aborted) {
      try {
        const report = await this.check()
        await parameters.onCycle?.(report)
        cycles += 1
        if (!report.ready) {
          return { status: 'halted', reason: 'setup-failed', cycles, lastReport: report }
        }
      } catch (error) {
        cycleErrorName = operatorErrorName(error)
        break
      }

      await waitForMonitorInterval(intervalMs, parameters.signal)
    }

    return cycleErrorName
      ? { status: 'halted', reason: 'cycle-error', cycles, cycleErrorName }
      : { status: 'stopped', reason: 'signal', cycles }
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
    const derivedMakerRead = this.readOnly
      ? Promise.resolve(undefined)
      : capture(() => this.state.getDerivedMaker())
    const referenceRead = this.referenceRequired
      ? capture(() => this.state.checkReference(), 'archive-rpc')
      : Promise.resolve(undefined)
    const reads = await Promise.all([
      capture(() => this.state.getChainId()),
      capture(() => this.state.getCode(this.config.midnight)),
      derivedMakerRead,
      capture(() => this.state.getNativeBalance(this.config.maker)),
      capture(() => this.state.getLoanAllowance(this.config.maker, this.config.loanAsset)),
      capture(() => this.state.getRatifier(this.config.maker, this.config.ratifier)),
      capture(() => this.state.getLatestTimestamp()),
      Promise.all(bookReads.map(async book => ({ ...book, response: await book.response }))),
      referenceRead,
      capture(() => this.state.inspectOffers(this.config.maker), 'morpho-api'),
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

    const makerRequirement = 'private key derives configured maker'
    const makerMatches =
      derivedMaker !== undefined &&
      derivedMaker.ok &&
      derivedMaker.value !== undefined &&
      sameAddress(derivedMaker.value, this.config.maker)
    const makerCheck =
      derivedMaker === undefined
        ? readOnlyMakerCheck()
        : !derivedMaker.ok
          ? providerFailure('maker', derivedMaker.error, makerRequirement)
          : setupResult(
              'maker',
              makerMatches,
              { derived: derivedMaker.value !== undefined, matches: makerMatches },
              makerRequirement
            )
    const nativeCheck = !nativeBalance.ok
      ? providerFailure('native-balance', nativeBalance.error, this.config.nativeReserve)
      : setupResult(
          'native-balance',
          nativeBalance.value >= this.config.nativeReserve,
          nativeBalance.value,
          this.config.nativeReserve,
          `fund the configured maker with native token to at least ${this.config.nativeReserve}`
        )
    const allowanceRequired = {
      spender: this.config.midnight,
      minimum: this.config.maximumLendExposure
    }
    const allowanceCheck = !allowance.ok
      ? providerFailure('loan-allowance', allowance.error, allowanceRequired)
      : setupResult(
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
      surfaceMatches: true,
      authorized: true
    }
    const ratifierCheck = !ratifier.ok
      ? providerFailure('ratifier', ratifier.error, ratifierRequired)
      : setupResult(
          'ratifier',
          ratifier.value.listed &&
            ratifier.value.deployed &&
            ratifier.value.midnightMatches &&
            ratifier.value.surfaceMatches &&
            ratifier.value.authorized,
          ratifier.value,
          ratifierRequired,
          ratifier.value.listed &&
            ratifier.value.deployed &&
            ratifier.value.midnightMatches &&
            ratifier.value.surfaceMatches &&
            !ratifier.value.authorized
            ? 'authorize the configured maker with the selected ratifier'
            : 'select a Router-listed ratifier with the expected deployed surface'
        )
    const referenceRequired = {
      marketId: this.config.referenceMarketId,
      referenceReadable: true,
      archiveReadable: true
    }
    const referenceCheck =
      reference === undefined
        ? {
            name: 'reference' as const,
            status: 'not-required' as const,
            observed: { reason: 'no variable_rate_avg target-rate strategy is active' },
            required: 'only for variable_rate_avg target-rate strategies'
          }
        : !reference.ok
          ? providerFailure('reference', reference.error, referenceRequired)
          : setupResult(
              'reference',
              reference.value.marketId === this.config.referenceMarketId &&
                reference.value.referenceReadable &&
                reference.value.archiveReadable,
              reference.value,
              referenceRequired
            )
    const offersRequired = { unknownNamespaces: [], unknownMarketIds: [], invertedMarketIds: [] }
    const offersCheck = !offers.ok
      ? providerFailure('offers', offers.error, offersRequired)
      : setupResult(
          'offers',
          offers.value.unknownNamespaces.length === 0 &&
            offers.value.unknownMarketIds.length === 0 &&
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
