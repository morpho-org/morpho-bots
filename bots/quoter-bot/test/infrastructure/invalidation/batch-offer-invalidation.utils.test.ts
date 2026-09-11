import type { Address, Hex } from 'viem'

import { MAX_OFFER_CAP, midnightAbi } from '@morpho-org/midnight-sdk'
import { decodeFunctionData } from 'viem'
import { describe, expect, test, vi } from 'vitest'

import { invalidateOffersBatch } from '../../../src/infrastructure/invalidation/batch-offer-invalidation.utils'

const maker: Address = '0x1111111111111111111111111111111111111111'
const midnight: Address = '0x2222222222222222222222222222222222222222'
const groupIds = [`0x${'44'.repeat(32)}`, `0x${'55'.repeat(32)}`] as const
const txHash: Hex = `0x${'aa'.repeat(32)}`

const subject = () => {
  const execute = vi.fn(async (_transaction: { to: Address; data: Hex; value: bigint }) => txHash)
  return { execute }
}

describe('invalidateOffersBatch', () => {
  test('submits one exact Midnight multicall through the guarded executor', async () => {
    const { execute } = subject()

    const result = await invalidateOffersBatch({
      midnight,
      maker,
      groupIds,
      execute
    })

    expect(result).toBe(txHash)
    expect(execute).toHaveBeenCalledTimes(1)
    const transaction = execute.mock.calls[0]![0]
    expect(transaction).toMatchObject({ to: midnight, value: 0n })
    const outer = decodeFunctionData({ abi: midnightAbi, data: transaction.data })
    expect(outer.functionName).toBe('multicall')
    if (outer.functionName !== 'multicall') throw new Error('expected multicall calldata')
    const [calls] = outer.args
    expect(calls).toHaveLength(2)
    expect(calls.map(data => decodeFunctionData({ abi: midnightAbi, data }))).toEqual([
      { functionName: 'setConsumed', args: [groupIds[0], MAX_OFFER_CAP, maker] },
      { functionName: 'setConsumed', args: [groupIds[1], MAX_OFFER_CAP, maker] }
    ])
  })

  test('propagates an executor failure', async () => {
    const expected = new Error('guarded execution failed')
    const execute = vi.fn(async () => Promise.reject(expected))

    const error = await invalidateOffersBatch({
      midnight,
      maker,
      groupIds,
      execute
    }).catch(value => value)

    expect(error).toBe(expected)
  })
})
