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
