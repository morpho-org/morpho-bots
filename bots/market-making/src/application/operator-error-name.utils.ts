/** Stable operator-visible error classifications permitted at injected application boundaries. */
type OperatorErrorName =
  | 'BootstrapAdapterError'
  | 'BootstrapConfigurationError'
  | 'ConfigFileError'
  | 'ConfigValidationError'
  | 'ProviderPaginationError'
  | 'ProviderReadError'
  | 'ProviderResponseError'
  | 'SafeProviderError'
  | 'SetupFailedError'
  | 'TypeError'
  | 'RangeError'
  | 'URIError'
  | 'UnknownError'

const knownNames: Readonly<Record<string, OperatorErrorName>> = {
  BootstrapAdapterError: 'BootstrapAdapterError',
  BootstrapConfigurationError: 'BootstrapConfigurationError',
  ConfigFileError: 'ConfigFileError',
  ConfigValidationError: 'ConfigValidationError',
  ProviderPaginationError: 'ProviderPaginationError',
  ProviderReadError: 'ProviderReadError',
  ProviderResponseError: 'ProviderResponseError',
  SafeProviderError: 'SafeProviderError',
  SetupFailedError: 'SetupFailedError',
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
