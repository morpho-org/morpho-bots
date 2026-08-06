import { morphoViemExtension } from '@morpho-org/morpho-sdk'
import { createPublicClient, createWalletClient, http, isAddressEqual, publicActions } from 'viem'
import { base } from 'viem/chains'

import type { OfferInvalidationPort } from '../../application/invalidation/offer-invalidation.service'
import type { ConfigService } from '../../config/config.service'

import { createBootstrapGroupOwnership } from '../bootstrap/bootstrap-group-ownership.utils'
import { readBootstrapGroups } from '../bootstrap/bootstrap-groups.utils'
import { createLadderGroupOwnership } from '../ladder/ladder-group-ownership.utils'
import { createManagedMakerAccount } from '../make/managed-maker-account.utils'
import { invalidateOffersBatch } from './batch-offer-invalidation.utils'
import { OfferInvalidationAdapterError } from './offer-invalidation-adapter.error'
import { offerInvalidationGroupIds } from './offer-invalidation-group.utils'
import { assertOfferInvalidationTransaction } from './offer-invalidation-transaction.utils'

const providerOperation = async <Result>(
  operation: string,
  execute: () => Promise<Result>
): Promise<Result> => {
  try {
    return await execute()
  } catch (error) {
    if (error instanceof OfferInvalidationAdapterError) throw error
    throw new OfferInvalidationAdapterError(operation)
  }
}

/**
 * Composes the cancellation-specific provider, signer, and ownership port.
 * @param config - Fully validated runtime configuration and selected mutation mode.
 * @returns A port that targets every active maker group or an explicit bytes32 group.
 * @throws `OfferInvalidationAdapterError` when write-mode signer identity differs from the maker.
 * @remarks The preflight checks connected Base identity, deployed Midnight bytecode, and write-mode
 * native reserve without requiring healthy books, archive data, ratifier state, allowance, or
 * known offer namespaces. Read-only mode never derives an account, signs, submits, or edits state.
 */
export const createProductionOfferInvalidationPort = (
  config: ConfigService
): OfferInvalidationPort => {
  const maker = config.identity.maker
  const client = createPublicClient({
    chain: base,
    transport: http(config.rpcUrl, { timeout: config.requestTimeoutMs })
  }).extend(morphoViemExtension({ supportSignature: true, supportDeployless: true }))
  const midnight = client.morpho.midnight(base.id)
  const bootstrapOwnership = createBootstrapGroupOwnership({
    maker,
    marketIds: config.setup.marketIds,
    configuredGroupIds: config.v0OfferGroupIds
  })
  const ladderOwnership = createLadderGroupOwnership({
    maker,
    strategyMarketIds: config.ladder.map(item => item.marketId)
  })

  const preflight = () =>
    providerOperation('preflight', async () => {
      const [chainId, code, nativeBalance] = await Promise.all([
        client.getChainId(),
        client.getCode({ address: config.setup.midnight }),
        config.identity.readOnly
          ? Promise.resolve(config.setup.nativeReserve)
          : client.getBalance({ address: maker })
      ])
      if (
        chainId !== base.id ||
        code === undefined ||
        code === '0x' ||
        nativeBalance < config.setup.nativeReserve
      ) {
        throw new OfferInvalidationAdapterError('preflight')
      }
    })

  const listActiveGroupIds = () =>
    providerOperation('offer-groups-read', async () => {
      const [groups, bootstrapGroupIds, ladderGroupIds] = await Promise.all([
        readBootstrapGroups({
          maker,
          morphoApiBaseUrl: config.morphoApiBaseUrl,
          requestTimeoutMs: config.requestTimeoutMs
        }),
        bootstrapOwnership.readPersistedGroupIds(),
        ladderOwnership.readGroupIds()
      ])
      return offerInvalidationGroupIds(groups, bootstrapGroupIds, ladderGroupIds)
    })

  if (config.identity.readOnly) {
    return {
      mode: () => 'readonly',
      preflight,
      listActiveGroupIds,
      invalidateBatch: async () => undefined,
      invalidate: async () => undefined,
      forgetGroups: async () => undefined
    }
  }

  const account = createManagedMakerAccount(config.identity.privateKey)
  if (!isAddressEqual(account.address, maker)) {
    throw new OfferInvalidationAdapterError('maker-private-key-mismatch')
  }
  const wallet = createWalletClient({
    account,
    chain: base,
    transport: http(config.rpcUrl, { timeout: config.requestTimeoutMs })
  }).extend(publicActions)

  return {
    mode: () => 'write',
    preflight,
    listActiveGroupIds,
    invalidateBatch: (groupIds, onTransactionSubmitted) =>
      providerOperation('batch-transaction', () =>
        invalidateOffersBatch({
          wallet,
          midnight: config.setup.midnight,
          maker,
          groupIds,
          receiptTimeoutMs: config.transactionReceiptTimeoutMs,
          onTransactionSubmitted
        })
      ),
    invalidate: (groupId, onTransactionSubmitted) =>
      providerOperation('transaction', async () => {
        const transaction = midnight
          .cancelOffer({ group: groupId, accountAddress: maker })
          .buildTx()
        assertOfferInvalidationTransaction(transaction, {
          target: config.setup.midnight,
          groupId,
          account: maker
        })

        const txHash = await wallet.sendTransaction(transaction)
        try {
          await onTransactionSubmitted?.(txHash)
        } catch {
          // Application observers are diagnostic and cannot interrupt receipt handling.
        }
        const receipt = await wallet.waitForTransactionReceipt({
          hash: txHash,
          timeout: config.transactionReceiptTimeoutMs
        })
        if (receipt.status !== 'success') {
          throw new OfferInvalidationAdapterError('transaction-reverted')
        }
        return txHash
      }),
    forgetGroups: groupIds =>
      providerOperation('ownership-cleanup', async () => {
        await Promise.all([bootstrapOwnership.forget(groupIds), ladderOwnership.forget(groupIds)])
      })
  }
}
