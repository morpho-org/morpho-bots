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
import { ResolverPrivateKeyRequiredError } from './config/resolver-private-key-required.error'
import { MatchingService } from './domain/matching.service'
import { createMorphoApiClient } from './infrastructure/morpho-api/client'
import { MorphoApiService } from './infrastructure/morpho-api/service'
import { ViemResolverEncoder } from './infrastructure/resolver/resolver.encoder'
import { ResolverExecutionService } from './infrastructure/resolver/resolver.service'
import { ViemResolverTransport } from './infrastructure/resolver/resolver.transport'
import { createRouterApiClient } from './infrastructure/router-api/client'
import { RouterApiService } from './infrastructure/router-api/service'

function resolverSelector() {
  const resolveAbi = getAbiItem({ abi: CrossedBooksResolver.abi, name: 'resolve' })
  if (!resolveAbi || resolveAbi.type !== 'function') throw new Error('resolve ABI is missing')
  return toFunctionSelector(resolveAbi)
}

/**
 * Composes the crossed-books resolver runtime for the selected environment mode.
 * @param environment - Runtime configuration and optional observability values.
 * @returns A lifecycle handle that polls immediately and then follows new blocks when started.
 * @throws `Error` when configuration is invalid or required contracts are not deployed.
 * @remarks Readonly composition creates no signer, pending transaction queue, or balance monitor;
 * both modes perform RPC deployment checks during composition.
 */
export async function createApplication(
  environment: Record<string, string | undefined> = process.env
) {
  const config = ConfigService.from(environment)
  const logger = createLogger('info', {
    context: {
      bot: 'midnight-crossed-books',
      chainId: config.chainId,
      ...railwayContext()
    }
  })
  const chainClient = createDeploylessClient(config)
  let sender = config.resolver
  let signer: ReturnType<typeof createSigner> | undefined
  let queue: ReturnType<typeof createPendingQueue> | undefined

  if (!config.readOnly) {
    const privateKey = config.privateKey
    if (!privateKey) throw new ResolverPrivateKeyRequiredError()
    signer = createSigner({
      chain: config.chain,
      rpcUrl: config.rpcUrl,
      rpcUrlFallback: config.rpcUrlFallback,
      privateKey,
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
    sender = signer.account.address
    queue = createPendingQueue({
      send: signer.send,
      getReceipt: signer.getReceipt,
      getBaseFee: signer.getBaseFee,
      syncNonce: signer.syncNonce,
      getConsumedNonce: signer.consumedNonce,
      maxFeeWei: config.maxFeeWei,
      logger
    })
  }

  await assertContractDeployed(chainClient, config.midnight, 'Midnight singleton')
  await assertContractDeployed(
    chainClient,
    config.resolver,
    'CrossedBooksResolver',
    'deploy it with `pnpm --filter @repo/contracts run deploy:crossed-books-resolver`'
  )

  const markets = new MorphoApiService(
    createMorphoApiClient(config.apiBaseUrl),
    config.chainId as 8453
  )
  const books = new RouterApiService(createRouterApiClient(config.routerApiBaseUrl))
  const matching = new MatchingService()
  const submission = queue && signer ? { queue, signer, maxFeeWei: config.maxFeeWei } : undefined
  const resolverTransport = new ViemResolverTransport(
    chainClient,
    sender,
    config.resolver,
    submission
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
    config.maxMatches,
    () => queue?.inflightLabels() ?? new Set(),
    config.readOnly,
    logger
  )
  const balance = signer
    ? createBalanceMonitor({ address: sender, read: signer.balance, logger })
    : undefined
  const heartbeat = createHeartbeatMonitor({
    url: environment.BETTERSTACK_HEARTBEAT_URL,
    logger
  })

  let nextScanAt = 0
  const runner = createRunner({
    getBlockNumber: () => getBlockNumber(chainClient),
    tick: async blockNumber => {
      if (Date.now() < nextScanAt || (queue?.size ?? 0) > 0) return
      nextScanAt = Date.now() + config.scanIntervalMs
      await bot.run({ blockNumber })
    },
    maintain: async blockNumber => {
      await queue?.onBlock(blockNumber)
      await balance?.maybeLog(blockNumber)
    },
    logger
  })

  return {
    async start() {
      logger.info('startup', {
        readOnly: config.readOnly,
        sender: config.readOnly ? undefined : sender,
        midnight: config.midnight,
        resolver: config.resolver,
        minimumProfit: config.minimumProfit,
        maxMatches: config.maxMatches
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
