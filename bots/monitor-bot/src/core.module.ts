import { Global, Module } from '@nestjs/common'

import { ENV, envProvider } from './config/env'
import { LOGGER, loggerProvider } from './logging/logger.provider'

// Global so every feature module can inject ENV and LOGGER without importing this module
// explicitly — there is exactly one env snapshot and one logger instance per process.
@Global()
@Module({
  providers: [envProvider, loggerProvider],
  exports: [ENV, LOGGER]
})
export class CoreModule {}
