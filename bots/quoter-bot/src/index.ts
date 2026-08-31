import {
  createBotObservability,
  enhanceVerboseArgv,
  installProcessObservers
} from '@repo/observability'

import { operatorErrorName } from './application/operator-error-name.utils'
import { createApplication } from './bootstrap'
import { observabilityChainId } from './config/supported-chains.utils'
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

// Resolved once so the observability record and its monitoring logger always report the same
// chain; both used to be pinned to Base.
const chainId = observabilityChainId(process.env)

const observability = createBotObservability({
  bot: 'quoter-bot',
  chainId,
  errorName: operatorErrorName,
  logger: createMonitoringLogger({ bot: 'quoter-bot', chainId })
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
