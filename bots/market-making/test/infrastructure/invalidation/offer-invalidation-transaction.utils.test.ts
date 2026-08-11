import type { Address, Hex } from 'viem'

import { MAX_OFFER_CAP, midnightAbi } from '@morpho-org/midnight-sdk'
import { encodeFunctionData } from 'viem'
import { describe, expect, test } from 'vitest'

import { OfferInvalidationAdapterError } from '../../../src/infrastructure/invalidation/offer-invalidation-adapter.error'
import { assertOfferInvalidationTransaction } from '../../../src/infrastructure/invalidation/offer-invalidation-transaction.utils'

const target: Address = '0x2222222222222222222222222222222222222222'
const maker: Address = '0x1111111111111111111111111111111111111111'
const groupId: Hex = `0x${'33'.repeat(32)}`

const cancellation = {
  to: target,
  data: encodeFunctionData({
    abi: midnightAbi,
    functionName: 'setConsumed',
    args: [groupId, MAX_OFFER_CAP, maker]
  }),
  value: 0n
}

describe('assertOfferInvalidationTransaction', () => {
  test('accepts only the canonical full-consumption call for the selected maker group', () => {
    expect(
      assertOfferInvalidationTransaction(cancellation, { target, groupId, account: maker })
    ).toBeUndefined()
  })

  test.each([
    { ...cancellation, to: maker },
    { ...cancellation, value: 1n },
    {
      ...cancellation,
      data: encodeFunctionData({
        abi: midnightAbi,
        functionName: 'setConsumed',
        args: [`0x${'44'.repeat(32)}`, MAX_OFFER_CAP, maker]
      })
    }
  ])('rejects a transaction outside the cancellation policy', transaction => {
    expect(() =>
      assertOfferInvalidationTransaction(transaction, { target, groupId, account: maker })
    ).toThrow(OfferInvalidationAdapterError)
  })
})
