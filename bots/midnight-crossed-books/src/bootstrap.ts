import {
  assertContractDeployed,
  createBalanceMonitor,
  createDeploylessClient,
  createHeartbeatMonitor,
  createLogger,
  createPendingQueue,
  createRunner,
  createSigner,
  DEFAULT_MAX_DATA_BYTES,
  DEFAULT_MAX_GAS_LIMIT,
  railwayContext
} from '@repo/bot-kit'
import { CrossedBooksResolver } from '@repo/contracts'
import { getAbiItem, toFunctionSelector } from 'viem'
import { getBlockNumber } from 'viem/actions'

import { CrossedBooksBotService } from './application/crossed-books-bot.service'
import { ConfigService } from './config/config.service'
import { MatchingService } from './domain/matching.service'
import { createMorphoApiClient } from './infrastructure/morpho-api/client'
import { MorphoApiService } from './infrastructure/morpho-api/service'
import { createRouterApiClient } from './infrastructure/router-api/client'
import { RouterApiService } from './infrastructure/router-api/service'
import { ResolverExecutionService } from './infrastructure/resolver/resolver.service'
import { ViemResolverEncoder } from './infrastructure/resolver/resolver.encoder'
import { ViemResolverTransport } from './infrastructure/resolver/resolver.transport'

function resolverSelector() {
  const resolveAbi = getAbiItem({ abi: CrossedBooksResolver.abi, name: 'resolve' })
  if (!resolveAbi || resolveAbi.type !== 'function') throw new Error('resolve ABI is missing')
  return toFunctionSelector(resolveAbi)
}

export async function createApplication(environment: Record<string, string | undefined> = Bun.env) {
  const config = ConfigService.from(environment)
  const logger = createLogger('info', {
    context: {
      bot: 'midnight-crossed-books',
      chainId: config.chainId,
      ...railwayContext()
    }
  })
  const signer = createSigner({
    chain: config.chain,
    rpcUrl: config.rpcUrl,
    rpcUrlFallback: config.rpcUrlFallback,
    privateKey: config.privateKey,
    policy: {
      chainId: config.chainId,
      executor: config.resolver,
      selector: resolverSelector(),
      maxFeePerGasWei: config.maxFeeWei,
      maxGasLimit: DEFAULT_MAX_GAS_LIMIT,
      maxDataBytes: DEFAULT_MAX_DATA_BYTES
    },
    logger
  })
  const sender = signer.account.address
  const chainClient = createDeploylessClient(config)

  await assertContractDeployed(chainClient, config.midnight, 'Midnight singleton')
  await assertContractDeployed(
    chainClient,
    config.resolver,
    'CrossedBooksResolver',
    'deploy it with `bun run --filter @repo/contracts deploy:crossed-books-resolver`'
  )

  const queue = createPendingQueue({
    send: signer.send,
    getReceipt: signer.getReceipt,
    getBaseFee: signer.getBaseFee,
    syncNonce: signer.syncNonce,
    getConsumedNonce: signer.consumedNonce,
    maxFeeWei: config.maxFeeWei,
    logger
  })
  const markets = new MorphoApiService(
    createMorphoApiClient(config.apiBaseUrl),
    config.chainId as 8453
  )
  const books = new RouterApiService(createRouterApiClient(config.routerApiBaseUrl))
  const matching = new MatchingService()
  const resolverTransport = new ViemResolverTransport(
    chainClient,
    sender,
    config.resolver,
    queue,
    signer,
    config.maxFeeWei
  )
  const resolver = new ResolverExecutionService(
    resolverTransport,
    new ViemResolverEncoder(),
    config.minimumProfit
  )
  const bot = new CrossedBooksBotService(
    markets,
    books,
    matching,
    resolver,
    () => queue.inflightLabels(),
    logger
  )
  const balance = createBalanceMonitor({ address: sender, read: signer.balance, logger })
  const heartbeat = createHeartbeatMonitor({
    url: environment.BETTERSTACK_HEARTBEAT_URL,
    logger
  })

  let nextScanAt = 0
  const runner = createRunner({
    getBlockNumber: () => getBlockNumber(chainClient),
    tick: async blockNumber => {
      if (Date.now() < nextScanAt || queue.size > 0) return
      nextScanAt = Date.now() + config.scanIntervalMs
      await bot.run({ blockNumber })
    },
    maintain: async blockNumber => {
      await queue.onBlock(blockNumber)
      await balance.maybeLog(blockNumber)
    },
    logger
  })

  return {
    async start() {
      logger.info('startup', {
        sender,
        midnight: config.midnight,
        resolver: config.resolver,
        minimumProfit: config.minimumProfit
      })
      void heartbeat.start()
      await runner.poll()
      runner.start()
    },
    async stop() {
      await runner.stop()
      heartbeat.stop()
    }
  }
}
