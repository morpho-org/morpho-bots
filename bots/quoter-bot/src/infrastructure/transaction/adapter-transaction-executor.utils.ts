import type {
  OperatorAdapterErrorClass,
  OperatorAdapterOperation
} from '../../application/monitoring/operator-error-name.utils'
import type { QuoterTransactionExecutor } from './quoter-transaction-executor'

import { QuoterTransactionError } from './quoter-transaction.error'

/**
 * Executes one guarded strategy write and preserves ambiguous post-broadcast outcomes.
 * @param adapterError - Strategy adapter error class thrown on failure.
 * @param executor - Invocation-scoped quoter transaction executor.
 * @param parameters - Canonical transaction and operation metadata.
 * @param definiteFailure - Failure reported when the transaction cannot take effect.
 * @returns The transaction hash that confirmed successfully and its receipt block.
 * @throws `adapterError` with an outcome safe for reservation cleanup decisions.
 */
export const executeAdapterTransaction = async (
  adapterError: OperatorAdapterErrorClass,
  executor: QuoterTransactionExecutor,
  parameters: Parameters<QuoterTransactionExecutor['execute']>[0],
  definiteFailure: OperatorAdapterOperation = 'transaction-reverted'
) => {
  try {
    return await executor.execute(parameters)
  } catch (error) {
    if (
      error instanceof QuoterTransactionError &&
      (error.operation === 'transaction-pending' || error.operation === 'transaction-dropped')
    ) {
      throw new adapterError(error.operation)
    }
    throw new adapterError(definiteFailure)
  }
}
