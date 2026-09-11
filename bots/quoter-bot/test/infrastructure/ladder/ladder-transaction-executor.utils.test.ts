import type { Hex } from 'viem'

import { describe, expect, test } from 'vitest'

import type { QuoterTransactionExecutor } from '../../../src/infrastructure/transaction/quoter-transaction-executor'

import { executeLadderTransaction } from '../../../src/infrastructure/ladder/ladder-transaction-executor.utils'
import { QuoterTransactionError } from '../../../src/infrastructure/transaction/quoter-transaction.error'

const transactionHash: Hex = `0x${'11'.repeat(32)}`
const transaction = {
  to: '0x2222222222222222222222222222222222222222' as const,
  data: '0xdeadbeef' as const,
  value: 0n
}

const executorThat = (
  execute: QuoterTransactionExecutor['execute']
): QuoterTransactionExecutor => ({
  signer: '0x3333333333333333333333333333333333333333',
  assertNoPendingNonce: async () => {},
  execute
})

const parameters = {
  transaction,
  operation: 'publish' as const,
  label: 'ladder:publish:test'
}

describe('executeLadderTransaction', () => {
  test('returns the confirmed transaction hash', async () => {
    await expect(
      executeLadderTransaction(
        executorThat(async () => transactionHash),
        parameters
      )
    ).resolves.toBe(transactionHash)
  })

  test.each(['transaction-pending', 'transaction-dropped'] as const)(
    'preserves the ambiguous %s outcome',
    async operation => {
      const executor = executorThat(async () => {
        throw new QuoterTransactionError(operation)
      })

      await expect(executeLadderTransaction(executor, parameters)).rejects.toMatchObject({
        operation
      })
    }
  )

  test('maps a definite failure to the caller-selected cleanup outcome', async () => {
    const executor = executorThat(async () => {
      throw new QuoterTransactionError('simulation-reverted')
    })

    await expect(
      executeLadderTransaction(
        executor,
        parameters,
        'publication-transaction-reverted-after-ratification'
      )
    ).rejects.toMatchObject({
      operation: 'publication-transaction-reverted-after-ratification'
    })
  })
})
