import type { Address, Hex } from 'viem'

import { midnightAbi, Payload } from '@morpho-org/midnight-sdk'
import { getAbiItem, isAddressEqual, isHex, size, slice, toFunctionSelector } from 'viem'

import { BootstrapAdapterError } from './bootstrap-adapter.error'

type BootstrapTransaction = { to: Address; data: Hex; value: bigint }
type BootstrapTransactionPolicy = {
  kind: 'cancel' | 'publication'
  target: Address
}

/**
 * Enforces the hot-key signer policy before any Midnight transaction is broadcast.
 * @param transaction - SDK-built transaction awaiting publication.
 * @param policy - Exact allowed target and cancellation or mempool payload shape.
 * @returns Completion only after target, value, and calldata satisfy the local policy.
 * @throws `BootstrapAdapterError` when any transaction field falls outside the allowlist.
 * @remarks Cancellation calldata must be the exact fixed-width `setConsumed` call; publication
 *   calldata must decode as a bounded canonical Midnight payload.
 */
export const assertBootstrapTransaction = async (
  transaction: BootstrapTransaction,
  policy: BootstrapTransactionPolicy
) => {
  try {
    if (!isAddressEqual(transaction.to, policy.target) || transaction.value !== 0n) {
      throw new BootstrapAdapterError('transaction-policy')
    }
  } catch (error) {
    if (error instanceof BootstrapAdapterError) throw error
    throw new BootstrapAdapterError('transaction-policy')
  }
  if (!isHex(transaction.data, { strict: true })) {
    throw new BootstrapAdapterError('transaction-policy')
  }
  if (policy.kind === 'cancel') {
    const selector = toFunctionSelector(getAbiItem({ abi: midnightAbi, name: 'setConsumed' }))
    if (size(transaction.data) !== 100 || slice(transaction.data, 0, 4) !== selector) {
      throw new BootstrapAdapterError('transaction-policy')
    }
    return
  }
  try {
    const items = await Payload.decode(transaction.data)
    if (items.length === 0) throw new BootstrapAdapterError('transaction-policy')
  } catch (error) {
    if (error instanceof BootstrapAdapterError) throw error
    throw new BootstrapAdapterError('transaction-policy')
  }
}
