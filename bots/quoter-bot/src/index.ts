import {
  createBotObservability,
  enhanceVerboseArgv,
  installProcessObservers
} from '@repo/observability'

import { operatorErrorName } from './application/operator-error-name.utils'
import { createApplication } from './bootstrap'
import { BASE_CHAIN_ID } from './config/config.utils'
import {
  QUOTER_BOT_VERBOSE_COMMANDS,
  runQuoterBotEntrypoint
} from './infrastructure/cli/quoter-bot-entrypoint'
import { createMonitoringLogger } from './infrastructure/observability/monitoring-logger.utils'

// oxlint-disable-next-line eslint/no-extend-native -- CLI root policy requested by maintainers.
Object.defineProperty(BigInt.prototype, 'toJSON', {
  configurable: true,
  value(this: bigint) {
    return this.toString()
  }
})

const shutdown = new AbortController()
const requestShutdown = () => shutdown.abort()
process.once('SIGINT', requestShutdown)
process.once('SIGTERM', requestShutdown)

const observability = createBotObservability({
  bot: 'quoter-bot',
  chainId: BASE_CHAIN_ID,
  errorName: operatorErrorName,
  logger: createMonitoringLogger({ bot: 'quoter-bot', chainId: BASE_CHAIN_ID })
})
const removeProcessObservers = installProcessObservers(observability)
await observability.start()

try {
  process.exitCode = await runQuoterBotEntrypoint(
    createApplication(),
    enhanceVerboseArgv(process.argv.slice(2), {
      commands: QUOTER_BOT_VERBOSE_COMMANDS,
      env: process.env
    }),
    {
      writeOut: value => console.log(value),
      writeError: value => console.error(value)
    },
    { signal: shutdown.signal },
    observability
  )
} finally {
  observability.stop(process.exitCode === 0 ? 'completed' : 'failed')
  removeProcessObservers()
  process.removeListener('SIGINT', requestShutdown)
  process.removeListener('SIGTERM', requestShutdown)
}
