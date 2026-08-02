/** Stable operator-visible error classifications permitted at injected application boundaries. */
type OperatorErrorName =
  | 'BootstrapAdapterError'
  | 'BootstrapMempoolValidationError'
  | 'BootstrapHardHaltError'
  | 'BootstrapOwnershipCleanupError'
  | 'BootstrapConfigurationError'
  | 'LadderConfigurationError'
  | 'LadderAdapterError'
  | 'LadderHardHaltError'
  | 'LadderOwnershipCleanupError'
  | 'OfferInvalidationAdapterError'
  | 'OfferInvalidationFailedError'
  | 'ReferenceAdapterError'
  | 'ConfigFileError'
  | 'ConfigValidationError'
  | 'ProviderPaginationError'
  | 'ProviderReadError'
  | 'ProviderResponseError'
  | 'SafeProviderError'
  | 'SetupFailedError'
  | 'SetupMonitorConfigurationError'
  | 'SetupMonitorHaltedError'
  | 'TypeError'
  | 'RangeError'
  | 'URIError'
  | 'UnknownError'

const knownNames: Readonly<Record<string, OperatorErrorName>> = {
  BootstrapAdapterError: 'BootstrapAdapterError',
  BootstrapMempoolValidationError: 'BootstrapMempoolValidationError',
  BootstrapHardHaltError: 'BootstrapHardHaltError',
  BootstrapOwnershipCleanupError: 'BootstrapOwnershipCleanupError',
  BootstrapConfigurationError: 'BootstrapConfigurationError',
  LadderConfigurationError: 'LadderConfigurationError',
  LadderAdapterError: 'LadderAdapterError',
  LadderHardHaltError: 'LadderHardHaltError',
  LadderOwnershipCleanupError: 'LadderOwnershipCleanupError',
  OfferInvalidationAdapterError: 'OfferInvalidationAdapterError',
  OfferInvalidationFailedError: 'OfferInvalidationFailedError',
  ReferenceAdapterError: 'ReferenceAdapterError',
  ConfigFileError: 'ConfigFileError',
  ConfigValidationError: 'ConfigValidationError',
  ProviderPaginationError: 'ProviderPaginationError',
  ProviderReadError: 'ProviderReadError',
  ProviderResponseError: 'ProviderResponseError',
  SafeProviderError: 'SafeProviderError',
  SetupFailedError: 'SetupFailedError',
  SetupMonitorConfigurationError: 'SetupMonitorConfigurationError',
  SetupMonitorHaltedError: 'SetupMonitorHaltedError',
  TypeError: 'TypeError',
  RangeError: 'RangeError',
  URIError: 'URIError'
}

/**
 * Maps an untrusted thrown value to a fixed operator-visible classification.
 * @param error - Unknown failure from an injected application or provider port.
 * @returns A fixed allowlisted name, or `UnknownError`; no arbitrary error text is returned.
 * @remarks This pure projection never returns messages, URLs, credentials, or raw custom names.
 */
export const operatorErrorName = (error: unknown): OperatorErrorName =>
  error instanceof Error ? (knownNames[error.name] ?? 'UnknownError') : 'UnknownError'

/**
 * Projects a failure into fixed operator-safe fields and retains a sanitized Mempool asset floor.
 * @param error - Unknown failure from an injected application or provider port.
 * @returns An allowlisted error name and optional decimal minimum-assets value.
 * @remarks Provider messages, response bodies, URLs, addresses, and credentials are never returned.
 */
export const operatorErrorDetails = (error: unknown) => {
  const errorName = operatorErrorName(error)
  if (
    errorName !== 'BootstrapMempoolValidationError' ||
    typeof error !== 'object' ||
    error === null
  ) {
    return { errorName }
  }

  const minimumAssets = (error as Record<string, unknown>).minimumAssets
  return {
    errorName,
    ...(typeof minimumAssets === 'bigint' && minimumAssets >= 0n
      ? { minimumAssets: String(minimumAssets) }
      : {})
  }
}
