import { Offer, TickLib } from '@morpho-org/midnight-sdk'
import { morphoViemExtension } from '@morpho-org/morpho-sdk'
import { fetchMarket } from '@morpho-org/morpho-sdk/fetch'
import { getChainAddress } from '@morpho-org/morpho-ts'
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  publicActions,
  type Hex
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'

import type {
  BootstrapMakeService,
  BootstrapPositionService,
  BootstrapReferenceRateService
} from '../../application/position-bootstrap.service'
import type { ConfigService } from '../../config/config.service'
import type { BootstrapOffer } from '../../domain/position-bootstrap'
import type { BootstrapActiveGroup, BootstrapInventoryReader } from './bootstrap-position.service'
import type { BlueReferenceReader, BlueSupplyCheckpoint } from './bootstrap-reference-rate.service'

import { BootstrapAdapterError } from './bootstrap-adapter.error'
import { bootstrapExposureMarketIds } from './bootstrap-exposure.utils'
import { createBootstrapGroupOwnership } from './bootstrap-group-ownership.utils'
import { readBootstrapGroups, strategyBootstrapGroups } from './bootstrap-groups.utils'
import { MidnightBootstrapMakeService } from './bootstrap-make.service'
import { bootstrapContinuousFeeCap } from './bootstrap-offer.utils'
import { MidnightBootstrapPositionService } from './bootstrap-position.service'
import { BlueBootstrapReferenceRateService } from './bootstrap-reference-rate.service'
import { signBootstrapRequirements } from './bootstrap-requirements.utils'
import { assertBootstrapTransaction } from './bootstrap-transaction.utils'

const WAD = 10n ** 18n
const YEAR_SECONDS = 31_536_000n

type HistoricalBlockReader = {
  getBlock(parameters: { blockTag: 'latest' } | { blockNumber: bigint }): Promise<{
    number: bigint | null
    timestamp: bigint
  }>
}

const createBlueReader = (
  config: ConfigService,
  client: HistoricalBlockReader
): BlueReferenceReader => {
  const checkpoint = async (blockNumber: bigint): Promise<BlueSupplyCheckpoint> => {
    const block = await client.getBlock({ blockNumber })
    const market = await fetchMarket(
      config.setup.referenceMarketId as Parameters<typeof fetchMarket>[0],
      client as never,
      { blockNumber, deployless: false }
    )
    const accrued = market.accrueInterest(block.timestamp)
    return {
      blockNumber,
      timestamp: block.timestamp,
      supplyAssetsPerWadShares: accrued.toSupplyAssets(WAD)
    }
  }
  return {
    readLatest: async () => {
      const block = await client.getBlock({ blockTag: 'latest' })
      if (block.number === null) throw new BootstrapAdapterError('reference-latest-block')
      return checkpoint(block.number)
    },
    readAtOrBefore: async target => {
      const latest = await client.getBlock({ blockTag: 'latest' })
      if (latest.number === null) throw new BootstrapAdapterError('reference-latest-block')
      let low = 0n
      let high = latest.number
      while (low < high) {
        const middle = (low + high + 1n) / 2n
        const block = await client.getBlock({ blockNumber: middle })
        if (block.timestamp <= target) low = middle
        else high = middle - 1n
      }
      return checkpoint(low)
    }
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
 * @returns Production bootstrap ports sharing one maker and mutation queue.
 * @throws Only during later provider reads, signing, publication, or invalidation; composition is lazy.
 * @remarks No provider request or write occurs while this function constructs the adapters.
 */
export const createProductionBootstrapAdapters = (
  config: ConfigService
): ProductionBootstrapAdapters => {
  const account = privateKeyToAccount(config.privateKey)
  const wallet = createWalletClient({
    account,
    chain: base,
    transport: http(config.rpcUrl, { timeout: config.requestTimeoutMs })
  })
    .extend(publicActions)
    .extend(morphoViemExtension({ supportSignature: true, supportDeployless: true }))
  const referenceClient = createPublicClient({
    chain: base,
    transport: http(config.referenceRpcUrl, { timeout: config.requestTimeoutMs })
  })
  const midnight = wallet.morpho.midnight(base.id)
  const ownership = createBootstrapGroupOwnership({
    maker: account.address,
    marketIds: config.setup.marketIds,
    configuredGroupIds: config.v0OfferGroupIds
  })
  const readGroups = () =>
    readBootstrapGroups({
      maker: account.address,
      morphoApiBaseUrl: config.morphoApiBaseUrl,
      requestTimeoutMs: config.requestTimeoutMs
    })

  const activeGroups = async (): Promise<BootstrapActiveGroup[]> => {
    const [block, groups, ownedIds, ownedOffers] = await Promise.all([
      wallet.getBlock({ blockTag: 'latest' }),
      readGroups(),
      ownership.read(),
      ownership.readOffers()
    ])
    const intended = new Map(
      ownedOffers.map(offer => [`${offer.groupId}:${offer.marketId}`, offer] as const)
    )
    return strategyBootstrapGroups(groups, ownedIds)
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
            TickLib.tickToApr(group.tick as bigint, (group.maturity as bigint) - block.timestamp) /
              (WAD / 10_000n),
          ...(persisted ? { referenceObservationId: persisted.referenceObservationId } : {})
        }
      })
  }

  const ownedGroupIds = async () => {
    const [groups, ownedIds] = await Promise.all([readGroups(), ownership.read()])
    return strategyBootstrapGroups(groups, ownedIds).map(group => group.id)
  }

  const inventory: BootstrapInventoryReader = {
    readPositions: async () => {
      const block = await wallet.getBlock({ blockTag: 'latest' })
      return Promise.all(
        bootstrapExposureMarketIds(config).map(async marketId => {
          const position = (
            await midnight.getPositionData({
              marketId,
              accountAddress: account.address,
              parameters: { blockNumber: block.number }
            })
          ).accrueInterest(block.timestamp)
          return { marketId, credit: position.credit, debt: position.debt }
        })
      )
    },
    readCashBalance: () =>
      wallet.readContract({
        address: config.setup.loanAsset,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account.address]
      }),
    readActiveGroups: activeGroups
  }

  const execute = async (
    transaction: { to: `0x${string}`; data: Hex; value: bigint },
    policy: Parameters<typeof assertBootstrapTransaction>[1]
  ) => {
    await assertBootstrapTransaction(transaction, policy)
    const hash = await wallet.sendTransaction(transaction)
    const receipt = await wallet.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new BootstrapAdapterError('transaction-reverted')
  }

  const preparedOffers = new Map<Hex, Offer>()
  const prepareOffer = async (offer: BootstrapOffer) => {
    const [market, block] = await Promise.all([
      midnight.getMarketData(offer.marketId),
      wallet.getBlock({ blockTag: 'latest' })
    ])
    const periodRateWad =
      (offer.rateBps * (WAD / 10_000n) * (market.params.maturity - block.timestamp)) / YEAR_SECONDS
    return Offer.create({
      market: market.params,
      buy: true,
      maker: account.address,
      tick: TickLib.priceToTick(TickLib.rateToPrice(periodRateWad), BigInt(market.tickSpacing)),
      expiry: market.params.maturity,
      ratifier: config.setup.ratifier,
      maxAssets: offer.assets,
      continuousFeeCap: bootstrapContinuousFeeCap(market)
    })
  }

  const make = new MidnightBootstrapMakeService({
    listActiveGroups: activeGroups,
    listOwnedGroupIds: ownedGroupIds,
    listBookOffers: async () =>
      (await readGroups()).flatMap(group =>
        group.offers.map(offer => ({ ...offer, groupId: group.id }))
      ),
    toProspectiveBookOffer: async offer => {
      const created = await prepareOffer(offer)
      preparedOffers.set(offer.marketId, created)
      return { marketId: offer.marketId, buy: true, tick: created.tick }
    },
    invalidate: async group => {
      await execute(midnight.cancelOffer({ group, accountAddress: account.address }).buildTx(), {
        kind: 'cancel',
        target: config.setup.midnight
      })
    },
    reserveGroup: ownership.reserve,
    confirmPublishedGroup: ownership.confirm,
    releaseGroupReservation: ownership.release,
    preparePublication: async (offer: BootstrapOffer) => {
      const created = preparedOffers.get(offer.marketId)
      preparedOffers.delete(offer.marketId)
      if (!created) throw new BootstrapAdapterError('prospective-offer-missing')
      const output = await midnight.makeLend({
        accountAddress: account.address,
        offers: [created],
        validation: { apiUrl: `${config.morphoApiBaseUrl}/v0/midnight` },
        loanToken: config.setup.loanAsset,
        loanAssets: offer.assets
      })
      const signatures = await signBootstrapRequirements(
        await output.getRequirements(),
        requirement =>
          requirement.sign(wallet, account.address) as Promise<
            import('@morpho-org/morpho-sdk').MidnightOfferRootSignature
          >
      )
      const transaction = output.buildTx(signatures)
      const publicationPolicy = {
        kind: 'publication' as const,
        target: getChainAddress(base.id, 'midnightMempool')
      }
      await assertBootstrapTransaction(transaction, publicationPolicy)
      return {
        groupId: output.groups[0] as Hex,
        publish: () => execute(transaction, publicationPolicy)
      }
    }
  })

  return {
    positions: new MidnightBootstrapPositionService(inventory, account.address),
    rates: new BlueBootstrapReferenceRateService(
      createBlueReader(config, referenceClient as HistoricalBlockReader)
    ),
    make
  }
}
