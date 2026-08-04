import { Offer, TickLib, Tree } from '@morpho-org/midnight-sdk'
import { morphoViemExtension } from '@morpho-org/morpho-sdk'
import { getChainAddress } from '@morpho-org/morpho-ts'
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  isAddressEqual,
  publicActions,
  type Address,
  type Hex
} from 'viem'
import { base } from 'viem/chains'

import type {
  BootstrapSubmittedTransaction,
  BootstrapTransactionSubmittedObserver
} from '../../application/bootstrap/position-bootstrap-verbose'
import type {
  BootstrapMakeService,
  BootstrapPositionService,
  BootstrapReferenceRateService
} from '../../application/bootstrap/position-bootstrap.service'
import type { ConfigService } from '../../config/config.service'
import type { BootstrapOffer } from '../../domain/bootstrap/position-bootstrap'
import type { BootstrapActiveGroup, BootstrapInventoryReader } from './bootstrap-position.service'

import { pendingLadderQuoteSets } from '../ladder/ladder-active-publication.utils'
import { pendingLadderBuyReservations } from '../ladder/ladder-cash-reservation.utils'
import { createLadderGroupOwnership } from '../ladder/ladder-group-ownership.utils'
import { buildLadderTree } from '../ladder/ladder-offer.utils'
import { createManagedMakerAccount } from '../make/managed-maker-account.utils'
import { ReadOnlyBootstrapMakeService } from '../make/read-only-bootstrap-make.service'
import {
  createBlueReferenceReader,
  type HistoricalBlockReader
} from '../reference/blue-reference-reader.utils'
import { BootstrapAdapterError } from './bootstrap-adapter.error'
import { bootstrapExposureMarketIds } from './bootstrap-exposure.utils'
import { createBootstrapGroupOwnership } from './bootstrap-group-ownership.utils'
import {
  bootstrapBookOffers,
  bootstrapReservedLoanAssets,
  readBootstrapGroups,
  strategyBootstrapGroups
} from './bootstrap-groups.utils'
import { MidnightBootstrapMakeService } from './bootstrap-make.service'
import {
  validateBootstrapMempoolPayload,
  validateBootstrapMempoolPublication
} from './bootstrap-mempool-validation.utils'
import { createBootstrapOffer } from './bootstrap-offer.utils'
import { pendingBootstrapGroups } from './bootstrap-pending-offer.utils'
import { MidnightBootstrapPositionService } from './bootstrap-position.service'
import { BlueBootstrapReferenceRateService } from './bootstrap-reference-rate.service'
import { createBootstrapRequirementClient } from './bootstrap-requirement-client.utils'
import { prepareBootstrapRequirements } from './bootstrap-requirements.utils'
import { assertBootstrapProspectiveSpread, bootstrapMarketGroupIds } from './bootstrap-spread.utils'
import { assertBootstrapTransaction } from './bootstrap-transaction.utils'

const WAD = 10n ** 18n

type BootstrapMakeLendArguments = {
  accountAddress: Address
  offers: [Offer]
  validation: { apiUrl: string }
  loanToken: Address
  loanAssets: bigint
  reservedLoanAssets: bigint
}

/**
 * Builds the exact bounded argument object passed to Midnight `makeLend`.
 * @param parameters - Publication identity, offer, API endpoint, assets, and existing reserve.
 * @returns A single-offer publication request with the complete pre-existing owned reserve.
 */
export const bootstrapMakeLendArguments = (
  parameters: BootstrapMakeLendArguments
): BootstrapMakeLendArguments => parameters

type PublishBootstrapPublicationParameters = {
  ratifierType: 'ecrecover' | 'setter'
  payload: Hex
  ratify: () => Promise<readonly BootstrapSubmittedTransaction[]>
  validate: (payload: Hex) => Promise<void>
  publish: () => Promise<BootstrapSubmittedTransaction>
}

/**
 * Executes a prepared bootstrap publication with Setter's final payload validation barrier.
 * @param parameters - Exact payload plus confirmed ratification, validation, and publication steps.
 * @returns Confirmed ratification and publication transactions in submission order.
 * @throws `BootstrapAdapterError` after a confirmed approval when final validation or publication
 * fails; failures before approval confirmation pass through unchanged.
 * @remarks Ecrecover payloads were already validated after signing by the SDK preparation path and
 * therefore skip this Setter-only second validation. A confirmed Setter approval is retained in the
 * thrown error so the caller preserves its durable reservation for safe cleanup.
 */
export const publishBootstrapPublication = async (
  parameters: PublishBootstrapPublicationParameters
): Promise<readonly BootstrapSubmittedTransaction[]> => {
  const submittedTransactions: BootstrapSubmittedTransaction[] = []
  try {
    submittedTransactions.push(...(await parameters.ratify()))
    if (parameters.ratifierType === 'setter') {
      try {
        await parameters.validate(parameters.payload)
      } catch (error) {
        if (submittedTransactions.length > 0) {
          throw new BootstrapAdapterError('mempool-validation-after-ratification')
        }
        throw error
      }
    }
    submittedTransactions.push(await parameters.publish())
    return submittedTransactions
  } catch (error) {
    if (submittedTransactions.length === 0) throw error
    const failure =
      error instanceof BootstrapAdapterError
        ? error
        : new BootstrapAdapterError('publication-after-ratification')
    throw failure.recordConfirmedTransactions(submittedTransactions)
  }
}

/** Production ports used by the default position-bootstrap application service. */
type ProductionBootstrapAdapters = {
  positions: BootstrapPositionService
  rates: BootstrapReferenceRateService
  make: BootstrapMakeService
}

/**
 * Composes concrete viem, Morpho SDK, Midnight SDK, and Mempool adapters.
 * @param config - Fully validated runtime configuration.
 * @param writeReadOnlyEvent - Optional terminal writer for read-only make records.
 * @returns Production read ports and either a live mutation queue or terminal-only make adapter.
 * @throws `BootstrapAdapterError` when write-mode signer identity differs from the configured maker;
 * later provider reads, signing, publication, or invalidation may also fail.
 * @remarks No provider request or write occurs while this function constructs the adapters.
 * Read-only configuration never derives an account or constructs a wallet client. Write mode checks
 * the key-derived account before constructing any maker action, independently of the setup gate.
 */
export const createProductionBootstrapAdapters = (
  config: ConfigService,
  writeReadOnlyEvent?: (line: string) => void | Promise<void>
): ProductionBootstrapAdapters => {
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
  const ownership = createBootstrapGroupOwnership({
    maker,
    marketIds: config.setup.marketIds,
    configuredGroupIds: config.v0OfferGroupIds
  })
  const ladderOwnership = createLadderGroupOwnership({
    maker,
    strategyMarketIds: config.ladder.map(item => item.marketId)
  })
  const readGroups = () =>
    readBootstrapGroups({
      maker,
      morphoApiBaseUrl: config.morphoApiBaseUrl,
      requestTimeoutMs: config.requestTimeoutMs
    })

  const activeGroups = async (): Promise<BootstrapActiveGroup[]> => {
    const [block, groups, ownedIds, ownedOffers] = await Promise.all([
      client.getBlock({ blockTag: 'latest' }),
      readGroups(),
      ownership.read(),
      ownership.readOffers()
    ])
    const intended = new Map(
      ownedOffers.map(offer => [`${offer.groupId}:${offer.marketId}`, offer] as const)
    )
    return [
      ...strategyBootstrapGroups(groups, ownedIds)
        .filter(
          group =>
            group.marketId !== undefined &&
            group.tick !== undefined &&
            group.maturity !== undefined &&
            group.maxAssets > group.consumed
        )
        .map(group => {
          const persisted = intended.get(`${group.id}:${group.marketId as Hex}`)
          return {
            id: group.id,
            marketId: group.marketId as Hex,
            assets: group.maxAssets - group.consumed,
            rateBps:
              persisted?.rateBps ??
              TickLib.tickToApr(
                group.tick as bigint,
                (group.maturity as bigint) - block.timestamp
              ) /
                (WAD / 10_000n),
            ...(persisted ? { referenceObservationId: persisted.referenceObservationId } : {})
          }
        }),
      ...pendingBootstrapGroups(groups, ownedOffers)
    ]
  }

  const readGroupInventory = async () => {
    const [block, groups, ownedIds, ownedOffers, ladderPublications] = await Promise.all([
      client.getBlock({ blockTag: 'latest' }),
      readGroups(),
      ownership.read(),
      ownership.readOffers(),
      ladderOwnership.read()
    ])
    const intended = new Map(
      ownedOffers.map(offer => [`${offer.groupId}:${offer.marketId}`, offer] as const)
    )
    const project = (
      selectedGroups: ReturnType<typeof strategyBootstrapGroups>,
      includeIntent: boolean
    ): BootstrapActiveGroup[] =>
      selectedGroups
        .filter(
          group =>
            group.marketId !== undefined &&
            group.tick !== undefined &&
            group.maturity !== undefined &&
            group.maxAssets > group.consumed
        )
        .map(group => {
          const persisted = includeIntent
            ? intended.get(`${group.id}:${group.marketId as Hex}`)
            : undefined
          return {
            id: group.id,
            marketId: group.marketId as Hex,
            assets: group.maxAssets - group.consumed,
            rateBps:
              persisted?.rateBps ??
              TickLib.tickToApr(
                group.tick as bigint,
                (group.maturity as bigint) - block.timestamp
              ) /
                (WAD / 10_000n),
            ...(persisted ? { referenceObservationId: persisted.referenceObservationId } : {})
          }
        })

    return {
      activeGroups: [
        ...project(strategyBootstrapGroups(groups, ownedIds), true),
        ...pendingBootstrapGroups(groups, ownedOffers)
      ],
      cashReservations: [
        ...project(
          strategyBootstrapGroups(
            groups,
            ladderPublications.flatMap(publication =>
              publication.groups.map(group => group.groupId)
            )
          ),
          false
        ),
        ...pendingLadderBuyReservations(groups, ladderPublications).flatMap(reservation =>
          reservation.marketIds.map(marketId => ({
            id: reservation.id,
            marketId,
            assets: reservation.assets,
            rateBps: 0n
          }))
        )
      ]
    }
  }

  const ownedGroupIds = () => ownership.read()

  const inventory: BootstrapInventoryReader = {
    readPositions: async () => {
      const block = await client.getBlock({ blockTag: 'latest' })
      return Promise.all(
        bootstrapExposureMarketIds(config).map(async marketId => {
          const position = (
            await midnight.getPositionData({
              marketId,
              accountAddress: maker,
              parameters: { blockNumber: block.number }
            })
          ).accrueInterest(block.timestamp)
          return { marketId, credit: position.credit, debt: position.debt }
        })
      )
    },
    readCashBalance: () =>
      client.readContract({
        address: config.setup.loanAsset,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [maker]
      }),
    readGroupInventory
  }

  const positions = new MidnightBootstrapPositionService(inventory, maker)
  const rates = new BlueBootstrapReferenceRateService(
    createBlueReferenceReader(
      config.setup.referenceMarketId,
      referenceClient as HistoricalBlockReader
    )
  )
  const prepareOffer = async (offer: BootstrapOffer) => {
    const [market, block] = await Promise.all([
      midnight.getMarketData(offer.marketId),
      client.getBlock({ blockTag: 'latest' })
    ])
    return createBootstrapOffer({
      offer,
      market,
      maker,
      ratifier: config.setup.ratifier,
      now: block.timestamp
    })
  }
  const completeBookOffers = async () => {
    const [groups, ladderPublications] = await Promise.all([readGroups(), ladderOwnership.read()])
    const pendingLadderOffers = (
      await Promise.all(
        pendingLadderQuoteSets(ladderPublications, groups).map(async quote => {
          const [market, block] = await Promise.all([
            midnight.getMarketData(quote.marketId),
            client.getBlock({ blockTag: 'latest' })
          ])
          return buildLadderTree({
            quote,
            market,
            maker,
            ratifier: config.setup.ratifier,
            now: block.timestamp
          }).bookOffers
        })
      )
    ).flat()
    return {
      groups,
      ladderPublications,
      book: [...bootstrapBookOffers(groups), ...pendingLadderOffers]
    }
  }
  const prepareMempoolPublication = (
    offer: BootstrapOffer,
    created: Offer,
    groups: Awaited<ReturnType<typeof readGroups>>,
    ownedIds: readonly Hex[],
    replacedGroupIds: ReadonlySet<Hex>
  ) =>
    validateBootstrapMempoolPublication(() =>
      midnight.makeLend(
        bootstrapMakeLendArguments({
          accountAddress: maker,
          offers: [created],
          validation: { apiUrl: `${config.morphoApiBaseUrl}/v0/midnight` },
          loanToken: config.setup.loanAsset,
          loanAssets: offer.assets,
          reservedLoanAssets: bootstrapReservedLoanAssets(groups, ownedIds, replacedGroupIds)
        })
      )
    )

  if (config.identity.readOnly) {
    const validate = async (parameters: Parameters<BootstrapMakeService['reconcile']>[0]) => {
      if (!parameters.desiredOffer) return

      const [bookState, ownedIds, prospectiveOffer, activeStrategyGroups] = await Promise.all([
        completeBookOffers(),
        ownership.read(),
        prepareOffer(parameters.desiredOffer),
        activeGroups()
      ])
      const marketGroupIds = bootstrapMarketGroupIds(activeStrategyGroups, parameters.marketId)
      assertBootstrapProspectiveSpread({
        marketId: parameters.marketId,
        replacedGroupIds: marketGroupIds,
        book: bookState.book,
        prospective: {
          marketId: parameters.marketId,
          buy: true,
          tick: prospectiveOffer.tick
        }
      })
      await prepareMempoolPublication(
        parameters.desiredOffer,
        prospectiveOffer,
        bookState.groups,
        [
          ...ownedIds,
          ...bookState.ladderPublications.flatMap(publication =>
            publication.groups.map(group => group.groupId)
          )
        ],
        marketGroupIds
      )
    }
    return {
      positions,
      rates,
      make: new ReadOnlyBootstrapMakeService(writeReadOnlyEvent, validate)
    }
  }

  const account = createManagedMakerAccount(config.identity.privateKey)
  if (!isAddressEqual(account.address, maker)) {
    throw new BootstrapAdapterError('maker-private-key-mismatch')
  }
  const wallet = createWalletClient({
    account,
    chain: base,
    transport: http(config.rpcUrl, { timeout: config.requestTimeoutMs })
  })
    .extend(publicActions)
    .extend(morphoViemExtension({ supportSignature: true, supportDeployless: true }))

  const execute = async (
    transaction: { to: `0x${string}`; data: Hex; value: bigint },
    policy: Parameters<typeof assertBootstrapTransaction>[1],
    operation: 'cancel' | 'ratify' | 'publish',
    onTransactionSubmitted?: BootstrapTransactionSubmittedObserver,
    revertOperation = 'transaction-reverted'
  ) => {
    await assertBootstrapTransaction(transaction, policy)
    const hash = await wallet.sendTransaction(transaction)
    await onTransactionSubmitted?.({ operation, txHash: hash })
    const receipt = await wallet.waitForTransactionReceipt({
      hash,
      timeout: config.transactionReceiptTimeoutMs
    })
    if (receipt.status !== 'success') throw new BootstrapAdapterError(revertOperation)
    return hash
  }

  const preparedOffers = new Map<Hex, Offer>()
  const make = new MidnightBootstrapMakeService({
    listActiveGroups: activeGroups,
    listOwnedGroupIds: ownedGroupIds,
    listBookOffers: async () => (await completeBookOffers()).book,
    toProspectiveBookOffer: async offer => {
      const created = await prepareOffer(offer)
      preparedOffers.set(offer.marketId, created)
      return { marketId: offer.marketId, buy: true, tick: created.tick }
    },
    invalidate: async (group, onTransactionSubmitted) => {
      return execute(
        midnight.cancelOffer({ group, accountAddress: maker }).buildTx(),
        {
          kind: 'cancel',
          target: config.setup.midnight,
          groupId: group,
          account: maker
        },
        'cancel',
        onTransactionSubmitted
      )
    },
    reserveGroup: ownership.reserve,
    confirmPublishedGroup: ownership.confirm,
    releaseGroupReservation: ownership.release,
    forgetGroups: ownership.forget,
    preparePublication: async (offer: BootstrapOffer) => {
      const created = preparedOffers.get(offer.marketId)
      preparedOffers.delete(offer.marketId)
      if (!created) throw new BootstrapAdapterError('prospective-offer-missing')
      const [groups, ownedIds, ladderOwnedIds, activeStrategyGroups] = await Promise.all([
        readGroups(),
        ownership.read(),
        ladderOwnership.readGroupIds(),
        activeGroups()
      ])
      const replacedGroupIds = bootstrapMarketGroupIds(activeStrategyGroups, offer.marketId)
      const output = await prepareMempoolPublication(
        offer,
        created,
        groups,
        [...ownedIds, ...ladderOwnedIds],
        replacedGroupIds
      )
      const tree = Tree.create([created])
      if (tree.root !== output.root) {
        throw new BootstrapAdapterError('unexpected-requirement')
      }
      const requirementClient = createBootstrapRequirementClient({ account, chain: base, tree })
      const { signatures, transactions: ratificationTransactions } =
        await prepareBootstrapRequirements(
          await output.getRequirements(),
          (requirement, requirementAccount) =>
            requirement.sign(requirementClient, requirementAccount) as Promise<
              import('@morpho-org/morpho-sdk').MidnightOfferRootSignature
            >,
          output.ratifierType === 'ecrecover'
            ? {
                kind: 'ecrecover',
                target: config.setup.ratifier,
                root: output.root,
                account: maker,
                offers: tree.offers.length
              }
            : { kind: 'setter', target: config.setup.ratifier, root: output.root, account: maker }
        )
      if (
        (output.ratifierType === 'setter' && signatures.length > 0) ||
        (output.ratifierType === 'ecrecover' &&
          (signatures.length !== 1 || ratificationTransactions.length > 0))
      ) {
        throw new BootstrapAdapterError('unexpected-requirement')
      }
      const transaction = output.buildTx(signatures)
      const publicationPolicy = {
        kind: 'publication' as const,
        target: getChainAddress(base.id, 'midnightMempool'),
        offer: created,
        ratifierType: output.ratifierType,
        chainId: base.id,
        root: output.root,
        maker
      }
      await assertBootstrapTransaction(transaction, publicationPolicy)
      return {
        groupId: output.groups[0] as Hex,
        publish: onTransactionSubmitted =>
          publishBootstrapPublication({
            ratifierType: output.ratifierType,
            payload: transaction.data,
            ratify: async () => {
              const submittedTransactions: BootstrapSubmittedTransaction[] = []
              for (const ratification of ratificationTransactions) {
                const txHash = await execute(
                  ratification,
                  {
                    kind: 'ratification',
                    target: config.setup.ratifier,
                    root: output.root,
                    account: maker
                  },
                  'ratify',
                  onTransactionSubmitted,
                  'ratifier-transaction-reverted'
                )
                submittedTransactions.push({ operation: 'ratify' as const, txHash })
              }
              return submittedTransactions
            },
            validate: payload =>
              validateBootstrapMempoolPayload({
                chainId: base.id,
                baseUrl: `${config.morphoApiBaseUrl}/v0/midnight`,
                payload
              }),
            publish: async () => {
              const txHash = await execute(
                transaction,
                publicationPolicy,
                'publish',
                onTransactionSubmitted,
                output.ratifierType === 'setter'
                  ? 'publication-transaction-reverted-after-ratification'
                  : 'transaction-reverted'
              )
              return { operation: 'publish' as const, txHash }
            }
          })
      }
    }
  })

  return {
    positions,
    rates,
    make
  }
}
