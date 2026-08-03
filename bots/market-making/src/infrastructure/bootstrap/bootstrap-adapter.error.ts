/** Stable production-adapter failure without provider URLs, payloads, or secret material. */
export class BootstrapAdapterError extends Error {
  readonly code = 'BOOTSTRAP_ADAPTER_FAILED'
  readonly kind = 'provider-error'
  reservationCleanupErrorName?: string

  /** Creates a sanitized failure for one fixed adapter operation. @param operation - Stable operation code. */
  constructor(readonly operation: string) {
    super('Position bootstrap adapter failed')
    this.name = 'BootstrapAdapterError'
  }

  /**
   * Retains a sanitized rollback-storage failure without replacing the primary adapter failure.
   * @param errorName - Allowlisted classification of the reservation cleanup failure.
   * @returns This original adapter failure with supplementary cleanup diagnostics.
   */
  recordReservationCleanupFailure(errorName: string) {
    this.reservationCleanupErrorName = errorName
    return this
  }
}
