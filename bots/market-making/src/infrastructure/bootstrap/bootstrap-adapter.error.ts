import type { BootstrapSubmittedTransaction } from '../../application/bootstrap/position-bootstrap-verbose'

/** Stable production-adapter failure without provider URLs, payloads, or secret material. */
export class BootstrapAdapterError extends Error {
  readonly code = 'BOOTSTRAP_ADAPTER_FAILED'
  readonly kind = 'provider-error'
  reservationCleanupErrorName?: string
  confirmedTransactions: readonly BootstrapSubmittedTransaction[] = []

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

  /**
   * Retains confirmed transactions that completed before this adapter failure.
   * @param transactions - Confirmed protocol mutations in submission order.
   * @returns This original adapter failure with supplementary transaction evidence.
   */
  recordConfirmedTransactions(transactions: readonly BootstrapSubmittedTransaction[]) {
    this.confirmedTransactions = [...transactions]
    return this
  }
}
