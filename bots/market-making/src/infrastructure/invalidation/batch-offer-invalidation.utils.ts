import type { Address, Hex } from 'viem'

import { midnightAbi } from '@morpho-org/midnight-sdk'
import { RevokeOffers } from '@repo/contracts'
import { tryCatch } from '@repo/utils'
import { encodeFunctionData, isAddress, isAddressEqual } from 'viem'

import { OfferInvalidationAdapterError } from './offer-invalidation-adapter.error'
import { assertBatchOfferInvalidationTransaction } from './offer-invalidation-transaction.utils'

type BatchOfferInvalidationClient = {
  getCode(parameters: { address: Address }): Promise<Hex | undefined>
  readContract(parameters: {
    address: Address
    abi: readonly unknown[]
    functionName: string
    args?: readonly unknown[]
  }): Promise<unknown>
}

type BatchOfferInvalidationWallet = {
  sendTransaction(transaction: { to: Address; data: Hex; value: bigint }): Promise<Hex>
  waitForTransactionReceipt(parameters: { hash: Hex; timeout: number }): Promise<{ status: string }>
}

/**
 * Safely submits one helper transaction for an ordered selection of offer groups.
 * @param parameters - Provider, wallet, expected contracts, maker, groups, receipt timeout, and
 * optional post-submission observer.
 * @returns The confirmed shared transaction hash, or `undefined` only when code, bound Midnight, or
 * maker authorization makes the helper unavailable, including unreadable capability getters.
 * @throws `OfferInvalidationAdapterError` when a submitted transaction fails.
 * @remarks The identity and authorization reads run concurrently after bytecode is confirmed. Once
 * submission occurs, no fallback signal is returned; receipt failure throws after preserving the
 * submitted hash through the observer.
 */
export const invalidateOffersBatch = async (parameters: {
  client: BatchOfferInvalidationClient
  wallet: BatchOfferInvalidationWallet
  helper: Address
  midnight: Address
  maker: Address
  groupIds: readonly Hex[]
  receiptTimeoutMs: number
  onTransactionSubmitted?: (txHash: Hex) => void | Promise<void>
}) => {
  const codeResult = await tryCatch(parameters.client.getCode({ address: parameters.helper }))
  if (codeResult.error || codeResult.data === undefined || codeResult.data === '0x')
    return undefined

  const capability = await tryCatch(
    Promise.all([
      parameters.client.readContract({
        address: parameters.helper,
        abi: RevokeOffers.abi,
        functionName: 'MIDNIGHT'
      }),
      parameters.client.readContract({
        address: parameters.midnight,
        abi: midnightAbi,
        functionName: 'isAuthorized',
        args: [parameters.maker, parameters.helper]
      })
    ])
  )
  if (capability.error) return undefined
  const [boundMidnight, authorized] = capability.data

  if (
    typeof boundMidnight !== 'string' ||
    !isAddress(boundMidnight) ||
    !isAddressEqual(boundMidnight, parameters.midnight) ||
    authorized !== true
  ) {
    return undefined
  }

  const transaction = {
    to: parameters.helper,
    data: encodeFunctionData({
      abi: RevokeOffers.abi,
      functionName: 'revokeOffers',
      args: [parameters.groupIds]
    }),
    value: 0n
  }
  assertBatchOfferInvalidationTransaction(transaction, {
    target: parameters.helper,
    groupIds: parameters.groupIds
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
