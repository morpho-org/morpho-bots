import type { Address, Hex } from 'viem'

import { MAX_OFFER_CAP, midnightAbi } from '@morpho-org/midnight-sdk'
import { decodeFunctionData, isAddressEqual, isHex, size } from 'viem'

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
