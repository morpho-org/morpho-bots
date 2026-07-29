import type { SafeProviderFailure } from '../../application/setup/safe-provider.error'

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
