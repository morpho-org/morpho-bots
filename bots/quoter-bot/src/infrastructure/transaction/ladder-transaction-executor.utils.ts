import type { QuoterTransactionExecutor } from './quoter-transaction-executor'

import { LadderAdapterError } from '../ladder/ladder-adapter.error'
import { executeAdapterTransaction } from './adapter-transaction-executor.utils'

type DefiniteFailureOperation =
  | 'transaction-reverted'
  | 'ratifier-transaction-reverted'
  | 'publication-transaction-reverted-after-ratification'

/**
 * Executes one guarded ladder write and preserves ambiguous post-broadcast outcomes.
 * @param executor - Invocation-scoped quoter transaction executor.
 * @param parameters - Canonical transaction and operation metadata.
 * @param definiteFailure - Ladder failure reported when the transaction cannot take effect.
 * @returns The transaction hash that confirmed successfully and its receipt block.
 * @throws `LadderAdapterError` with an outcome safe for reservation cleanup decisions.
 */
export const executeLadderTransaction = (
  executor: QuoterTransactionExecutor,
  parameters: Parameters<QuoterTransactionExecutor['execute']>[0],
  definiteFailure: DefiniteFailureOperation = 'transaction-reverted'
) => executeAdapterTransaction(LadderAdapterError, executor, parameters, definiteFailure)
