import type { QuoterTransactionExecutor } from '../transaction/quoter-transaction-executor'

import { QuoterTransactionError } from '../transaction/quoter-transaction.error'
import { LadderAdapterError } from './ladder-adapter.error'

type DefiniteFailureOperation =
  | 'transaction-reverted'
  | 'ratifier-transaction-reverted'
  | 'publication-transaction-reverted-after-ratification'

/**
 * Executes one guarded ladder write and preserves ambiguous post-broadcast outcomes.
 * @param executor - Invocation-scoped quoter transaction executor.
 * @param parameters - Canonical transaction and operation metadata.
 * @param definiteFailure - Ladder failure reported when the transaction cannot take effect.
 * @returns The transaction hash that confirmed successfully.
 * @throws `LadderAdapterError` with an outcome safe for reservation cleanup decisions.
 */
export const executeLadderTransaction = async (
  executor: QuoterTransactionExecutor,
  parameters: Parameters<QuoterTransactionExecutor['execute']>[0],
  definiteFailure: DefiniteFailureOperation = 'transaction-reverted'
) => {
  try {
    return await executor.execute(parameters)
  } catch (error) {
    if (
      error instanceof QuoterTransactionError &&
      ['transaction-pending', 'transaction-dropped'].includes(error.operation)
    ) {
      throw new LadderAdapterError(error.operation)
    }
    throw new LadderAdapterError(definiteFailure)
  }
}
