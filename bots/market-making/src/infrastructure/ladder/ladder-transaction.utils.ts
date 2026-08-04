import type { IOffer } from '@morpho-org/midnight-sdk'
import type { Address, Hex } from 'viem'

import {
  MAX_OFFER_CAP,
  midnightAbi,
  Offer,
  Payload,
  setterRatifierAbi
} from '@morpho-org/midnight-sdk'
import { decodeFunctionData, isAddressEqual, isHex, size } from 'viem'

import { LadderAdapterError } from './ladder-adapter.error'

/**
 * Enforces the exact Setter root-approval policy before the ladder hot key broadcasts it.
 * @param transaction - Locally built Setter approval transaction.
 * @param policy - Configured ratifier, maker, and canonical tree root.
 * @returns Completion only for `setIsRootRatified(maker, root, true)` with zero value.
 * @throws `LadderAdapterError` when target, value, width, selector, or arguments differ.
 */
export const assertLadderRatificationTransaction = (
  transaction: { to: Address; data: Hex; value: bigint },
  policy: { target: Address; account: Address; root: Hex }
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
    const decoded = decodeFunctionData({ abi: setterRatifierAbi, data: transaction.data })
    if (decoded.functionName !== 'setIsRootRatified') {
      throw new LadderAdapterError('transaction-policy')
    }
    const [account, root, ratified] = decoded.args
    if (!isAddressEqual(account, policy.account) || root !== policy.root || !ratified) {
      throw new LadderAdapterError('transaction-policy')
    }
  } catch (error) {
    if (error instanceof LadderAdapterError) throw error
    throw new LadderAdapterError('transaction-policy')
  }
}

/**
 * Enforces the ladder hot-key policy before a mixed-side payload is broadcast.
 * @param transaction - Locally built transaction awaiting submission.
 * @param policy - Exact mempool target and SDK-produced offer/ratifier-data items.
 * @returns Completion only after target, value, payload size, offer hashes, and ratifier data match.
 * @throws `LadderAdapterError` when any transaction field is outside the allowlist.
 */
export const assertLadderPublicationTransaction = async (
  transaction: { to: Address; data: Hex; value: bigint },
  policy: { target: Address; items: readonly { offer: IOffer; ratifierData: Hex }[] }
) => {
  try {
    if (
      !isAddressEqual(transaction.to, policy.target) ||
      transaction.value !== 0n ||
      !isHex(transaction.data, { strict: true })
    ) {
      throw new LadderAdapterError('transaction-policy')
    }
    const items = await Payload.decode(transaction.data, { maxItems: policy.items.length })
    if (items.length !== policy.items.length) {
      throw new LadderAdapterError('transaction-policy')
    }
    const actual = items
      .map(item => `${Offer.from(item.offer).hash}:${item.ratifierData}`)
      .toSorted()
    const expected = policy.items
      .map(item => `${Offer.from(item.offer).hash}:${item.ratifierData}`)
      .toSorted()
    if (actual.some((item, index) => item !== expected[index])) {
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
