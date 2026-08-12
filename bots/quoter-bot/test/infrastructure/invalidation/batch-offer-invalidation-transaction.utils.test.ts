import type { Address, Hex } from 'viem'

import { MAX_OFFER_CAP, midnightAbi } from '@morpho-org/midnight-sdk'
import { encodeFunctionData } from 'viem'
import { describe, expect, test } from 'vitest'

import { OfferInvalidationAdapterError } from '../../../src/infrastructure/invalidation/offer-invalidation-adapter.error'
import { assertBatchOfferInvalidationTransaction } from '../../../src/infrastructure/invalidation/offer-invalidation-transaction.utils'

const maker: Address = '0x1111111111111111111111111111111111111111'
const foreignMaker: Address = '0x3333333333333333333333333333333333333333'
const target: Address = '0x2222222222222222222222222222222222222222'
const foreignTarget: Address = '0x4444444444444444444444444444444444444444'
const groupA: Hex = `0x${'55'.repeat(32)}`
const groupB: Hex = `0x${'66'.repeat(32)}`
const groupC: Hex = `0x${'77'.repeat(32)}`
const groupIds = [groupA, groupB] as const

const setConsumed = (groupId: Hex, amount = MAX_OFFER_CAP, onBehalf: Address = maker) =>
  encodeFunctionData({
    abi: midnightAbi,
    functionName: 'setConsumed',
    args: [groupId, amount, onBehalf]
  })

const multicall = (calls: readonly Hex[]) =>
  encodeFunctionData({ abi: midnightAbi, functionName: 'multicall', args: [calls] })

const cancellation = {
  to: target,
  data: multicall([setConsumed(groupA), setConsumed(groupB)]),
  value: 0n
}

const assertRejected = (transaction: { to: Address; data: Hex; value: bigint }) => {
  expect(() =>
    assertBatchOfferInvalidationTransaction(transaction, { target, groupIds, maker })
  ).toThrow(OfferInvalidationAdapterError)
}

describe('assertBatchOfferInvalidationTransaction', () => {
  test('accepts the exact Midnight target and ordered setConsumed calls', () => {
    expect(
      assertBatchOfferInvalidationTransaction(cancellation, { target, groupIds, maker })
    ).toBeUndefined()
  })

  test('rejects a wrong target, value, or outer selector', () => {
    assertRejected({ ...cancellation, to: foreignTarget })
    assertRejected({ ...cancellation, value: 1n })
    assertRejected({ ...cancellation, data: setConsumed(groupA) })
  })

  test('rejects extra, missing, reordered, or duplicate-substituted calls', () => {
    assertRejected({
      ...cancellation,
      data: multicall([setConsumed(groupA), setConsumed(groupB), setConsumed(groupC)])
    })
    assertRejected({ ...cancellation, data: multicall([setConsumed(groupA)]) })
    assertRejected({
      ...cancellation,
      data: multicall([setConsumed(groupB), setConsumed(groupA)])
    })
    assertRejected({
      ...cancellation,
      data: multicall([setConsumed(groupA), setConsumed(groupA)])
    })
  })

  test('rejects a wrong inner selector, amount, or on-behalf account', () => {
    assertRejected({
      ...cancellation,
      data: multicall([
        encodeFunctionData({ abi: midnightAbi, functionName: 'multicall', args: [[]] }),
        setConsumed(groupB)
      ])
    })
    assertRejected({
      ...cancellation,
      data: multicall([setConsumed(groupA, MAX_OFFER_CAP - 1n), setConsumed(groupB)])
    })
    assertRejected({
      ...cancellation,
      data: multicall([setConsumed(groupA, MAX_OFFER_CAP, foreignMaker), setConsumed(groupB)])
    })
  })

  test('rejects malformed or trailing calldata', () => {
    assertRejected({ ...cancellation, data: '0x1234' })
    assertRejected({ ...cancellation, data: `${cancellation.data}00` as Hex })
  })
})
