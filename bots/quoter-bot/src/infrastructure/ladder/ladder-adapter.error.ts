import type { LadderSubmittedTransaction } from '../../application/ladder/ladder-verbose'
import type { OperatorAdapterOperation } from '../../application/monitoring/operator-error-name.utils'

/** Stable production ladder-adapter failure without provider data or credentials. */
export class LadderAdapterError extends Error {
  readonly code = 'LADDER_ADAPTER_FAILED'
  readonly kind = 'provider-error'
  confirmedTransactions: readonly LadderSubmittedTransaction[] = []

  /** Creates one sanitized adapter failure. @param operation - Stable failed operation code. */
  constructor(readonly operation: OperatorAdapterOperation) {
    super('Ladder adapter failed')
    this.name = 'LadderAdapterError'
  }

  /**
   * Retains confirmed transactions that completed before this adapter failure.
   * @param transactions - Confirmed protocol mutations in submission order.
   * @returns This original adapter failure with supplementary transaction evidence.
   */
  recordConfirmedTransactions(transactions: readonly LadderSubmittedTransaction[]) {
    this.confirmedTransactions = [...transactions]
    return this
  }
}
