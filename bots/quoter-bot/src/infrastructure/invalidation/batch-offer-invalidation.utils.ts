import type { Address, Hex } from 'viem'

import { MAX_OFFER_CAP, midnightAbi } from '@morpho-org/midnight-sdk'
import { encodeFunctionData } from 'viem'

import { assertBatchOfferInvalidationTransaction } from './offer-invalidation-transaction.utils'

/**
 * Submits one native Midnight multicall for an ordered selection of offer groups.
 * @param parameters - Configured Midnight, maker, groups, and guarded transaction executor.
 * @returns The confirmed transaction hash shared by every invalidated group.
 * @throws `OfferInvalidationAdapterError` when policy validation or receipt confirmation fails.
 * @remarks Every inner call fixes `onBehalf` to the configured maker and `amount` to `MAX_OFFER_CAP`.
 * Midnight executes its native multicall with `delegatecall`, preserving the maker wallet's
 * `msg.sender` for each `setConsumed`. Once submitted, a failure is surfaced without serial retry.
 */
export const invalidateOffersBatch = async (parameters: {
  midnight: Address
  maker: Address
  groupIds: readonly Hex[]
  execute: (transaction: { to: Address; data: Hex; value: bigint }) => Promise<Hex>
}) => {
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

  return parameters.execute(transaction)
}
