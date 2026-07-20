import type { Provider } from '@nestjs/common'

import { createLogger, railwayContext } from '@repo/bot-kit'

import { ENV, type MonitorEnv } from '../config/env'

export const LOGGER = Symbol('LOGGER')

export const loggerProvider: Provider = {
  provide: LOGGER,
  useFactory: (env: MonitorEnv) =>
    createLogger(env.LOG_LEVEL, { context: { bot: 'monitor-bot', ...railwayContext() } }),
  inject: [ENV]
}
