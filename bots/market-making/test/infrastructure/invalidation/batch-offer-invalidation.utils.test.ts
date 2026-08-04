import type { Address, Hex } from 'viem'

import { midnightAbi } from '@morpho-org/midnight-sdk'
import { RevokeOffers } from '@repo/contracts'
import { describe, expect, mock, test } from 'bun:test'
import { decodeFunctionData } from 'viem'

import { invalidateOffersBatch } from '../../../src/infrastructure/invalidation/batch-offer-invalidation.utils'
import { OfferInvalidationAdapterError } from '../../../src/infrastructure/invalidation/offer-invalidation-adapter.error'

const maker: Address = '0x1111111111111111111111111111111111111111'
const midnight: Address = '0x2222222222222222222222222222222222222222'
const helper: Address = '0x3333333333333333333333333333333333333333'
const groupIds = [`0x${'44'.repeat(32)}`, `0x${'55'.repeat(32)}`] as const
const txHash: Hex = `0x${'aa'.repeat(32)}`

const subject = (
  overrides: {
    code?: Hex
    boundMidnight?: Address
    authorized?: boolean
    status?: string
    readFails?: boolean
    codeFails?: boolean
  } = {}
) => {
  const sendTransaction = mock(
    async (_transaction: { to: Address; data: Hex; value: bigint }) => txHash
  )
  const waitForTransactionReceipt = mock(async () => ({ status: overrides.status ?? 'success' }))
  const client = {
    getCode: mock(async () => {
      if (overrides.codeFails) throw new Error('code read failed')
      return overrides.code ?? ('0x01' as Hex)
    }),
    readContract: mock(
      async ({ address, functionName }: { address: Address; functionName: string }) => {
        if (overrides.readFails) throw new Error('read failed')
        if (address === helper && functionName === 'MIDNIGHT') {
          return overrides.boundMidnight ?? midnight
        }
        if (address === midnight && functionName === 'isAuthorized') {
          return overrides.authorized ?? true
        }
        throw new Error('unexpected read')
      }
    )
  }
  const wallet = { sendTransaction, waitForTransactionReceipt }
  return { client, wallet, sendTransaction, waitForTransactionReceipt }
}

describe('invalidateOffersBatch', () => {
  test('submits one exact helper call after code, identity, and authorization preflight', async () => {
    const { client, wallet, sendTransaction } = subject()
    const submitted: Hex[] = []

    const result = await invalidateOffersBatch({
      client,
      wallet,
      helper,
      midnight,
      maker,
      groupIds,
      receiptTimeoutMs: 123,
      onTransactionSubmitted: (hash: Hex) => {
        submitted.push(hash)
      }
    })

    expect(result).toBe(txHash)
    expect(submitted).toEqual([txHash])
    expect(sendTransaction).toHaveBeenCalledTimes(1)
    const transaction = sendTransaction.mock.calls[0]?.[0]
    expect(transaction).toMatchObject({ to: helper, value: 0n })
    expect(decodeFunctionData({ abi: RevokeOffers.abi, data: transaction!.data })).toEqual({
      functionName: 'revokeOffers',
      args: [groupIds]
    })
    expect(client.readContract).toHaveBeenCalledWith({
      address: midnight,
      abi: midnightAbi,
      functionName: 'isAuthorized',
      args: [maker, helper]
    })
  })

  test('returns unavailable before ABI reads when the helper has no bytecode', async () => {
    const { client, wallet, sendTransaction } = subject({ code: '0x', readFails: true })

    const result = await invalidateOffersBatch({
      client,
      wallet,
      helper,
      midnight,
      maker,
      groupIds,
      receiptTimeoutMs: 123
    })

    expect(result).toBeUndefined()
    expect(client.readContract).not.toHaveBeenCalled()
    expect(sendTransaction).not.toHaveBeenCalled()
  })

  test('returns unavailable without submission when bytecode lookup fails', async () => {
    const { client, wallet, sendTransaction } = subject({ codeFails: true })

    const result = await invalidateOffersBatch({
      client,
      wallet,
      helper,
      midnight,
      maker,
      groupIds,
      receiptTimeoutMs: 123
    })

    expect(result).toBeUndefined()
    expect(sendTransaction).not.toHaveBeenCalled()
  })

  test('returns unavailable without submission when helper identity reads fail', async () => {
    const { client, wallet, sendTransaction } = subject({ readFails: true })

    const result = await invalidateOffersBatch({
      client,
      wallet,
      helper,
      midnight,
      maker,
      groupIds,
      receiptTimeoutMs: 123
    })

    expect(result).toBeUndefined()
    expect(sendTransaction).not.toHaveBeenCalled()
  })

  test.each([{ code: '0x' as Hex }, { boundMidnight: maker }, { authorized: false }])(
    'returns unavailable without submission when capability preflight is unsafe',
    async overrides => {
      const { client, wallet, sendTransaction } = subject(overrides)

      const result = await invalidateOffersBatch({
        client,
        wallet,
        helper,
        midnight,
        maker,
        groupIds,
        receiptTimeoutMs: 123
      })

      expect(result).toBeUndefined()
      expect(sendTransaction).not.toHaveBeenCalled()
    }
  )

  test('reports the hash before a reverted receipt and does not return fallback capability', async () => {
    const { client, wallet } = subject({ status: 'reverted' })
    const submitted: Hex[] = []

    const error = await invalidateOffersBatch({
      client,
      wallet,
      helper,
      midnight,
      maker,
      groupIds,
      receiptTimeoutMs: 123,
      onTransactionSubmitted: (hash: Hex) => {
        submitted.push(hash)
      }
    }).catch(value => value)

    expect(submitted).toEqual([txHash])
    expect(error).toBeInstanceOf(OfferInvalidationAdapterError)
  })
})
