const KNOWN_NAMES = [
  'BootstrapAdapterError',
  'BootstrapMempoolValidationError',
  'BootstrapConfigurationError',
  'LadderConfigurationError',
  'LadderAdapterError',
  'SignerAccountError',
  'QuoterTransactionError',
  'KernelPlanError',
  'KernelStopError',
  'KernelRefusedError',
  'FeeLimitError',
  'SignWithdrawnError',
  'PolicyViolationError',
  'PreparedTransactionError',
  'MissingBlockTimeError',
  'FinalityBeyondWindowError',
  'NoCommitmentsError',
  'KernelConfigError',
  'LedgerRefusedError',
  'ActFailedError',
  'QuoterReadingUnavailableError',
  'OfferInvalidationAdapterError',
  'OfferInvalidationFailedError',
  'ReferenceAdapterError',
  'ConfigFileError',
  'ConfigValidationError',
  'ProviderReadError',
  'ProviderResponseError',
  'OfferGroupsReadError',
  'SafeProviderError',
  'SetupFailedError',
  'StrategyStateVersionError',
  'QuoterRunFailedError',
  'StartupCleanupFailedError',
  'TypeError',
  'RangeError',
  'URIError',
  'HttpRequestError',
  'TimeoutError',
  'RpcRequestError',
  'LimitExceededRpcError',
  'InternalRpcError',
  'ResourceNotFoundRpcError',
  'ResourceUnavailableRpcError',
  'InvalidParamsRpcError',
  'MethodNotSupportedRpcError',
  'UnknownRpcError',
  'BlockNotFoundError',
  'CallExecutionError',
  'ContractFunctionExecutionError',
  'ContractFunctionRevertedError',
  'ContractFunctionZeroDataError',
  'ChainMismatchError'
] as const

const ADAPTER_OPERATIONS = [
  'book-response',
  'book-timeout',
  'borrowing-closed',
  'cash-capped-buy-group',
  'configuration',
  'cross-book-evidence-missing',
  'empty-ladder',
  'group-consumption-read',
  'group-ownership-state',
  'head-behind-world',
  'latest-block',
  'loss-factor-read',
  'market-configuration-missing',
  'market-continuous-fee',
  'market-matured',
  'mempool-validation',
  'mempool-validation-after-ratification',
  'missing-owned-group-intent',
  'negative-spread',
  'offer-groups-cursor',
  'offer-groups-item-limit',
  'offer-groups-maker',
  'offer-groups-page-limit',
  'offer-groups-page-size',
  'offer-groups-read',
  'offer-groups-repeated-cursor',
  'offer-groups-response',
  'offer-groups-timeout',
  'position-unavailable',
  'preflight',
  'publication-reservation-missing',
  'rate-out-of-range',
  'rate-window-empty',
  'reconciliation-required',
  'reference-checkpoint',
  'reference-history',
  'reference-rate',
  'reference-stale',
  'reference-uninitialized',
  'shared-group-reconciliation',
  'signer-identity-mismatch',
  'simulation-reverted',
  'snapshot-unavailable',
  'submission-refused',
  'target-rate-strategy-missing',
  'transaction-dropped',
  'transaction-pending',
  'transaction-reverted',
  'unexpected-requirement',
  'unknown-pending-nonce',
  'unowned-group',
  'unsupported-ratifier'
] as const

/**
 * Stable operator-visible adapter failure reasons safe to use as a grouping dimension.
 * @remarks Adapter error constructors take this type, so a new reason must be listed here before it
 * can be thrown; that is what keeps the shipped `adapterOperation` free of provider text.
 */
export type OperatorAdapterOperation = (typeof ADAPTER_OPERATIONS)[number]

/** A strategy's adapter error, injected into readers both strategies share. */
export type OperatorAdapterErrorClass = new (operation: OperatorAdapterOperation) => Error

const adapterOperations: ReadonlySet<string> = new Set(ADAPTER_OPERATIONS)

/**
 * Projects an adapter failure's specific operation when it is an allowlisted reason.
 * @param error - Unknown failure from an injected application or provider port.
 * @returns The allowlisted adapter operation, or `undefined` for any other failure.
 * @remarks Distinguishes reasons that {@link operatorErrorName} collapses into one class, so a
 * guardrail signal can key on the exact failure instead of every adapter error. Never returns
 * messages, URLs, credentials, or unrecognized operation names.
 */
export const operatorAdapterOperation = (error: unknown): OperatorAdapterOperation | undefined => {
  if (typeof error !== 'object' || error === null) return undefined
  const operation = (error as { operation?: unknown }).operation
  return typeof operation === 'string' && adapterOperations.has(operation)
    ? (operation as OperatorAdapterOperation)
    : undefined
}

/**
 * Projects an adapter failure's allowlisted operation into an optional operator-visible field.
 * @param error - Unknown failure from an injected application or provider port.
 * @returns `{ adapterOperation }` for an allowlisted reason, or an empty object otherwise.
 * @remarks Returns a spreadable object so callers never emit an `undefined` `adapterOperation` key.
 * Sanitization rules are documented on {@link operatorAdapterOperation}.
 */
export const adapterOperationField = (error: unknown) => {
  const adapterOperation = operatorAdapterOperation(error)
  return adapterOperation ? { adapterOperation } : {}
}

/** Stable operator-visible error classifications permitted at injected application boundaries. */
type OperatorErrorName = (typeof KNOWN_NAMES)[number] | 'UnknownError'

const knownNames: ReadonlyMap<string, OperatorErrorName> = new Map(
  KNOWN_NAMES.map(name => [name, name])
)

/**
 * Maps an untrusted thrown value to a fixed operator-visible classification.
 * @param error - Unknown failure from an injected application or provider port.
 * @returns A fixed allowlisted name, or `UnknownError`; no arbitrary error text is returned.
 * @remarks This pure projection never returns messages, URLs, credentials, or raw custom names.
 */
export const operatorErrorName = (error: unknown): OperatorErrorName =>
  error instanceof Error ? (knownNames.get(error.name) ?? 'UnknownError') : 'UnknownError'
