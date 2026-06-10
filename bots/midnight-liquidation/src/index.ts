import { ensureError } from '@repo/utils'
import { privateKeyToAccount } from 'viem/accounts'
import { getBlockNumber } from 'viem/actions'

import { createApiClient } from './api/client'
import { assertContractDeployed, createDeploylessClient } from './chain/client'
import { loadConfig } from './config'
import { createDaemon } from './daemon/daemon'
import { runTick } from './daemon/tick'
import { createPostgresQuery, discoverBorrowers } from './discovery/borrowers'
import { simulateLiquidate } from './execution/simulate'
import { readMidnightLiquidationLens } from './lens/lens.sol'
import { createLogger } from './logger'

async function main() {
  const config = loadConfig()
  const logger = createLogger(config.logLevel)
  const { address: liquidator } = privateKeyToAccount(config.liquidatorPrivateKey)

  logger.info('startup', {
    chainId: config.chainId,
    liquidator,
    callback: config.executooorAddress,
    midnight: config.midnight,
    apiUrl: config.midnightApiUrl
  })

  // Read-only client shared by the lens and simulate paths. Validate EXECUTOOOR_ADDRESS holds code
  // before doing any work — fatal on a typo / not-yet-deployed address (liveness, not identity).
  const client = createDeploylessClient(config)
  await assertContractDeployed(client, config.executooorAddress, 'EXECUTOOOR_ADDRESS')

  const apiClient = createApiClient(config.midnightApiUrl)
  const query = createPostgresQuery(config.databaseUrl)
  const discover = () => discoverBorrowers(query)

  // Phase-3 daemon: an HTTP block-poll watcher drives one read-only tick per new block (coalescing
  // backlog). The signed-send queue + graceful drain land in CRTR-2585; the daemon swallows tick
  // errors so a single bad tick never kills the loop.
  const tick = () =>
    runTick({
      apiClient,
      discover,
      chainId: config.chainId,
      caller: config.executooorAddress,
      readLens: pairs => readMidnightLiquidationLens(client, config.midnight, pairs),
      simulate: args =>
        simulateLiquidate(client, {
          midnight: config.midnight,
          executooor: config.executooorAddress,
          ...args
        }),
      logger
    })

  const daemon = createDaemon({ getBlockNumber: () => getBlockNumber(client), tick, logger })
  daemon.start()

  const shutdown = (signal: string) => {
    logger.info('shutdown', { signal })
    void daemon.stop().finally(() => process.exit(0))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch(error => {
  // Config/client never came up, so we cannot honor LOG_LEVEL — emit the failure directly, exit non-zero.
  console.error(
    JSON.stringify({ level: 'error', event: 'startup.error', error: ensureError(error).message })
  )
  process.exitCode = 1
})
