import type { Address, LocalAccount } from 'viem'

import {
  MAX_CONTINUOUS_FEE,
  midnightAbi,
  Offer,
  OfferUtils,
  Payload,
  SetterRatifierUtils,
  setterRatifierAbi,
  Tree
} from '@morpho-org/midnight-sdk'
import { morphoViemExtension } from '@morpho-org/morpho-sdk'

const discardingJournal = {
  sink: { append: async () => {}, finalize: async () => {} },
  capacityBytes: 100_000_000
}
import { getChainAddress } from '@morpho-org/morpho-ts'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createWalletClient, http, publicActions, toFunctionSelector } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

import type { MonitoringEvent } from '../../src/application/monitoring/monitoring-event'
import type { AnvilHandle } from './anvil'
import type { RouterApiHandle } from './router-api'

import { createApplication } from '../../src/bootstrap'
import { ConfigService } from '../../src/config/config.service'
import { StartupCleanupFailedError, QuoterStartError } from '../../src/errors'
import { createOfferInvalidation } from '../../src/infrastructure/invalidation/offer-invalidation'
import { buildLadderTree } from '../../src/infrastructure/ladder/ladder-offer.utils'
import { createSignerAccount } from '../../src/kernel'
import { startQuoterEngine, type QuoterEngine } from '../../src/run'
import { startAnvil, stopAnvil } from './anvil'
import {
  ANVIL_DEFAULT_ACCOUNT,
  ANVIL_DEFAULT_PRIVATE_KEY,
  ANVIL_TAKER_ACCOUNT,
  ECRECOVER_RATIFIER,
  MARKET_ID,
  MIDNIGHT,
  NATIVE_RESERVE,
  REFERENCE_MARKET_ID,
  USDC
} from './constants'
import {
  clearMakerCash,
  prepareMakerBorrowTake,
  publishCollateralizedTree,
  publishMakerSell,
  redeemMakerCredit,
  repayTakerDebt,
  takeMakerLend
} from './fork-actions'
import { startRouterApi, stopRouterApi } from './router-api'
import { setupMaker } from './setup-maker'

const PINNED_FORK_TIMESTAMP = 1_784_589_348n
/** How far the pinned wall clock runs ahead of the fork's head, as a node's clock runs past its blocks. */
const WALL_CLOCK_LEAD_SECONDS = 150n
const PINNED_WALL_TIMESTAMP = PINNED_FORK_TIMESTAMP + WALL_CLOCK_LEAD_SECONDS
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
    minimumRateBps: '11',
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
  // Pinned so the probe reads 10,800 blocks upstream of the fork rather than the three-day
  // default's 129,600, which anvil would proxy to the upstream archive on every run.
  REFERENCE_LOOKBACK_SECONDS: '21600',
  NATIVE_RESERVE_WEI: String(NATIVE_RESERVE),
  MAX_FEE_GWEI: '100',
  MAX_TRANSACTION_SPEND_WEI: '100000000000000000',
  // Bootstrap accepts the market's live continuous fee, so the fork allows the protocol maximum.
  MAX_CONTINUOUS_FEE_CAP: String(MAX_CONTINUOUS_FEE),
  KERNEL_ENROLLMENT: 'enrolling',
  // An automining fork mines only on a transaction, so finality one block deep is reached by mining.
  FINALITY: '1',
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
  delegate: Address,
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

const jsonBigint = (_: string, value: unknown) =>
  typeof value === 'bigint' ? value.toString() : value

/** Engines a test started; each is abandoned before the fork is reverted or the ledger reset. */
const writers: QuoterEngine[] = []

/**
 * Pins the wall clock {@link WALL_CLOCK_LEAD_SECONDS} past the head again. Anvil adds a second per
 * mined block, so a clock that stayed pinned would fall behind the head as the suite mines.
 */
const followHead = async (handle: AnvilHandle) => {
  const { timestamp } = await handle.client.getBlock({ blockTag: 'latest' })
  vi.setSystemTime(new Date(Number(timestamp + WALL_CLOCK_LEAD_SECONDS) * 1_000))
}

/** How far Anvil's `safe` block trails its head; automine adds no block without a transaction. */
const ANVIL_SAFE_LAG_BLOCKS = 32

/**
 * Makes every transaction so far safe, as a fresh enrollment needs before the kernel takes a
 * nonce, without mining while a one-shot command then reads the world.
 */
const finalizeHead = async (handle: AnvilHandle) => {
  await handle.client.mine({ blocks: ANVIL_SAFE_LAG_BLOCKS })
  await followHead(handle)
}

/**
 * Mines while `work` runs, failing after `ms`. The kernel's start waits for the signer's nonce to
 * be safe ({@link ANVIL_SAFE_LAG_BLOCKS}), and a clean stop for its cancellations to be final.
 */
const whileMining = async <T>(
  handle: AnvilHandle,
  work: Promise<T>,
  what: string,
  ms = 120_000
) => {
  const miner = setInterval(
    () =>
      void handle.client
        .mine({ blocks: 1 })
        .then(() => followHead(handle))
        .catch(() => {}),
    250
  )
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms)
      })
    ])
  } finally {
    clearTimeout(deadline)
    clearInterval(miner)
  }
}

/** Deadlines run on the monotonic clock, since the suite pins `Date`. */
const until = async (done: () => boolean, what: string, ms = 120_000) => {
  const deadline = performance.now() + ms
  while (!done()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(25)
  }
}

type Strategy = 'ladder' | 'bootstrap'
type Completed = Extract<MonitoringEvent, { event: 'cycle.completed' }>

/**
 * What each market did since the last check, from its liveness records: the first that is not a
 * plain observation (an act's outcome, or a failure), else its last observation.
 */
const reportedResults = (records: readonly Completed[]) =>
  [...new Set(records.map(record => record.marketId))].map(marketId => {
    const own = records.filter(record => record.marketId === marketId)
    const {
      marketId: _,
      status,
      action,
      reason
    } = own.find(record => record.status !== 'observed') ?? own.at(-1)!
    return {
      marketId,
      status,
      ...(action === undefined ? {} : { action }),
      ...(reason === undefined ? {} : { reason })
    }
  })

/**
 * Starts the engine a writer process runs, as composition does, and reports each strategy's cycles.
 * The fork's clock is frozen, so a market is re-read only after one of the bot's own acts, or when a
 * test asks for it after changing the world.
 */
const startWriter = async (
  handle: AnvilHandle,
  config: ConfigService,
  strategies: Readonly<Record<Strategy, boolean>>,
  account?: LocalAccount
) => {
  const identity = config.identity
  if (identity.readOnly) throw new TypeError('a writer needs a signing identity')
  // Every report since the last check; a market reports its act there, then rests while re-read.
  const cycles: Partial<Record<Strategy, Completed[]>> = {}
  const reported = (strategy: Strategy) => reportedResults(cycles[strategy] ?? [])
  const signer = account ?? (await createSignerAccount(identity))
  const engine = await whileMining(
    handle,
    startQuoterEngine({
      config,
      journal: discardingJournal,
      strategies,
      account: signer,
      writeEvent: event => {
        if (event.event.startsWith('kernel.')) console.info(JSON.stringify(event, jsonBigint))
        if (event.event === 'cycle.completed' && event.workflow !== 'setup-check')
          cycles[event.workflow] = [...(cycles[event.workflow] ?? []), event]
      }
    }),
    'the kernel to start'
  )
  writers.push(engine)
  /** Waits until every market is steady, and returns the cycle that shows it. */
  const steady = async (strategy: Strategy) => {
    await until(() => engine.steady() && cycles[strategy] !== undefined, `${strategy} to settle`)
    const results = reported(strategy)
    delete cycles[strategy]
    return results
  }
  return {
    engine,
    steady,
    /**
     * Reads the world again after a change the bot did not make, and waits for it to settle. A
     * poll reports only a world read that differs from the last, so the read is taken at a new head.
     */
    recheck: async (strategy: Strategy) => {
      delete cycles[strategy]
      await handle.client.mine({ blocks: 1 })
      await followHead(handle)
      const head = Number(await handle.client.getBlockNumber({ cacheTime: 0 }))
      await until(
        () => (engine.kernelState()?.head?.number ?? 0) >= head,
        'the kernel to see a new head'
      )
      engine.refresh()
      await until(() => cycles[strategy] !== undefined, `a fresh ${strategy} reading`)
      return steady(strategy)
    },
    /** Withdraws everything and stops, as a graceful shutdown does. */
    stop: async () => {
      engine.stop()
      return whileMining(handle, engine.stopped, 'the kernel to stop')
    }
  }
}

describe('quoter-bot workflow on a pinned Base fork', () => {
  let anvil: AnvilHandle | undefined
  let api: RouterApiHandle | undefined
  let stateDirectory: string | undefined
  const originalStateHome = process.env.XDG_STATE_HOME

  const resetStateDirectory = async () => {
    await Promise.all(writers.splice(0).map(engine => engine.abandon()))
    if (anvil) await followHead(anvil)
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
    // Automine reuses a timestamp within one wall-clock second, so a republished offer could hash
    // to a cancelled group; a real chain's timestamps strictly increase (Yellow Paper §4.3.4).
    await anvil.client.setBlockTimestampInterval({ interval: 1 })
    api = await startRouterApi(anvil.rpcUrl)
    // Anvil's published keys carry live EIP-7702 delegations on Base, and the kernel refuses an
    // account with code (https://eips.ethereum.org/EIPS/eip-7702).
    for (const address of [ANVIL_DEFAULT_ACCOUNT.address, DELEGATED_SIGNER.address])
      await anvil.client.setCode({ address, bytecode: '0x' })
    await setupMaker(anvil)
    await anvil.client.setBalance({ address: DELEGATED_SIGNER.address, value: 2n * NATIVE_RESERVE })
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
    const probe = await startWriter(anvil, config, { ladder: false, bootstrap: true })
    expect(await probe.steady('bootstrap')).toMatchObject([
      { status: 'applied', action: 'publish' }
    ])
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
        const writer = await startWriter(anvil, config, { ladder: false, bootstrap: true })
        const result = await writer.steady('bootstrap')
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
      const runtime = await startWriter(anvil, config, { ladder: true, bootstrap: false })
      expect(await runtime.steady('ladder')).toMatchObject([{ action: 'publish' }])
      expect(await api.activeOffers()).toHaveLength(3)
      expect((await publishMakerSell(anvil, api, 6_744n)).status).toBe('success')
      expect(await api.activeOffers()).toHaveLength(4)
      expect((await runtime.stop()).outcome).toBe('clean')
      expect(await api.activeOffers()).toHaveLength(1)
    } finally {
      await anvil.client.revert({ id: baseline })
      await resetStateDirectory()
    }

    const crossing = await anvil.client.snapshot()
    try {
      const config = ConfigService.from(environment(anvil.rpcUrl, api.baseUrl))
      expect((await publishMakerSell(anvil, api, 0n)).status).toBe('success')
      const runtime = await startWriter(anvil, config, { ladder: true, bootstrap: false })
      expect(await runtime.steady('ladder')).toMatchObject([
        { status: 'applied', action: 'publish' }
      ])
      // A tick-zero sell is worth zero assets, so it neither moves the buys nor counts as a cross.
      expect(await api.activeOffers()).toHaveLength(4)
      expect(await runtime.recheck('ladder')).toMatchObject([
        { status: 'observed', action: 'rest' }
      ])
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
    await finalizeHead(anvil)
    const result = await createApplication(applicationEnvironment).run(['bootstrap'])

    expect(result).toMatchObject([{ status: 'applied', action: 'publish' }])
    const publishedOffers = await api.activeOffers()
    expect(publishedOffers).toHaveLength(1)
    const publishedOffer = OfferUtils.toStruct({ offer: publishedOffers[0]!.offer })
    expect(publishedOffer.maxUnits).toBe(500_000_000n)

    // An enrolling start beside an existing ledger is refused, and the writer fails to start.
    const refused = await startWriter(anvil, ConfigService.from(applicationEnvironment), {
      ladder: false,
      bootstrap: true
    }).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(QuoterStartError)
    expect((refused as QuoterStartError).report.outcome).toBe('refused')
    // A later process holds no quote for what it adopts, so it withdraws it before quoting again.
    const config = ConfigService.from({ ...applicationEnvironment, KERNEL_ENROLLMENT: 'enrolled' })
    const bootstrap = await startWriter(anvil, config, { ladder: false, bootstrap: true })
    expect(await bootstrap.steady('bootstrap')).toMatchObject([
      { status: 'applied', action: 'publish' }
    ])
    const republished = await api.activeOffers()
    expect(republished).toHaveLength(1)
    const resting = OfferUtils.toStruct({ offer: republished[0]!.offer })
    expect(resting.group).not.toBe(publishedOffer.group)
    const fill = await takeMakerLend(anvil, api, 250_000_000n)
    expect(fill.receipt.status).toBe('success')
    expect(fill.makerPosition.credit).toBeGreaterThan(250_000_000n)

    expect(await bootstrap.recheck('bootstrap')).toEqual([
      { marketId: MARKET_ID, status: 'observed', action: 'rest' }
    ])
    const partialOffers = await api.activeOffers()
    expect(partialOffers).toHaveLength(1)
    expect(OfferUtils.toStruct({ offer: partialOffers[0]!.offer }).group).toBe(resting.group)
    const remainingUnits = resting.maxUnits - fill.makerPosition.credit
    expect(remainingUnits).toBeGreaterThan(0n)
    expect(remainingUnits).toBeLessThan(250_000_000n)

    const completedFill = await takeMakerLend(anvil, api, { units: remainingUnits })
    expect(completedFill.makerPosition.credit).toBe(500_000_000n)
    expect(await bootstrap.recheck('bootstrap')).toEqual([
      { marketId: MARKET_ID, status: 'observed', action: 'target-reached' }
    ])
    expect(await api.activeOffers()).toHaveLength(0)

    expect((await repayTakerDebt(anvil)).status).toBe('success')
    expect((await redeemMakerCredit(anvil, ANVIL_DEFAULT_ACCOUNT))?.status).toBe('success')
    await resetStateDirectory()
    const strategySnapshot = await anvil.client.snapshot()
    const ladderEnvironment = {
      ...applicationEnvironment,
      LADDER_MARKETS: ladderConfiguration('0', '10', '1000000000')
    }
    const ladder = await startWriter(anvil, ConfigService.from(ladderEnvironment), {
      ladder: true,
      bootstrap: false
    })
    expect(await ladder.steady('ladder')).toEqual([
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
    expect(await ladder.recheck('ladder')).toEqual([
      { marketId: MARKET_ID, status: 'observed', action: 'rest' }
    ])
    expect(await api.activeOffers()).toHaveLength(3)
    await Promise.all(writers.splice(0).map(engine => engine.abandon()))

    const recentered = await startWriter(
      anvil,
      ConfigService.from({
        ...ladderEnvironment,
        KERNEL_ENROLLMENT: 'enrolled',
        LADDER_MARKETS: ladderConfiguration('500', '10', '1000000000')
      }),
      { ladder: true, bootstrap: false }
    )
    expect(await recentered.steady('ladder')).toMatchObject([
      { action: 'publish', reason: 'publish' }
    ])
    expect(await api.activeOffers()).toHaveLength(3)

    await clearMakerCash(anvil)
    expect(await recentered.recheck('ladder')).toMatchObject([{ action: 'replace' }])
    expect(await api.activeOffers()).toHaveLength(0)

    await anvil.client.revert({ id: strategySnapshot })
    await resetStateDirectory()
    expect(await api.activeOffers()).toHaveLength(0)
    const sellRuntime = await startWriter(
      anvil,
      ConfigService.from({
        ...ladderEnvironment,
        LADDER_MARKETS: ladderConfiguration('-100', '1000', '1000000000')
      }),
      { ladder: true, bootstrap: false }
    )
    expect(await sellRuntime.steady('ladder')).toMatchObject([
      { action: 'publish', reason: 'publish' }
    ])
    const restartOffers = await api.activeOffers()
    expect(restartOffers).toHaveLength(3)
    expect(restartOffers.map(item => OfferUtils.toStruct({ offer: item.offer }).buy)).toEqual([
      true,
      true,
      true
    ])
    expect((await sellRuntime.stop()).outcome).toBe('clean')
    expect(await api.activeOffers()).toHaveLength(0)
  }, 300_000)

  test('previews a bootstrap publication read-only through the real world reads, sending nothing', async () => {
    expect(anvil).toBeDefined()
    expect(api).toBeDefined()
    if (!anvil || !api) return
    const handle = anvil
    const maker = ANVIL_DEFAULT_ACCOUNT.address
    const nonce = await handle.client.getTransactionCount({ address: maker })

    const result = await whileMining(
      handle,
      createApplication({
        ...environment(handle.rpcUrl, api.baseUrl),
        MAKER_PRIVATE_KEY: undefined
      }).run(['--readonly', 'bootstrap'], {
        writeEvent: event => {
          const record = event as { event?: string }
          if (record.event?.startsWith('kernel.')) console.info(JSON.stringify(event, jsonBigint))
        }
      }),
      'a read-only bootstrap'
    )

    expect(result).toMatchObject([{ action: 'publish' }])
    expect(await api.activeOffers()).toHaveLength(0)
    expect(await handle.client.getTransactionCount({ address: maker })).toBe(nonce)
  }, 240_000)

  test('refuses to start beside a transaction its ledger never recorded, leaving the book to the operator', async () => {
    expect(anvil).toBeDefined()
    expect(api).toBeDefined()
    if (!anvil || !api) return
    const handle = anvil
    const maker = ANVIL_DEFAULT_ACCOUNT.address
    const wallet = createWalletClient({
      account: ANVIL_DEFAULT_ACCOUNT,
      chain: base,
      transport: http(handle.rpcUrl)
    })
    const ladderEnvironment = {
      ...environment(handle.rpcUrl, api.baseUrl),
      BOOTSTRAP_MARKETS: '[]'
    }

    const snapshot = await handle.client.snapshot()
    try {
      await finalizeHead(handle)
      expect(await createApplication(ladderEnvironment).run(['ladder'])).toMatchObject([
        { status: 'applied', action: 'publish' }
      ])
      expect(await api.activeOffers()).toHaveLength(3)
      // A transaction the kernel never signed, pending at the signer's next nonce.
      await handle.client.setAutomine(false)
      await wallet.sendTransaction({ to: maker, value: 0n })

      const error = await createApplication(ladderEnvironment)
        .run(['ladder'])
        .catch((value: unknown) => value)

      expect(error).toBeInstanceOf(StartupCleanupFailedError)
      expect((error as StartupCleanupFailedError).report).toMatchObject({
        errorName: 'KernelRefusedError',
        ladder: { status: 'failed', errorName: 'KernelStopError' },
        bootstrap: { status: 'failed', errorName: 'KernelStopError' }
      })
      expect(await api.activeOffers()).toHaveLength(3)
    } finally {
      await handle.client.request({ method: 'anvil_dropAllTransactions' } as never)
      await handle.client.setAutomine(true)
      await handle.client.revert({ id: snapshot })
      await resetStateDirectory()
    }
  }, 240_000)

  test('uses a distinct delegated signer for offers, deauthorization, and cancellation', async () => {
    expect(anvil).toBeDefined()
    expect(api).toBeDefined()
    if (!anvil || !api) return

    const fillSnapshot = await anvil.client.snapshot()
    try {
      await setMakerAuthorization(anvil, DELEGATED_SIGNER.address, true)
      const config = ConfigService.from(delegatedEnvironment(anvil.rpcUrl, api.baseUrl))
      const bootstrap = await startWriter(
        anvil,
        config,
        { ladder: false, bootstrap: true },
        DELEGATED_SIGNER
      )

      expect(await bootstrap.steady('bootstrap')).toMatchObject([
        { status: 'applied', action: 'publish' }
      ])
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
      const bootstrap = await startWriter(
        anvil,
        config,
        { ladder: false, bootstrap: true },
        DELEGATED_SIGNER
      )
      expect(await bootstrap.steady('bootstrap')).toMatchObject([
        { status: 'applied', action: 'publish' }
      ])
      const published = await api.activeOffers()
      const offer = OfferUtils.toStruct({ offer: published[0]!.offer })

      await setMakerAuthorization(anvil, DELEGATED_SIGNER.address, false)
      await expect(takeMakerLend(anvil, api, 100_000_000n)).rejects.toBeDefined()

      await setMakerAuthorization(anvil, DELEGATED_SIGNER.address, true)
      // The quoting process ends; the operator's command is a later process over the same ledger.
      await Promise.all(writers.splice(0).map(engine => engine.abandon()))
      const enrolled = ConfigService.from({
        ...delegatedEnvironment(anvil.rpcUrl, api.baseUrl),
        KERNEL_ENROLLMENT: 'enrolled'
      })
      const invalidation = createOfferInvalidation(enrolled, {
        writer: {
          signer: DELEGATED_SIGNER.address,
          start: options =>
            startQuoterEngine({
              config: enrolled,
              strategies: { ladder: false, bootstrap: false },
              account: DELEGATED_SIGNER,
              journal: discardingJournal,
              ...options
            })
        }
      })
      await anvil.client.setBalance({ address: ANVIL_DEFAULT_ACCOUNT.address, value: 0n })
      await expect(invalidation.run({ groupId: offer.group })).resolves.toMatchObject({
        status: 'applied',
        invalidatedGroups: [{ groupId: offer.group, txHash: expect.any(String) }]
      })
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

  // Last in the suite: it moves the fork's clock to the borrowing cutoff.
  test('lets a borrowing sell be taken at its cutoff and leaves nothing to take one second later', async () => {
    expect(anvil).toBeDefined()
    expect(api).toBeDefined()
    if (!anvil || !api) return
    const snapshot = await anvil.client.snapshot()
    try {
      const head = await anvil.client.getBlock({ blockTag: 'latest' })
      const cutoff = head.timestamp + 600n
      const marketData = await createWalletClient({
        chain: base,
        transport: http(anvil.rpcUrl)
      })
        .extend(publicActions)
        .extend(morphoViemExtension({ supportSignature: true, supportDeployless: true }))
        .morpho.midnight(base.id)
        .getMarketData(MARKET_ID)
      const { tree } = buildLadderTree({
        quote: {
          marketId: MARKET_ID,
          centerRateBps: 500n,
          groupMode: 'shared-rung',
          lower: [{ index: 0, rateBps: 400n, assets: 1_000_000n }],
          higher: [],
          debtCapable: true
        },
        market: marketData,
        maker: ANVIL_TAKER_ACCOUNT.address,
        ratifier: ECRECOVER_RATIFIER,
        now: head.timestamp,
        minimumRateBps: 1n,
        maximumRateBps: 100_000n,
        debt: {
          maximumDebtUnits: 1_000_000n,
          stopBorrowingBeforeMaturitySeconds: Number(marketData.params.maturity - cutoff)
        }
      })
      expect(tree.offers.map(offer => [offer.reduceOnly, offer.expiry])).toEqual([[false, cutoff]])
      expect((await publishCollateralizedTree(anvil, tree)).status).toBe('success')
      const take = await prepareMakerBorrowTake(anvil, api, 500_000n)

      const atCutoff = await anvil.client.snapshot()
      await anvil.client.setNextBlockTimestamp({ timestamp: cutoff })
      const hash = await take.send()
      expect((await anvil.client.waitForTransactionReceipt({ hash })).status).toBe('success')
      await anvil.client.revert({ id: atCutoff })

      await anvil.client.setNextBlockTimestamp({ timestamp: cutoff + 1n })
      await anvil.client.mine({ blocks: 1 })
      const failure = await take.send().then(
        () => undefined,
        (error: unknown) => error
      )
      expect(failure).toBeInstanceOf(Error)
      // takeLend's bundle swallows each take's OfferExpired and reverts OutOfOffers when unfilled:
      // https://github.com/morpho-org/bundles/blob/main/src/midnight/MidnightBundlesV1.sol
      expect((failure as Error).message.toLowerCase()).toContain(
        toFunctionSelector('OutOfOffers()').slice(2)
      )
    } finally {
      await anvil.client.revert({ id: snapshot })
      await resetStateDirectory()
    }
  }, 180_000)
})
