import type { Address, Hex } from 'viem'

import { MAX_OFFER_CAP, midnightAbi } from '@morpho-org/midnight-sdk'
import { encodeFunctionData, isAddressEqual } from 'viem'

import { OfferInvalidationAdapterError } from './offer-invalidation-adapter.error'
import { assertBatchOfferInvalidationTransaction } from './offer-invalidation-transaction.utils'

type BatchOfferInvalidationWallet = {
  account: { address: Address }
  sendTransaction(transaction: { to: Address; data: Hex; value: bigint }): Promise<Hex>
  waitForTransactionReceipt(parameters: { hash: Hex; timeout: number }): Promise<{ status: string }>
}

/**
 * Submits one native Midnight multicall for an ordered selection of offer groups.
 * @param parameters - Maker wallet, configured Midnight, maker, groups, receipt timeout, and optional
 * post-submission observer.
 * @returns The confirmed transaction hash shared by every invalidated group.
 * @throws `OfferInvalidationAdapterError` when policy validation or receipt confirmation fails.
 * @remarks Every inner call fixes `onBehalf` to the configured maker and `amount` to `MAX_OFFER_CAP`.
 * Midnight executes its native multicall with `delegatecall`, preserving the maker wallet's
 * `msg.sender` for each `setConsumed`. Once submitted, a failure is surfaced without serial retry.
 */
export const invalidateOffersBatch = async (parameters: {
  wallet: BatchOfferInvalidationWallet
  midnight: Address
  maker: Address
  groupIds: readonly Hex[]
  receiptTimeoutMs: number
  onTransactionSubmitted?: (txHash: Hex) => void | Promise<void>
}) => {
  if (!isAddressEqual(parameters.wallet.account.address, parameters.maker)) {
    throw new OfferInvalidationAdapterError('maker-wallet-mismatch')
  }
  const calls = parameters.groupIds.map(groupId =>
    encodeFunctionData({
      abi: midnightAbi,
      functionName: 'setConsumed',
      args: [groupId, MAX_OFFER_CAP, parameters.maker]
    })
  )
  const transaction = {
    to: parameters.midnight,
    data: encodeFunctionData({
      abi: midnightAbi,
      functionName: 'multicall',
      args: [calls]
    }),
    value: 0n
  }
  assertBatchOfferInvalidationTransaction(transaction, {
    target: parameters.midnight,
    groupIds: parameters.groupIds,
    maker: parameters.maker
  })

  const txHash = await parameters.wallet.sendTransaction(transaction)
  try {
    await parameters.onTransactionSubmitted?.(txHash)
  } catch {
    // Application observers are diagnostic and cannot interrupt receipt handling.
  }
  const receipt = await parameters.wallet.waitForTransactionReceipt({
    hash: txHash,
    timeout: parameters.receiptTimeoutMs
  })
  if (receipt.status !== 'success') {
    throw new OfferInvalidationAdapterError('transaction-reverted')
  }
  return txHash
}
