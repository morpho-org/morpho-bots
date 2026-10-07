import type { BookOffer } from '@repo/offers'

import { MAX_TICK, midnightAbi, Payload, TickLib } from '@morpho-org/midnight-sdk'
import { morphoViemExtension } from '@morpho-org/morpho-sdk'
import { getChainAddress, MathLib } from '@morpho-org/morpho-ts'
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  isAddressEqual,
  type Hex
} from 'viem'

import type {
  LadderMakeService,
  LadderPositionService,
  LadderReferenceRateService
} from '../../application/ladder/ladder-quoter.service'
import type {
  LadderReadOnlyValidation,
  LadderSubmittedTransaction,
  LadderTransactionSubmittedObserver
} from '../../application/ladder/ladder-verbose'
import type { ConfigService } from '../../config/config.service'
import type { OwnedOverlapBookOffer } from '../../domain/intentional-overlap'
import type { LadderQuoteSet } from '../../domain/ladder'
import type { OfferCap } from '../../domain/offer-cap'
import type { BootstrapOffer } from '../../domain/position-bootstrap'
import type { MakerOfferGroup } from '../provider/offer-groups.utils'
import type { HistoricalBlockReader } from '../reference/blue-reference-reader.utils'
import type { LadderGroupReference, OwnedLadderPublication } from './ladder-group-ownership.utils'

import { supportedChain } from '../../config/supported-chains.utils'
import { acceptedLossFactorOf, MAX_LOSS_FACTOR } from '../../domain/loss-factor'
import { isGroupClosed, remainingCap } from '../../domain/offer-cap'
import { mapSelectedMarketItems } from '../../domain/selected-market-items'
import { rateTickWindow } from '../../domain/tick-window'
import { createBootstrapGroupOwnership } from '../bootstrap/bootstrap-group-ownership.utils'
import { bootstrapBookOffers, strategyBootstrapGroups } from '../bootstrap/bootstrap-groups.utils'
import { readLivePendingBootstrapOffers } from '../bootstrap/bootstrap-pending-offer.utils'
import {
  BlueBootstrapReferenceRateService,
  StrategyBootstrapReferenceRateService
} from '../bootstrap/bootstrap-reference-rate.service'
import {
  admitExposureCandidate,
  snapshotLadderCapacities
} from '../exposure/exposure-admission.utils'
import {
  createExposureSnapshotReader,
  durableBuyReservations,
  readExposureSnapshot
} from '../exposure/exposure-snapshot.utils'
import { invalidateOffersBatch } from '../invalidation/batch-offer-invalidation.utils'
import { OfferInvalidationAdapterError } from '../invalidation/offer-invalidation-adapter.error'
import { maturityReadsByMarket } from '../provider/maturity-read.utils'
import { readMakerOfferGroups } from '../provider/offer-groups.utils'
import { createBlueReferenceReader } from '../reference/blue-reference-reader.utils'
import { executeLadderTransaction } from '../transaction/ladder-transaction-executor.utils'
import {
  assertLadderCancellationTransaction,
  assertLadderPublicationTransaction,
  assertLadderRatificationTransaction
} from '../transaction/ladder-transaction.utils'
import {
  createQuoterTransactionExecutor,
  type QuoterTransactionExecutor
} from '../transaction/quoter-transaction-executor'
import { createSignerAccount } from '../transaction/signer-account.utils'
import {
  activeOwnedLadderGroupIds,
  activeOwnedLadderGroupIdsBySide,
  ownedLadderGroupConsumption,
  reconstructOwnedLadderPublication
} from './ladder-active-publication.utils'
import { LadderAdapterError } from './ladder-adapter.error'
import { readLadderBookOffers } from './ladder-book.utils'
import {
  bookCrossesRestingLadder,
  clearableOpposingBook,
  hasClearableCrossing,
  retainedOpposingBookTicks
} from './ladder-cross-book.utils'
import { createLadderGroupOwnership } from './ladder-group-ownership.utils'
import {
  MidnightLadderMakeService,
  type LadderObservedBook,
  type LadderObservedMarket,
  type LadderOfferTransport
} from './ladder-make.service'
import { buildPublishableLadderTree, snapshotRateWindow } from './ladder-offer.utils'
import { configuredRatifierType, prepareLadderRatification } from './ladder-ratification.utils'
import { assertLadderProspectiveSpread } from './ladder-spread.utils'

/** Concrete ports used by the default ladder application service. */
type ProductionLadderAdapters = {
  positions: LadderPositionService
  rates: LadderReferenceRateService
  make: LadderMakeService
  validateReconcile: (
    parameters: Parameters<LadderMakeService['reconcile']>[0]
  ) => Promise<LadderReadOnlyValidation | undefined>
}

const BPS_WAD = MathLib.WAD / 10_000n

type OwnedBootstrapOffer = BootstrapOffer & { groupId: Hex }

/**
 * Finds the lowest live own-bootstrap buy rate relevant to one ladder market.
 * @param parameters - Indexed groups, durable ownership, persisted and pending intents, market, and block time.
 * @returns The lowest nominal or exact tick-derived annual rate, or `undefined` without a live own buy.
 * @remarks The lowest rate is the binding one: every ladder sell must clear every own bootstrap buy,
 * and ticks are inverse to rates, so this selects the same offer as `ownBootstrapBuyTickCeiling`.
 * Configured V0 groups may predate persisted offer intents, so their indexed tick and maturity are
 * authoritative fallback evidence while the projection is live.
 */
export const lowestBootstrapBuyRateBps = (parameters: {
  groups: readonly MakerOfferGroup[]
  ownedGroupIds: readonly Hex[]
  persistedOffers: readonly OwnedBootstrapOffer[]
  pendingOffers: readonly OwnedBootstrapOffer[]
  marketId: Hex
  now: bigint
}) => {
  const persistedByGroup = new Map(parameters.persistedOffers.map(offer => [offer.groupId, offer]))
  const indexedRates = strategyBootstrapGroups(parameters.groups, parameters.ownedGroupIds)
    .filter(
      group =>
        group.marketId === parameters.marketId && remainingCap(group.cap, group.consumed) > 0n
    )
    .flatMap(group => {
      const persisted = persistedByGroup.get(group.id)
      if (persisted?.marketId === parameters.marketId) return [persisted.rateBps]
      if ((group.maturity as bigint) <= parameters.now) return []
      return [
        TickLib.tickToApr(group.tick as bigint, (group.maturity as bigint) - parameters.now) /
          BPS_WAD
      ]
    })
  const pendingRates = parameters.pendingOffers
    .filter(offer => offer.marketId === parameters.marketId)
    .map(offer => offer.rateBps)
  return [...indexedRates, ...pendingRates].reduce<bigint | undefined>(
    (lowest, rateBps) => (lowest === undefined || rateBps < lowest ? rateBps : lowest),
    undefined
  )
}

/**
 * Deduplicates concurrent async work while allowing a fresh attempt after the active call settles.
 * @param operation - Async operation to execute at most once concurrently.
 * @returns A callable that shares the active promise and reruns the operation after settlement.
 * @throws Forwards the rejection from the active operation to every caller sharing that attempt.
 * @remarks The returned function retains only the currently active promise. Concurrent calls are
 * deduplicated, while every call made after settlement starts a new operation.
 */
export const createRepeatableSingleFlight = <T>(operation: () => Promise<T>) => {
  let active: Promise<T> | undefined
  return () => {
    active ??= operation().finally(() => {
      active = undefined
    })
    return active
  }
}

type RemovedLadderGroupCleanup = {
  removed: ReadonlyMap<Hex, { cap: OfferCap; buy: boolean }>
  indexedGroupIds: ReadonlySet<Hex>
  readGroupConsumed: (groupId: Hex) => Promise<bigint>
  invalidate: (groupId: Hex) => Promise<unknown>
  forgetGroups: (groupIds: readonly Hex[]) => Promise<void>
}

/**
 * Cancels removed ladder groups and tolerates a concurrent fill that exhausts the group.
 * @param cleanup - Removed groups and the protocol/indexer operations needed to clean them.
 * @returns Indexed canceled group IDs that remain visible as readiness tombstones.
 * @throws `LadderAdapterError` when any group still requires cleanup after its attempt.
 */
export const cleanupRemovedLadderGroups = async (cleanup: RemovedLadderGroupCleanup) => {
  const failures: unknown[] = []
  const tombstones: Hex[] = []
  for (const [groupId, group] of cleanup.removed) {
    try {
      if (!isGroupClosed(group, await cleanup.readGroupConsumed(groupId))) {
        // oxlint-disable-next-line max-depth
        try {
          await cleanup.invalidate(groupId)
        } catch (error) {
          // oxlint-disable-next-line max-depth
          if (!isGroupClosed(group, await cleanup.readGroupConsumed(groupId))) throw error
        }
        tombstones.push(groupId)
        continue
      }
      if (!cleanup.indexedGroupIds.has(groupId)) await cleanup.forgetGroups([groupId])
      else tombstones.push(groupId)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new LadderAdapterError('removed-market-cleanup')
  return tombstones
}

const ownedLadderProspectiveOffers = (
  offers: readonly { marketId: Hex; buy: boolean; tick: bigint }[]
) =>
  offers.map(offer => ({
    ...offer,
    ...(!offer.buy ? { overlapOwner: 'ladder-sell' as const } : {})
  }))

const highestTick = (ticks: readonly bigint[]) =>
  ticks.reduce<bigint | undefined>(
    (highest, tick) => (highest === undefined || tick > highest ? tick : highest),
    undefined
  )

/**
 * Selects the highest live own bootstrap-buy tick that prospective ladder sells must clear.
 * @param book - Complete selected-market book with durable bootstrap ownership marks attached.
 * @param marketId - Canonical market being quoted.
 * @returns The highest marked bootstrap-buy tick, or `undefined` without any live own bootstrap buy.
 */
export const ownBootstrapBuyTickCeiling = (book: readonly OwnedOverlapBookOffer[], marketId: Hex) =>
  highestTick(
    book
      .filter(
        offer => offer.marketId === marketId && offer.buy && offer.overlapOwner === 'bootstrap-buy'
      )
      .map(offer => offer.tick)
  )

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

const ownedGroups = (
  publications: readonly OwnedLadderPublication[],
  side?: LadderGroupReference['side']
) =>
  publications.flatMap(publication =>
    publication.groups.flatMap(group => {
      if (side !== undefined && group.side !== side) return []
      const rungIndexes = new Set(group.rungIndexes)
      const maximum = publication.quote[group.side]
        .filter(rung => rungIndexes.has(rung.index))
        .reduce((sum, rung) => sum + rung.assets, 0n)
      if (maximum <= 0n) throw new LadderAdapterError('group-ownership-state')
      return [
        {
          groupId: group.groupId,
          cap: { kind: 'units' as const, maximum },
          buy: group.side === 'higher'
        }
      ]
    })
  )

/**
 * Composes live chain, archive reference, Mempool, signing, and ownership ladder adapters.
 * @param config - Fully validated runtime configuration.
 * @param configuredAccount - Optional preconstructed account for write-mode adapter reuse.
 * @param configuredExecutor - Optional invocation-scoped transaction executor shared with bootstrap.
 * @returns Production position, reference-rate, and make ports.
 * @throws `SignerAccountError` for construction failures, or `LadderAdapterError` when an injected
 * account violates the required maker relationship; later operations may also fail.
 * @remarks Read-only construction never derives an account or creates a wallet. Every published
 * tree is API-validated unsigned and locally policy-checked; a signed Ecrecover payload never
 * leaves the process until it is published. Ecrecover publication
 * uses one transaction. Setter publication uses an ordered approval transaction followed by the
 * publication transaction; its durable reservation remains owned after approval if publication is
 * not confirmed.
 */
export const createProductionLadderAdapters = (
  config: ConfigService,
  configuredAccount?: Awaited<ReturnType<typeof createSignerAccount>>,
  configuredExecutor?: QuoterTransactionExecutor
): ProductionLadderAdapters | Promise<ProductionLadderAdapters> => {
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
  const bootstrapOwnership = createBootstrapGroupOwnership({
    chainId: config.chainId,
    maker,
    marketIds: config.setup.marketIds,
    configuredGroupIds: config.v0OfferGroupIds
  })
  const ladderOwnership = createLadderGroupOwnership({
    chainId: config.chainId,
    maker
  })
  const configByMarket = new Map(config.ladder.map(item => [item.marketId, item]))
  // Concurrent readers within one market check (active-quote reconstruction and consumption
  // telemetry) must share one request: monitoring may not add a round trip to the quoting path.
  // Deduplication is concurrent-only, so every fresh call still reads current group state.
  const readGroups = createRepeatableSingleFlight(() =>
    readMakerOfferGroups({
      adapterError: LadderAdapterError,
      chainId: config.chainId,
      maker,
      morphoApiBaseUrl: config.morphoApiBaseUrl,
      requestTimeoutMs: config.requestTimeoutMs
    })
  )
  const readGroupConsumed = (groupId: Hex, blockNumber?: bigint) =>
    client.readContract({
      address: config.setup.midnight,
      abi: midnightAbi,
      functionName: 'consumed',
      args: [maker, groupId],
      ...(blockNumber === undefined ? {} : { blockNumber })
    })

  let cleanupRemovedMarkets: () => Promise<readonly Hex[] | void> = async () => []

  // Observing third parties is best-effort: a book the reader rejects as oversized or malformed
  // yields no crossing signal, never a withdrawn ladder. Provider failures keep failing the read.
  const observeBookOffers = async (marketId: Hex) => {
    try {
      return await readLadderBookOffers({
        baseUrl: config.morphoApiBaseUrl,
        marketIds: [marketId],
        timeoutMs: config.requestTimeoutMs
      })
    } catch (error) {
      if (
        error instanceof LadderAdapterError &&
        ['book-response', 'book-timeout'].includes(error.operation)
      ) {
        return undefined
      }
      throw error
    }
  }

  const exposureReader = createExposureSnapshotReader({
    client,
    positions: midnight,
    maker,
    midnight: config.setup.midnight,
    loanAsset: config.setup.loanAsset,
    marketIds: config.setup.marketIds
  })

  const readSnapshot = async (minimumBlockNumber?: bigint) => {
    const [groups, publications, bootstrapGroupIds, persistedBootstrapOffers] = await Promise.all([
      readGroups(),
      ladderOwnership.read(),
      bootstrapOwnership.read(),
      bootstrapOwnership.readOffers()
    ])
    const snapshot = await readExposureSnapshot({
      reader: exposureReader,
      indexedGroups: groups,
      durableReservations: durableBuyReservations({
        ladderPublications: publications,
        bootstrapGroupIds,
        bootstrapOffers: persistedBootstrapOffers
      }),
      ...(minimumBlockNumber === undefined ? {} : { minimumBlockNumber }),
      adapterError: LadderAdapterError
    })
    return { snapshot, groups, publications, bootstrapGroupIds, persistedBootstrapOffers }
  }

  const positions: LadderPositionService = {
    readLendGuard: async marketId => {
      const lossFactor = await client.readContract({
        address: config.setup.midnight,
        abi: midnightAbi,
        functionName: 'lossFactor',
        args: [marketId]
      })
      if (typeof lossFactor !== 'bigint' || lossFactor > MAX_LOSS_FACTOR) {
        throw new LadderAdapterError('loss-factor-read')
      }
      return { lossFactor, ...acceptedLossFactorOf(config.setup.acceptedLossFactor, marketId) }
    },
    readMarket: async marketId => {
      const selectedConfig = configByMarket.get(marketId)
      if (!selectedConfig) throw new LadderAdapterError('market-configuration-missing')
      const [
        { snapshot, groups, publications, bootstrapGroupIds, persistedBootstrapOffers },
        marketData,
        wholeBook
      ] = await Promise.all([
        readSnapshot(),
        midnight.getMarketData(marketId),
        observeBookOffers(marketId)
      ])
      const block = { number: snapshot.blockNumber, timestamp: snapshot.timestamp }
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
      const bootstrapBuyRateBps = lowestBootstrapBuyRateBps({
        groups,
        ownedGroupIds: bootstrapGroupIds,
        persistedOffers: persistedBootstrapOffers,
        pendingOffers: pendingBootstrapOffers,
        marketId,
        now: block.timestamp
      })

      const activeLadderGroupIds = new Set(
        activeOwnedLadderGroupIds(publications, groups, marketId)
      )
      const observedBookCrossing = (wholeBook: readonly OwnedOverlapBookOffer[]) => {
        const opposingBookTicks = retainedOpposingBookTicks({
          marketId,
          replacedGroupIds: activeLadderGroupIds,
          book: markOwnBootstrapBuys(
            wholeBook,
            durableBootstrapGroupIds(bootstrapGroupIds, persistedBootstrapOffers)
          ),
          depthFloor: { maker, minimumOpposingAssets: selectedConfig.minimumOfferAssets }
        })
        const crossed = bookCrossesRestingLadder({
          marketId,
          maker,
          book: wholeBook,
          activeLadderGroupIds: activeOwnedLadderGroupIdsBySide(
            publications,
            marketId,
            activeLadderGroupIds
          ),
          minimumOpposingAssets: selectedConfig.minimumOfferAssets
        })
        const tickSpacing = BigInt(marketData.tickSpacing)
        const timeToMaturity = marketData.params.maturity - block.timestamp
        const clearable =
          timeToMaturity <= 0n
            ? undefined
            : clearableOpposingBook({
                ticks: opposingBookTicks,
                window: rateTickWindow({
                  minimumRateBps: selectedConfig.minimumRateBps,
                  maximumRateBps: selectedConfig.maximumRateBps,
                  timeToMaturity,
                  tickSpacing
                }),
                tickSpacing
              })
        return clearable === undefined
          ? undefined
          : {
              lower: { crossed: crossed.lower, clearable: clearable.lower },
              higher: { crossed: crossed.higher, clearable: clearable.higher }
            }
      }
      const bookCrossing = wholeBook === undefined ? undefined : observedBookCrossing(wholeBook)

      return {
        ...snapshotLadderCapacities(snapshot, {
          marketId,
          adapterError: LadderAdapterError,
          excludedGroupIds: replacedGroupIds,
          targetMarketExposureAssets: selectedConfig.targetMarketExposureAssets,
          maximumTotalExposureAssets: selectedConfig.maximumTotalExposureAssets
        }),
        ...(bootstrapBuyRateBps === undefined ? {} : { bootstrapBuyRateBps }),
        ...(bookCrossing === undefined ? {} : { bookCrossing }),
        maturityTimestamp: marketData.params.maturity,
        observedTimestamp: block.timestamp,
        ...snapshotRateWindow({
          market: marketData,
          now: block.timestamp,
          minimumRateBps: selectedConfig.minimumRateBps,
          maximumRateBps: selectedConfig.maximumRateBps,
          minimumOfferAssets: selectedConfig.minimumOfferAssets
        })
      }
    }
  }

  const blueRates = new BlueBootstrapReferenceRateService(
    LadderAdapterError,
    createBlueReferenceReader(
      config.setup.referenceMarketId ?? config.setup.marketIds[0]!,
      referenceClient as HistoricalBlockReader,
      config.chainId
    ),
    config.referenceLookbackSeconds
  )
  const strategyRates = new StrategyBootstrapReferenceRateService(
    LadderAdapterError,
    new Map(config.ladder.map(item => [item.marketId, item.targetRate] as const)),
    blueRates,
    maturityReadsByMarket({
      adapterError: LadderAdapterError,
      entries: config.ladder,
      midnight,
      client,
      // The ladder monitor runs at the shortest configured cadence; capping block sharing there
      // guarantees every cycle re-derives the premium from a fresh timestamp.
      blockShareMs: 1_000 * Math.min(...config.ladder.map(item => item.loopIntervalSeconds))
    })
  )
  const rates: LadderReferenceRateService = {
    readRate: async marketId => (await strategyRates.readRate(marketId)).rateBps,
    readObservation: async marketId => {
      const observation = await strategyRates.readRate(marketId)
      return {
        rateBps: observation.rateBps,
        observationId: observation.observationId,
        ...(observation.secondsToMaturity === undefined
          ? {}
          : { secondsToMaturity: observation.secondsToMaturity })
      }
    }
  }

  const durableBootstrapGroupIds = (
    ownedGroupIds: readonly Hex[],
    persistedOffers: readonly { groupId: Hex }[]
  ) =>
    new Set<Hex>([
      ...config.v0OfferGroupIds,
      ...ownedGroupIds,
      ...persistedOffers.map(offer => offer.groupId)
    ])

  const markOwnBootstrapBuys = (
    book: readonly BookOffer[],
    bootstrapGroupIds: ReadonlySet<Hex>
  ): OwnedOverlapBookOffer[] =>
    book.map(offer =>
      offer.buy && offer.groupId !== undefined && bootstrapGroupIds.has(offer.groupId)
        ? { ...offer, overlapOwner: 'bootstrap-buy' as const }
        : offer
    )

  const completeBookOffers = async (marketId: Hex) => {
    const [groups, durableBootstrapIds, persistedBootstrapOffers, wholeBook] = await Promise.all([
      readGroups(),
      bootstrapOwnership.read(),
      bootstrapOwnership.readOffers(),
      readLadderBookOffers({
        baseUrl: config.morphoApiBaseUrl,
        marketIds: [marketId],
        timeoutMs: config.requestTimeoutMs
      })
    ])
    const pendingBootstrapOffers = await readLivePendingBootstrapOffers({
      groups,
      ownedGroupIds: durableBootstrapIds,
      offers: persistedBootstrapOffers,
      readGroupConsumed
    })
    const pendingOffers = await mapSelectedMarketItems(
      marketId,
      pendingBootstrapOffers,
      async offer => ({
        groupId: offer.groupId,
        marketId: offer.marketId,
        maker,
        buy: true,
        tick: offer.tick ?? MAX_TICK,
        overlapOwner: 'bootstrap-buy' as const
      })
    )
    const indexedOffers = markOwnBootstrapBuys(
      bootstrapBookOffers(groups),
      durableBootstrapGroupIds(durableBootstrapIds, persistedBootstrapOffers)
    )
    const key = (offer: { groupId?: Hex; marketId: Hex; buy: boolean; tick: bigint }) =>
      `${offer.groupId ?? ''}:${offer.marketId}:${offer.buy ? 'buy' : 'sell'}:${offer.tick}`
    const indexedByKey = new Map(indexedOffers.map(offer => [key(offer), offer] as const))
    const wholeBookKeys = new Set(wholeBook.map(key))
    return {
      groups,
      book: [
        ...wholeBook.map(offer => ({ ...offer, ...indexedByKey.get(key(offer)) })),
        ...indexedOffers.filter(offer => !wholeBookKeys.has(key(offer))),
        ...pendingOffers
      ]
    }
  }

  // The quote and its groups' consumption are derived from ONE groups read rather than two
  // concurrent readers sharing a single-flight slot: that slot is released as soon as the first
  // request settles, so deduplication there is timing-dependent and monitoring could add a real
  // round trip to the quoting path.
  const readActiveState = async (marketId: Hex) => {
    await cleanupRemovedMarkets()
    const [groups, publications] = await Promise.all([readGroups(), ladderOwnership.read()])
    const quote = publications
      .filter(item => item.marketId === marketId)
      .toReversed()
      .map(publication => reconstructOwnedLadderPublication(publication, groups))
      .find(item => item !== undefined)
    return {
      ...(quote === undefined ? {} : { quote }),
      consumption: ownedLadderGroupConsumption(publications, groups, marketId)
    }
  }

  const readActive = async (marketId: Hex) => (await readActiveState(marketId)).quote

  const readObservedMarket = async (marketId: Hex): Promise<LadderObservedMarket> => {
    const [market, block] = await Promise.all([
      midnight.getMarketData(marketId),
      client.getBlock({ blockTag: 'latest' })
    ])
    return { market, now: block.timestamp }
  }

  const assessBookCrossing = async (marketId: Hex, observed: LadderObservedBook) => {
    const selectedConfig = configByMarket.get(marketId)
    if (!selectedConfig) throw new LadderAdapterError('market-configuration-missing')
    const [observedMarket, publications] = await Promise.all([
      readObservedMarket(marketId),
      ladderOwnership.read()
    ])
    const timeToMaturity = BigInt(observedMarket.market.params.maturity) - observedMarket.now
    if (timeToMaturity <= 0n) throw new LadderAdapterError('market-matured')
    const tickSpacing = BigInt(observedMarket.market.tickSpacing)
    const crossed = bookCrossesRestingLadder({
      marketId,
      maker,
      book: observed.book,
      activeLadderGroupIds: activeOwnedLadderGroupIdsBySide(
        publications,
        marketId,
        observed.replacedGroupIds
      ),
      minimumOpposingAssets: selectedConfig.minimumOfferAssets
    })
    const clearable = clearableOpposingBook({
      ticks: retainedOpposingBookTicks({
        marketId,
        replacedGroupIds: observed.replacedGroupIds,
        book: observed.book,
        depthFloor: { maker, minimumOpposingAssets: selectedConfig.minimumOfferAssets }
      }),
      window: rateTickWindow({
        minimumRateBps: selectedConfig.minimumRateBps,
        maximumRateBps: selectedConfig.maximumRateBps,
        timeToMaturity,
        tickSpacing
      }),
      tickSpacing
    })
    return {
      reconciliation: {
        preparedAtTimestamp: observedMarket.now,
        bookCrossing: {
          lower: { crossed: crossed.lower, clearable: clearable.lower },
          higher: { crossed: crossed.higher, clearable: clearable.higher }
        }
      },
      observedMarket
    }
  }

  const prepareUnsignedPublication = async (
    quote: LadderQuoteSet,
    observed: LadderObservedBook & { observedMarket?: LadderObservedMarket }
  ) => {
    const selectedConfig = config.ladder.find(item => item.marketId === quote.marketId)
    if (!selectedConfig) throw new LadderAdapterError('market-not-configured')
    const { market, now } = observed.observedMarket ?? (await readObservedMarket(quote.marketId))
    const bootstrapTickCeiling = ownBootstrapBuyTickCeiling(observed.book, quote.marketId)
    const opposingBookTicks = retainedOpposingBookTicks({
      marketId: quote.marketId,
      replacedGroupIds: observed.replacedGroupIds,
      book: observed.book,
      depthFloor: { maker, minimumOpposingAssets: selectedConfig.minimumOfferAssets }
    })
    const publishable = buildPublishableLadderTree({
      quote,
      market,
      maker,
      ratifier: config.setup.ratifier,
      now,
      minimumRateBps: selectedConfig.minimumRateBps,
      maximumRateBps: selectedConfig.maximumRateBps,
      opposingBookTicks,
      ...(bootstrapTickCeiling === undefined
        ? {}
        : { ownBootstrapBuyTickCeiling: bootstrapTickCeiling })
    })
    await publishable.prepared?.tree.mempoolValidate({
      chainId: config.chainId,
      apiUrl: `${config.morphoApiBaseUrl}/v0/midnight`
    })
    return publishable
  }

  const withdrawnSidesField = (withdrawnSides: readonly ('lower' | 'higher')[]) =>
    withdrawnSides.length === 0 ? {} : { withdrawnSides }

  const validateReconcile: ProductionLadderAdapters['validateReconcile'] = async parameters => {
    if (parameters.reason === 'rest' || !parameters.desired) return undefined
    const [bookState, publications] = await Promise.all([
      completeBookOffers(parameters.marketId),
      ladderOwnership.read()
    ])
    const observed = {
      book: bookState.book,
      replacedGroupIds: new Set(
        activeOwnedLadderGroupIds(publications, bookState.groups, parameters.marketId)
      )
    }
    const assessed = await assessBookCrossing(parameters.marketId, observed)
    if (
      parameters.reason === 'book-crossed' &&
      !hasClearableCrossing(assessed.reconciliation.bookCrossing, parameters.bookCrossedSides)
    ) {
      return { reconciliation: { ...assessed.reconciliation, applied: false } }
    }
    const { prepared, withdrawnSides } = await prepareUnsignedPublication(parameters.desired, {
      ...observed,
      observedMarket: assessed.observedMarket
    })
    if (!prepared) {
      return {
        reconciliation: { ...assessed.reconciliation, applied: true },
        ...withdrawnSidesField(withdrawnSides)
      }
    }
    assertLadderProspectiveSpread({
      marketId: parameters.marketId,
      maker,
      replacedGroupIds: observed.replacedGroupIds,
      book: observed.book,
      prospective: ownedLadderProspectiveOffers(prepared.bookOffers)
    })
    return {
      reconciliation: { ...assessed.reconciliation, applied: true },
      bookClearedRungs: prepared.bookClearedRungs,
      ...withdrawnSidesField(withdrawnSides)
    }
  }

  const readOnlyMake: LadderMakeService = {
    readActive,
    readActiveState,
    reconcile: async () => {
      throw new LadderAdapterError('readonly-mutation')
    },
    cancelBuys: async () => {
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

  const account = configuredAccount ?? createSignerAccount(config.identity)
  if (account instanceof Promise) {
    return account.then(value => createProductionLadderAdapters(config, value, configuredExecutor))
  }
  if (
    (config.identity.method === 'aws' && isAddressEqual(account.address, maker)) ||
    (config.identity.method !== 'aws' && !isAddressEqual(account.address, maker))
  ) {
    throw new LadderAdapterError('signer-identity-mismatch')
  }
  const signingClient = createWalletClient({
    account,
    chain: supportedChain(config.chainId),
    transport: custom({
      request: async () => {
        throw new LadderAdapterError('ratifier-signature')
      }
    })
  })
  const transactionExecutor = configuredExecutor ?? createQuoterTransactionExecutor(config, account)
  const mempool = getChainAddress(config.chainId, 'midnightMempool')

  const transport: LadderOfferTransport = {
    readActive,
    readActiveState,
    listOwnedGroups: async () => ownedGroups(await ladderOwnership.read()),
    listOwnedBuyGroups: async marketId =>
      ownedGroups(
        (await ladderOwnership.read()).filter(publication => publication.marketId === marketId),
        'higher'
      ),
    readGroupConsumed,
    listActiveGroupIds: async marketId => {
      const [publications, groups] = await Promise.all([ladderOwnership.read(), readGroups()])
      return activeOwnedLadderGroupIds(publications, groups, marketId)
    },
    listBookOffers: async marketId => (await completeBookOffers(marketId)).book,
    assessBook: assessBookCrossing,
    preparePublication: async (quote, observed) => {
      const { prepared, withdrawnSides } = await prepareUnsignedPublication(quote, observed)
      if (!prepared) return undefined
      const { bookClearedRungs } = prepared
      const ratifierType = configuredRatifierType(config.setup.ratifier, config.chainId)
      const ratification = await prepareLadderRatification({
        type: ratifierType,
        tree: prepared.tree,
        maker,
        client: signingClient,
        account
      })
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
        bookClearedRungs,
        ...withdrawnSidesField(withdrawnSides),
        prospective: ownedLadderProspectiveOffers(prepared.bookOffers),
        publish: onTransactionSubmitted =>
          publishLadderPublication({
            approve: async () => {
              if (ratification.approval === undefined) return undefined
              assertLadderRatificationTransaction(ratification.approval, {
                target: config.setup.ratifier,
                account: maker,
                root: prepared.tree.root
              })
              const { txHash } = await executeLadderTransaction(
                transactionExecutor,
                {
                  transaction: ratification.approval,
                  operation: 'ratify',
                  label: `ladder:ratify:${prepared.tree.root}`,
                  onTransactionSubmitted: hash =>
                    notifySubmitted(onTransactionSubmitted, 'ratify', hash)
                },
                'ratifier-transaction-reverted'
              )
              return { operation: 'ratify', txHash }
            },
            validate: async () => {
              if (ratification.approval === undefined) return
              try {
                await prepared.tree.mempoolValidate({
                  chainId: config.chainId,
                  apiUrl: `${config.morphoApiBaseUrl}/v0/midnight`,
                  ratification: ratification.validation
                })
              } catch {
                throw new LadderAdapterError('mempool-validation-after-ratification')
              }
            },
            sendPublication: async () => {
              const { txHash } = await executeLadderTransaction(
                transactionExecutor,
                {
                  transaction,
                  operation: 'publish',
                  label: `ladder:publish:${prepared.tree.root}`,
                  onTransactionSubmitted: hash =>
                    notifySubmitted(onTransactionSubmitted, 'publish', hash)
                },
                ratifierType === 'setter'
                  ? 'publication-transaction-reverted-after-ratification'
                  : 'transaction-reverted'
              )
              return { operation: 'publish', txHash }
            },
            confirmPublication: async () => {}
          })
      }
    },
    reservePublication: publication => ladderOwnership.reserve(publication),
    confirmPublication: ladderOwnership.confirm,
    releasePublication: ladderOwnership.release,
    admitPublication: async ({ marketId, quote, groupIds, minimumBlockNumber }) => {
      const selectedConfig = configByMarket.get(marketId)
      if (!selectedConfig) throw new LadderAdapterError('market-configuration-missing')
      const { snapshot } = await readSnapshot(minimumBlockNumber)
      return admitExposureCandidate({
        candidate: {
          marketId,
          groupIds,
          buyAssets: quote.higher.reduce((sum, rung) => sum + rung.assets, 0n),
          accepted: acceptedLossFactorOf(config.setup.acceptedLossFactor, marketId),
          limits: {
            kind: 'ladder',
            targetMarketExposureAssets: selectedConfig.targetMarketExposureAssets,
            maximumTotalExposureAssets: selectedConfig.maximumTotalExposureAssets,
            buyPricing: { config: selectedConfig, quote }
          }
        },
        snapshot,
        adapterError: LadderAdapterError
      })
    },
    invalidate: async (groupId, onTransactionSubmitted) => {
      const transaction = midnight.cancelOffer({ group: groupId, accountAddress: maker }).buildTx()
      assertLadderCancellationTransaction(transaction, {
        target: config.setup.midnight,
        groupId,
        account: maker
      })
      return executeLadderTransaction(transactionExecutor, {
        transaction,
        operation: 'cancel',
        label: `ladder:cancel:${groupId}`,
        onTransactionSubmitted: hash => notifySubmitted(onTransactionSubmitted, 'cancel', hash)
      })
    },
    invalidateBatch: async (groupIds, onTransactionSubmitted) => {
      try {
        return await invalidateOffersBatch({
          midnight: config.setup.midnight,
          maker,
          groupIds,
          execute: transaction =>
            executeLadderTransaction(transactionExecutor, {
              transaction,
              operation: 'cancel-batch',
              label: 'ladder:cancel-batch',
              onTransactionSubmitted: hash =>
                notifySubmitted(onTransactionSubmitted, 'cancel', hash)
            })
        })
      } catch (error) {
        if (error instanceof OfferInvalidationAdapterError) {
          throw new LadderAdapterError(error.operation)
        }
        throw error
      }
    },
    forgetGroups: ladderOwnership.forget
  }

  cleanupRemovedMarkets = createRepeatableSingleFlight(async () => {
    const publications = await ladderOwnership.read()
    const configuredMarkets = new Set(config.ladder.map(item => item.marketId))
    const retainedGroupIds = new Set(
      publications
        .filter(publication => configuredMarkets.has(publication.marketId))
        .flatMap(publication => publication.groups.map(group => group.groupId))
    )
    const removed = new Map(
      ownedGroups(publications)
        .filter(group => !retainedGroupIds.has(group.groupId))
        .map(({ groupId, ...group }) => [groupId, group] as const)
    )
    if (removed.size === 0) return []
    const tombstones = await cleanupRemovedLadderGroups({
      removed,
      indexedGroupIds: new Set((await readGroups()).map(group => group.id)),
      readGroupConsumed,
      invalidate: groupId => transport.invalidate(groupId),
      forgetGroups: ladderOwnership.forget
    })
    return tombstones
  })

  return {
    positions,
    rates,
    make: Object.assign(new MidnightLadderMakeService(transport, maker), { cleanupRemovedMarkets }),
    validateReconcile
  }
}
