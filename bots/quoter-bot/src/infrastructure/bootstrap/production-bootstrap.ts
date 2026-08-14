import { midnightAbi, Offer, TickLib, Tree } from '@morpho-org/midnight-sdk'
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
import type { HistoricalBlockReader } from '../reference/blue-reference-reader.utils'
import type { BootstrapActiveGroup, BootstrapInventoryReader } from './bootstrap-position.service'

import { invalidateOffersBatch } from '../invalidation/batch-offer-invalidation.utils'
import { OfferInvalidationAdapterError } from '../invalidation/offer-invalidation-adapter.error'
import { pendingLadderQuoteSets } from '../ladder/ladder-active-publication.utils'
import { readLadderBookOffers } from '../ladder/ladder-book.utils'
import { pendingLadderBuyReservations } from '../ladder/ladder-cash-reservation.utils'
import { createLadderGroupOwnership } from '../ladder/ladder-group-ownership.utils'
import { buildLadderTree } from '../ladder/ladder-offer.utils'
import { createMakerAccount } from '../make/maker-account.utils'
import { ReadOnlyBootstrapMakeService } from '../make/read-only-bootstrap-make.service'
import { createBlueReferenceReader } from '../reference/blue-reference-reader.utils'
import { mapSelectedMarketItems } from '../selected-market-items.utils'
import { BootstrapAdapterError } from './bootstrap-adapter.error'
import { resolveBootstrapProspectiveOffer } from './bootstrap-cross-book.utils'
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
import { bootstrapContinuousFeeCap, createBootstrapOffer } from './bootstrap-offer.utils'
import {
  readLivePendingBootstrapOffers,
  readOwnedGroupIdsForCleanup
} from './bootstrap-pending-offer.utils'
import { MidnightBootstrapPositionService } from './bootstrap-position.service'
import {
  BlueBootstrapReferenceRateService,
  StrategyBootstrapReferenceRateService
} from './bootstrap-reference-rate.service'
import { createBootstrapRequirementClient } from './bootstrap-requirement-client.utils'
import { prepareBootstrapRequirements } from './bootstrap-requirements.utils'
import { bootstrapMarketGroupIds } from './bootstrap-spread.utils'
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

type PrepareCappedBootstrapOfferParameters = {
  offer: BootstrapOffer
  maximumAssets?: bigint
  created: Offer
  exactTick?: bigint
  minimumRateBps?: bigint
  maximumRateBps?: bigint
  prepareOffer: (
    offer: BootstrapOffer,
    exactTick?: bigint
  ) => Promise<{ created: Offer; effectiveRateBps?: bigint }>
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
  const { created, effectiveRateBps } = await parameters.prepareOffer(offer, parameters.exactTick)
  if (
    effectiveRateBps !== undefined &&
    ((parameters.minimumRateBps !== undefined && effectiveRateBps < parameters.minimumRateBps) ||
      (parameters.maximumRateBps !== undefined && effectiveRateBps > parameters.maximumRateBps))
  ) {
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
 * @param configuredAccount - Optional preconstructed account for write-mode adapter reuse.
 * @param ignoredOfferGroupIds - Recently canceled ladder groups still visible in the API index.
 * @returns Production read ports and either a live mutation queue or terminal-only make adapter.
 * @throws `BootstrapAdapterError` when write-mode signer identity differs from the configured maker;
 * later provider reads, signing, publication, or invalidation may also fail.
 * @remarks No provider request or write occurs while this function constructs the adapters.
 * Read-only configuration never derives an account or constructs a wallet client. Write mode checks
 * the key-derived account before constructing any maker action, independently of the setup gate.
 */
export const createProductionBootstrapAdapters = (
  config: ConfigService,
  writeReadOnlyEvent?: (line: string) => void | Promise<void>,
  configuredAccount?: Awaited<ReturnType<typeof createMakerAccount>>,
  ignoredOfferGroupIds: readonly Hex[] = []
): ProductionBootstrapAdapters | Promise<ProductionBootstrapAdapters> => {
  const maker = config.identity.maker
  const client = createPublicClient({
    chain: base,
    transport: http(config.rpcUrl, { timeout: config.requestTimeoutMs })
  }).extend(morphoViemExtension({ supportSignature: true, supportDeployless: true }))
  const referenceClient = createPublicClient({
    chain: base,
    transport: http(config.referenceRpcUrl ?? config.rpcUrl, { timeout: config.requestTimeoutMs })
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
    readBootstrapGroups({
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
            group.maxAssets > group.consumed
        )
        .map(group => {
          const persisted = intended.get(`${group.id}:${group.marketId as Hex}`)
          return {
            id: group.id,
            marketId: group.marketId as Hex,
            assets: group.maxAssets - group.consumed,
            tick: group.tick as bigint,
            maximumAssets: group.maxAssets,
            offerCount: group.offers.length,
            continuousFeeCap: group.continuousFeeCap,
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
      ...pendingGroups
    ]
  }

  const readGroupInventory = async () => {
    const [block, groups, ownedIds, ownedOffers, ladderPublications] = await Promise.all([
      client.getBlock({ blockTag: 'latest' }),
      readGroups(),
      ownership.read(),
      ownership.readOffers(),
      readLadderPublications()
    ])
    const intended = new Map(
      ownedOffers.map(offer => [`${offer.groupId}:${offer.marketId}`, offer] as const)
    )
    const pendingGroups = await readPendingGroups(block.number, groups, ownedIds, ownedOffers)
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
            tick: group.tick as bigint,
            maximumAssets: group.maxAssets,
            offerCount: group.offers.length,
            continuousFeeCap: group.continuousFeeCap,
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
      activeGroups: [...project(strategyBootstrapGroups(groups, ownedIds), true), ...pendingGroups],
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

  const uncanceledOwnedGroupIds = () =>
    readOwnedGroupIdsForCleanup({
      readOwnedGroupIds: ownership.read,
      readBlockNumber: async () => (await client.getBlock({ blockTag: 'latest' })).number,
      readGroupConsumed
    })

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
    readMarketContinuousFeeCap: async marketId =>
      bootstrapContinuousFeeCap(await midnight.getMarketData(marketId)),
    readGroupInventory
  }

  const positions = new MidnightBootstrapPositionService(inventory, maker)
  const blueRates = new BlueBootstrapReferenceRateService(
    createBlueReferenceReader(
      config.setup.referenceMarketId ?? config.setup.marketIds[0]!,
      referenceClient as HistoricalBlockReader
    )
  )
  const rates = new StrategyBootstrapReferenceRateService(
    new Map(config.bootstrap.map(item => [item.marketId, item.targetRate] as const)),
    blueRates
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
    const pendingLadderOffers = (
      await mapSelectedMarketItems(
        marketId,
        pendingLadderQuoteSets(ladderPublications, groups),
        async quote => {
          const ladderBounds = config.ladder.find(item => item.marketId === quote.marketId)
          const [market, block] = await Promise.all([
            midnight.getMarketData(quote.marketId),
            client.getBlock({ blockTag: 'latest' })
          ])
          return buildLadderTree({
            quote,
            market,
            maker,
            ratifier: config.setup.ratifier,
            now: block.timestamp,
            ...(ladderBounds === undefined
              ? {}
              : {
                  minimumRateBps: ladderBounds.minimumRateBps,
                  maximumRateBps: ladderBounds.maximumRateBps
                })
          }).bookOffers
        }
      )
    ).flat()
    const indexedOffers = bootstrapBookOffers(groups)
    const key = (offer: { groupId?: Hex; marketId: Hex; buy: boolean; tick: bigint }) =>
      `${offer.groupId ?? ''}:${offer.marketId}:${offer.buy ? 'buy' : 'sell'}:${offer.tick}`
    const wholeBookKeys = new Set(wholeBook.map(key))
    return {
      groups,
      ladderPublications,
      book: [
        ...wholeBook,
        ...indexedOffers.filter(offer => !wholeBookKeys.has(key(offer))),
        ...pendingLadderOffers
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
          loanAssets: offer.assets,
          reservedLoanAssets: bootstrapReservedLoanAssets(groups, ownedIds, replacedGroupIds)
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
                  effectiveRateBps:
                    TickLib.tickToApr(created.tick, prepared.maturity - prepared.timestamp) /
                    (WAD / 10_000n)
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
                  effectiveRateBps:
                    TickLib.tickToApr(
                      prepared.created.tick,
                      prepared.maturity - prepared.timestamp
                    ) /
                    (WAD / 10_000n)
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

  const account = configuredAccount ?? createMakerAccount(config.identity)
  if (account instanceof Promise) {
    return account.then(
      value =>
        createProductionBootstrapAdapters(config, writeReadOnlyEvent, value, ignoredOfferGroupIds),
      () => {
        throw new BootstrapAdapterError('maker-private-key-mismatch')
      }
    )
  }
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
              effectiveRateBps:
                TickLib.tickToApr(created.tick, prepared.maturity - prepared.timestamp) /
                (WAD / 10_000n)
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
          wallet,
          midnight: config.setup.midnight,
          maker,
          groupIds: groups,
          receiptTimeoutMs: config.transactionReceiptTimeoutMs,
          onTransactionSubmitted: hash =>
            onTransactionSubmitted?.({ operation: 'cancel', txHash: hash })
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
        tick: created.tick,
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
