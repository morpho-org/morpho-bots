import type { IOffer } from '@morpho-org/midnight-sdk'
import type { Address, Hex } from 'viem'

import {
  EcrecoverRatifierUtils,
  MAX_OFFER_CAP,
  midnightAbi,
  Offer,
  Payload,
  SetterRatifierUtils,
  setterRatifierAbi
} from '@morpho-org/midnight-sdk'
import { decodeFunctionData, isAddressEqual, isHex, size } from 'viem'

import { BootstrapAdapterError } from './bootstrap-adapter.error'

type BootstrapTransaction = { to: Address; data: Hex; value: bigint }
type BootstrapTransactionPolicy =
  | { kind: 'cancel'; target: Address; groupId: Hex; account: Address }
  | { kind: 'ratification'; target: Address; root: Hex; account: Address }
  | {
      kind: 'publication'
      target: Address
      offer: IOffer
      ratifierType: 'ecrecover' | 'setter'
      chainId: number
      root: Hex
      maker: Address
    }

/**
 * Enforces the hot-key signer policy before any Midnight transaction is broadcast.
 * @param transaction - SDK-built transaction awaiting publication.
 * @param policy - Exact allowed target and cancellation or mempool payload shape.
 * @returns Completion only after target, value, and calldata satisfy the local policy.
 * @throws `BootstrapAdapterError` when any transaction field falls outside the allowlist.
 * @remarks Cancellation and Setter ratification calldata must be exact fixed-width calls;
 *   publication calldata must decode as a bounded canonical Midnight payload whose ratifier data
 *   proves the expected root and, for Ecrecover, recovers the configured maker.
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
  if (policy.kind === 'ratification') {
    if (size(transaction.data) !== 100) {
      throw new BootstrapAdapterError('transaction-policy')
    }
    try {
      const decoded = decodeFunctionData({ abi: setterRatifierAbi, data: transaction.data })
      if (decoded.functionName !== 'setIsRootRatified') {
        throw new BootstrapAdapterError('transaction-policy')
      }
      const [account, root, ratified] = decoded.args
      if (!isAddressEqual(account, policy.account) || root !== policy.root || !ratified) {
        throw new BootstrapAdapterError('transaction-policy')
      }
    } catch (error) {
      if (error instanceof BootstrapAdapterError) throw error
      throw new BootstrapAdapterError('transaction-policy')
    }
    return
  }
  if (policy.kind === 'cancel') {
    if (size(transaction.data) !== 100) {
      throw new BootstrapAdapterError('transaction-policy')
    }
    try {
      const decoded = decodeFunctionData({ abi: midnightAbi, data: transaction.data })
      if (decoded.functionName !== 'setConsumed') {
        throw new BootstrapAdapterError('transaction-policy')
      }
      const [groupId, amount, account] = decoded.args
      if (
        groupId !== policy.groupId ||
        amount !== MAX_OFFER_CAP ||
        !isAddressEqual(account, policy.account)
      ) {
        throw new BootstrapAdapterError('transaction-policy')
      }
    } catch (error) {
      if (error instanceof BootstrapAdapterError) throw error
      throw new BootstrapAdapterError('transaction-policy')
    }
    return
  }
  try {
    const items = await Payload.decode(transaction.data, { maxItems: 1 })
    const [item] = items
    if (!item || Offer.from(item.offer).hash !== Offer.from(policy.offer).hash) {
      throw new BootstrapAdapterError('transaction-policy')
    }
    if (policy.ratifierType === 'setter') {
      const verified = SetterRatifierUtils.verifyRatifierData(item)
      if (verified.root !== policy.root) throw new BootstrapAdapterError('transaction-policy')
    } else {
      const verified = await EcrecoverRatifierUtils.verifyRatifierData({
        chainId: policy.chainId,
        ...item
      })
      if (verified.root !== policy.root || !isAddressEqual(verified.signer, policy.maker)) {
        throw new BootstrapAdapterError('transaction-policy')
      }
    }
  } catch (error) {
    if (error instanceof BootstrapAdapterError) throw error
    throw new BootstrapAdapterError('transaction-policy')
  }
}
