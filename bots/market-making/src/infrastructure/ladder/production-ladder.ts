import { MAX_TICK, midnightAbi, Payload } from '@morpho-org/midnight-sdk'
import { morphoViemExtension } from '@morpho-org/morpho-sdk'
import { getChainAddress } from '@morpho-org/morpho-ts'
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  isAddressEqual,
  publicActions,
  type Hex
} from 'viem'
import { base } from 'viem/chains'

import type {
  LadderMakeService,
  LadderPositionService,
  LadderReferenceRateService
} from '../../application/ladder/ladder-market-maker.service'
import type {
  LadderSubmittedTransaction,
  LadderTransactionSubmittedObserver
} from '../../application/ladder/ladder-verbose'
import type { ConfigService } from '../../config/config.service'
import type { LadderQuoteSet } from '../../domain/ladder/ladder'
import type { HistoricalBlockReader } from '../reference/blue-reference-reader.utils'
import type { OwnedLadderPublication } from './ladder-group-ownership.utils'

import { createBootstrapGroupOwnership } from '../bootstrap/bootstrap-group-ownership.utils'
import { bootstrapBookOffers, readBootstrapGroups } from '../bootstrap/bootstrap-groups.utils'
import {
  legacyBootstrapOfferTickUpperBound,
  recoverLegacyBootstrapOfferTick
} from '../bootstrap/bootstrap-offer.utils'
import { readLivePendingBootstrapOffers } from '../bootstrap/bootstrap-pending-offer.utils'
import { BlueBootstrapReferenceRateService } from '../bootstrap/bootstrap-reference-rate.service'
import { createMakerAccount } from '../make/maker-account.utils'
import { createBlueReferenceReader } from '../reference/blue-reference-reader.utils'
import {
  activeOwnedLadderGroupIds,
  reconstructOwnedLadderPublication
} from './ladder-active-publication.utils'
import { LadderAdapterError } from './ladder-adapter.error'
import { ladderCashReservations } from './ladder-cash-reservation.utils'
import { createLadderGroupOwnership } from './ladder-group-ownership.utils'
import { MidnightLadderMakeService, type LadderOfferTransport } from './ladder-make.service'
import { buildLadderTree } from './ladder-offer.utils'
import { configuredRatifierType, prepareLadderRatification } from './ladder-ratification.utils'
import { assertLadderProspectiveSpread } from './ladder-spread.utils'
import {
  assertLadderCancellationTransaction,
  assertLadderPublicationTransaction,
  assertLadderRatificationTransaction
} from './ladder-transaction.utils'

/** Concrete ports used by the default ladder application service. */
type ProductionLadderAdapters = {
  positions: LadderPositionService
  rates: LadderReferenceRateService
  make: LadderMakeService
  validateReconcile: (parameters: Parameters<LadderMakeService['reconcile']>[0]) => Promise<void>
}

const minimum = (left: bigint, right: bigint) => (left < right ? left : right)
const remaining = (limit: bigint, used: bigint) => (limit > used ? limit - used : 0n)

const notifySubmitted = async (
  observer: LadderTransactionSubmittedObserver | undefined,
  operation: 'cancel' | 'ratify' | 'publish',
  txHash: Hex
) => {
  await observer?.({ operation, txHash })
}

type PublishLadderPublicationParameters = {
  approve: () => Promise<LadderSubmittedTransaction | undefined>
  validate: () => Promise<void>
  sendPublication: () => Promise<LadderSubmittedTransaction>
  confirmPublication: (transaction: LadderSubmittedTransaction) => Promise<void>
}

/**
 * Executes the ordered ratification and publication stages for one prepared ladder tree.
 * @param parameters - Confirmed approval, validation, publication submission, and receipt stages.
 * @returns Confirmed ratification and publication transactions in submission order.
 * @throws `LadderAdapterError` with confirmed approval evidence when publication confirmation fails.
 * @remarks A confirmed Setter approval remains recorded when the later publication is not confirmed,
 * allowing the application service to retain its durable reservation for safe cleanup.
 */
export const publishLadderPublication = async (
  parameters: PublishLadderPublicationParameters
): Promise<readonly LadderSubmittedTransaction[]> => {
  const submittedTransactions: LadderSubmittedTransaction[] = []
  try {
    const approval = await parameters.approve()
    if (approval) submittedTransactions.push(approval)
    await parameters.validate()
    const publication = await parameters.sendPublication()
    await parameters.confirmPublication(publication)
    submittedTransactions.push(publication)
    return submittedTransactions
  } catch (error) {
    if (submittedTransactions.length === 0) throw error
    const failure =
      error instanceof LadderAdapterError
        ? error
        : new LadderAdapterError('publication-after-ratification')
    throw failure.recordConfirmedTransactions(submittedTransactions)
  }
}

const ownedGroups = (publications: readonly OwnedLadderPublication[]) =>
  publications.flatMap(publication =>
    publication.groups.map(group => {
      const rungIndexes = new Set(group.rungIndexes)
      const maxAssets = publication.quote[group.side]
        .filter(rung => rungIndexes.has(rung.index))
        .reduce((sum, rung) => sum + rung.assets, 0n)
      if (maxAssets <= 0n) throw new LadderAdapterError('group-ownership-state')
      return { groupId: group.groupId, maxAssets }
    })
  )

/**
 * Composes live chain, archive reference, Mempool, signing, and ownership ladder adapters.
 * @param config - Fully validated runtime configuration.
 * @returns Production position, reference-rate, and make ports.
 * @throws `LadderAdapterError` when write-mode signer identity differs from the maker; later reads,
 * validation, signing, publication, storage, or receipt confirmation may also fail.
 * @remarks Read-only construction never derives an account or creates a wallet. Every published
 * tree is API-validated before and after signing and locally policy-checked. Ecrecover publication
 * uses one transaction. Setter publication uses an ordered approval transaction followed by the
 * publication transaction; its durable reservation remains owned after approval if publication is
 * not confirmed.
 */
export const createProductionLadderAdapters = (
  config: ConfigService,
  configuredAccount?: Awaited<ReturnType<typeof createMakerAccount>>
): ProductionLadderAdapters | Promise<ProductionLadderAdapters> => {
  const maker = config.identity.maker
  const client = createPublicClient({
    chain: base,
    transport: http(config.rpcUrl, { timeout: config.requestTimeoutMs })
  }).extend(morphoViemExtension({ supportSignature: true, supportDeployless: true }))
  const referenceClient = createPublicClient({
    chain: base,
    transport: http(config.referenceRpcUrl, { timeout: config.requestTimeoutMs })
  })
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
  const configByMarket = new Map(config.ladder.map(item => [item.marketId, item]))
  const readGroups = () =>
    readBootstrapGroups({
      maker,
      morphoApiBaseUrl: config.morphoApiBaseUrl,
      requestTimeoutMs: config.requestTimeoutMs
    })
  const readGroupConsumed = (groupId: Hex, blockNumber?: bigint) =>
    client.readContract({
      address: config.setup.midnight,
      abi: midnightAbi,
      functionName: 'consumed',
      args: [maker, groupId],
      ...(blockNumber === undefined ? {} : { blockNumber })
    })

  const positions: LadderPositionService = {
    readMarket: async marketId => {
      const selectedConfig = configByMarket.get(marketId)
      if (!selectedConfig) throw new LadderAdapterError('market-configuration-missing')
      const block = await client.getBlock({ blockTag: 'latest' })
      const [
        groups,
        publications,
        bootstrapGroupIds,
        persistedBootstrapOffers,
        cashBalance,
        allowance,
        positionSnapshots
      ] = await Promise.all([
        readGroups(),
        ladderOwnership.read(),
        bootstrapOwnership.read(),
        bootstrapOwnership.readOffers(),
        client.readContract({
          address: config.setup.loanAsset,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [maker]
        }),
        client.readContract({
          address: config.setup.loanAsset,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [maker, config.setup.midnight]
        }),
        Promise.all(
          config.setup.marketIds.map(async configuredMarketId => {
            const position = (
              await midnight.getPositionData({
                marketId: configuredMarketId,
                accountAddress: maker,
                parameters: { blockNumber: block.number }
              })
            ).accrueInterest(block.timestamp)
            return {
              marketId: configuredMarketId,
              credit: position.credit
            }
          })
        )
      ])
      const selectedPosition = positionSnapshots.find(item => item.marketId === marketId)
      if (!selectedPosition) throw new LadderAdapterError('position-unavailable')
      const pendingBootstrapOffers = await readLivePendingBootstrapOffers({
        groups,
        ownedGroupIds: bootstrapGroupIds,
        offers: persistedBootstrapOffers,
        readGroupConsumed: groupId => readGroupConsumed(groupId, block.number)
      })

      const replacedGroupIds = new Set(
        publications
          .filter(publication => publication.marketId === marketId)
          .flatMap(publication => publication.groups.map(group => group.groupId))
      )
      const reservations = ladderCashReservations({
        groups,
        publications,
        bootstrapGroupIds,
        bootstrapOffers: pendingBootstrapOffers,
        replacedGroupIds
      })
      const reservedCash = reservations.reduce((sum, reservation) => sum + reservation.assets, 0n)
      const availableCash = remaining(minimum(cashBalance, allowance), reservedCash)
      const marketReserved = reservations
        .filter(reservation => reservation.marketIds.includes(marketId))
        .reduce((sum, reservation) => sum + reservation.assets, 0n)
      const marketExposure = selectedPosition.credit + marketReserved
      const totalCredit = positionSnapshots.reduce((sum, position) => sum + position.credit, 0n)
      const totalExposure = totalCredit + reservedCash

      return {
        lowerRateCapacityAssets: selectedPosition.credit,
        higherRateCapacityAssets: availableCash,
        targetMarketCapacityAssets: remaining(
          selectedConfig.targetMarketExposureAssets,
          marketExposure
        ),
        maximumTotalCapacityAssets: remaining(
          selectedConfig.maximumTotalExposureAssets,
          totalExposure
        )
      }
    }
  }

  const blueRates = new BlueBootstrapReferenceRateService(
    createBlueReferenceReader(
      config.setup.referenceMarketId,
      referenceClient as HistoricalBlockReader
    )
  )
  const rates: LadderReferenceRateService = {
    readRate: async marketId => (await blueRates.readRate(marketId)).rateBps
  }

  const completeBookOffers = async () => {
    const [groups, bootstrapGroupIds, persistedBootstrapOffers] = await Promise.all([
      readGroups(),
      bootstrapOwnership.read(),
      bootstrapOwnership.readOffers()
    ])
    const pendingBootstrapOffers = await readLivePendingBootstrapOffers({
      groups,
      ownedGroupIds: bootstrapGroupIds,
      offers: persistedBootstrapOffers,
      readGroupConsumed
    })
    const pendingOffers = await Promise.all(
      pendingBootstrapOffers.map(async offer => {
        if (offer.tick !== undefined) {
          return { marketId: offer.marketId, buy: true, tick: offer.tick }
        }
        const market = await midnight.getMarketData(offer.marketId)
        const recoveredTick = recoverLegacyBootstrapOfferTick({
          groupId: offer.groupId,
          maximumAssets: offer.maximumAssets,
          market,
          maker,
          ratifier: config.setup.ratifier,
          continuousFeeCap: offer.continuousFeeCap
        })
        const conservativeTick =
          recoveredTick ?? legacyBootstrapOfferTickUpperBound({ offer, market }) ?? MAX_TICK
        return {
          marketId: offer.marketId,
          buy: true,
          tick: conservativeTick
        }
      })
    )
    return { groups, book: [...bootstrapBookOffers(groups), ...pendingOffers] }
  }

  const readActive = async (marketId: Hex) => {
    const [groups, publications] = await Promise.all([readGroups(), ladderOwnership.read()])
    return publications
      .filter(item => item.marketId === marketId)
      .toReversed()
      .map(publication => reconstructOwnedLadderPublication(publication, groups))
      .find(quote => quote !== undefined)
  }

  const prepareUnsignedPublication = async (quote: LadderQuoteSet) => {
    const [market, block] = await Promise.all([
      midnight.getMarketData(quote.marketId),
      client.getBlock({ blockTag: 'latest' })
    ])
    const prepared = buildLadderTree({
      quote,
      market,
      maker,
      ratifier: config.setup.ratifier,
      now: block.timestamp
    })
    await prepared.tree.mempoolValidate({
      chainId: base.id,
      apiUrl: `${config.morphoApiBaseUrl}/v0/midnight`
    })
    return prepared
  }

  const validateReconcile: ProductionLadderAdapters['validateReconcile'] = async parameters => {
    if (parameters.reason === 'rest' || !parameters.desired) return
    const prepared = await prepareUnsignedPublication(parameters.desired)
    const [bookState, publications] = await Promise.all([
      completeBookOffers(),
      ladderOwnership.read()
    ])
    assertLadderProspectiveSpread({
      marketId: parameters.marketId,
      replacedGroupIds: new Set(
        activeOwnedLadderGroupIds(publications, bookState.groups, parameters.marketId)
      ),
      book: bookState.book,
      prospective: prepared.bookOffers
    })
  }

  const readOnlyMake: LadderMakeService = {
    readActive,
    reconcile: async () => {
      throw new LadderAdapterError('readonly-mutation')
    },
    hardHalt: async () => {
      throw new LadderAdapterError('readonly-mutation')
    },
    cleanup: async () => {
      throw new LadderAdapterError('readonly-mutation')
    }
  }
  if (config.identity.readOnly) {
    return { positions, rates, make: readOnlyMake, validateReconcile }
  }

  const account = configuredAccount ?? createMakerAccount(config.identity)
  if (account instanceof Promise) {
    return account.then(value => createProductionLadderAdapters(config, value))
  }
  if (!isAddressEqual(account.address, maker)) {
    throw new LadderAdapterError('maker-private-key-mismatch')
  }
  const wallet = createWalletClient({
    account,
    chain: base,
    transport: http(config.rpcUrl, { timeout: config.requestTimeoutMs })
  })
    .extend(publicActions)
    .extend(morphoViemExtension({ supportSignature: true, supportDeployless: true }))
  const mempool = getChainAddress(base.id, 'midnightMempool')

  const transport: LadderOfferTransport = {
    readActive,
    listOwnedGroups: async () => ownedGroups(await ladderOwnership.read()),
    readGroupConsumed,
    listActiveGroupIds: async marketId => {
      const [publications, groups] = await Promise.all([ladderOwnership.read(), readGroups()])
      return activeOwnedLadderGroupIds(publications, groups, marketId)
    },
    listBookOffers: async () => (await completeBookOffers()).book,
    preparePublication: async quote => {
      const prepared = await prepareUnsignedPublication(quote)
      const ratifierType = configuredRatifierType(config.setup.ratifier)
      const ratification = await prepareLadderRatification({
        type: ratifierType,
        tree: prepared.tree,
        client: wallet,
        account
      })
      if (ratification.approval === undefined) {
        await prepared.tree.mempoolValidate({
          chainId: base.id,
          apiUrl: `${config.morphoApiBaseUrl}/v0/midnight`,
          ratification: ratification.validation
        })
      }
      const transaction = {
        to: mempool,
        data: await Payload.encode(ratification.items),
        value: 0n
      }
      await assertLadderPublicationTransaction(transaction, {
        target: mempool,
        items: ratification.items
      })
      const groupIds = [...new Set(prepared.groups.map(group => group.groupId))]
      return {
        groupIds,
        groups: prepared.groups,
        prospective: prepared.bookOffers,
        publish: onTransactionSubmitted =>
          publishLadderPublication({
            approve: async () => {
              if (ratification.approval === undefined) return undefined
              assertLadderRatificationTransaction(ratification.approval, {
                target: config.setup.ratifier,
                account: maker,
                root: prepared.tree.root
              })
              const txHash = await wallet.sendTransaction(ratification.approval)
              await notifySubmitted(onTransactionSubmitted, 'ratify', txHash)
              const receipt = await wallet.waitForTransactionReceipt({
                hash: txHash,
                timeout: config.transactionReceiptTimeoutMs
              })
              if (receipt.status !== 'success') {
                throw new LadderAdapterError('ratifier-transaction-reverted')
              }
              return { operation: 'ratify', txHash }
            },
            validate: async () => {
              if (ratification.approval === undefined) return
              try {
                await prepared.tree.mempoolValidate({
                  chainId: base.id,
                  apiUrl: `${config.morphoApiBaseUrl}/v0/midnight`,
                  ratification: ratification.validation
                })
              } catch {
                throw new LadderAdapterError('mempool-validation-after-ratification')
              }
            },
            sendPublication: async () => {
              const txHash = await wallet.sendTransaction(transaction)
              await notifySubmitted(onTransactionSubmitted, 'publish', txHash)
              return { operation: 'publish', txHash }
            },
            confirmPublication: async publication => {
              const receipt = await wallet.waitForTransactionReceipt({
                hash: publication.txHash,
                timeout: config.transactionReceiptTimeoutMs
              })
              if (receipt.status !== 'success') {
                throw new LadderAdapterError(
                  ratification.approval === undefined
                    ? 'transaction-reverted'
                    : 'publication-transaction-reverted-after-ratification'
                )
              }
            }
          })
      }
    },
    reservePublication: publication => ladderOwnership.reserve(publication),
    confirmPublication: ladderOwnership.confirm,
    releasePublication: ladderOwnership.release,
    invalidate: async (groupId, onTransactionSubmitted) => {
      const transaction = midnight.cancelOffer({ group: groupId, accountAddress: maker }).buildTx()
      assertLadderCancellationTransaction(transaction, {
        target: config.setup.midnight,
        groupId,
        account: maker
      })
      const hash = await wallet.sendTransaction(transaction)
      await notifySubmitted(onTransactionSubmitted, 'cancel', hash)
      const receipt = await wallet.waitForTransactionReceipt({
        hash,
        timeout: config.transactionReceiptTimeoutMs
      })
      if (receipt.status !== 'success') throw new LadderAdapterError('transaction-reverted')
      return hash
    },
    forgetGroups: ladderOwnership.forget
  }

  return {
    positions,
    rates,
    make: new MidnightLadderMakeService(transport),
    validateReconcile
  }
}
