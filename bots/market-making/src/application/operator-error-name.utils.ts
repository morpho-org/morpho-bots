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
  'MarketMakingMonitorHaltedError',
  'TypeError',
  'RangeError',
  'URIError'
] as const

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
 * @returns An allowlisted error name and optional decimal minimum-assets value.
 * @remarks Provider messages, response bodies, URLs, addresses, and credentials are never returned.
 */
export const operatorErrorDetails = (error: unknown) => {
  const errorName = operatorErrorName(error)
  if (typeof error !== 'object' || error === null) return { errorName }

  const details = error as Record<string, unknown>
  const minimumAssets = details.minimumAssets
  const cleanupName = details.reservationCleanupErrorName
  const reservationCleanupErrorName =
    typeof cleanupName === 'string' ? knownNames.get(cleanupName) : undefined
  return {
    errorName,
    ...(errorName === 'BootstrapMempoolValidationError' &&
    typeof minimumAssets === 'bigint' &&
    minimumAssets >= 0n
      ? { minimumAssets: String(minimumAssets) }
      : {}),
    ...(reservationCleanupErrorName ? { reservationCleanupErrorName } : {})
  }
}
