import type { LoggerService } from '@nestjs/common'
import type { Logger } from '@repo/bot-kit'

// Bridges NestJS framework logs (router mapping, lifecycle, unhandled errors) into the bot-kit
// JSON-lines logger so every line the bot emits shares one structured format.
export class NestLoggerAdapter implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, context?: string) {
    this.logger.info('nest.log', { message: String(message), context })
  }

  error(message: unknown, trace?: string, context?: string) {
    this.logger.error('nest.error', { message: String(message), trace, context })
  }

  warn(message: unknown, context?: string) {
    this.logger.warn('nest.warn', { message: String(message), context })
  }

  debug(message: unknown, context?: string) {
    this.logger.debug('nest.debug', { message: String(message), context })
  }

  verbose(message: unknown, context?: string) {
    this.logger.debug('nest.verbose', { message: String(message), context })
  }
}
