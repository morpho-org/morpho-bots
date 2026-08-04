import type { Address, Hex } from 'viem'

import { MAX_OFFER_CAP, midnightAbi } from '@morpho-org/midnight-sdk'
import { decodeFunctionData, encodeFunctionData, isAddressEqual, isHex, keccak256 } from 'viem'

import { OfferInvalidationAdapterError } from './offer-invalidation-adapter.error'

/**
 * Enforces the exact hot-key policy for one explicit offer-group cancellation.
 * @param transaction - SDK-built cancellation awaiting submission.
 * @param policy - Expected Midnight target, group identifier, and maker account.
 * @returns Completion only when the target, value, calldata width, selector, and arguments match.
 * @throws `OfferInvalidationAdapterError` when any transaction field is outside the allowlist.
 */
export const assertOfferInvalidationTransaction = (
  transaction: { to: Address; data: Hex; value: bigint },
  policy: { target: Address; groupId: Hex; account: Address }
) => {
  try {
    if (
      !isAddressEqual(transaction.to, policy.target) ||
      transaction.value !== 0n ||
      !isHex(transaction.data, { strict: true })
    ) {
      throw new OfferInvalidationAdapterError('transaction-policy')
    }

    const decoded = decodeFunctionData({ abi: midnightAbi, data: transaction.data })
    if (decoded.functionName !== 'setConsumed') {
      throw new OfferInvalidationAdapterError('transaction-policy')
    }

    const [groupId, amount, account] = decoded.args
    if (
      groupId !== policy.groupId ||
      amount !== MAX_OFFER_CAP ||
      !isAddressEqual(account, policy.account)
    ) {
      throw new OfferInvalidationAdapterError('transaction-policy')
    }

    const expected = encodeFunctionData({
      abi: midnightAbi,
      functionName: 'setConsumed',
      args: [policy.groupId, MAX_OFFER_CAP, policy.account]
    })
    if (keccak256(transaction.data) !== keccak256(expected)) {
      throw new OfferInvalidationAdapterError('transaction-policy')
    }
  } catch (error) {
    if (error instanceof OfferInvalidationAdapterError) throw error
    throw new OfferInvalidationAdapterError('transaction-policy')
  }
}

/**
 * Enforces the exact hot-key policy for an ordered Midnight multicall cancellation.
 * @param transaction - Native Midnight multicall awaiting submission.
 * @param policy - Expected Midnight target, ordered group identifiers, and configured maker.
 * @returns Completion only for a zero-value multicall containing the exact `setConsumed` calls.
 * @throws `OfferInvalidationAdapterError` for a wrong target, selector, count, order, group, amount,
 * on-behalf account, malformed payload, or additional calldata.
 */
export const assertBatchOfferInvalidationTransaction = (
  transaction: { to: Address; data: Hex; value: bigint },
  policy: { target: Address; groupIds: readonly Hex[]; maker: Address }
) => {
  try {
    if (
      !isAddressEqual(transaction.to, policy.target) ||
      transaction.value !== 0n ||
      !isHex(transaction.data, { strict: true })
    ) {
      throw new OfferInvalidationAdapterError('transaction-policy')
    }

    const outer = decodeFunctionData({ abi: midnightAbi, data: transaction.data })
    if (outer.functionName !== 'multicall') {
      throw new OfferInvalidationAdapterError('transaction-policy')
    }
    const [calls] = outer.args
    if (calls.length !== policy.groupIds.length) {
      throw new OfferInvalidationAdapterError('transaction-policy')
    }

    for (const [index, data] of calls.entries()) {
      const inner = decodeFunctionData({ abi: midnightAbi, data })
      if (inner.functionName !== 'setConsumed') {
        throw new OfferInvalidationAdapterError('transaction-policy')
      }
      const [groupId, amount, onBehalf] = inner.args
      if (
        groupId !== policy.groupIds[index] ||
        amount !== MAX_OFFER_CAP ||
        !isAddressEqual(onBehalf, policy.maker)
      ) {
        throw new OfferInvalidationAdapterError('transaction-policy')
      }
    }

    const expectedCalls = policy.groupIds.map(groupId =>
      encodeFunctionData({
        abi: midnightAbi,
        functionName: 'setConsumed',
        args: [groupId, MAX_OFFER_CAP, policy.maker]
      })
    )
    const expected = encodeFunctionData({
      abi: midnightAbi,
      functionName: 'multicall',
      args: [expectedCalls]
    })
    if (keccak256(transaction.data) !== keccak256(expected)) {
      throw new OfferInvalidationAdapterError('transaction-policy')
    }
  } catch (error) {
    if (error instanceof OfferInvalidationAdapterError) throw error
    throw new OfferInvalidationAdapterError('transaction-policy')
  }
}
