import { Offer, TickLib } from '@morpho-org/midnight-sdk'
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

import type { BootstrapTransactionSubmittedObserver } from '../../application/bootstrap/position-bootstrap-verbose'
import type {
  BootstrapMakeService,
  BootstrapPositionService,
  BootstrapReferenceRateService
} from '../../application/bootstrap/position-bootstrap.service'
import type { ConfigService } from '../../config/config.service'
import type { BootstrapOffer } from '../../domain/bootstrap/position-bootstrap'
import type { BootstrapActiveGroup, BootstrapInventoryReader } from './bootstrap-position.service'

import { createLadderGroupOwnership } from '../ladder/ladder-group-ownership.utils'
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
import { validateBootstrapMempoolPublication } from './bootstrap-mempool-validation.utils'
import { bootstrapContinuousFeeCap } from './bootstrap-offer.utils'
import { pendingBootstrapGroups } from './bootstrap-pending-offer.utils'
import { MidnightBootstrapPositionService } from './bootstrap-position.service'
import { BlueBootstrapReferenceRateService } from './bootstrap-reference-rate.service'
import { signBootstrapRequirements } from './bootstrap-requirements.utils'
import { assertBootstrapProspectiveSpread, bootstrapMarketGroupIds } from './bootstrap-spread.utils'
import { assertBootstrapTransaction } from './bootstrap-transaction.utils'

const WAD = 10n ** 18n
const YEAR_SECONDS = 31_536_000n

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

/** Production ports used by the default position-bootstrap application service. */
type ProductionBootstrapAdapters = {
  positions: BootstrapPositionService
  rates: BootstrapReferenceRateService
  make: BootstrapMakeService
}

/**
 * Composes concrete viem, Morpho SDK, Midnight SDK, and Mempool adapters.
 * @param config - Fully validated runtime configuration.
 * @returns Production read ports and either a live mutation queue or terminal-only make adapter.
 * @throws `BootstrapAdapterError` when write-mode signer identity differs from the configured maker;
 * later provider reads, signing, publication, or invalidation may also fail.
 * @remarks No provider request or write occurs while this function constructs the adapters.
 * Read-only configuration never derives an account or constructs a wallet client. Write mode checks
 * the key-derived account before constructing any maker action, independently of the setup gate.
 */
export const createProductionBootstrapAdapters = (
  config: ConfigService
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
    const [block, groups, ownedIds, ownedOffers, ladderGroupIds] = await Promise.all([
      client.getBlock({ blockTag: 'latest' }),
      readGroups(),
      ownership.read(),
      ownership.readOffers(),
      ladderOwnership.readGroupIds()
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
      cashReservations: project(strategyBootstrapGroups(groups, ladderGroupIds), false)
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
    const periodRateWad =
      (offer.rateBps * (WAD / 10_000n) * (market.params.maturity - block.timestamp)) / YEAR_SECONDS
    return Offer.create({
      market: market.params,
      buy: true,
      maker,
      tick: TickLib.priceToTick(TickLib.rateToPrice(periodRateWad), BigInt(market.tickSpacing)),
      expiry: market.params.maturity,
      ratifier: config.setup.ratifier,
      maxAssets: offer.assets,
      continuousFeeCap: bootstrapContinuousFeeCap(market)
    })
  }
  const prepareMempoolPublication = (
    offer: BootstrapOffer,
    created: Offer,
    groups: Awaited<ReturnType<typeof readGroups>>,
    ownedIds: readonly Hex[]
  ) =>
    validateBootstrapMempoolPublication(() =>
      midnight.makeLend(
        bootstrapMakeLendArguments({
          accountAddress: maker,
          offers: [created],
          validation: { apiUrl: `${config.morphoApiBaseUrl}/v0/midnight` },
          loanToken: config.setup.loanAsset,
          loanAssets: offer.assets,
          reservedLoanAssets: bootstrapReservedLoanAssets(groups, ownedIds)
        })
      )
    )

  if (config.identity.readOnly) {
    const validate = async (parameters: Parameters<BootstrapMakeService['reconcile']>[0]) => {
      if (!parameters.desiredOffer) return

      const [groups, ownedIds, ladderOwnedIds, prospectiveOffer, activeStrategyGroups] =
        await Promise.all([
          readGroups(),
          ownership.read(),
          ladderOwnership.readGroupIds(),
          prepareOffer(parameters.desiredOffer),
          activeGroups()
        ])
      const marketGroupIds = bootstrapMarketGroupIds(activeStrategyGroups, parameters.marketId)
      assertBootstrapProspectiveSpread({
        marketId: parameters.marketId,
        replacedGroupIds: marketGroupIds,
        book: bootstrapBookOffers(groups),
        prospective: {
          marketId: parameters.marketId,
          buy: true,
          tick: prospectiveOffer.tick
        }
      })
      await prepareMempoolPublication(parameters.desiredOffer, prospectiveOffer, groups, [
        ...ownedIds,
        ...ladderOwnedIds
      ])
    }
    return {
      positions,
      rates,
      make: new ReadOnlyBootstrapMakeService(undefined, validate)
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
    operation: 'cancel' | 'publish',
    onTransactionSubmitted?: BootstrapTransactionSubmittedObserver
  ) => {
    await assertBootstrapTransaction(transaction, policy)
    const hash = await wallet.sendTransaction(transaction)
    await onTransactionSubmitted?.({ operation, txHash: hash })
    const receipt = await wallet.waitForTransactionReceipt({
      hash,
      timeout: config.transactionReceiptTimeoutMs
    })
    if (receipt.status !== 'success') throw new BootstrapAdapterError('transaction-reverted')
    return hash
  }

  const preparedOffers = new Map<Hex, Offer>()
  const make = new MidnightBootstrapMakeService({
    listActiveGroups: activeGroups,
    listOwnedGroupIds: ownedGroupIds,
    listBookOffers: async () => bootstrapBookOffers(await readGroups()),
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
      const [groups, ownedIds, ladderOwnedIds] = await Promise.all([
        readGroups(),
        ownership.read(),
        ladderOwnership.readGroupIds()
      ])
      const output = await prepareMempoolPublication(offer, created, groups, [
        ...ownedIds,
        ...ladderOwnedIds
      ])
      const signatures = await signBootstrapRequirements(
        await output.getRequirements(),
        requirement =>
          requirement.sign(wallet, maker) as Promise<
            import('@morpho-org/morpho-sdk').MidnightOfferRootSignature
          >
      )
      const transaction = output.buildTx(signatures)
      const publicationPolicy = {
        kind: 'publication' as const,
        target: getChainAddress(base.id, 'midnightMempool'),
        offer: created
      }
      await assertBootstrapTransaction(transaction, publicationPolicy)
      return {
        groupId: output.groups[0] as Hex,
        publish: onTransactionSubmitted =>
          execute(transaction, publicationPolicy, 'publish', onTransactionSubmitted)
      }
    }
  })

  return {
    positions,
    rates,
    make
  }
}
