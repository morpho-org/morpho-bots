import type { Address, Hex } from 'viem'

import { MAX_OFFER_CAP, midnightAbi } from '@morpho-org/midnight-sdk'
import { decodeFunctionData } from 'viem'
import { describe, expect, test, vi } from 'vitest'

import { invalidateOffersBatch } from '../../../src/infrastructure/invalidation/batch-offer-invalidation.utils'
import { OfferInvalidationAdapterError } from '../../../src/infrastructure/invalidation/offer-invalidation-adapter.error'

const maker: Address = '0x1111111111111111111111111111111111111111'
const midnight: Address = '0x2222222222222222222222222222222222222222'
const foreignMaker: Address = '0x3333333333333333333333333333333333333333'
const groupIds = [`0x${'44'.repeat(32)}`, `0x${'55'.repeat(32)}`] as const
const txHash: Hex = `0x${'aa'.repeat(32)}`

const subject = (status = 'success', account = maker) => {
  const sendTransaction = vi.fn(
    async (_transaction: { to: Address; data: Hex; value: bigint }) => txHash
  )
  const waitForTransactionReceipt = vi.fn(async () => ({ status }))
  return {
    wallet: { account: { address: account }, sendTransaction, waitForTransactionReceipt },
    sendTransaction,
    waitForTransactionReceipt
  }
}

describe('invalidateOffersBatch', () => {
  test('submits one exact Midnight multicall from the maker and waits for confirmation', async () => {
    const { wallet, sendTransaction, waitForTransactionReceipt } = subject()
    const submitted: Hex[] = []

    const result = await invalidateOffersBatch({
      wallet,
      midnight,
      maker,
      groupIds,
      receiptTimeoutMs: 123,
      onTransactionSubmitted: hash => {
        submitted.push(hash)
      }
    })

    expect(result).toBe(txHash)
    expect(submitted).toEqual([txHash])
    expect(sendTransaction).toHaveBeenCalledTimes(1)
    const transaction = sendTransaction.mock.calls[0]![0]
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
    expect(waitForTransactionReceipt).toHaveBeenCalledWith({ hash: txHash, timeout: 123 })
  })

  test('reports the hash before a reverted receipt and never returns a fallback signal', async () => {
    const { wallet } = subject('reverted')
    const submitted: Hex[] = []

    const error = await invalidateOffersBatch({
      wallet,
      midnight,
      maker,
      groupIds,
      receiptTimeoutMs: 123,
      onTransactionSubmitted: hash => {
        submitted.push(hash)
      }
    }).catch(value => value)

    expect(submitted).toEqual([txHash])
    expect(error).toBeInstanceOf(OfferInvalidationAdapterError)
  })

  test('rejects a wallet that does not send from the configured maker', async () => {
    const { wallet, sendTransaction } = subject('success', foreignMaker)

    const error = await invalidateOffersBatch({
      wallet,
      midnight,
      maker,
      groupIds,
      receiptTimeoutMs: 123
    }).catch(value => value)

    expect(error).toBeInstanceOf(OfferInvalidationAdapterError)
    expect(sendTransaction).not.toHaveBeenCalled()
  })
})
