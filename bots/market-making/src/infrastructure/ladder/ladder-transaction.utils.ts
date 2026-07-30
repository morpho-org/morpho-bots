import type { IOffer } from '@morpho-org/midnight-sdk'
import type { Address, Hex } from 'viem'

import { MAX_OFFER_CAP, midnightAbi, Offer, Payload } from '@morpho-org/midnight-sdk'
import { decodeFunctionData, isAddressEqual, isHex, size } from 'viem'

import { LadderAdapterError } from './ladder-adapter.error'

/**
 * Enforces the ladder hot-key policy before a mixed-side payload is broadcast.
 * @param transaction - Locally built transaction awaiting submission.
 * @param policy - Exact mempool target and expected offer set.
 * @returns Completion only after target, value, payload size, and offer hashes match.
 * @throws `LadderAdapterError` when any transaction field is outside the allowlist.
 */
export const assertLadderPublicationTransaction = async (
  transaction: { to: Address; data: Hex; value: bigint },
  policy: { target: Address; offers: readonly IOffer[] }
) => {
  try {
    if (
      !isAddressEqual(transaction.to, policy.target) ||
      transaction.value !== 0n ||
      !isHex(transaction.data, { strict: true })
    ) {
      throw new LadderAdapterError('transaction-policy')
    }
    const items = await Payload.decode(transaction.data, { maxItems: policy.offers.length })
    if (items.length !== policy.offers.length) {
      throw new LadderAdapterError('transaction-policy')
    }
    const actual = items.map(item => Offer.from(item.offer).hash).toSorted()
    const expected = policy.offers.map(offer => Offer.from(offer).hash).toSorted()
    if (actual.some((hash, index) => hash !== expected[index])) {
      throw new LadderAdapterError('transaction-policy')
    }
  } catch (error) {
    if (error instanceof LadderAdapterError) throw error
    throw new LadderAdapterError('transaction-policy')
  }
}

/**
 * Enforces the exact ladder cancellation transaction policy.
 * @param transaction - SDK-built cancellation awaiting submission.
 * @param policy - Expected Midnight target, group, and maker.
 * @returns Completion only for the canonical full-consumption call.
 * @throws `LadderAdapterError` when target, value, width, selector, or arguments differ.
 */
export const assertLadderCancellationTransaction = (
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
      throw new LadderAdapterError('transaction-policy')
    }
    const decoded = decodeFunctionData({ abi: midnightAbi, data: transaction.data })
    if (decoded.functionName !== 'setConsumed') {
      throw new LadderAdapterError('transaction-policy')
    }
    const [groupId, amount, account] = decoded.args
    if (
      groupId !== policy.groupId ||
      amount !== MAX_OFFER_CAP ||
      !isAddressEqual(account, policy.account)
    ) {
      throw new LadderAdapterError('transaction-policy')
    }
  } catch (error) {
    if (error instanceof LadderAdapterError) throw error
    throw new LadderAdapterError('transaction-policy')
  }
}
