import type { Hex } from 'viem'

import type { BootstrapSubmittedTransaction } from './application/bootstrap/position-bootstrap-verbose'
import type { PositionBootstrapMonitorReport } from './application/bootstrap/position-bootstrap.service'
import type { OfferInvalidationFailureReport } from './application/invalidation/offer-invalidation.service'
import type { LadderMonitorReport } from './application/ladder/ladder-quoter.service'
import type { LadderSubmittedTransaction } from './application/ladder/ladder-verbose'
import type { OperatorAdapterOperation } from './application/monitoring/operator-error-name.utils'
import type { QuoterBotMonitorReport } from './application/quoter-bot/quoter-bot.service'
import type { StartupCleanupReport } from './application/quoter-bot/startup-cleanup.utils'
import type {
  SetupCheckReport,
  SetupCheckMonitorReport
} from './application/setup/setup-check.service'

/** Signals that a confirmed bootstrap cancellation could not be removed from durable ownership. */
export class BootstrapOwnershipCleanupError extends Error {
  readonly code = 'BOOTSTRAP_OWNERSHIP_CLEANUP_FAILED'
  readonly kind = 'cleanup-error'

  /**
   * Creates a sanitized ownership-cleanup failure after an onchain cancellation completed.
   * @param groupId - Confirmed canceled bootstrap group.
   * @param submittedTransactions - Confirmed cancellation transaction retained for reporting.
   * @param cleanupErrorName - Allowlisted classification of the ownership write failure.
   */
  constructor(
    readonly groupId: Hex,
    readonly submittedTransactions: readonly BootstrapSubmittedTransaction[],
    readonly cleanupErrorName: string
  ) {
    super('Bootstrap ownership cleanup failed after confirmed cancellation')
    this.name = 'BootstrapOwnershipCleanupError'
  }
}

/** Sanitized per-market bootstrap outcomes preserved for operator diagnostics. */
type PositionBootstrapHaltReport = readonly Record<string, unknown>[]

/** Expected CLI failure emitted when a bootstrap cycle enters a strategy-wide safety halt. */
export class PositionBootstrapHaltedError extends Error {
  readonly code = 'POSITION_BOOTSTRAP_HALTED'
  readonly kind = 'safety-halt'

  /** Creates the stable, secret-free operator error. @param report - Sanitized bootstrap outcomes. */
  constructor(readonly report: PositionBootstrapHaltReport) {
    super('Position bootstrap halted for safety')
    this.name = 'PositionBootstrapHaltedError'
  }
}

/** Expected CLI failure emitted when continuous position bootstrap halts before shutdown. */
export class PositionBootstrapMonitorHaltedError extends Error {
  readonly code = 'POSITION_BOOTSTRAP_MONITOR_HALTED'
  readonly kind = 'safety-halt'

  /**
   * Creates the stable, secret-free operator error.
   * @param report - Sanitized terminal monitor and cleanup report.
   */
  constructor(readonly report: PositionBootstrapMonitorReport) {
    super('Position bootstrap monitor halted for safety')
    this.name = 'PositionBootstrapMonitorHaltedError'
  }
}

/** Signals that one or more requested offer-group cancellations did not complete safely. */
export class OfferInvalidationFailedError extends Error {
  /**
   * Creates an aggregate failure with sanitized per-group evidence.
   * @param report - Complete failure report containing no provider messages, URLs, or credentials.
   */
  constructor(readonly report: OfferInvalidationFailureReport) {
    super('Offer invalidation failed')
    this.name = 'OfferInvalidationFailedError'
  }
}

/** Sanitized per-market ladder outcomes preserved for operator diagnostics. */
type LadderCycleHaltReport = readonly Record<string, unknown>[]

/** Expected CLI failure emitted when a ladder cycle fails or enters a safety halt. */
export class LadderCycleHaltedError extends Error {
  readonly code = 'LADDER_CYCLE_HALTED'
  readonly kind = 'safety-halt'

  /** Creates the stable, secret-free operator error. @param report - Sanitized ladder outcomes. */
  constructor(readonly report: LadderCycleHaltReport) {
    super('Ladder cycle halted for safety')
    this.name = 'LadderCycleHaltedError'
  }
}

/** Expected CLI failure emitted when continuous ladder monitoring halts before a shutdown signal. */
export class LadderMonitorHaltedError extends Error {
  readonly code = 'LADDER_MONITOR_HALTED'
  readonly kind = 'safety-halt'

  /**
   * Creates the stable, secret-free operator error.
   * @param report - Sanitized terminal monitor and cleanup report.
   */
  constructor(readonly report: LadderMonitorReport) {
    super('Ladder monitor halted for safety')
    this.name = 'LadderMonitorHaltedError'
  }
}

/** Signals that a confirmed ladder cancellation could not be removed from durable ownership. */
export class LadderOwnershipCleanupError extends Error {
  readonly code = 'LADDER_OWNERSHIP_CLEANUP_FAILED'
  readonly kind = 'cleanup-error'

  /**
   * Creates a sanitized ownership-cleanup failure after an onchain cancellation completed.
   * @param groupId - Confirmed canceled ladder group.
   * @param submittedTransactions - Confirmed cancellation transaction retained for reporting.
   * @param cleanupErrorName - Allowlisted classification of the ownership write failure.
   */
  constructor(
    readonly groupId: Hex,
    readonly submittedTransactions: readonly LadderSubmittedTransaction[],
    readonly cleanupErrorName: string
  ) {
    super('Ladder ownership cleanup failed after confirmed cancellation')
    this.name = 'LadderOwnershipCleanupError'
  }
}

/** Expected CLI failure carrying a sanitized halted combined-monitor report. */
export class QuoterBotMonitorHaltedError extends Error {
  readonly name = 'QuoterBotMonitorHaltedError'
  readonly code = 'QUOTER_BOT_MONITOR_HALTED'
  readonly kind = 'safety-halt'

  /**
   * Creates a combined monitor halt from its operator-safe terminal report.
   * @param report - Complete terminal outcomes for setup, bootstrap, and ladder monitoring.
   */
  constructor(readonly report: QuoterBotMonitorReport) {
    super('Quoter bot monitor halted for safety')
  }
}

/** Expected CLI failure after a writer startup failure whose owned-offer cleanup did not complete. */
export class StartupCleanupFailedError extends Error {
  readonly name = 'StartupCleanupFailedError'
  readonly code = 'STARTUP_CLEANUP_FAILED'
  readonly kind = 'cleanup-error'

  /**
   * Creates the failure from its operator-safe report.
   * @param report - Startup failure classification and each strategy's sanitized cleanup outcome.
   */
  constructor(readonly report: StartupCleanupReport) {
    super('Startup failed and owned offers may still be live')
  }
}

/** Allowlisted provider failure metadata safe for operator-visible reports. */
export type SafeProviderFailure = {
  kind: 'provider-error'
  provider: 'provider' | 'rpc' | 'archive-rpc' | 'morpho-api' | 'router-api'
  name: string
  code?: string | number
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

/** Signals that startup readiness stopped because shutdown interrupted a transient provider retry. */
export class SetupCheckAbortedError extends Error {
  /** Creates a fixed, sanitized abort error for an interrupted setup check. */
  constructor() {
    super('Setup check aborted')
    this.name = 'AbortError'
  }
}

/** Signals that the complete read-only setup report contains one or more failed checks. */
export class SetupFailedError extends Error {
  /**
   * Creates a stable readiness failure while retaining every sanitized check result.
   * @param report - Complete operator-safe report; it must not contain provider URLs or credentials.
   */
  constructor(readonly report: SetupCheckReport) {
    const failed = report.checks.filter(check => check.status === 'failed')
    super(`Setup check failed: ${failed.map(check => check.name).join(', ')}`)
    this.name = 'SetupFailedError'
  }
}

/** Expected setup-monitor interval validation failure with no rejected value attached. */
export class SetupMonitorConfigurationError extends Error {
  readonly name = 'SetupMonitorConfigurationError'
  readonly code = 'INVALID_SETUP_MONITOR_CONFIGURATION'
  readonly kind = 'configuration'

  /** Creates a sanitized setup-monitor configuration error. */
  constructor() {
    super('Setup monitor interval must be a positive safe integer')
  }
}

/** Expected terminal error carrying a sanitized halted setup-monitor report. */
export class SetupMonitorHaltedError extends Error {
  readonly name = 'SetupMonitorHaltedError'
  readonly code = 'SETUP_MONITOR_HALTED'
  readonly kind = 'monitor-halt'

  /**
   * Creates a setup-monitor halt from its operator-safe terminal report.
   * @param report - Halted lifecycle report with only an allowlisted error classification.
   */
  constructor(readonly report: SetupCheckMonitorReport & { status: 'halted' }) {
    super('Setup monitor halted')
  }
}

/** Signals a sanitized YAML configuration file selection, access, size, or structure failure. */
export class ConfigFileError extends Error {
  readonly code = 'CONFIG_FILE_ERROR'
  readonly kind = 'configuration'

  /**
   * Creates an operator-safe file failure without retaining paths or file contents.
   * @param reason - Stable reason code used to select the sanitized error message.
   */
  constructor(
    readonly reason:
      | 'missing-explicit'
      | 'unreadable-explicit'
      | 'unreadable-discovered'
      | 'unsupported-extension'
      | 'too-large'
      | 'empty'
      | 'malformed'
      | 'invalid-root'
      | 'unknown-key'
  ) {
    const messages = {
      'missing-explicit': 'Explicit configuration file does not exist',
      'unreadable-explicit': 'Explicit configuration file is unreadable',
      'unreadable-discovered': 'Discovered configuration file is unreadable',
      'unsupported-extension': 'Explicit configuration file must use a .yaml or .yml extension',
      'too-large': 'Configuration file exceeds the maximum supported size',
      empty: 'Configuration file must not be empty',
      malformed: 'Configuration file contains malformed YAML',
      'invalid-root': 'Configuration file root must be a mapping',
      'unknown-key': 'Configuration file contains an unsupported key'
    } as const
    super(messages[reason])
    this.name = 'ConfigFileError'
  }
}

/** Signals invalid runtime configuration without retaining the rejected value. */
export class ConfigValidationError extends Error {
  /**
   * Creates a configuration failure from safe field and reason identifiers.
   * @param field - Environment field name; never the field value.
   * @param reason - Stable validation reason containing no rejected input.
   * @param message - Operator-facing message that must not interpolate secrets or provider URLs.
   * @param options - Optional internal cause; callers must not serialize nested third-party errors.
   */
  constructor(
    readonly field: string,
    readonly reason: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'ConfigValidationError'
  }
}

/** Identifies an unsafe bootstrap strategy setting before an offer is derived. */
export class BootstrapConfigurationError extends Error {
  override readonly name = 'BootstrapConfigurationError'

  /**
   * Creates a safe field-scoped strategy configuration failure.
   * @param field - Non-secret configuration field that failed validation.
   * @param reason - Stable operator-facing reason without rejected provider or secret values.
   */
  constructor(
    readonly field: string,
    readonly reason: string
  ) {
    super(`${field} ${reason}`)
  }
}

/** Expected failure raised when a ladder shape or runtime decision violates a safety invariant. */
export class LadderConfigurationError extends Error {
  /**
   * Creates a sanitized ladder configuration failure.
   * @param field - Stable rejected field or derived-value name.
   * @param reason - Operator-safe invariant description with no untrusted input.
   */
  constructor(
    readonly field: string,
    readonly reason: string
  ) {
    super(`${field} ${reason}`)
    this.name = 'LadderConfigurationError'
  }
}

/** Stable production-adapter failure without provider URLs, payloads, or secret material. */
export class BootstrapAdapterError extends Error {
  readonly code = 'BOOTSTRAP_ADAPTER_FAILED'
  readonly kind = 'provider-error'
  reservationCleanupErrorName?: string
  confirmedTransactions: readonly BootstrapSubmittedTransaction[] = []

  /** Creates a sanitized failure for one fixed adapter operation. @param operation - Stable operation code. */
  constructor(readonly operation: OperatorAdapterOperation) {
    super('Position bootstrap adapter failed')
    this.name = 'BootstrapAdapterError'
  }

  /**
   * Retains a sanitized rollback-storage failure without replacing the primary adapter failure.
   * @param errorName - Allowlisted classification of the reservation cleanup failure.
   * @returns This original adapter failure with supplementary cleanup diagnostics.
   */
  recordReservationCleanupFailure(errorName: string) {
    this.reservationCleanupErrorName = errorName
    return this
  }

  /**
   * Retains confirmed transactions that completed before this adapter failure.
   * @param transactions - Confirmed protocol mutations in submission order.
   * @returns This original adapter failure with supplementary transaction evidence.
   */
  recordConfirmedTransactions(transactions: readonly BootstrapSubmittedTransaction[]) {
    this.confirmedTransactions = [...transactions]
    return this
  }
}

/** Sanitized cancellation failure produced after a complete hard-halt cleanup attempt. */
type BootstrapHardHaltFailure = { groupId: Hex; errorName: string }

/** Deterministic aggregate failure after every strategy-owned group cancellation was attempted. */
export class BootstrapHardHaltError extends Error {
  readonly code = 'BOOTSTRAP_HARD_HALT_FAILED'
  readonly kind = 'cleanup-error'

  /** Creates a sanitized aggregate. @param failures - Ordered group IDs and allowlisted error names. */
  constructor(readonly failures: readonly BootstrapHardHaltFailure[]) {
    super('Position bootstrap hard-halt cleanup failed')
    this.name = 'BootstrapHardHaltError'
  }
}

/** Sanitized Midnight Mempool policy issue retained at the infrastructure boundary. */
export type BootstrapMempoolValidationIssue = {
  rule: string
  minimumAssets?: bigint
}

/** Expected rejection of a prospective bootstrap offer by Midnight Mempool policy. */
export class BootstrapMempoolValidationError extends Error {
  readonly code = 'BOOTSTRAP_MEMPOOL_VALIDATION_FAILED'
  readonly kind = 'validation-error'
  readonly minimumAssets?: bigint

  /**
   * Creates a sanitized policy failure without retaining provider messages or response bodies.
   * @param issues - Allowlisted rule names and safe numeric details returned by the boundary mapper.
   */
  constructor(readonly issues: readonly BootstrapMempoolValidationIssue[]) {
    super('Position bootstrap offer failed Midnight Mempool validation')
    this.name = 'BootstrapMempoolValidationError'
    this.minimumAssets = issues
      .map(issue => issue.minimumAssets)
      .filter((value): value is bigint => value !== undefined)
      .reduce<bigint | undefined>(
        (largest, value) => (largest === undefined || value > largest ? value : largest),
        undefined
      )
  }
}

/** Signals invalid CLI usage without retaining user-controlled arguments or Commander details. */
export class CliUsageError extends Error {
  readonly code = 'INVALID_USAGE' as const
  readonly kind = 'usage' as const

  /**
   * Creates a deterministic usage failure containing only stable allowlisted fields.
   * @remarks Raw arguments, command text, option names/values, URLs, and nested causes are discarded.
   */
  constructor() {
    super('Invalid command-line usage; rerun with --help for usage')
    this.name = 'CliUsageError'
  }
}

/** Stable cancellation-adapter failure without provider data, endpoints, or credentials. */
export class OfferInvalidationAdapterError extends Error {
  readonly code = 'OFFER_INVALIDATION_ADAPTER_FAILED'
  readonly kind = 'provider-error'

  /** Creates one sanitized adapter failure. @param operation - Stable failed operation code. */
  constructor(readonly operation: OperatorAdapterOperation) {
    super('Offer invalidation adapter failed')
    this.name = 'OfferInvalidationAdapterError'
  }
}

/** Stable production ladder-adapter failure without provider data or credentials. */
export class LadderAdapterError extends Error {
  readonly code = 'LADDER_ADAPTER_FAILED'
  readonly kind = 'provider-error'
  confirmedTransactions: readonly LadderSubmittedTransaction[] = []

  /** Creates one sanitized adapter failure. @param operation - Stable failed operation code. */
  constructor(readonly operation: OperatorAdapterOperation) {
    super('Ladder adapter failed')
    this.name = 'LadderAdapterError'
  }

  /**
   * Retains confirmed transactions that completed before this adapter failure.
   * @param transactions - Confirmed protocol mutations in submission order.
   * @returns This original adapter failure with supplementary transaction evidence.
   */
  recordConfirmedTransactions(transactions: readonly LadderSubmittedTransaction[]) {
    this.confirmedTransactions = [...transactions]
    return this
  }
}

/** One sanitized ladder cleanup failure. */
type LadderHardHaltFailure = { groupId: Hex; errorName: string }

/** Aggregate failure raised after every owned ladder group has been attempted. */
export class LadderHardHaltError extends Error {
  readonly code = 'LADDER_HARD_HALT_FAILED'
  readonly kind = 'cleanup-error'

  /** Creates the aggregate. @param failures - Ordered group IDs and sanitized error names. */
  constructor(readonly failures: readonly LadderHardHaltFailure[]) {
    super('Ladder hard-halt cleanup failed')
    this.name = 'LadderHardHaltError'
  }
}

/** Signals that bounded provider pagination violated a stable safety invariant. */
export class ProviderPaginationError extends Error {
  /**
   * Creates a pagination failure using no cursor value, URL, response body, or credential.
   * @param provider - Fixed provider identifier safe for operator-visible reports.
   * @param reason - Stable pagination reason containing no cursor or response data.
   * @param message - Sanitized operator-facing invariant failure message.
   */
  constructor(
    readonly provider: SafeProviderFailure['provider'],
    readonly reason: string,
    message: string
  ) {
    super(message)
    this.name = 'ProviderPaginationError'
  }
}

/** Identifies an infrastructure provider without retaining its URL or credentials. */
export type ProviderId = 'rpc' | 'archive-rpc' | 'morpho-api' | 'router-api'

/** Enumerates safe operation codes exposed by setup-state provider boundaries. */
export type ProviderOperation =
  | 'chain-id'
  | 'contract-code'
  | 'native-balance'
  | 'signer-latest-nonce'
  | 'signer-pending-nonce'
  | 'signer-authorization'
  | 'loan-allowance'
  | 'ratifier-registry'
  | 'ratifier-code'
  | 'ratifier-midnight'
  | 'ratifier-root'
  | 'ratifier-authorization'
  | 'market-listing'
  | 'book-market'
  | 'book-tick-spacing'
  | 'market-loss-factor'
  | 'reference-chain-id'
  | 'reference-latest-block'
  | 'reference-historical-block'
  | 'reference-market-params'
  | 'reference-market-state'
  | 'reference-latest-market-state'
  | 'offer-groups'

/** Allowlisted provider-error fields safe to expose in setup reports and retry classification. */
export type SafeProviderReadMetadata = {
  name?: 'AbortError' | 'TimeoutError' | 'NetworkError' | 'HttpError'
  code?:
    | 'ECONNREFUSED'
    | 'ECONNRESET'
    | 'ENETUNREACH'
    | 'ETIMEDOUT'
    | 'ABORT_ERR'
    | 'UND_ERR_CONNECT_TIMEOUT'
    | 'UND_ERR_HEADERS_TIMEOUT'
    | number
  status?: number
}

/** Signals a sanitized failure at a public read-only provider boundary. */
export class ProviderReadError extends Error {
  readonly code = 'PROVIDER_READ_FAILED' as const
  readonly failure: Record<string, unknown>
  readonly provider: ProviderId
  readonly operation: ProviderOperation

  /**
   * Creates a deterministic provider-read failure from allowlisted identifiers only.
   * @param provider - Fixed provider identifier; never a URL, host, or transport message.
   * @param operation - Stable code for the attempted read; never request or response content.
   * @param metadata - Allowlisted error name, code, and status copied into sanitized failure
   * metadata for operator reporting and transient-retry classification.
   * @remarks The rejected value is deliberately discarded, including its message, stack, and cause.
   */
  constructor(
    provider: ProviderId,
    operation: ProviderOperation,
    metadata: SafeProviderReadMetadata = {}
  ) {
    super('Provider read failed')
    this.name = 'ProviderReadError'
    this.provider = provider
    this.operation = operation
    this.failure = {
      kind: 'provider-error',
      provider,
      name: metadata.name ?? 'ProviderError',
      code: metadata.code ?? this.code,
      ...(metadata.status === undefined ? {} : { status: metadata.status }),
      context: 'read'
    }
  }
}

/** Signals a malformed or inconsistent provider result using only allowlisted safe metadata. */
export class ProviderResponseError extends Error {
  readonly failure: Record<string, unknown>
  readonly provider: 'provider' | 'rpc' | 'archive-rpc' | 'morpho-api' | 'router-api'
  readonly operation: string

  /**
   * Creates a provider response failure without retaining response bodies, URLs, or credentials.
   * @param provider - Fixed provider identifier safe for operator-visible reports.
   * @param operation - Stable operation identifier that contains no request data.
   * @param message - Sanitized invariant failure message containing no untrusted provider text.
   * @remarks Response bodies, URLs, credentials, and nested third-party causes are never retained.
   */
  constructor(
    provider: 'provider' | 'rpc' | 'archive-rpc' | 'morpho-api' | 'router-api',
    operation: string,
    message: string
  ) {
    super(message)
    this.name = 'ProviderResponseError'
    this.provider = provider
    this.operation = operation
    this.failure = {
      kind: 'provider-error',
      provider,
      name: 'ProviderError',
      context: 'read'
    }
  }
}

/** Stable shared reference-reader failure without provider details. */
export class ReferenceAdapterError extends Error {
  readonly code = 'REFERENCE_ADAPTER_FAILED'
  readonly kind = 'provider-error'

  /** Creates one sanitized reference failure. @param operation - Stable failed operation code. */
  constructor(readonly operation: OperatorAdapterOperation) {
    super('Reference adapter failed')
    this.name = 'ReferenceAdapterError'
  }
}

/**
 * Signals strategy state this version cannot trust: unreadable, or written by an earlier version.
 * @remarks Its message is the whole operator procedure; see the README's "Upgrading to unit-capped
 * offers".
 */
export class StrategyStateVersionError extends Error {
  /** Creates the operator-facing failure; it carries no path or file contents. */
  constructor() {
    super(
      'Strategy state is unreadable or was written by an earlier quoter-bot version. Stop that ' +
        'version, confirm with its `invalidate --readonly` that no offer group remains, delete ' +
        'the strategy state directory ' +
        '($XDG_STATE_HOME/morpho-quoter-bot, by default ~/.local/state/morpho-quoter-bot), then ' +
        'start this version.'
    )
    this.name = 'StrategyStateVersionError'
  }
}

/** Sanitized failure from the guarded quoter transaction lifecycle. */
export class QuoterTransactionError extends Error {
  readonly name = 'QuoterTransactionError'

  /**
   * Creates a credential-free transaction lifecycle failure.
   * @param operation - Sanitized lifecycle stage that failed.
   */
  constructor(
    readonly operation: Extract<
      OperatorAdapterOperation,
      | 'configuration'
      | 'simulation-reverted'
      | 'submission-refused'
      | 'transaction-reverted'
      | 'transaction-dropped'
      | 'transaction-pending'
      | 'reconciliation-required'
      | 'unknown-pending-nonce'
    >
  ) {
    super(`Quoter transaction ${operation}`)
  }
}

/** Sanitized signer-construction or remote-signing failure. */
export class SignerAccountError extends Error {
  readonly name = 'SignerAccountError'

  /**
   * Creates a sanitized account failure from an allowlisted operation only.
   * @param operation - Stable signer operation that failed without retaining secret material.
   */
  constructor(
    readonly operation:
      | 'signer-address'
      | 'keystore-read'
      | 'keystore-decrypt'
      | 'kms-public-key'
      | 'kms-sign'
  ) {
    super(`Signer account ${operation} failed`)
  }
}
