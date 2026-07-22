import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { createHeartbeatMonitor, type Logger } from '@repo/bot-kit'
import { ensureError } from '@repo/utils'

import { AppModule } from './app.module'
import { ENV, type MonitorEnv } from './config/env'
import { LOGGER } from './logging/logger.provider'
import { NestLoggerAdapter } from './logging/nest-logger'

async function main() {
  // bufferLogs holds framework logs until useLogger swaps in the DI-provided bot-kit logger —
  // one logger instance per process (a second instance would double the BetterStack transport).
  // abortOnError: false lets a failed bootstrap reject into the structured startup.error path
  // below instead of Nest exiting on its own.
  const app = await NestFactory.create(AppModule, { bufferLogs: true, abortOnError: false })
  const logger = app.get<Logger>(LOGGER)
  app.useLogger(new NestLoggerAdapter(logger))
  app.enableShutdownHooks()
  const env = app.get<MonitorEnv>(ENV)
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
  // exit(1), not just exitCode: a failed bootstrap can leave started cron timers or sockets
  // keeping the event loop alive — a crash-looping container beats a zombie process.
  process.exit(1)
})
