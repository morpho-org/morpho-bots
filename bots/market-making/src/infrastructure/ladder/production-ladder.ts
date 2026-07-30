import { EcrecoverRatifierUtils, Payload } from '@morpho-org/midnight-sdk'
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
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'

import type {
  LadderMakeService,
  LadderPositionService,
  LadderReferenceRateService
} from '../../application/ladder/ladder-market-maker.service'
import type { LadderTransactionSubmittedObserver } from '../../application/ladder/ladder-verbose'
import type { ConfigService } from '../../config/config.service'
import type { LadderQuoteSet, LadderRung } from '../../domain/ladder/ladder'
import type { BootstrapRawGroup } from '../bootstrap/bootstrap-groups.utils'
import type { HistoricalBlockReader } from '../reference/blue-reference-reader.utils'
import type { OwnedLadderPublication } from './ladder-group-ownership.utils'

import { createBootstrapGroupOwnership } from '../bootstrap/bootstrap-group-ownership.utils'
import {
  bootstrapBookOffers,
  bootstrapReservedLoanAssets,
  readBootstrapGroups
} from '../bootstrap/bootstrap-groups.utils'
import { BlueBootstrapReferenceRateService } from '../bootstrap/bootstrap-reference-rate.service'
import { createBlueReferenceReader } from '../reference/blue-reference-reader.utils'
import { LadderAdapterError } from './ladder-adapter.error'
import { createLadderGroupOwnership } from './ladder-group-ownership.utils'
import { MidnightLadderMakeService, type LadderOfferTransport } from './ladder-make.service'
import { buildLadderTree } from './ladder-offer.utils'
import {
  assertLadderCancellationTransaction,
  assertLadderPublicationTransaction
} from './ladder-transaction.utils'

/** Concrete ports used by the default ladder application service. */
type ProductionLadderAdapters = {
  positions: LadderPositionService
  rates: LadderReferenceRateService
  make: LadderMakeService
}

const minimum = (left: bigint, right: bigint) => (left < right ? left : right)
const remaining = (limit: bigint, used: bigint) => (limit > used ? limit - used : 0n)

const notifySubmitted = async (
  observer: LadderTransactionSubmittedObserver | undefined,
  operation: 'cancel' | 'publish',
  txHash: Hex
) => {
  await observer?.({ operation, txHash })
}

const distinctGroups = (groups: readonly BootstrapRawGroup[]) => [
  ...new Map(groups.map(group => [group.id, group])).values()
]

const scaleRungs = (rungs: readonly LadderRung[], assets: bigint): LadderRung[] => {
  const total = rungs.reduce((sum, rung) => sum + rung.assets, 0n)
  if (total === 0n || assets === 0n) return []
  const scaled = rungs.map(rung => ({ ...rung, assets: (assets * rung.assets) / total }))
  const allocated = scaled.reduce((sum, rung) => sum + rung.assets, 0n)
  const last = scaled.at(-1)
  if (last) last.assets += assets - allocated
  return scaled.filter(rung => rung.assets > 0n)
}

const reconstructPublication = (
  publication: OwnedLadderPublication,
  liveGroups: ReadonlyMap<Hex, BootstrapRawGroup>
): LadderQuoteSet | undefined => {
  const side = (name: 'lower' | 'higher') => {
    const original = publication.quote[name]
    const byIndex = new Map(original.map(rung => [rung.index, rung]))
    const reconstructed: LadderRung[] = []
    for (const reference of publication.groups.filter(group => group.side === name)) {
      const group = liveGroups.get(reference.groupId)
      if (!group || group.maxAssets <= group.consumed) continue
      const rungs = reference.rungIndexes.flatMap(index => {
        const rung = byIndex.get(index)
        return rung ? [rung] : []
      })
      reconstructed.push(...scaleRungs(rungs, group.maxAssets - group.consumed))
    }
    return reconstructed.toSorted((left, right) => left.index - right.index)
  }
  const lower = side('lower')
  const higher = side('higher')
  if (lower.length === 0 && higher.length === 0) return undefined
  return { ...publication.quote, lower, higher }
}

const activeOwnedGroupIds = (
  publications: readonly OwnedLadderPublication[],
  groups: readonly BootstrapRawGroup[],
  marketId?: Hex
) => {
  const live = new Set(
    groups.filter(group => group.maxAssets > group.consumed).map(group => group.id)
  )
  return [
    ...new Set(
      publications
        .filter(publication => marketId === undefined || publication.marketId === marketId)
        .flatMap(publication => publication.groups.map(group => group.groupId))
        .filter(groupId => live.has(groupId))
    )
  ]
}

/**
 * Composes live chain, archive reference, Mempool, signing, and ownership ladder adapters.
 * @param config - Fully validated runtime configuration.
 * @returns Production position, reference-rate, and make ports.
 * @throws `LadderAdapterError` when write-mode signer identity differs from the maker; later reads,
 * validation, signing, publication, storage, or receipt confirmation may also fail.
 * @remarks Read-only construction never derives an account or creates a wallet. Every published
 * tree is API-validated before and after signing, locally policy-checked, and submitted atomically.
 */
export const createProductionLadderAdapters = (config: ConfigService): ProductionLadderAdapters => {
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
    marketIds: config.setup.marketIds
  })
  const configByMarket = new Map(config.ladder.map(item => [item.marketId, item]))
  const readGroups = () =>
    readBootstrapGroups({
      maker,
      morphoApiBaseUrl: config.morphoApiBaseUrl,
      requestTimeoutMs: config.requestTimeoutMs
    })

  const positions: LadderPositionService = {
    readMarket: async marketId => {
      const selectedConfig = configByMarket.get(marketId)
      if (!selectedConfig) throw new LadderAdapterError('market-configuration-missing')
      const block = await client.getBlock({ blockTag: 'latest' })
      const [groups, publications, bootstrapGroupIds, cashBalance, allowance, positionSnapshots] =
        await Promise.all([
          readGroups(),
          ladderOwnership.read(),
          bootstrapOwnership.read(),
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

      const ladderGroupIds = new Set(
        publications.flatMap(publication => publication.groups.map(group => group.groupId))
      )
      const ownedGroupIds = new Set([...bootstrapGroupIds, ...ladderGroupIds])
      const replacedGroupIds = new Set(
        publications
          .filter(publication => publication.marketId === marketId)
          .flatMap(publication => publication.groups.map(group => group.groupId))
      )
      const otherBuyGroups = distinctGroups(groups).filter(
        group =>
          ownedGroupIds.has(group.id) &&
          !replacedGroupIds.has(group.id) &&
          group.offers.some(offer => offer.buy)
      )
      const otherBuyGroupIds = otherBuyGroups.map(group => group.id)
      const reservedCash = bootstrapReservedLoanAssets(otherBuyGroups, otherBuyGroupIds)
      const availableCash = remaining(minimum(cashBalance, allowance), reservedCash)
      const marketBuyGroups = otherBuyGroups.filter(group =>
        group.offers.some(offer => offer.marketId === marketId && offer.buy)
      )
      const marketReserved = bootstrapReservedLoanAssets(
        marketBuyGroups,
        marketBuyGroups.map(group => group.id)
      )
      const marketExposure = selectedPosition.credit + marketReserved
      const totalCredit = positionSnapshots.reduce((sum, position) => sum + position.credit, 0n)
      const totalExposure = totalCredit + reservedCash

      return {
        lowerRateCapacityAssets: availableCash,
        higherRateCapacityAssets: selectedPosition.credit,
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

  const readActive = async (marketId: Hex) => {
    const [groups, publications] = await Promise.all([readGroups(), ladderOwnership.read()])
    const liveGroups = new Map(
      distinctGroups(groups)
        .filter(group => group.maxAssets > group.consumed)
        .map(group => [group.id, group])
    )
    const publication = publications
      .filter(item => item.marketId === marketId)
      .toReversed()
      .find(item => item.groups.some(group => liveGroups.has(group.groupId)))
    return publication ? reconstructPublication(publication, liveGroups) : undefined
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
  if (config.identity.readOnly) return { positions, rates, make: readOnlyMake }

  const account = privateKeyToAccount(config.identity.privateKey)
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
    listActiveGroupIds: async marketId => {
      const [publications, groups] = await Promise.all([ladderOwnership.read(), readGroups()])
      return activeOwnedGroupIds(publications, groups, marketId)
    },
    listBookOffers: async () => bootstrapBookOffers(await readGroups()),
    preparePublication: async quote => {
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
      const signature = await EcrecoverRatifierUtils.sign({
        tree: prepared.tree,
        client: wallet,
        account: maker
      })
      await prepared.tree.mempoolValidate({
        chainId: base.id,
        apiUrl: `${config.morphoApiBaseUrl}/v0/midnight`,
        ratification: { type: 'ecrecover', account: maker, signature }
      })
      const items = await EcrecoverRatifierUtils.ratify({
        tree: prepared.tree,
        account: maker,
        signature
      })
      const transaction = {
        to: mempool,
        data: await Payload.encode(items),
        value: 0n
      }
      await assertLadderPublicationTransaction(transaction, {
        target: mempool,
        offers: prepared.tree.offers
      })
      const groupIds = [...new Set(prepared.groups.map(group => group.groupId))]
      return {
        groupIds,
        groups: prepared.groups,
        prospective: prepared.bookOffers,
        publish: async onTransactionSubmitted => {
          const hash = await wallet.sendTransaction(transaction)
          await notifySubmitted(onTransactionSubmitted, 'publish', hash)
          const receipt = await wallet.waitForTransactionReceipt({
            hash,
            timeout: config.requestTimeoutMs
          })
          if (receipt.status !== 'success') {
            throw new LadderAdapterError('transaction-reverted')
          }
          return hash
        }
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
        timeout: config.requestTimeoutMs
      })
      if (receipt.status !== 'success') throw new LadderAdapterError('transaction-reverted')
      return hash
    },
    forgetGroups: ladderOwnership.forget
  }

  return {
    positions,
    rates,
    make: new MidnightLadderMakeService(transport)
  }
}
