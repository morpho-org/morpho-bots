import type { Address, Hex } from 'viem'

import { withActiveSpan } from '@repo/telemetry'

import type { SupportedChainId } from '../../config/supported-chains.utils'
import type { LadderDebtConfig } from '../../domain/debt-ceiling'

import { SetupCheckAbortedError, SetupFailedError } from '../../errors'
import { operatorErrorName } from '../monitoring/operator-error-name.utils'
import {
  booksCheck,
  capture,
  captureSigner,
  chainCheck,
  hasOnlyTransientProviderFailures,
  loanAllowanceCheck,
  positionHealthCheck,
  providerFailure,
  readOnlySignerCheck,
  sameAddress,
  setupResult,
  unsafeOffersStatus
} from './setup-check.utils'

/** How long readiness monitoring waits after one cycle ends before it starts the next. */
export const SETUP_CHECK_MONITOR_INTERVAL_MS = 60_000
const SETUP_CHECK_TRANSIENT_ATTEMPTS = 3
type SetupCheckStatus = 'passed' | 'failed' | 'warning' | 'not-required'

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
    | 'signer'
    | 'native-balance'
    | 'signer-native-balance'
    | 'signer-authorization'
    | 'loan-allowance'
    | 'ratifier'
    | 'books'
    | 'reference'
    | 'offers'
    | 'position-health'
  /** Whether the requirement passed, failed, warned without blocking readiness, or is outside V0 scope. */
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

/** Validated configuration required to evaluate quoter readiness on a supported chain. */
export type SetupCheckConfig = {
  /** Configured EVM chain identifier, narrowed to a chain the bot supports. */
  chainId: SupportedChainId
  /** Funded principal retained in every offer and Midnight `onBehalf` value. */
  maker: Address
  /** Selected signer mode, used to enforce local equality or delegated AWS separation. */
  signerMode: 'read-only' | 'private-key' | 'keystore' | 'aws'
  /** Expected Midnight singleton address. */
  midnight: Address
  /** Maker's native-token floor for transaction fees. Omitted in AWS write mode, where the maker sends no transactions. */
  nativeReserve?: bigint
  /** Allowance funding one full deployment of the configured buy exposure; startup warns below it. */
  requiredAllowance: bigint
  /** AWS signer's operating-gas floor. Omitted when signer and maker are the same account. */
  signerNativeReserve?: bigint
  /** ERC-20 asset lent by every configured market. */
  loanAsset: Address
  /** Canonical SDK Ecrecover or Setter ratifier expected to authorize the maker. */
  ratifier: Address
  /** Non-empty set of Midnight Market identifiers to validate concurrently. */
  marketIds: readonly Hex[]
  /** Morpho Blue Market read through the archive-capable reference provider when required. */
  referenceMarketId?: Hex
  /**
   * Operator-accepted loss factor per market; an omitted market accepts `0`.
   * @remarks Lending on a market halts whenever its loss factor differs from this value.
   */
  acceptedLossFactor?: ReadonlyMap<Hex, bigint>
  /** Ladder markets whose sells may borrow, keyed by market; see {@link LadderDebtConfig}. */
  debt?: ReadonlyMap<Hex, LadderDebtConfig>
}

/** API and onchain facts used to validate one configured Midnight Market. */
export type BookSetup = {
  /** Market identifier returned by the provider. */
  id: Hex
  /** Whether the Morpho API lists the market. */
  allowlisted: boolean
  /** Whether the API reports the market as active. */
  active: boolean
  /** Loan asset returned by Midnight. */
  loanAsset: Address
  /** Onchain tick spacing; must be positive. */
  tickSpacing: number
}

/** The maker's loan-asset collateral slot in one market, as setup qualifies it for borrowing. */
export type LoanCollateralSetup = {
  /** Maker collateral held in the slot. */
  assets: bigint
  /** WAD-scaled LLTV of the slot. */
  lltv: bigint
  /** keccak256 of the slot oracle's runtime bytecode, or `undefined` when nothing is deployed. */
  oracleRuntimeHash: Hex | undefined
  /** Whether the market's enter gate is unset or lets the maker increase debt. */
  enterGateOpen: boolean
  /** Whether the market has reached maturity, after which its debt waits on the operator. */
  matured: boolean
}

/**
 * Consumer-owned, read-only port for every provider observation used by the setup gate.
 * Implementations may reject individual reads; {@link SetupCheckService.check} captures those
 * failures and continues collecting independent observations concurrently.
 */
export interface SetupStateService {
  /** Reads the connected RPC chain identifier. @returns The connected RPC chain identifier. */
  getChainId(): Promise<number>
  /** Reads the archive provider's chain identifier. @returns The chain the reference provider is actually serving. */
  getReferenceChainId(): Promise<number>
  /** Reads deployed runtime bytecode. @param address - Contract address to inspect. @returns Runtime bytecode, if deployed. */
  getCode(address: Address): Promise<Hex | undefined>
  /**
   * Derives the configured signer locally or through KMS public-key discovery.
   * @returns The derived signer, or `undefined` in read-only mode.
   */
  getDerivedSigner(): Promise<Address | undefined>
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
   * Reads SDK identity, runtime-code, immutable-target, callable-surface, and authorization facts.
   * Independent contract reads should run concurrently with `Promise.all`.
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
  /**
   * Reads whether the maker authorized a delegate through Midnight.
   * @param maker - Funded principal granting authority.
   * @param delegate - Address whose authority is checked.
   * @returns Whether the delegate is authorized for the maker.
   */
  getAuthorization(maker: Address, delegate: Address): Promise<boolean>
  /** Cross-checks one Midnight Market. @param id - Midnight Market identifier. @returns Cross-checked API and onchain market facts. */
  getBook(id: Hex): Promise<BookSetup>
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
  /**
   * Reads the maker's face debt in one market.
   * @param id - Midnight Market identifier.
   * @param maker - Maker whose position is read.
   * @returns The uint128 debt.
   */
  getDebt(id: Hex, maker: Address): Promise<bigint>
  /**
   * Reads the slot of one market whose collateral token is the loan asset.
   * @param id - Midnight Market identifier.
   * @param maker - Maker whose collateral and gate answer are read.
   * @returns The slot's facts, or `undefined` when the market lists no loan-asset collateral.
   */
  getLoanCollateral(id: Hex, maker: Address): Promise<LoanCollateralSetup | undefined>
}

/** Application service that evaluates every V0 quoter readiness requirement without writes. */
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
   * @param signal - Optional shutdown signal that stops transient startup retries after the current read.
   * @returns The complete ready report.
   * @throws `SetupFailedError` when an invariant fails or transient providers remain unavailable
   * after three total attempts; the error retains every check result from the final attempt.
   * @remarks Read-only. Independent provider checks run concurrently through `Promise.all` on each
   * attempt. Only reports caused exclusively by explicitly transient provider failures are retried.
   */
  async assertReady(signal?: AbortSignal) {
    const report = await this.checkWithTransientRetries(signal)
    if (signal?.aborted === true) throw new SetupCheckAbortedError()
    if (!report.ready) throw new SetupFailedError(report)
    return report
  }

  /**
   * One monitoring cycle: a complete readiness observation, retried within the cycle while its only
   * failures are explicitly transient provider failures, under the cycle's telemetry span.
   * @param signal - Shutdown signal that stops further transient retries.
   * @returns The cycle's final report; `readinessVerdict` decides whether it halts.
   */
  async cycle(signal: AbortSignal): Promise<SetupCheckReport> {
    return withActiveSpan(
      {
        name: 'quoter-bot.cycle',
        attributes: { workflow: 'setup-check' },
        errorName: operatorErrorName,
        failed: checked => !checked.ready
      },
      () => this.checkWithTransientRetries(signal, false)
    )
  }

  private async checkWithTransientRetries(signal?: AbortSignal, startup = true) {
    let report = await this.checkAt(startup)

    for (let attempt = 1; attempt < SETUP_CHECK_TRANSIENT_ATTEMPTS; attempt += 1) {
      if (signal?.aborted === true || !hasOnlyTransientProviderFailures(report)) break
      report = await this.checkAt(startup)
    }

    return report
  }

  /**
   * Evaluates all setup surfaces while isolating provider failures into sanitized report entries.
   * @returns A complete report in stable check order; provider rejection does not short-circuit peers.
   * @remarks Read-only. All independent reads, including per-book reads, start before the outer `Promise.all` is awaited so latency is
   * bounded by the slowest check rather than their sum.
   */
  async check(): Promise<SetupCheckReport> {
    return this.checkAt(true)
  }

  // oxlint-disable-next-line complexity
  private async checkAt(startup: boolean): Promise<SetupCheckReport> {
    const bookReads = this.config.marketIds.map(requestedId => ({
      requestedId,
      response: capture(() => this.state.getBook(requestedId))
    }))
    const debtReads = this.config.marketIds.map(requestedId => ({
      requestedId,
      debt: capture(() => this.state.getDebt(requestedId, this.config.maker)),
      ...(this.config.debt?.has(requestedId)
        ? {
            loanCollateral: capture(() =>
              this.state.getLoanCollateral(requestedId, this.config.maker)
            )
          }
        : {})
    }))
    const derivedSignerRead = this.readOnly
      ? Promise.resolve(undefined)
      : captureSigner(() => this.state.getDerivedSigner())
    const referenceRead = this.referenceRequired
      ? capture(() => this.state.checkReference(), 'archive-rpc')
      : Promise.resolve(undefined)
    // Only meaningful when a variable-rate strategy actually reads the archive provider.
    const referenceChainIdRead = this.referenceRequired
      ? capture(() => this.state.getReferenceChainId(), 'archive-rpc')
      : Promise.resolve(undefined)
    const reads = await Promise.all([
      capture(() => this.state.getChainId()),
      referenceChainIdRead,
      capture(() => this.state.getCode(this.config.midnight)),
      derivedSignerRead,
      this.config.signerMode === 'aws'
        ? Promise.resolve(undefined)
        : capture(() => this.state.getNativeBalance(this.config.maker)),
      capture(() => this.state.getLoanAllowance(this.config.maker, this.config.loanAsset)),
      capture(() => this.state.getRatifier(this.config.maker, this.config.ratifier)),
      Promise.all(bookReads.map(async book => ({ ...book, response: await book.response }))),
      referenceRead,
      capture(() => this.state.inspectOffers(this.config.maker), 'morpho-api'),
      Promise.all(
        debtReads.map(async read => ({
          requestedId: read.requestedId,
          debt: await read.debt,
          ...(read.loanCollateral === undefined
            ? {}
            : { loanCollateral: await read.loanCollateral })
        }))
      )
    ])
    const [
      chainId,
      referenceChainId,
      midnightCode,
      derivedSigner,
      nativeBalance,
      allowance,
      ratifier,
      books,
      reference,
      offers,
      debtPositions
    ] = reads

    const signerRequirement =
      this.config.signerMode === 'aws'
        ? 'AWS KMS signer differs from configured maker'
        : 'local signer equals configured maker'
    const signerMatches =
      derivedSigner !== undefined &&
      derivedSigner.ok &&
      derivedSigner.value !== undefined &&
      (this.config.signerMode === 'aws'
        ? !sameAddress(derivedSigner.value, this.config.maker)
        : sameAddress(derivedSigner.value, this.config.maker))
    const signerCheck =
      derivedSigner === undefined
        ? readOnlySignerCheck()
        : !derivedSigner.ok
          ? 'operation' in derivedSigner.error
            ? {
                name: 'signer' as const,
                status: 'failed' as const,
                observed: derivedSigner.error,
                required: signerRequirement
              }
            : providerFailure('signer', derivedSigner.error, signerRequirement)
          : setupResult(
              'signer',
              signerMatches,
              { derived: derivedSigner.value !== undefined, matches: signerMatches },
              signerRequirement
            )
    const signerAddress = derivedSigner?.ok ? derivedSigner.value : undefined
    const signerReads =
      signerAddress === undefined
        ? undefined
        : await Promise.all([
            this.config.signerMode === 'aws'
              ? capture(() => this.state.getNativeBalance(signerAddress))
              : Promise.resolve(undefined),
            this.config.signerMode === 'aws'
              ? capture(() => this.state.getAuthorization(this.config.maker, signerAddress))
              : Promise.resolve(undefined)
          ])
    const signerNative = signerReads?.[0]
    const signerAuthorization = signerReads?.[1]
    const signerNativeCheck =
      this.readOnly || this.config.signerMode !== 'aws'
        ? {
            name: 'signer-native-balance' as const,
            status: 'not-required' as const,
            observed: { reason: 'signer and maker are not separate' },
            required: 'only for AWS signing'
          }
        : signerNative === undefined
          ? setupResult(
              'signer-native-balance',
              false,
              { derived: false },
              this.config.signerNativeReserve
            )
          : !signerNative.ok
            ? providerFailure(
                'signer-native-balance',
                signerNative.error,
                this.config.signerNativeReserve
              )
            : setupResult(
                'signer-native-balance',
                this.config.signerNativeReserve !== undefined &&
                  signerNative.value >= this.config.signerNativeReserve,
                signerNative.value,
                this.config.signerNativeReserve,
                `fund the AWS signer with native token to at least ${this.config.signerNativeReserve}`
              )
    const signerAuthorizationCheck =
      this.readOnly || this.config.signerMode !== 'aws'
        ? {
            name: 'signer-authorization' as const,
            status: 'not-required' as const,
            observed: { reason: 'delegated authorization is not used' },
            required: 'only for AWS signing'
          }
        : signerAuthorization === undefined
          ? setupResult('signer-authorization', false, { derived: false }, true)
          : !signerAuthorization.ok
            ? providerFailure('signer-authorization', signerAuthorization.error, true)
            : setupResult(
                'signer-authorization',
                signerAuthorization.value,
                signerAuthorization.value,
                true,
                'authorize the AWS signer for the configured maker through Midnight'
              )
    const nativeCheck =
      nativeBalance === undefined
        ? {
            name: 'native-balance' as const,
            status: 'not-required' as const,
            observed: { reason: 'the maker sends no transactions' },
            required: 'not in AWS write mode'
          }
        : this.config.nativeReserve === undefined
          ? setupResult('native-balance', false, { configured: false }, 'a configured reserve')
          : !nativeBalance.ok
            ? providerFailure('native-balance', nativeBalance.error, this.config.nativeReserve)
            : setupResult(
                'native-balance',
                nativeBalance.value >= this.config.nativeReserve,
                nativeBalance.value,
                this.config.nativeReserve,
                `fund the configured maker with native token to at least ${this.config.nativeReserve}`
              )
    const allowanceCheck = !allowance.ok
      ? providerFailure('loan-allowance', allowance.error, { spender: this.config.midnight })
      : loanAllowanceCheck(allowance.value, this.config, startup)
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
            : 'select a canonical SDK ratifier with the expected deployed surface'
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
    const offersRequired = { unknownMarketIds: [], invertedMarketIds: [] }
    const offersCheck = !offers.ok
      ? providerFailure('offers', offers.error, offersRequired)
      : {
          name: 'offers' as const,
          status: unsafeOffersStatus(offers.value),
          observed: offers.value,
          required: offersRequired
        }

    const checks: SetupCheck[] = [
      chainCheck(this.config, chainId, midnightCode, referenceChainId),
      signerCheck,
      nativeCheck,
      signerNativeCheck,
      signerAuthorizationCheck,
      allowanceCheck,
      ratifierCheck,
      booksCheck(this.config, books),
      referenceCheck,
      offersCheck,
      positionHealthCheck(this.config, debtPositions)
    ]
    return { ready: checks.every(check => check.status !== 'failed'), checks }
  }
}
