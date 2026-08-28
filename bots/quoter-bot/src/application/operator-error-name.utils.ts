const KNOWN_NAMES = [
  'BootstrapAdapterError',
  'BootstrapMempoolValidationError',
  'BootstrapHardHaltError',
  'BootstrapOwnershipCleanupError',
  'BootstrapConfigurationError',
  'LadderConfigurationError',
  'LadderAdapterError',
  'LadderHardHaltError',
  'LadderOwnershipCleanupError',
  'MakerAccountError',
  'OfferInvalidationAdapterError',
  'OfferInvalidationFailedError',
  'ReferenceAdapterError',
  'ConfigFileError',
  'ConfigValidationError',
  'ProviderPaginationError',
  'ProviderReadError',
  'ProviderResponseError',
  'SafeProviderError',
  'SetupFailedError',
  'SetupMonitorConfigurationError',
  'SetupMonitorHaltedError',
  'QuoterBotMonitorHaltedError',
  'TypeError',
  'RangeError',
  'URIError'
] as const

// Every BootstrapAdapterError operation is a bot-authored literal, but the field is typed `string`,
// so it is allowlisted rather than passed through: an operator-visible dimension must never be able
// to carry provider text. Keep in sync with the `new BootstrapAdapterError(...)` call sites.
const ADAPTER_OPERATIONS = [
  'cross-book-evidence-missing',
  'group-consumption-read',
  'group-ownership-state',
  'maker-private-key-mismatch',
  'market-continuous-fee',
  'mempool-validation',
  'mempool-validation-after-ratification',
  'missing-owned-group-intent',
  'negative-spread',
  'offer-groups-cursor',
  'offer-groups-item-limit',
  'offer-groups-maker',
  'offer-groups-page-limit',
  'offer-groups-page-size',
  'offer-groups-repeated-cursor',
  'offer-groups-response',
  'offer-groups-timeout',
  'position-unavailable',
  'prospective-offer-missing',
  'publication-after-ratification',
  'publication-reservation-cleanup',
  'rate-window-empty',
  'reference-checkpoint',
  'reference-rate',
  'reference-stale',
  'requirement-signing-policy',
  'retained-group-metadata-refresh',
  'shared-group-reconciliation',
  'target-rate-strategy-missing',
  'transaction-policy',
  'unexpected-requirement'
] as const

/** Stable operator-visible adapter failure reasons safe to use as a grouping dimension. */
type OperatorAdapterOperation = (typeof ADAPTER_OPERATIONS)[number]

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

/**
 * Projects a failure into fixed operator-safe fields and retains a sanitized Mempool asset floor.
 * @param error - Unknown failure from an injected application or provider port.
 * @returns An allowlisted error name, adapter operation, and optional decimal minimum-assets value.
 * @remarks Provider messages, response bodies, URLs, addresses, and credentials are never returned.
 */
export const operatorErrorDetails = (error: unknown) => {
  const errorName = operatorErrorName(error)
  if (typeof error !== 'object' || error === null) return { errorName }

  const details = error as Record<string, unknown>
  const adapterOperation = operatorAdapterOperation(error)
  const minimumAssets = details.minimumAssets
  const cleanupName = details.reservationCleanupErrorName
  const reservationCleanupErrorName =
    typeof cleanupName === 'string' ? knownNames.get(cleanupName) : undefined
  return {
    errorName,
    ...(adapterOperation ? { adapterOperation } : {}),
    ...(errorName === 'BootstrapMempoolValidationError' &&
    typeof minimumAssets === 'bigint' &&
    minimumAssets >= 0n
      ? { minimumAssets: String(minimumAssets) }
      : {}),
    ...(reservationCleanupErrorName ? { reservationCleanupErrorName } : {})
  }
}
