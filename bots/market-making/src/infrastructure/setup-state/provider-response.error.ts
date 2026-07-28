/** Signals a malformed or inconsistent provider result using only allowlisted safe metadata. */
export class ProviderResponseError extends Error {
  /**
   * Creates a provider response failure without retaining response bodies, URLs, or credentials.
   * @param provider - Fixed provider identifier safe for operator-visible reports.
   * @param operation - Stable operation identifier that contains no request data.
   * @param message - Sanitized invariant failure message containing no untrusted provider text.
   * @remarks Response bodies, URLs, credentials, and nested third-party causes are never retained.
   */
  constructor(
    readonly provider: 'provider' | 'rpc' | 'archive-rpc' | 'morpho-api' | 'router-api',
    readonly operation: string,
    message: string
  ) {
    super(message)
    this.name = 'ProviderResponseError'
  }
}
