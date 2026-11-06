import type { KernelHead } from '@repo/kernel'
import type { Address, Client, Hex } from 'viem'

import { CrossedBooksResolver } from '@repo/contracts'
import { runIdAt } from '@repo/controller'
import {
  assertContractDeployed,
  blocksFor,
  buildIdentityFromEnv,
  callAt,
  createBalanceMonitor,
  createDeploylessClient,
  createHeartbeatMonitor,
  createJournalFileSink,
  createLogger,
  parseJournalRunCapBytes
} from '@repo/kit'
import { join } from 'node:path'
import { isAddress, isAddressEqual } from 'viem'
import { getBalance, getBlock, readContract } from 'viem/actions'

import type { Config, WriteConfig } from './config'
import type { MarketId } from './domain/order-book'
import type { ScanDeps } from './sources'

import { loadConfig } from './config'
import { ResolverMismatchError } from './errors'
import { createMorphoApiClient } from './infrastructure/morpho-api/client'
import { MorphoApiService } from './infrastructure/morpho-api/service'
import { createRouterApiClient } from './infrastructure/router-api/client'
import { RouterApiService } from './infrastructure/router-api/service'
import { resolverAccount, resolverKernel } from './kernel'
import { runReadonly } from './readonly'
import { revertReason } from './revert.utils'
import { startResolver } from './run'
import { scanBooks } from './sources'
import { superviseKernelBot } from './supervise'

const JOURNAL_CAPACITY_BYTES = 16 * 1024 * 1024
/** One resolution at a time: a maker's group can back offers in several markets at once. */
const RESOLUTIONS_AT_ONCE = 1
const BACKOFF_BASE_MS = 4_000
const BACKOFF_MAX_MS = 128_000

type Scan = Omit<ScanDeps, 'logger'>

const scanFrom = (config: Config, client: Client, sender: Address): Scan => {
  const markets = new MorphoApiService(
    createMorphoApiClient(config.apiBaseUrl),
    config.chainId as 8453
  )
  const books = new RouterApiService(createRouterApiClient(config.routerApiBaseUrl))
  return {
    listMarkets: () => markets.listListedActiveMarkets(),
    getBook: (marketId: MarketId) => books.getTakeableBook(marketId),
    simulate: (data: Hex, at: KernelHead) =>
      callAt(client, at, { from: sender, to: config.resolver, data }),
    maxMatches: config.maxMatches,
    minimumProfit: config.minimumProfit
  }
}

/** The validator trusts `resolver` to be a `CrossedBooksResolver` for `midnight`: check both hold code and agree. */
const assertDeployed = async (config: Config, client: Client) => {
  await assertContractDeployed(client, config.midnight, 'Midnight singleton')
  await assertContractDeployed(
    client,
    config.resolver,
    'CrossedBooksResolver',
    'deploy it with `pnpm --filter @repo/contracts run deploy:crossed-books-resolver`'
  )
  const midnight = await readContract(client, {
    address: config.resolver,
    abi: CrossedBooksResolver.abi,
    functionName: 'MIDNIGHT'
  })
  if (
    typeof midnight !== 'string' ||
    !isAddress(midnight) ||
    !isAddressEqual(midnight, config.midnight)
  )
    throw new ResolverMismatchError()
}

const startupFields = (config: Config, sender: Address) => ({
  readOnly: config.mode.readOnly,
  sender,
  midnight: config.midnight,
  resolver: config.resolver,
  minimumProfit: config.minimumProfit,
  maxMatches: config.maxMatches
})

const readonly = async (config: Config, caller: Address) => {
  const logger = createLogger('info', {
    context: { bot: 'midnight-crossed-books', chainId: config.chainId }
  })
  logger.info('startup', startupFields(config, caller))
  const client = createDeploylessClient(config)
  await assertDeployed(config, client)
  const scan = scanFrom(config, client, caller)
  using heartbeat = createHeartbeatMonitor({ url: process.env.BETTERSTACK_HEARTBEAT_URL, logger })
  void heartbeat.start()
  const stopping = new AbortController()
  const stop = (signal: NodeJS.Signals) => {
    logger.info('shutdown', { signal })
    stopping.abort()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  await runReadonly({
    latest: async () => {
      const { number, hash } = await getBlock(client, { blockTag: 'latest' })
      return { number: Number(number), hash }
    },
    scan: at => scanBooks(at, { ...scan, logger }),
    everyMs: config.scanIntervalMs,
    signal: stopping.signal,
    logger
  })
  return 0
}

const write = async (config: Config, mode: WriteConfig) => {
  const build = buildIdentityFromEnv(process.env)
  const runCapBytes = parseJournalRunCapBytes(process.env.JOURNAL_RUN_CAP_BYTES)
  const logger = createLogger('info', {
    context: { bot: 'midnight-crossed-books', chainId: config.chainId, ...build }
  })
  const account = resolverAccount(mode)
  const sender = account.address
  logger.info('startup', startupFields(config, sender))
  const client = createDeploylessClient(config)
  await assertDeployed(config, client)
  const balanceMonitor = createBalanceMonitor({
    address: sender,
    read: () => getBalance(client, { address: sender }),
    logger,
    chain: config.chain
  })
  using heartbeat = createHeartbeatMonitor({ url: process.env.BETTERSTACK_HEARTBEAT_URL, logger })
  void heartbeat.start()
  const kernel = resolverKernel({ config, mode, account, logger })
  const journal = await createJournalFileSink({
    directory: join(mode.kernel.stateDirectory, 'journal'),
    graph: 'midnight-crossed-books',
    build,
    capacityBytes: JOURNAL_CAPACITY_BYTES,
    runCapBytes
  })
  logger.info('journal.pruned', journal.pruned)
  const running = await startResolver({
    journal: journal.journal,
    kernel: kernel.live,
    scan: scanFrom(config, client, sender),
    resolver: config.resolver,
    scanIntervalMs: config.scanIntervalMs,
    worldValidMs: config.worldValidMs,
    onHead: head => void balanceMonitor.maybeLog(BigInt(head.number)),
    backoff: {
      baseBlocks: blocksFor(BACKOFF_BASE_MS, config.chain),
      maxBlocks: blocksFor(BACKOFF_MAX_MS, config.chain)
    },
    runId: runIdAt(Date.now()),
    maxReservations: RESOLUTIONS_AT_ONCE,
    logger
  })
  return await superviseKernelBot(running, journal.runCapReached, logger)
}

const main = async () => {
  const config = loadConfig()
  const { mode } = config
  process.exitCode = mode.readOnly
    ? await readonly(config, mode.simulationCaller)
    : await write(config, mode)
}

main().catch(error => {
  // The logger may not exist yet, so the failure is written directly and the exit is non-zero.
  console.error(
    JSON.stringify({ level: 'error', event: 'startup.error', error: revertReason(error) })
  )
  process.exitCode = 1
})
