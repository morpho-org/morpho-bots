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
