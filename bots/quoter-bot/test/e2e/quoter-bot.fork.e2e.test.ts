import {
  midnightAbi,
  Offer,
  OfferUtils,
  Payload,
  SetterRatifierUtils,
  setterRatifierAbi,
  Tree
} from '@morpho-org/midnight-sdk'
import { morphoViemExtension } from '@morpho-org/morpho-sdk'
import { getChainAddress } from '@morpho-org/morpho-ts'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWalletClient, http, publicActions } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

import type { AnvilHandle } from './anvil'
import type { RouterApiHandle } from './router-api'

import { PositionBootstrapService } from '../../src/application/bootstrap/position-bootstrap.service'
import { LadderQuoterService } from '../../src/application/ladder/ladder-quoter.service'
import { createApplication } from '../../src/bootstrap'
import { ConfigService } from '../../src/config/config.service'
import { createProductionBootstrapAdapters } from '../../src/infrastructure/bootstrap/production-bootstrap'
import { createProductionOfferInvalidationPort } from '../../src/infrastructure/invalidation/production-offer-invalidation'
import { createProductionLadderAdapters } from '../../src/infrastructure/ladder/production-ladder'
import { createQuoterTransactionExecutor } from '../../src/infrastructure/transaction/quoter-transaction-executor'
import { startAnvil, stopAnvil } from './anvil'
import {
  ANVIL_DEFAULT_ACCOUNT,
  ANVIL_DEFAULT_PRIVATE_KEY,
  ECRECOVER_RATIFIER,
  MARKET_ID,
  MIDNIGHT,
  NATIVE_RESERVE,
  REFERENCE_MARKET_ID,
  USDC
} from './constants'
import {
  clearMakerCash,
  publishMakerSell,
  redeemMakerCredit,
  repayTakerDebt,
  takeMakerLend
} from './fork-actions'
import { startRouterApi, stopRouterApi } from './router-api'
import { setupMaker } from './setup-maker'

const PINNED_FORK_TIMESTAMP = 1_784_589_348n
const PINNED_WALL_TIMESTAMP = PINNED_FORK_TIMESTAMP + 150n
const DELEGATED_SIGNER = privateKeyToAccount(
  '0x5de4111afa1c4b3ebab8959708c3fe2503b7e5146ff7e53ecf0c8d132d13e5de'
)

const bootstrapConfiguration = JSON.stringify([
  {
    marketId: MARKET_ID,
    creditTarget: '500000000',
    acceptanceAssets: '0',
    offerSize: '500000000',
    premiumBps: '0',
    maximumMarketExposure: '2000000000',
    maximumTotalExposure: '2000000000',
    minimumRateBps: '1',
    maximumRateBps: '100000',
    autoRefill: true
  }
])

const ladderConfiguration = (
  quotePremiumBps: string,
  movementToleranceBps = '10',
  maximumTotalExposureAssets = '200000000'
) =>
  JSON.stringify([
    {
      marketId: MARKET_ID,
      quotePremiumBps,
      spreadBps: '200',
      stepBps: '100',
      rungCount: '3',
      sizeSkewBps: '0',
      lowerRateBudgetAssets: '100000000',
      higherRateBudgetAssets: '100000000',
      targetMarketExposureAssets: '200000000',
      maximumTotalExposureAssets,
      minimumOfferAssets: '1',
      groupMode: 'shared-rung',
      loopIntervalSeconds: '3600',
      movementToleranceBps,
      minimumRateBps: '1',
      maximumRateBps: '100000'
    }
  ])

const environment = (rpcUrl: string, apiBaseUrl: string) => ({
  CHAIN_ID: '8453',
  RPC_URL: rpcUrl,
  REFERENCE_RPC_URL: rpcUrl,
  MAKER_PRIVATE_KEY: ANVIL_DEFAULT_PRIVATE_KEY,
  MAKER_ADDRESS: ANVIL_DEFAULT_ACCOUNT.address,
  MIDNIGHT_ADDRESS: MIDNIGHT,
  LOAN_ASSET_ADDRESS: USDC,
  RATIFIER_ADDRESS: ECRECOVER_RATIFIER,
  MARKET_IDS: MARKET_ID,
  REFERENCE_MARKET_ID,
  NATIVE_RESERVE_WEI: String(NATIVE_RESERVE),
  MAX_FEE_GWEI: '100',
  PRIORITY_FEE_GWEI: '1',
  MAX_TRANSACTION_SPEND_WEI: '100000000000000000',
  MAX_PUBLICATION_GAS: '5000000',
  MAX_PUBLICATION_DATA_BYTES: '65536',
  MAX_CANCELLATION_GAS: '100000',
  MAX_BATCH_CANCELLATION_GAS: '1000000',
  MAX_BATCH_CANCELLATION_DATA_BYTES: '65536',
  MORPHO_API_BASE_URL: apiBaseUrl,
  ROUTER_API_BASE_URL: apiBaseUrl,
  REQUEST_TIMEOUT_MS: '30000',
  BOOTSTRAP_MARKETS: bootstrapConfiguration,
  LADDER_MARKETS: ladderConfiguration('0')
})

const delegatedEnvironment = (rpcUrl: string, apiBaseUrl: string) => ({
  ...environment(rpcUrl, apiBaseUrl),
  MAKER_PRIVATE_KEY: undefined,
  KEY_STORAGE_METHOD: 'aws',
  AWS_KMS_KEY_ID: 'alias/fork-delegated-signer',
  AWS_REGION: 'us-east-1',
  SIGNER_NATIVE_RESERVE_WEI: String(NATIVE_RESERVE)
})

const setMakerAuthorization = async (
  handle: AnvilHandle,
  delegate: `0x${string}`,
  authorized: boolean
) => {
  const wallet = createWalletClient({
    account: ANVIL_DEFAULT_ACCOUNT,
    chain: base,
    transport: http(handle.rpcUrl)
  })
  const hash = await wallet.writeContract({
    address: MIDNIGHT,
    abi: midnightAbi,
    functionName: 'setIsAuthorized',
    args: [delegate, authorized, ANVIL_DEFAULT_ACCOUNT.address]
  })
  const receipt = await handle.client.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new TypeError('Maker authorization reverted')
}

const createProductionLadderRuntime = async (config: ConfigService) => {
  const adapters = await createProductionLadderAdapters(config)
  const service = new LadderQuoterService(
    adapters.positions,
    adapters.rates,
    adapters.make,
    config.ladder
  )
  return {
    runOnce: () => service.runOnce(),
    shutdown: (cleanup: boolean) => (cleanup ? adapters.make.cleanup() : Promise.resolve())
  }
}

describe('quoter-bot workflow on a pinned Base fork', () => {
  let anvil: AnvilHandle | undefined
  let api: RouterApiHandle | undefined
  let stateDirectory: string | undefined
  const originalStateHome = process.env.XDG_STATE_HOME

  const resetStateDirectory = async () => {
    if (!stateDirectory) return
    await rm(stateDirectory, { recursive: true, force: true })
    await mkdir(stateDirectory, { recursive: true })
  }

  beforeAll(async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), 'quoter-bot-e2e-state-'))
    process.env.XDG_STATE_HOME = stateDirectory
    vi.setSystemTime(new Date(Number(PINNED_WALL_TIMESTAMP) * 1_000))
    anvil = await startAnvil(8549)
    await anvil.client.setNextBlockTimestamp({ timestamp: PINNED_FORK_TIMESTAMP })
    await anvil.client.mine({ blocks: 1 })
    api = await startRouterApi(anvil.rpcUrl)
    await setupMaker(anvil)
    await anvil.client.setBalance({ address: DELEGATED_SIGNER.address, value: NATIVE_RESERVE })
  }, 60_000)

  beforeEach(resetStateDirectory)

  afterAll(async () => {
    await Promise.all([stopAnvil(anvil), stopRouterApi(api)])
    vi.useRealTimers()
    if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = originalStateHome
    if (stateDirectory) await rm(stateDirectory, { recursive: true, force: true })
  })

  test('reprices strict and equal crossings below a real external sell and keeps safe spreads', async () => {
    expect(anvil).toBeDefined()
    expect(api).toBeDefined()
    if (!anvil || !api) return

    const config = ConfigService.from(environment(anvil.rpcUrl, api.baseUrl))
    const baseline = await anvil.client.snapshot()
    const baselineBlock = await anvil.client.getBlock({ blockTag: 'latest' })
    const externalOfferTimestamp = baselineBlock.timestamp + 1n
    await anvil.client.setNextBlockTimestamp({ timestamp: externalOfferTimestamp })
    await publishMakerSell(anvil, api, 6_744n)
    const probeAdapters = await createProductionBootstrapAdapters(config)
    const probe = new PositionBootstrapService(
      probeAdapters.positions,
      probeAdapters.rates,
      probeAdapters.make,
      config.bootstrap
    )
    expect(await probe.runOnce()).toMatchObject([{ status: 'applied', action: 'publish' }])
    const published = await api.activeOffers()
    expect(published).toHaveLength(2)
    const buy = published.find(item => OfferUtils.toStruct({ offer: item.offer }).buy)
    expect(buy).toBeDefined()
    if (!buy) throw new TypeError('Expected a production bootstrap buy offer')
    const buyTick = OfferUtils.toStruct({ offer: buy.offer }).tick
    await anvil.client.revert({ id: baseline })
    await resetStateDirectory()
    expect(await api.activeOffers()).toHaveLength(0)

    const tickSpacing = 4n
    const spreadCases = [
      { label: 'strict crossing', sellTick: buyTick - tickSpacing, repriced: true },
      { label: 'equal boundary', sellTick: buyTick, repriced: true },
      { label: 'adjacent safe boundary', sellTick: buyTick + tickSpacing, repriced: false }
    ] as const
    for (const spreadCase of spreadCases) {
      const snapshot = await anvil.client.snapshot()
      try {
        await anvil.client.setNextBlockTimestamp({ timestamp: externalOfferTimestamp })
        expect((await publishMakerSell(anvil, api, spreadCase.sellTick)).status).toBe('success')
        expect(await api.activeOffers()).toHaveLength(1)
        const adapters = await createProductionBootstrapAdapters(config)
        let makeFailure: unknown
        const make = {
          reconcile: async (parameters: Parameters<typeof adapters.make.reconcile>[0]) => {
            try {
              await adapters.make.reconcile(parameters)
            } catch (error) {
              makeFailure = error
              throw error
            }
          },
          hardHalt: (parameters: Parameters<typeof adapters.make.hardHalt>[0]) =>
            adapters.make.hardHalt(parameters),
          cleanup: (parameters?: Parameters<typeof adapters.make.cleanup>[0]) =>
            adapters.make.cleanup(parameters)
        }
        const bootstrap = new PositionBootstrapService(
          adapters.positions,
          adapters.rates,
          make,
          config.bootstrap
        )
        const result = await bootstrap.runOnce()
        expect(makeFailure, spreadCase.label).toBeUndefined()
        expect(result, spreadCase.label).toMatchObject([{ status: 'applied', action: 'publish' }])
        const active = await api.activeOffers()
        expect(active, spreadCase.label).toHaveLength(2)
        const publishedBuy = active
          .map(item => OfferUtils.toStruct({ offer: item.offer }))
          .find(offer => offer.buy)
        expect(publishedBuy, spreadCase.label).toBeDefined()
        if (!publishedBuy) throw new TypeError('Expected a published bootstrap buy offer')
        expect(publishedBuy.tick < spreadCase.sellTick, spreadCase.label).toBe(true)
        if (!spreadCase.repriced) expect(publishedBuy.tick, spreadCase.label).toBe(buyTick)
      } finally {
        await anvil.client.revert({ id: snapshot })
        await resetStateDirectory()
      }
    }
    expect(await api.activeOffers()).toHaveLength(0)
  }, 300_000)

  test('uses the whole external book while cleaning up only explicitly owned ladder groups', async () => {
    expect(anvil).toBeDefined()
    expect(api).toBeDefined()
    if (!anvil || !api) return
    const baseline = await anvil.client.snapshot()
    try {
      const config = ConfigService.from(environment(anvil.rpcUrl, api.baseUrl))
      const runtime = await createProductionLadderRuntime(config)
      expect(await runtime.runOnce()).toMatchObject([{ action: 'publish' }])
      expect(await api.activeOffers()).toHaveLength(3)
      expect((await publishMakerSell(anvil, api, 6_744n)).status).toBe('success')
      expect(await api.activeOffers()).toHaveLength(4)
      await runtime.shutdown(true)
      expect(await api.activeOffers()).toHaveLength(1)
    } finally {
      await anvil.client.revert({ id: baseline })
      await resetStateDirectory()
    }

    const crossing = await anvil.client.snapshot()
    try {
      const config = ConfigService.from(environment(anvil.rpcUrl, api.baseUrl))
      expect((await publishMakerSell(anvil, api, 0n)).status).toBe('success')
      const runtime = await createProductionLadderRuntime(config)
      expect(await runtime.runOnce()).toMatchObject([{ status: 'applied', action: 'publish' }])
      // A tick-zero sell is worth zero assets, so it neither moves the buys nor counts as a cross.
      expect(await api.activeOffers()).toHaveLength(4)
      expect(await runtime.runOnce()).toMatchObject([{ status: 'observed', action: 'rest' }])
      expect(await api.activeOffers()).toHaveLength(4)
    } finally {
      await anvil.client.revert({ id: crossing })
      await resetStateDirectory()
    }
  }, 240_000)

  test('publishes a bootstrap offer through production composition and the real mempool contract', async () => {
    expect(anvil).toBeDefined()
    expect(api).toBeDefined()
    if (!anvil || !api) return
    const applicationEnvironment = environment(anvil.rpcUrl, api.baseUrl)
    const result = await createApplication(applicationEnvironment).run(['bootstrap'])

    expect(result).toMatchObject([{ status: 'applied', action: 'publish' }])
    expect(await api.activeOffers()).toHaveLength(1)
    const fill = await takeMakerLend(anvil, api, 250_000_000n)
    expect(fill.receipt.status).toBe('success')
    expect(fill.makerPosition.credit).toBeGreaterThan(0n)

    const partialResult = await createApplication(applicationEnvironment).run(['bootstrap'])
    expect(partialResult).toMatchObject([{ status: 'applied', action: 'replace' }])
    const partialOffers = await api.activeOffers()
    expect(partialOffers).toHaveLength(1)
    const remainingAssets = OfferUtils.toStruct({ offer: partialOffers[0]!.offer }).maxAssets
    expect(remainingAssets).toBeGreaterThan(0n)
    expect(remainingAssets).toBeLessThan(250_000_000n)

    const completedFill = await takeMakerLend(anvil, api, remainingAssets)
    expect(completedFill.makerPosition.credit).toBeGreaterThanOrEqual(500_000_000n)
    const completeResult = await createApplication(applicationEnvironment).run(['bootstrap'])
    expect(completeResult).toEqual([
      { marketId: MARKET_ID, status: 'observed', action: 'target-reached' }
    ])
    expect(await api.activeOffers()).toHaveLength(0)

    expect((await repayTakerDebt(anvil)).status).toBe('success')
    expect((await redeemMakerCredit(anvil, ANVIL_DEFAULT_ACCOUNT))?.status).toBe('success')
    const strategySnapshot = await anvil.client.snapshot()
    const ladderEnvironment = {
      ...applicationEnvironment,
      LADDER_MARKETS: ladderConfiguration('0', '10', '1000000000')
    }
    const ladderResult = await createApplication(ladderEnvironment).run(['ladder'])
    expect(ladderResult).toEqual([
      { marketId: MARKET_ID, status: 'applied', action: 'publish', reason: 'publish' }
    ])
    expect(await api.activeOffers()).toHaveLength(3)
    const setupAfterLadder = (await createApplication(ladderEnvironment).run(['setup-check'])) as {
      ready: boolean
      checks: { name: string; observed: unknown }[]
    }
    expect(setupAfterLadder.ready).toBe(true)
    expect(setupAfterLadder.checks.find(check => check.name === 'offers')?.observed).toEqual({
      unknownNamespaces: [],
      unknownMarketIds: [],
      invertedMarketIds: []
    })
    const ladder = await createProductionLadderRuntime(ConfigService.from(ladderEnvironment))
    expect(await ladder.runOnce()).toEqual([
      { marketId: MARKET_ID, status: 'observed', action: 'rest' }
    ])
    await ladder.shutdown(false)
    expect(await api.activeOffers()).toHaveLength(3)

    const recentered = await createProductionLadderRuntime(
      ConfigService.from({
        ...ladderEnvironment,
        LADDER_MARKETS: ladderConfiguration('500', '10', '1000000000')
      })
    )
    expect(await recentered.runOnce()).toMatchObject([{ action: 'replace', reason: 'recenter' }])
    expect(await api.activeOffers()).toHaveLength(3)

    await clearMakerCash(anvil)
    expect(await recentered.runOnce()).toMatchObject([{ action: 'replace' }])
    expect(await api.activeOffers()).toHaveLength(0)

    await anvil.client.revert({ id: strategySnapshot })
    await resetStateDirectory()
    expect(await api.activeOffers()).toHaveLength(0)
    const sellRuntime = await createProductionLadderRuntime(
      ConfigService.from({
        ...ladderEnvironment,
        LADDER_MARKETS: ladderConfiguration('-100', '1000', '1000000000')
      })
    )
    expect(await sellRuntime.runOnce()).toMatchObject([{ action: 'publish', reason: 'publish' }])
    const restartOffers = await api.activeOffers()
    expect(restartOffers).toHaveLength(3)
    expect(restartOffers.map(item => OfferUtils.toStruct({ offer: item.offer }).buy)).toEqual([
      true,
      true,
      true
    ])
    await sellRuntime.shutdown(true)
    expect(await api.activeOffers()).toHaveLength(0)
  }, 180_000)

  test('uses a distinct delegated signer for offers, deauthorization, and cancellation', async () => {
    expect(anvil).toBeDefined()
    expect(api).toBeDefined()
    if (!anvil || !api) return

    const fillSnapshot = await anvil.client.snapshot()
    try {
      await setMakerAuthorization(anvil, DELEGATED_SIGNER.address, true)
      const config = ConfigService.from(delegatedEnvironment(anvil.rpcUrl, api.baseUrl))
      const executor = createQuoterTransactionExecutor(config, DELEGATED_SIGNER)
      const adapters = await createProductionBootstrapAdapters(
        config,
        undefined,
        DELEGATED_SIGNER,
        [],
        executor
      )
      const bootstrap = new PositionBootstrapService(
        adapters.positions,
        adapters.rates,
        adapters.make,
        config.bootstrap
      )

      expect(await bootstrap.runOnce()).toMatchObject([{ status: 'applied', action: 'publish' }])
      const published = await api.activeOffers()
      expect(published).toHaveLength(1)
      expect(OfferUtils.toStruct({ offer: published[0]!.offer }).maker).toBe(
        ANVIL_DEFAULT_ACCOUNT.address
      )
      expect((await takeMakerLend(anvil, api, 100_000_000n)).receipt.status).toBe('success')
    } finally {
      await anvil.client.revert({ id: fillSnapshot })
      await resetStateDirectory()
    }

    const revocationSnapshot = await anvil.client.snapshot()
    try {
      await setMakerAuthorization(anvil, DELEGATED_SIGNER.address, true)
      const config = ConfigService.from(delegatedEnvironment(anvil.rpcUrl, api.baseUrl))
      const executor = createQuoterTransactionExecutor(config, DELEGATED_SIGNER)
      const adapters = await createProductionBootstrapAdapters(
        config,
        undefined,
        DELEGATED_SIGNER,
        [],
        executor
      )
      const bootstrap = new PositionBootstrapService(
        adapters.positions,
        adapters.rates,
        adapters.make,
        config.bootstrap
      )
      expect(await bootstrap.runOnce()).toMatchObject([{ status: 'applied', action: 'publish' }])
      const published = await api.activeOffers()
      const offer = OfferUtils.toStruct({ offer: published[0]!.offer })

      await setMakerAuthorization(anvil, DELEGATED_SIGNER.address, false)
      await expect(takeMakerLend(anvil, api, 100_000_000n)).rejects.toBeDefined()

      await setMakerAuthorization(anvil, DELEGATED_SIGNER.address, true)
      const invalidation = await createProductionOfferInvalidationPort(
        config,
        DELEGATED_SIGNER,
        executor
      )
      await invalidation.preflight()
      await expect(invalidation.invalidate(offer.group)).resolves.toBeDefined()
      expect(await api.activeOffers()).toHaveLength(0)
    } finally {
      await anvil.client.revert({ id: revocationSnapshot })
      await resetStateDirectory()
    }
  }, 240_000)

  test('keeps an approved Setter root valid after its delegated signer is removed', async () => {
    expect(anvil).toBeDefined()
    expect(api).toBeDefined()
    if (!anvil || !api) return
    const snapshot = await anvil.client.snapshot()
    try {
      const setterRatifier = getChainAddress(base.id, 'setterRatifier')
      await setMakerAuthorization(anvil, setterRatifier, true)
      await setMakerAuthorization(anvil, DELEGATED_SIGNER.address, true)
      const wallet = createWalletClient({
        account: DELEGATED_SIGNER,
        chain: base,
        transport: http(anvil.rpcUrl)
      }).extend(publicActions)
      const midnight = wallet
        .extend(morphoViemExtension({ supportSignature: true, supportDeployless: true }))
        .morpho.midnight(base.id)
      const marketData = await midnight.getMarketData(MARKET_ID)
      const offer = Offer.create({
        market: marketData.params,
        buy: true,
        maker: ANVIL_DEFAULT_ACCOUNT.address,
        tick: 6_744n,
        expiry: marketData.params.maturity,
        ratifier: setterRatifier,
        maxAssets: 500_000_000n,
        continuousFeeCap: BigInt(marketData.continuousFee)
      })
      const tree = Tree.create([offer])
      const items = SetterRatifierUtils.ratify({ tree })
      const approvalHash = await wallet.writeContract({
        address: setterRatifier,
        abi: setterRatifierAbi,
        functionName: 'setIsRootRatified',
        args: [ANVIL_DEFAULT_ACCOUNT.address, tree.root, true]
      })
      expect((await wallet.waitForTransactionReceipt({ hash: approvalHash })).status).toBe(
        'success'
      )
      const publicationHash = await wallet.sendTransaction({
        to: getChainAddress(base.id, 'midnightMempool'),
        data: await Payload.encode(items)
      })
      expect((await wallet.waitForTransactionReceipt({ hash: publicationHash })).status).toBe(
        'success'
      )

      await setMakerAuthorization(anvil, DELEGATED_SIGNER.address, false)
      expect(
        await anvil.client.readContract({
          address: setterRatifier,
          abi: setterRatifierAbi,
          functionName: 'isRootRatified',
          args: [ANVIL_DEFAULT_ACCOUNT.address, tree.root]
        })
      ).toBe(true)
      expect((await takeMakerLend(anvil, api, 100_000_000n)).receipt.status).toBe('success')
    } finally {
      await anvil.client.revert({ id: snapshot })
      await resetStateDirectory()
    }
  }, 180_000)
})
