import type { MarketReport } from './application/engine/market-report'
import type { Read } from './application/engine/readings'
import type { OperatorAdapterOperation } from './application/monitoring/operator-error-name.utils'
import type { SetupCheckReport } from './application/setup/setup-check.service'
import type { OfferInvalidationFailureReport } from './infrastructure/invalidation/offer-invalidation'

/** Carries a failed read through a derivation, so the derivation fails with that same read. */
export class FailedReadError extends Error {
  /**
   * Wraps the failed read so the derivation reports it unchanged.
   * @param failure - The failed read the derivation consumed.
   */
  constructor(readonly failure: Extract<Read<never>, { ok: false }>) {
    super('A derivation input failed to read')
    this.name = 'FailedReadError'
  }
}

/** A market decision has no usable input; the controller then withdraws that market's offers. */
export class QuoterReadingUnavailableError extends Error {
  /**
   * Names the missing decision input in the operator-safe message.
   * @param input - Name of the input that had no usable value.
   */
  constructor(readonly input: string) {
    super(`no usable ${input}`)
    this.name = 'QuoterReadingUnavailableError'
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

/** How a quoter run ended, from the controller's report and the markets' own reports. */
export type QuoterRunReport = Readonly<{
  status: 'stopped' | 'failed' | 'halted'
  /**
   * `market-failed`: a one-shot run settled with a market failed or halted; `halted`: the
   * controller halted, `halt` says why; `graph-error`: the decision graph itself failed;
   * `cleanup-failed`: the kernel stopped with commitments it could not withdraw.
   */
  reason: 'signal' | 'market-failed' | 'halted' | 'graph-error' | 'cleanup-failed'
  halt?: string
  errorName?: string
  setupReady?: boolean
  /** The error a setup monitoring cycle threw, when one halted the run. */
  cycleErrorName?: string
  /** A one-shot run's final report per market; a continuous run's last poll with a failure. */
  markets?: readonly MarketReport[]
}>

/** Expected CLI failure: a run that halted, failed to clean up, or ended with a market failed. */
export class QuoterRunFailedError extends Error {
  readonly name = 'QuoterRunFailedError'
  readonly code = 'QUOTER_RUN_FAILED'
  readonly kind = 'safety-halt'

  /**
   * Carries the run's terminal report for the CLI to print and exit on.
   * @param report - The run's operator-safe terminal report.
   */
  constructor(readonly report: QuoterRunReport) {
    super('Quoter run failed')
  }
}

type StrategyCleanupOutcome =
  | {
      status: 'succeeded'
      transactions: readonly { operation: 'cancel' | 'ratify' | 'publish'; txHash: string }[]
    }
  | { status: 'failed'; errorName: string; adapterOperation?: string }

/** Sanitized evidence that a writer startup failed and its owned-offer cleanup did not complete. */
type StartupCleanupReport = {
  reason: 'startup-cleanup-failed'
  errorName: string
  adapterOperation?: string
  ladder: StrategyCleanupOutcome
  bootstrap: StrategyCleanupOutcome
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

  /** Creates a sanitized failure for one fixed adapter operation. @param operation - Stable operation code. */
  constructor(readonly operation: OperatorAdapterOperation) {
    super('Position bootstrap adapter failed')
    this.name = 'BootstrapAdapterError'
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

/** A run that waits to settle saw one of its acts end other than settled. */
export class ActFailedError extends Error {
  readonly name = 'ActFailedError'

  /**
   * Records which act ended unsettled and how the kernel reported it.
   * @param key - Controller key of the act's market.
   * @param notice - The kernel's terminal notice for the act.
   * @param reason - The kernel's reason, when it gave one.
   */
  constructor(
    readonly key: string,
    readonly notice: string,
    readonly reason?: string
  ) {
    super(`an act for ${key} ended ${notice}`)
  }
}

/** The kernel did not reach `running`, or did not withdraw the commitments an earlier run left open. */
export class KernelRefusedError extends Error {
  readonly name = 'KernelRefusedError'

  /**
   * Names which kernel gate the run could not pass.
   * @param reason - `start` when the kernel refused to run, `adopted` when earlier commitments stayed open.
   */
  constructor(readonly reason: 'start' | 'adopted') {
    super(
      reason === 'start'
        ? 'the kernel refused to start'
        : 'the kernel did not withdraw the commitments an earlier run left open'
    )
  }
}

/** The quoter could not open its gate; its kernel was stopped first, and `report` says how. */
export class QuoterStartError extends Error {
  readonly name = 'QuoterStartError'

  /**
   * Reports a failed start together with how the kernel stopped afterwards.
   * @param cause - The failure that kept the gate closed.
   * @param report - How the kernel stopped and why.
   */
  constructor(
    cause: unknown,
    readonly report: Readonly<{ outcome: 'clean' | 'unsafe' | 'refused'; reason: string }>
  ) {
    super(`the quoter did not start; its kernel stopped ${report.outcome}`, { cause })
  }
}

/** The kernel asked for a step's payload that no act this run submitted planned. */
export class UnplannedPublicationError extends Error {
  readonly name = 'UnplannedPublicationError'

  /** Fails the step closed rather than signing a payload no act planned. */
  constructor() {
    super('no publication was planned for this step')
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

/** What a dry world refuses: anything it cannot fake, or an effect withdrawn before it ran. */
export class DryRunError extends Error {
  readonly name = 'DryRunError'
}

/** The kernel stopped with commitments or transactions still open; its `kernel.stopped` record counts them. */
export class KernelStopError extends Error {
  readonly name = 'KernelStopError'

  /** Fails the run so the operator sees the open commitments in `kernel.stopped`. */
  constructor() {
    super('Kernel stopped with commitments still open')
  }
}

/** A kernel ledger on disk that the kernel's own validation refuses; nothing reads its entries. */
export class LedgerRefusedError extends Error {
  readonly name = 'LedgerRefusedError'

  /**
   * Names why the kernel refused the ledger.
   * @param reason - The kernel's reason, such as a retired format or a malformed record.
   */
  constructor(readonly reason: string) {
    super(`the kernel ledger was refused: ${reason}`)
  }
}

/** Stable production ladder-adapter failure without provider data or credentials. */
export class LadderAdapterError extends Error {
  readonly code = 'LADDER_ADAPTER_FAILED'
  readonly kind = 'provider-error'

  /** Creates one sanitized adapter failure. @param operation - Stable failed operation code. */
  constructor(readonly operation: OperatorAdapterOperation) {
    super('Ladder adapter failed')
    this.name = 'LadderAdapterError'
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
  | 'position-debt'
  | 'borrow-market'
  | 'borrow-block'
  | 'loan-collateral'
  | 'loan-collateral-oracle'
  | 'enter-gate'
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

/** The shared offer-group reader's failures, in setup's sanitized provider-failure shape. */
export class OfferGroupsReadError extends Error {
  readonly provider = 'morpho-api'
  readonly failure = {
    kind: 'provider-error',
    provider: 'morpho-api',
    name: 'ProviderError',
    context: 'read'
  }

  /**
   * Reports a failed offer-group read under its fixed operation name.
   * @param operation - The reader's fixed operation name; never provider text.
   */
  constructor(readonly operation: string) {
    super('Morpho API offer-group read failed')
    this.name = 'OfferGroupsReadError'
  }
}

/**
 * Signals strategy state this version cannot trust: unreadable, or written by a pre-kernel version.
 * @remarks Its message is the whole operator procedure; see the README's "Upgrading to the kernel".
 */
export class StrategyStateVersionError extends Error {
  /** Creates the operator-facing failure; it carries no path or file contents. */
  constructor() {
    super(
      'Strategy state is unreadable or was written by a pre-kernel quoter-bot version. Stop that ' +
        'version, confirm with its `invalidate --readonly` that no offer group remains, delete its ' +
        '0x….json files from the strategy state directory ' +
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
      | 'signer-identity-mismatch'
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
