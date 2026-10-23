import type { ReportCommand } from '@repo/kernel'
import type { Logger } from '@repo/kit'
import type { Address } from 'viem'

import { MetaMorphoAction, metaMorphoAbi } from '@morpho-org/blue-sdk-viem'
import { runIdAt } from '@repo/controller'
import { GraphFailedError } from '@repo/engine'
import {
  buildIdentityFromEnv,
  assertContractDeployed,
  createBalanceMonitor,
  createDeploylessClient,
  createHeartbeatMonitor,
  createJournalFileSink,
  createLogger,
  TRANSACTION_KERNEL_RESERVATIONS,
  railwayContext,
  simulateCall,
  withLogging
} from '@repo/kit'
import { tryCatch } from '@repo/utils'
import { join } from 'node:path'
import { isAddressEqual } from 'viem'
import { getBalance, readContract } from 'viem/actions'

import { loadConfig } from './config'
import { reallocatorAccount, reallocatorKernel } from './kernel'
import { revertReason } from './revert.utils'
import { startReallocator } from './run'
import { createStrategy } from './strategies'
import { checkVaults } from './vault-checks'
import { fetchVaults } from './vault-data'

/** How long a prepared reallocation may wait for a reservation before it is simulated again. */
const PREPARE_VALID_MS = 30_000
/** A failed or refused reallocation waits this many blocks, doubling, before it is prepared again. */
const BACKOFF = { baseBlocks: 20, maxBlocks: 600 }

const JOURNAL_CAPACITY_BYTES = 16 * 1024 * 1024
const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const

async function superviseKernelBot(
  running: Readonly<{ stop: () => void; stopped: Promise<ReportCommand | undefined> }>,
  logger: Logger,
  describe: (error: unknown) => string
): Promise<0 | 1> {
  const shutdown = (signal: NodeJS.Signals) => {
    logger.info('shutdown', { signal })
    running.stop()
  }
  for (const signal of STOP_SIGNALS) process.on(signal, shutdown)
  const stopped = await tryCatch(running.stopped)
  for (const signal of STOP_SIGNALS) process.off(signal, shutdown)
  if (stopped.error) {
    const failed = stopped.error instanceof GraphFailedError ? stopped.error : undefined
    const report = failed?.stop as ReportCommand | undefined
    logger.error('runner.failed', {
      error: describe(failed ? failed.cause : stopped.error),
      ...(failed && { origin: failed.origin }),
      ...(report && { outcome: report.outcome, reason: report.reason, open: report.open })
    })
    return 1
  }
  if (!stopped.data) return 0
  const { outcome, reason, open } = stopped.data
  logger.info('kernel.stopped', { outcome, reason, open })
  return outcome === 'clean' ? 0 : 1
}

async function main() {
  const config = loadConfig()
  const logger = createLogger(config.logLevel, {
    context: { bot: 'vault-v1-reallocation', chainId: config.chainId, ...railwayContext() }
  })

  const account = reallocatorAccount(config)
  const eoa = account.address

  logger.info('startup', {
    reallocator: eoa,
    vaults: config.vaultWhitelist,
    strategy: config.strategy,
    intervalMs: config.reallocationIntervalMs,
    dryRun: config.dryRun
  })

  const client = createDeploylessClient({
    chain: config.chain,
    rpcUrl: config.rpcUrl,
    rpcUrlFallback: config.rpcUrlFallback
  })

  const isAllocator = (vault: Address) =>
    readContract(client, {
      address: vault,
      abi: metaMorphoAbi,
      functionName: 'isAllocator',
      args: [eoa]
    })

  await checkVaults(
    config.vaultWhitelist,
    {
      assertDeployed: vault => assertContractDeployed(client, vault, 'VAULT_WHITELIST entry'),
      readV1Surface: vault =>
        Promise.all([
          readContract(client, { address: vault, abi: metaMorphoAbi, functionName: 'asset' }),
          readContract(client, {
            address: vault,
            abi: metaMorphoAbi,
            functionName: 'withdrawQueueLength'
          })
        ]),
      // Vault V1's `onlyAllocatorRole` admits the allocator set plus the curator and the owner, so
      // a curator- or owner-keyed EOA must not be gated out.
      hasAllocatorRole: async vault => {
        const [allocator, owner, curator] = await Promise.all([
          isAllocator(vault),
          readContract(client, { address: vault, abi: metaMorphoAbi, functionName: 'owner' }),
          readContract(client, { address: vault, abi: metaMorphoAbi, functionName: 'curator' })
        ])
        return allocator || isAddressEqual(owner, eoa) || isAddressEqual(curator, eoa)
      }
    },
    logger
  )

  const balanceMonitor = createBalanceMonitor({
    address: eoa,
    read: () => getBalance(client, { address: eoa }),
    logger
  })
  using heartbeatMonitor = createHeartbeatMonitor({
    url: process.env.BETTERSTACK_HEARTBEAT_URL,
    logger
  })
  void heartbeatMonitor.start()
  const kernel = reallocatorKernel({ config, account, logger })
  const journal = await createJournalFileSink({
    directory: join(config.kernel.stateDirectory, 'journal'),
    graph: 'vault-v1-reallocation',
    build: buildIdentityFromEnv(process.env),
    capacityBytes: JOURNAL_CAPACITY_BYTES
  })
  const running = await startReallocator({
    journal: journal.journal,
    kernel: kernel.live,
    world: {
      vaults: config.vaultWhitelist,
      fetchVaults: (vaults, blockHash) =>
        withLogging(
          () => fetchVaults(client, vaults, { chainId: config.chainId, at: { blockHash }, eoa }),
          { logger: logger.layer, lens: 'vault-v1-reallocation' }
        )
    },
    strategy: createStrategy(config),
    eoa,
    prepare: {
      encode: allocations => MetaMorphoAction.reallocate([...allocations]),
      // A revert here (role revoked, cap exceeded, inconsistent legs, market removed) means do not
      // send; the kernel simulates the same bytes again at its own head before signing.
      simulate: (vault, data) => simulateCall(client, { eoa, to: vault, data }),
      dryRun: config.dryRun,
      validForMs: PREPARE_VALID_MS,
      now: Date.now
    },
    intervalMs: config.reallocationIntervalMs,
    backoff: BACKOFF,
    runId: runIdAt(Date.now()),
    maxReservations: TRANSACTION_KERNEL_RESERVATIONS,
    onHead: head => void balanceMonitor.maybeLog(BigInt(head.number)),
    feesOf: kernel.feesOf,
    logger
  })

  process.exitCode = await superviseKernelBot(running, logger, error => revertReason(error))
}

main().catch(error => {
  // Config/client never came up, so we cannot honor LOG_LEVEL — emit the failure directly.
  // revertReason, not error.message: a raw viem transport message can embed the RPC URL.
  console.error(
    JSON.stringify({ level: 'error', event: 'startup.error', error: revertReason(error) })
  )
  process.exitCode = 1
})
