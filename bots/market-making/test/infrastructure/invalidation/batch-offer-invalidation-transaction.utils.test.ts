import type { Address, Hex } from 'viem'

import { RevokeOffers } from '@repo/contracts'
import { describe, expect, test } from 'bun:test'
import { encodeFunctionData } from 'viem'

import { OfferInvalidationAdapterError } from '../../../src/infrastructure/invalidation/offer-invalidation-adapter.error'
import { assertBatchOfferInvalidationTransaction } from '../../../src/infrastructure/invalidation/offer-invalidation-transaction.utils'

const target: Address = '0x2222222222222222222222222222222222222222'
const foreign: Address = '0x1111111111111111111111111111111111111111'
const groupA: Hex = `0x${'33'.repeat(32)}`
const groupB: Hex = `0x${'44'.repeat(32)}`
const groupIds = [groupA, groupB] as const
const cancellation = {
  to: target,
  data: encodeFunctionData({
    abi: RevokeOffers.abi,
    functionName: 'revokeOffers',
    args: [groupIds]
  }),
  value: 0n
}

describe('assertBatchOfferInvalidationTransaction', () => {
  test('accepts only the exact helper target and selected group array', () => {
    expect(
      assertBatchOfferInvalidationTransaction(cancellation, { target, groupIds })
    ).toBeUndefined()
  })

  test.each([
    { ...cancellation, to: foreign },
    { ...cancellation, value: 1n },
    {
      ...cancellation,
      data: encodeFunctionData({
        abi: RevokeOffers.abi,
        functionName: 'revokeOffers',
        args: [[groupB, groupA]]
      })
    },
    { ...cancellation, data: `${cancellation.data}00` as Hex }
  ])(
    'rejects target, value, selector arguments, or trailing calldata outside policy',
    transaction => {
      expect(() =>
        assertBatchOfferInvalidationTransaction(transaction, { target, groupIds })
      ).toThrow(OfferInvalidationAdapterError)
    }
  )
})
