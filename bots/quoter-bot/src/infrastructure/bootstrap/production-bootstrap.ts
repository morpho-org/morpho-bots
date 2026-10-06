import type { Offer } from '@morpho-org/midnight-sdk'

import {
  EcrecoverRatifierUtils,
  midnightAbi,
  Payload,
  TickLib,
  Tree
} from '@morpho-org/midnight-sdk'
import { morphoViemExtension } from '@morpho-org/morpho-sdk'
import { getChainAddress } from '@morpho-org/morpho-ts'
import { createPublicClient, http, isAddressEqual, type Address, type Hex } from 'viem'

import type {
  BootstrapSubmittedTransaction,
  BootstrapTransactionSubmittedObserver
} from '../../application/bootstrap/position-bootstrap-verbose'
import type {
  BootstrapMakeService,
  BootstrapPositionService,
  BootstrapReferenceRateService
} from '../../application/bootstrap/position-bootstrap.service'
import type { OperatorAdapterOperation } from '../../application/monitoring/operator-error-name.utils'
import type { ConfigService } from '../../config/config.service'
import type { BootstrapOffer } from '../../domain/position-bootstrap'
import type { HistoricalBlockReader } from '../reference/blue-reference-reader.utils'
import type { BootstrapActiveGroup, BootstrapInventoryReader } from './bootstrap-position.service'

import { supportedChain } from '../../config/supported-chains.utils'
import { acceptedLossFactorOf } from '../../domain/loss-factor'
import { remainingBuyAssets, remainingCap } from '../../domain/offer-cap'
import { isAprWadInRange } from '../../domain/tick-window'
import { admitExposureCandidate } from '../exposure/exposure-admission.utils'
import {
  createExposureSnapshotReader,
  durableBuyReservations,
  readExposureSnapshot
} from '../exposure/exposure-snapshot.utils'
import { invalidateOffersBatch } from '../invalidation/batch-offer-invalidation.utils'
import { OfferInvalidationAdapterError } from '../invalidation/offer-invalidation-adapter.error'
import { ownedLadderBookOffers } from '../ladder/ladder-active-publication.utils'
import { readLadderBookOffers } from '../ladder/ladder-book.utils'
import { createLadderGroupOwnership } from '../ladder/ladder-group-ownership.utils'
import { maturityReadsByMarket } from '../provider/maturity-read.utils'
import { readMakerOfferGroups } from '../provider/offer-groups.utils'
import { createBlueReferenceReader } from '../reference/blue-reference-reader.utils'
import { executeAdapterTransaction } from '../transaction/adapter-transaction-executor.utils'
import { assertBootstrapTransaction } from '../transaction/bootstrap-transaction.utils'
import {
  createQuoterTransactionExecutor,
  type QuoterTransactionExecutor
} from '../transaction/quoter-transaction-executor'
import { createSignerAccount } from '../transaction/signer-account.utils'
import { BootstrapAdapterError } from './bootstrap-adapter.error'
import { resolveBootstrapProspectiveOffer } from './bootstrap-cross-book.utils'
import { bootstrapExposureMarketIds } from './bootstrap-exposure.utils'
import { createBootstrapGroupOwnership } from './bootstrap-group-ownership.utils'
import {
  bootstrapBookOffers,
  bootstrapGroupRateBps,
  bootstrapReservedLoanAssets,
  strategyBootstrapGroups
} from './bootstrap-groups.utils'
import { bootstrapInventoryFromSnapshot } from './bootstrap-inventory.utils'
import { ReadOnlyBootstrapMakeService } from './bootstrap-make.read-only'
import { MidnightBootstrapMakeService } from './bootstrap-make.service'
import {
  validateBootstrapMempoolPayload,
  validateBootstrapMempoolPublication
} from './bootstrap-mempool-validation.utils'
import {
  bootstrapContinuousFeeCap,
  bootstrapRateWindowIsEmpty,
  createBootstrapOffer
} from './bootstrap-offer.utils'
import {
  readLivePendingBootstrapOffers,
  readOwnedGroupIdsForCleanup
} from './bootstrap-pending-offer.utils'
import { MidnightBootstrapPositionService } from './bootstrap-position.service'
import {
  BlueBootstrapReferenceRateService,
  StrategyBootstrapReferenceRateService
} from './bootstrap-reference-rate.service'
import { prepareBootstrapRequirements } from './bootstrap-requirements.utils'
import { bootstrapMarketGroupIds } from './bootstrap-spread.utils'

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

/**
 * The loan assets a bootstrap offer can spend, which `makeLend` reserves.
 * @param units - The offer's `maxUnits`.
 * @param tick - The offer's final protocol tick.
 * @returns The {@link remainingBuyAssets} bound of the units cap at `tick`, floored at one because
 * `makeLend` rejects zero.
 */
export const bootstrapLoanAssets = (units: bigint, tick: bigint) => {
  const assets = remainingBuyAssets({ kind: 'units', maximum: units }, 0n, [tick])
  return assets > 0n ? assets : 1n
}

type PrepareCappedBootstrapOfferParameters = {
  offer: BootstrapOffer
  maximumAssets?: bigint
  created: Offer
  exactTick?: bigint
  minimumRateBps: bigint
  maximumRateBps: bigint
  prepareOffer: (
    offer: BootstrapOffer,
    exactTick?: bigint
  ) => Promise<{ created: Offer; effectiveRateWad?: bigint }>
}

/**
 * Applies a reconciliation asset cap and re-projects the exact Midnight offer when it changes.
 * @param parameters - Resolved domain offer, optional cap, current projection, and projection port.
 * @returns The capped domain offer and matching Midnight offer used for read-only validation.
 * @throws Forwards projection failures when applying the cap requires a fresh Midnight offer.
 */
export const prepareCappedBootstrapOffer = async (
  parameters: PrepareCappedBootstrapOfferParameters
) => {
  if (
    parameters.maximumAssets === undefined ||
    parameters.offer.assets <= parameters.maximumAssets
  ) {
    return { offer: parameters.offer, created: parameters.created }
  }
  const offer = { ...parameters.offer, assets: parameters.maximumAssets }
  const { created, effectiveRateWad } = await parameters.prepareOffer(offer, parameters.exactTick)
  if (effectiveRateWad !== undefined && !isAprWadInRange(effectiveRateWad, parameters)) {
    throw new BootstrapAdapterError('negative-spread')
  }
  return { offer, created }
}

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
 * @remarks Ecrecover payloads were validated unsigned by the SDK preparation path and skip this
 * Setter-only second validation, so their signature never leaves the process before publication. A
 * confirmed Setter approval is retained in the thrown error so the caller preserves its durable
 * reservation for safe cleanup.
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
        // oxlint-disable-next-line max-depth
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
 * @param configuredAccount - Optional preconstructed account for write-mode adapter reuse.
 * @param ignoredOfferGroupIds - Recently canceled ladder groups still visible in the API index.
 * @param configuredExecutor - Optional invocation-scoped transaction executor shared with the ladder.
 * @returns Production read ports and either a live mutation queue or terminal-only make adapter.
 * @throws `SignerAccountError` for construction failures, or `BootstrapAdapterError` when an
 * injected account violates the required maker relationship; later operations may also fail.
 * @remarks No provider request or write occurs while this function constructs the adapters.
 * Read-only configuration never derives an account or constructs a wallet client. Write mode checks
 * the key-derived account before constructing any maker action, independently of the setup gate.
 */
export const createProductionBootstrapAdapters = (
  config: ConfigService,
  writeReadOnlyEvent?: (line: string) => void | Promise<void>,
  configuredAccount?: Awaited<ReturnType<typeof createSignerAccount>>,
  ignoredOfferGroupIds: readonly Hex[] = [],
  configuredExecutor?: QuoterTransactionExecutor
): ProductionBootstrapAdapters | Promise<ProductionBootstrapAdapters> => {
  const maker = config.identity.maker
  const client = createPublicClient({
    chain: supportedChain(config.chainId),
    transport: http(config.rpcUrl, { timeout: config.requestTimeoutMs })
  }).extend(morphoViemExtension({ supportSignature: true, supportDeployless: true }))
  const referenceClient = createPublicClient({
    chain: supportedChain(config.chainId),
    transport: http(config.referenceRpcUrl ?? config.rpcUrl, { timeout: config.requestTimeoutMs })
  })
  const midnight = client.morpho.midnight(config.chainId)
  const ownership = createBootstrapGroupOwnership({
    chainId: config.chainId,
    maker,
    marketIds: config.setup.marketIds,
    configuredGroupIds: config.v0OfferGroupIds
  })
  const ladderOwnership = createLadderGroupOwnership({
    chainId: config.chainId,
    maker
  })
  const ignoredGroupIds = new Set(ignoredOfferGroupIds)
  const readLadderPublications = async () =>
    (await ladderOwnership.read())
      .map(publication => ({
        ...publication,
        groups: publication.groups.filter(group => !ignoredGroupIds.has(group.groupId))
      }))
      .filter(publication => publication.groups.length > 0)
  const readLadderGroupIds = async () =>
    (await ladderOwnership.readGroupIds()).filter((groupId: Hex) => !ignoredGroupIds.has(groupId))
  const readGroups = () =>
    readMakerOfferGroups({
      adapterError: BootstrapAdapterError,
      chainId: config.chainId,
      maker,
      morphoApiBaseUrl: config.morphoApiBaseUrl,
      requestTimeoutMs: config.requestTimeoutMs
    })
  const bootstrapRateBounds = (marketId: Hex) =>
    config.bootstrap.find(item => item.marketId === marketId)
  const prepareOfferAtLatest = async (offer: BootstrapOffer, exactTick?: bigint) => {
    const [market, block] = await Promise.all([
      midnight.getMarketData(offer.marketId),
      client.getBlock({ blockTag: 'latest' })
    ])
    const bounds = bootstrapRateBounds(offer.marketId)
    const created = createBootstrapOffer({
      offer,
      market,
      maker,
      ratifier: config.setup.ratifier,
      now: block.timestamp,
      exactTick,
      ...(bounds === undefined
        ? {}
        : { minimumRateBps: bounds.minimumRateBps, maximumRateBps: bounds.maximumRateBps })
    })
    return {
      created,
      timestamp: block.timestamp,
      maturity: market.params.maturity,
      tickSpacing: BigInt(market.tickSpacing)
    }
  }
  const readGroupConsumed = (groupId: Hex, blockNumber: bigint) =>
    client.readContract({
      address: config.setup.midnight,
      abi: midnightAbi,
      functionName: 'consumed',
      args: [maker, groupId],
      blockNumber
    })
  const readPendingGroups = async (
    blockNumber: bigint,
    groups: Awaited<ReturnType<typeof readGroups>>,
    ownedGroupIds: readonly Hex[],
    offers: Awaited<ReturnType<typeof ownership.readOffers>>
  ): Promise<BootstrapActiveGroup[]> => {
    const liveOffers = await readLivePendingBootstrapOffers({
      groups,
      ownedGroupIds,
      offers,
      readGroupConsumed: groupId => readGroupConsumed(groupId, blockNumber)
    })

    return liveOffers.map(({ groupId, ...offer }) => ({ id: groupId, ...offer, offerCount: 1 }))
  }

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
    const pendingGroups = await readPendingGroups(block.number, groups, ownedIds, ownedOffers)

    return [
      ...strategyBootstrapGroups(groups, ownedIds)
        .filter(
          group =>
            group.marketId !== undefined &&
            group.tick !== undefined &&
            group.maturity !== undefined &&
            remainingCap(group.cap, group.consumed) > 0n
        )
        .map(group => {
          const persisted = intended.get(`${group.id}:${group.marketId as Hex}`)
          return {
            id: group.id,
            marketId: group.marketId as Hex,
            assets: remainingCap(group.cap, group.consumed),
            tick: group.tick as bigint,
            maximumAssets: group.cap.maximum,
            offerCount: group.offers.length,
            continuousFeeCap: group.continuousFeeCap,
            rateBps:
              persisted?.rateBps ??
              bootstrapGroupRateBps({
                tick: group.tick as bigint,
                maturity: group.maturity as bigint,
                observedTimestamp: block.timestamp
              }),
            ...(persisted ? { referenceObservationId: persisted.referenceObservationId } : {})
          }
        }),
      ...pendingGroups
    ]
  }

  const uncanceledOwnedGroupIds = () =>
    readOwnedGroupIdsForCleanup({
      readOwnedGroupIds: ownership.read,
      readBlockNumber: async () => (await client.getBlock({ blockTag: 'latest' })).number,
      readGroupConsumed
    })

  const exposureReader = createExposureSnapshotReader({
    client,
    positions: midnight,
    maker,
    midnight: config.setup.midnight,
    loanAsset: config.setup.loanAsset,
    marketIds: bootstrapExposureMarketIds(config)
  })
  const readSnapshot = async (minimumBlockNumber?: bigint) => {
    const [groups, ownedGroupIds, ownedOffers, ladderPublications] = await Promise.all([
      readGroups(),
      ownership.read(),
      ownership.readOffers(),
      readLadderPublications()
    ])
    const snapshot = await readExposureSnapshot({
      reader: exposureReader,
      indexedGroups: groups,
      durableReservations: durableBuyReservations({
        ladderPublications,
        bootstrapGroupIds: ownedGroupIds,
        bootstrapOffers: ownedOffers
      }),
      ...(minimumBlockNumber === undefined ? {} : { minimumBlockNumber }),
      adapterError: BootstrapAdapterError
    })
    return { snapshot, groups, ownedGroupIds, ownedOffers }
  }

  const inventory: BootstrapInventoryReader = {
    readInventory: async () => bootstrapInventoryFromSnapshot(await readSnapshot()),
    readMarketContinuousFeeCap: async marketId =>
      bootstrapContinuousFeeCap(await midnight.getMarketData(marketId)),
    readMarketMaturity: async marketId => {
      const [market, block] = await Promise.all([
        midnight.getMarketData(marketId),
        client.getBlock({ blockTag: 'latest' })
      ])
      const bounds = bootstrapRateBounds(marketId)
      return {
        maturityTimestamp: market.params.maturity,
        observedTimestamp: block.timestamp,
        rateWindowEmpty: bootstrapRateWindowIsEmpty(market, {
          now: block.timestamp,
          ...(bounds === undefined
            ? {}
            : { minimumRateBps: bounds.minimumRateBps, maximumRateBps: bounds.maximumRateBps })
        })
      }
    }
  }

  const positions = new MidnightBootstrapPositionService(
    inventory,
    maker,
    config.setup.acceptedLossFactor ?? new Map()
  )
  const blueRates = new BlueBootstrapReferenceRateService(
    BootstrapAdapterError,
    createBlueReferenceReader(
      config.setup.referenceMarketId ?? config.setup.marketIds[0]!,
      referenceClient as HistoricalBlockReader,
      config.chainId
    ),
    config.referenceLookbackSeconds
  )
  const rates = new StrategyBootstrapReferenceRateService(
    BootstrapAdapterError,
    new Map(config.bootstrap.map(item => [item.marketId, item.targetRate] as const)),
    blueRates,
    maturityReadsByMarket({
      adapterError: BootstrapAdapterError,
      entries: config.bootstrap,
      midnight,
      client
    })
  )
  const completeBookOffers = async (marketId: Hex) => {
    const [groups, ladderPublications, wholeBook] = await Promise.all([
      readGroups(),
      readLadderPublications(),
      readLadderBookOffers({
        baseUrl: config.morphoApiBaseUrl,
        marketIds: [marketId],
        timeoutMs: config.requestTimeoutMs,
        ignoredOfferGroupIds
      })
    ])
    const indexedOffers = bootstrapBookOffers(groups)
    const key = (offer: { groupId?: Hex; marketId: Hex; buy: boolean; tick: bigint }) =>
      `${offer.groupId ?? ''}:${offer.marketId}:${offer.buy ? 'buy' : 'sell'}:${offer.tick}`
    const wholeBookKeys = new Set(wholeBook.map(key))
    const indexedBook = [
      ...wholeBook,
      ...indexedOffers.filter(offer => !wholeBookKeys.has(key(offer)))
    ]
    const indexedKeys = new Set(indexedBook.map(key))
    return {
      groups,
      ladderPublications,
      book: [
        ...indexedBook,
        ...ownedLadderBookOffers(ladderPublications, groups, marketId).filter(
          offer => !indexedKeys.has(key(offer))
        )
      ]
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
          loanAssets: bootstrapLoanAssets(offer.assets, created.tick),
          reservedLoanAssets: bootstrapReservedLoanAssets(groups, replacedGroupIds)
        })
      )
    )

  if (config.identity.readOnly) {
    const validate = async (parameters: Parameters<BootstrapMakeService['reconcile']>[0]) => {
      if (!parameters.desiredOffer) return parameters

      const [bookState, ownedIds, activeStrategyGroups, initialPrepared] = await Promise.all([
        completeBookOffers(parameters.marketId),
        ownership.read(),
        activeGroups(),
        prepareOfferAtLatest(parameters.desiredOffer)
      ])
      const marketGroupIds = bootstrapMarketGroupIds(activeStrategyGroups, parameters.marketId)
      const spreadReplacedGroupIds = new Set([
        ...bootstrapMarketGroupIds(activeStrategyGroups, parameters.marketId),
        ...ownedIds
      ])
      const bounds = config.bootstrap.find(item => item.marketId === parameters.marketId)
      if (!bounds) throw new BootstrapAdapterError('negative-spread')
      let created = initialPrepared.created
      const resolved = await resolveBootstrapProspectiveOffer({
        desiredOffer: parameters.desiredOffer,
        prospective: {
          marketId: parameters.marketId,
          buy: true,
          tick: created.tick,
          continuousFeeCap: created.continuousFeeCap
        },
        replacedGroupIds: spreadReplacedGroupIds,
        book: bookState.book,
        minimumRateBps: bounds.minimumRateBps,
        maximumRateBps: bounds.maximumRateBps,
        toProspectiveBookOffer: async (offer, exactTick) => {
          const prepared = await prepareOfferAtLatest(offer, exactTick)
          created = prepared.created
          return {
            marketId: offer.marketId,
            buy: true,
            tick: created.tick,
            continuousFeeCap: created.continuousFeeCap,
            tickSpacing: prepared.tickSpacing,
            ...(exactTick === undefined
              ? {}
              : {
                  effectiveRateWad: TickLib.tickToApr(
                    created.tick,
                    prepared.maturity - prepared.timestamp
                  )
                })
          }
        }
      })
      if (!resolved) return { ...parameters, desiredOffer: undefined }
      const capped = await prepareCappedBootstrapOffer({
        offer: resolved.offer,
        maximumAssets: parameters.maximumAssets,
        created,
        exactTick: resolved.prospective.tick,
        minimumRateBps: bounds.minimumRateBps,
        maximumRateBps: bounds.maximumRateBps,
        prepareOffer: async (offer, exactTick) => {
          const prepared = await prepareOfferAtLatest(offer, exactTick)
          return {
            created: prepared.created,
            ...(exactTick === undefined
              ? {}
              : {
                  effectiveRateWad: TickLib.tickToApr(
                    prepared.created.tick,
                    prepared.maturity - prepared.timestamp
                  )
                })
          }
        }
      })
      const resolvedOffer = capped.offer
      created = capped.created
      await prepareMempoolPublication(
        resolvedOffer,
        created,
        bookState.groups,
        [
          ...ownedIds,
          ...bookState.ladderPublications.flatMap(publication =>
            publication.groups.map(group => group.groupId)
          )
        ],
        marketGroupIds
      )
      return { ...parameters, desiredOffer: resolvedOffer }
    }
    return {
      positions,
      rates,
      make: new ReadOnlyBootstrapMakeService(writeReadOnlyEvent, validate)
    }
  }

  const account = configuredAccount ?? createSignerAccount(config.identity)
  if (account instanceof Promise) {
    return account.then(value =>
      createProductionBootstrapAdapters(
        config,
        writeReadOnlyEvent,
        value,
        ignoredOfferGroupIds,
        configuredExecutor
      )
    )
  }
  if (
    (config.identity.method === 'aws' && isAddressEqual(account.address, maker)) ||
    (config.identity.method !== 'aws' && !isAddressEqual(account.address, maker))
  ) {
    throw new BootstrapAdapterError('signer-identity-mismatch')
  }
  const transactionExecutor = configuredExecutor ?? createQuoterTransactionExecutor(config, account)

  const execute = async (
    transaction: { to: Address; data: Hex; value: bigint },
    policy: Parameters<typeof assertBootstrapTransaction>[1],
    operation: 'cancel' | 'ratify' | 'publish',
    onTransactionSubmitted?: BootstrapTransactionSubmittedObserver,
    revertOperation: OperatorAdapterOperation = 'transaction-reverted'
  ) => {
    await assertBootstrapTransaction(transaction, policy)
    return executeAdapterTransaction(
      BootstrapAdapterError,
      transactionExecutor,
      {
        transaction,
        operation,
        label: `bootstrap:${operation}`,
        onTransactionSubmitted: hash => onTransactionSubmitted?.({ operation, txHash: hash })
      },
      revertOperation
    )
  }

  const preparedOffers = new Map<Hex, { created: Offer; assets: bigint; rateBps: bigint }>()
  const make = new MidnightBootstrapMakeService({
    rateBounds: marketId => config.bootstrap.find(item => item.marketId === marketId),
    listActiveGroups: activeGroups,
    listOwnedGroupIds: uncanceledOwnedGroupIds,
    listBookOffers: async marketId => (await completeBookOffers(marketId)).book,
    toProspectiveBookOffer: async (offer, exactTick) => {
      const prepared = await prepareOfferAtLatest(offer, exactTick)
      const created = prepared.created
      preparedOffers.set(offer.marketId, { created, assets: offer.assets, rateBps: offer.rateBps })
      return {
        marketId: offer.marketId,
        buy: true,
        tick: created.tick,
        continuousFeeCap: created.continuousFeeCap,
        tickSpacing: prepared.tickSpacing,
        ...(exactTick === undefined
          ? {}
          : {
              effectiveRateWad: TickLib.tickToApr(
                created.tick,
                prepared.maturity - prepared.timestamp
              )
            })
      }
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
    invalidateBatch: async (groups, onTransactionSubmitted) => {
      try {
        return await invalidateOffersBatch({
          midnight: config.setup.midnight,
          maker,
          groupIds: groups,
          execute: transaction =>
            executeAdapterTransaction(BootstrapAdapterError, transactionExecutor, {
              transaction,
              operation: 'cancel-batch',
              label: 'bootstrap:cancel-batch',
              onTransactionSubmitted: hash =>
                onTransactionSubmitted?.({ operation: 'cancel', txHash: hash })
            })
        })
      } catch (error) {
        if (error instanceof OfferInvalidationAdapterError) {
          throw new BootstrapAdapterError(error.operation)
        }
        throw error
      }
    },
    reserveGroup: ownership.reserve,
    confirmPublishedGroup: ownership.confirm,
    releaseGroupReservation: ownership.release,
    admitPublication: async ({ marketId, groupId, assets, minimumBlockNumber }) => {
      const limits = config.bootstrap.find(item => item.marketId === marketId)
      if (!limits) throw new BootstrapAdapterError('market-not-configured')
      const { snapshot } = await readSnapshot(minimumBlockNumber)
      return admitExposureCandidate({
        candidate: {
          marketId,
          groupIds: [groupId],
          buyAssets: assets,
          accepted: acceptedLossFactorOf(config.setup.acceptedLossFactor, marketId),
          limits: {
            kind: 'bootstrap',
            offerSize: limits.offerSize,
            creditTarget: limits.creditTarget,
            maximumMarketExposure: limits.maximumMarketExposure,
            maximumTotalExposure: limits.maximumTotalExposure
          }
        },
        snapshot,
        adapterError: BootstrapAdapterError
      })
    },
    forgetGroups: ownership.forget,
    preparePublication: async (offer: BootstrapOffer) => {
      const prospectiveOffer = preparedOffers.get(offer.marketId)
      preparedOffers.delete(offer.marketId)
      if (
        !prospectiveOffer ||
        prospectiveOffer.assets !== offer.assets ||
        prospectiveOffer.rateBps !== offer.rateBps
      ) {
        throw new BootstrapAdapterError('prospective-offer-missing')
      }
      const created = prospectiveOffer.created
      const [groups, ownedIds, ladderOwnedIds, activeStrategyGroups] = await Promise.all([
        readGroups(),
        ownership.read(),
        readLadderGroupIds(),
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
      const { signatures, transactions: ratificationTransactions } =
        await prepareBootstrapRequirements(
          await output.getRequirements(),
          async (_requirement, requirementAccount) => {
            if (!isAddressEqual(requirementAccount, account.address)) {
              throw new BootstrapAdapterError('requirement-signing-policy')
            }
            try {
              return await account.signTypedData(
                EcrecoverRatifierUtils.typedData({
                  tree,
                  chainId: config.chainId
                }) as unknown as Parameters<typeof account.signTypedData>[0]
              )
            } catch {
              throw new BootstrapAdapterError('requirement-signing-policy')
            }
          },
          output.ratifierType === 'ecrecover'
            ? {
                kind: 'ecrecover',
                target: config.setup.ratifier,
                root: output.root,
                signer: account.address,
                offers: tree.offers.length
              }
            : { kind: 'setter', target: config.setup.ratifier, root: output.root, maker }
        )
      if (
        (output.ratifierType === 'setter' && signatures.length > 0) ||
        (output.ratifierType === 'ecrecover' &&
          (signatures.length !== 1 || ratificationTransactions.length > 0))
      ) {
        throw new BootstrapAdapterError('unexpected-requirement')
      }
      const transaction =
        output.ratifierType === 'ecrecover'
          ? {
              to: getChainAddress(config.chainId, 'midnightMempool'),
              data: await Payload.encode(
                await EcrecoverRatifierUtils.ratify({
                  tree,
                  account: account.address,
                  signature: signatures[0]!
                })
              ),
              value: 0n
            }
          : output.buildTx([])
      const publicationPolicy = {
        kind: 'publication' as const,
        target: getChainAddress(config.chainId, 'midnightMempool'),
        offer: created,
        ratifierType: output.ratifierType,
        chainId: config.chainId,
        root: output.root,
        maker,
        signer: account.address
      }
      await assertBootstrapTransaction(transaction, publicationPolicy)
      return {
        groupId: output.groups[0] as Hex,
        tick: created.tick,
        publish: onTransactionSubmitted =>
          publishBootstrapPublication({
            ratifierType: output.ratifierType,
            payload: transaction.data,
            ratify: async () => {
              const submittedTransactions: BootstrapSubmittedTransaction[] = []
              for (const ratification of ratificationTransactions) {
                const { txHash } = await execute(
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
                chainId: config.chainId,
                baseUrl: `${config.morphoApiBaseUrl}/v0/midnight`,
                payload
              }),
            publish: async () => {
              const { txHash } = await execute(
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
