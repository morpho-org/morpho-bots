/** Identifies an infrastructure provider without retaining its URL or credentials. */
export type ProviderId = 'rpc' | 'archive-rpc' | 'morpho-api' | 'router-api'

/** Enumerates safe operation codes exposed by setup-state provider boundaries. */
export type ProviderOperation =
  | 'chain-id'
  | 'contract-code'
  | 'native-balance'
  | 'loan-allowance'
  | 'latest-timestamp'
  | 'ratifier-registry'
  | 'ratifier-code'
  | 'ratifier-midnight'
  | 'ratifier-root'
  | 'ratifier-authorization'
  | 'book-api'
  | 'market-listing'
  | 'book-market'
  | 'book-tick-spacing'
  | 'reference-latest-block'
  | 'reference-historical-block'
  | 'reference-market-params'
  | 'reference-market-state'
  | 'offer-groups'

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
   * @remarks The rejected value is deliberately discarded, including its message, stack, and cause.
   */
  constructor(provider: ProviderId, operation: ProviderOperation) {
    super('Provider read failed')
    this.name = 'ProviderReadError'
    this.provider = provider
    this.operation = operation
    this.failure = {
      kind: 'provider-error',
      provider,
      name: 'ProviderError',
      code: this.code,
      context: 'read'
    }
  }
}
