import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { createHeartbeatMonitor, createLogger, railwayContext } from '@repo/bot-kit'
import { ensureError } from '@repo/utils'

import { AppModule } from './app.module'
import { loadEnv } from './config/env'
import { NestLoggerAdapter } from './logging/nest-logger'

async function main() {
  const env = loadEnv()
  const logger = createLogger(env.LOG_LEVEL, {
    context: { bot: 'monitor-bot', ...railwayContext() }
  })
  const app = await NestFactory.create(AppModule, { logger: new NestLoggerAdapter(logger) })
  app.enableShutdownHooks()
  await app.listen(env.PORT)
  logger.info('startup.listening', { port: env.PORT })

  // Opt-in BetterStack uptime heartbeat — inert when the URL is unset.
  const heartbeat = createHeartbeatMonitor({ url: process.env.BETTERSTACK_HEARTBEAT_URL, logger })
  await heartbeat.start()
}

main().catch(error => {
  // Raw JSON because the logger may not exist yet if startup failed while loading config.
  console.error(
    JSON.stringify({ level: 'error', event: 'startup.error', error: ensureError(error).message })
  )
  process.exitCode = 1
})
