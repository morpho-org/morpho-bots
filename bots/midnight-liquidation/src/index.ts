import { ensureError } from '@repo/utils'
import { privateKeyToAccount } from 'viem/accounts'

import { createApiClient } from './api/client'
import { loadConfig } from './config'
import { runDryRunTick } from './daemon/tick'
import { createPostgresQuery, discoverBorrowers } from './discovery/borrowers'
import { createLogger } from './logger'

const TICK_INTERVAL_MS = 60_000

function main() {
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

  const apiClient = createApiClient(config.midnightApiUrl)
  const query = createPostgresQuery(config.databaseUrl)
  const discover = () => discoverBorrowers(query)

  // Phase-1 dry-run: one tick on boot, then on an interval. The Phase-3 daemon (CRTR-2583) replaces
  // this with a block-poll loop that coalesces backlog and owns the queue.
  const tick = () => {
    logger.info('tick.begin', {})
    void runDryRunTick({ apiClient, discover, chainId: config.chainId, logger }).catch(error =>
      logger.error('tick.error', { error: ensureError(error).message })
    )
  }
  const timer = setInterval(tick, TICK_INTERVAL_MS)
  tick()

  const shutdown = (signal: string) => {
    logger.info('shutdown', { signal })
    clearInterval(timer)
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

try {
  main()
} catch (error) {
  // Config never loaded, so we cannot honor LOG_LEVEL — emit the failure directly and exit non-zero.
  console.error(
    JSON.stringify({ level: 'error', event: 'startup.error', error: ensureError(error).message })
  )
  process.exitCode = 1
}
