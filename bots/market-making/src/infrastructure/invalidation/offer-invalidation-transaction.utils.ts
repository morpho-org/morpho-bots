import type { Address, Hex } from 'viem'

import { MAX_OFFER_CAP, midnightAbi } from '@morpho-org/midnight-sdk'
import { RevokeOffers } from '@repo/contracts'
import {
  decodeFunctionData,
  encodeFunctionData,
  isAddressEqual,
  isHex,
  keccak256,
  size
} from 'viem'

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
      !isHex(transaction.data, { strict: true }) ||
      size(transaction.data) !== 100
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
  } catch (error) {
    if (error instanceof OfferInvalidationAdapterError) throw error
    throw new OfferInvalidationAdapterError('transaction-policy')
  }
}

/**
 * Enforces the exact hot-key policy for one helper-backed batch cancellation.
 * @param transaction - Helper call awaiting submission.
 * @param policy - Expected helper target and ordered bytes32 group array.
 * @returns Completion only for zero-value `revokeOffers` calldata matching the exact selection.
 * @throws `OfferInvalidationAdapterError` when any transaction field is outside the allowlist.
 * @remarks The helper ABI has no on-behalf argument; its Solidity implementation always uses
 * `msg.sender`, and exact re-encoding rejects appended calldata.
 */
export const assertBatchOfferInvalidationTransaction = (
  transaction: { to: Address; data: Hex; value: bigint },
  policy: { target: Address; groupIds: readonly Hex[] }
) => {
  try {
    if (
      !isAddressEqual(transaction.to, policy.target) ||
      transaction.value !== 0n ||
      !isHex(transaction.data, { strict: true })
    ) {
      throw new OfferInvalidationAdapterError('transaction-policy')
    }

    const decoded = decodeFunctionData({ abi: RevokeOffers.abi, data: transaction.data })
    if (decoded.functionName !== 'revokeOffers') {
      throw new OfferInvalidationAdapterError('transaction-policy')
    }

    const expected = encodeFunctionData({
      abi: RevokeOffers.abi,
      functionName: 'revokeOffers',
      args: [policy.groupIds]
    })
    if (keccak256(transaction.data) !== keccak256(expected)) {
      throw new OfferInvalidationAdapterError('transaction-policy')
    }
  } catch (error) {
    if (error instanceof OfferInvalidationAdapterError) throw error
    throw new OfferInvalidationAdapterError('transaction-policy')
  }
}
