import type { Hex } from 'viem'

import { describe, expect, test } from 'vitest'

import type { QuoterTransactionExecutor } from '../../../src/infrastructure/transaction/quoter-transaction-executor'

import { BootstrapAdapterError } from '../../../src/infrastructure/bootstrap/bootstrap-adapter.error'
import { executeAdapterTransaction } from '../../../src/infrastructure/transaction/adapter-transaction-executor.utils'
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
  label: 'bootstrap:publish'
}

describe('executeAdapterTransaction', () => {
  test('returns the confirmed transaction hash and receipt block', async () => {
    await expect(
      executeAdapterTransaction(
        BootstrapAdapterError,
        executorThat(async () => ({ txHash: transactionHash, blockNumber: 7n })),
        parameters
      )
    ).resolves.toEqual({ txHash: transactionHash, blockNumber: 7n })
  })

  test.each(['transaction-pending', 'transaction-dropped'] as const)(
    'preserves the ambiguous %s outcome',
    async operation => {
      const executor = executorThat(async () => {
        throw new QuoterTransactionError(operation)
      })

      await expect(
        executeAdapterTransaction(BootstrapAdapterError, executor, parameters)
      ).rejects.toMatchObject({
        operation
      })
    }
  )

  test('maps a definite failure to the caller-selected cleanup outcome', async () => {
    const executor = executorThat(async () => {
      throw new QuoterTransactionError('simulation-reverted')
    })

    const error = await executeAdapterTransaction(
      BootstrapAdapterError,
      executor,
      parameters,
      'publication-transaction-reverted-after-ratification'
    ).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(BootstrapAdapterError)
    expect(error).toMatchObject({
      operation: 'publication-transaction-reverted-after-ratification'
    })
  })
})
