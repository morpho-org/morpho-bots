/** Stable production-adapter failure without provider URLs, payloads, or secret material. */
export class BootstrapAdapterError extends Error {
  readonly code = 'BOOTSTRAP_ADAPTER_FAILED'
  readonly kind = 'provider-error'

  /** Creates a sanitized failure for one fixed adapter operation. @param operation - Stable operation code. */
  constructor(readonly operation: string) {
    super('Position bootstrap adapter failed')
    this.name = 'BootstrapAdapterError'
  }
}
