import { ensureError } from '@repo/utils'
import { privateKeyToAccount } from 'viem/accounts'

import { loadConfig } from './config'
import { createLogger } from './logger'

const HEARTBEAT_MS = 60_000

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

  // Placeholder for daemon.start() (Phase 3 — CRTR-2583). Until the block-poll daemon lands,
  // a debug heartbeat holds the event loop open so the shutdown handlers below stay reachable.
  const heartbeat = setInterval(() => logger.debug('heartbeat'), HEARTBEAT_MS)

  const shutdown = (signal: string) => {
    logger.info('shutdown', { signal })
    clearInterval(heartbeat)
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
