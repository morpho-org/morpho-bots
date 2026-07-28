import type { MidnightOfferRootSignature } from '@morpho-org/morpho-sdk'

import { Offer, TickLib } from '@morpho-org/midnight-sdk'
import { isRequirementSignature, morphoViemExtension } from '@morpho-org/morpho-sdk'
import { fetchMarket } from '@morpho-org/morpho-sdk/fetch'
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

import { requestJson } from '../setup-state/http-json.utils'
import { BootstrapAdapterError } from './bootstrap-adapter.error'
import { MidnightBootstrapMakeService } from './bootstrap-make.service'
import { MidnightBootstrapPositionService } from './bootstrap-position.service'
import { BlueBootstrapReferenceRateService } from './bootstrap-reference-rate.service'

const WAD = 10n ** 18n
const YEAR_SECONDS = 31_536_000n
const PAGE_SIZE = 100

type RawGroup = {
  id: Hex
  marketId: Hex
  consumed: bigint
  maxAssets: bigint
  tick: bigint
  maturity: bigint
}

type HistoricalBlockReader = {
  getBlock(parameters: { blockTag: 'latest' } | { blockNumber: bigint }): Promise<{
    number: bigint | null
    timestamp: bigint
  }>
}

const readGroups = async (config: ConfigService): Promise<RawGroup[]> => {
  const groups: RawGroup[] = []
  let cursor: string | undefined
  do {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) })
    if (cursor) query.set('cursor', cursor)
    const response = (await requestJson(
      `${config.morphoApiBaseUrl}/v0/midnight/users/${config.setup.maker}/offer-groups?${query.toString()}`,
      'morpho-api',
      config.requestTimeoutMs
    )) as { data?: unknown; cursor?: unknown }
    if (!Array.isArray(response.data)) throw new BootstrapAdapterError('offer-groups-response')
    for (const value of response.data) {
      const group = value as Record<string, unknown>
      if (!Array.isArray(group.offers)) throw new BootstrapAdapterError('offer-groups-response')
      const offer = group.offers.find(item => (item as Record<string, unknown>).buy === true) as
        | Record<string, unknown>
        | undefined
      if (!offer) continue
      if (
        typeof group.id !== 'string' ||
        typeof group.consumed !== 'string' ||
        typeof group.max_assets !== 'string' ||
        typeof offer.market_id !== 'string' ||
        typeof offer.tick !== 'number' ||
        typeof offer.market !== 'object' ||
        offer.market === null
      ) {
        throw new BootstrapAdapterError('offer-groups-response')
      }
      const market = offer.market as Record<string, unknown>
      if (typeof market.maturity !== 'number') {
        throw new BootstrapAdapterError('offer-groups-response')
      }
      groups.push({
        id: group.id as Hex,
        marketId: offer.market_id as Hex,
        consumed: BigInt(group.consumed),
        maxAssets: BigInt(group.max_assets),
        tick: BigInt(offer.tick),
        maturity: BigInt(market.maturity)
      })
    }
    if (
      response.cursor !== null &&
      response.cursor !== undefined &&
      typeof response.cursor !== 'string'
    ) {
      throw new BootstrapAdapterError('offer-groups-cursor')
    }
    cursor = response.cursor ?? undefined
  } while (cursor)
  return groups
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
  const ownedGroups = new Set(config.v0OfferGroupIds)

  const activeGroups = async (): Promise<BootstrapActiveGroup[]> => {
    const now = (await wallet.getBlock({ blockTag: 'latest' })).timestamp
    return (await readGroups(config))
      .filter(group => ownedGroups.has(group.id) && group.maxAssets > group.consumed)
      .map(group => ({
        id: group.id,
        marketId: group.marketId,
        assets: group.maxAssets - group.consumed,
        rateBps: TickLib.tickToApr(group.tick, group.maturity - now) / (WAD / 10_000n)
      }))
  }

  const inventory: BootstrapInventoryReader = {
    readPositions: async () => {
      const block = await wallet.getBlock({ blockTag: 'latest' })
      return Promise.all(
        config.bootstrap.map(async strategy => {
          const position = (
            await midnight.getPositionData({
              marketId: strategy.marketId,
              accountAddress: account.address,
              parameters: { blockNumber: block.number }
            })
          ).accrueInterest(block.timestamp)
          return { marketId: strategy.marketId, credit: position.credit, debt: position.debt }
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

  const execute = async (transaction: { to: `0x${string}`; data: Hex; value: bigint }) => {
    const hash = await wallet.sendTransaction(transaction)
    const receipt = await wallet.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new BootstrapAdapterError('transaction-reverted')
  }

  const make = new MidnightBootstrapMakeService(
    {
      listActiveGroups: activeGroups,
      invalidate: async group => {
        await execute(midnight.cancelOffer({ group, accountAddress: account.address }).buildTx())
      },
      publish: async (offer: BootstrapOffer) => {
        const [market, block] = await Promise.all([
          midnight.getMarketData(offer.marketId),
          wallet.getBlock({ blockTag: 'latest' })
        ])
        const periodRateWad =
          (offer.rateBps * (WAD / 10_000n) * (market.params.maturity - block.timestamp)) /
          YEAR_SECONDS
        const created = Offer.create({
          market: market.params,
          buy: true,
          maker: account.address,
          tick: TickLib.priceToTick(TickLib.rateToPrice(periodRateWad), BigInt(market.tickSpacing)),
          expiry: market.params.maturity,
          ratifier: config.setup.ratifier,
          maxAssets: offer.assets
        })
        const output = await midnight.makeLend({
          accountAddress: account.address,
          offers: [created],
          validation: { apiUrl: `${config.morphoApiBaseUrl}/v0/midnight` },
          loanToken: config.setup.loanAsset,
          loanAssets: offer.assets
        })
        const signatures: MidnightOfferRootSignature[] = []
        for (const requirement of await output.getRequirements()) {
          if (
            isRequirementSignature(requirement) &&
            requirement.action.type === 'midnightOfferRootSignature'
          ) {
            signatures.push(
              (await requirement.sign(
                wallet as never,
                account.address
              )) as MidnightOfferRootSignature
            )
          } else {
            if (isRequirementSignature(requirement)) {
              throw new BootstrapAdapterError('unexpected-signature-requirement')
            }
            await execute(requirement)
          }
        }
        await execute(output.buildTx(signatures))
        ownedGroups.add(output.groups[0] as Hex)
        return output.groups[0] as Hex
      }
    },
    config.v0OfferGroupIds
  )

  return {
    positions: new MidnightBootstrapPositionService(inventory, account.address),
    rates: new BlueBootstrapReferenceRateService(
      createBlueReader(config, referenceClient as HistoricalBlockReader)
    ),
    make
  }
}
