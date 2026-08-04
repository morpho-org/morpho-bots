import {
  createBotObservability,
  enhanceVerboseArgv,
  installProcessObservers
} from '@repo/observability'

import { operatorErrorName } from './application/operator-error-name.utils'
import { createApplication } from './bootstrap'
import { BASE_CHAIN_ID } from './config/config.utils'
import {
  MARKET_MAKING_VERBOSE_COMMANDS,
  runMarketMakingEntrypoint
} from './infrastructure/cli/market-making-entrypoint'

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
  bot: 'market-making',
  chainId: BASE_CHAIN_ID,
  errorName: operatorErrorName
})
const removeProcessObservers = installProcessObservers(observability)
await observability.start()

try {
  process.exitCode = await runMarketMakingEntrypoint(
    createApplication(),
    enhanceVerboseArgv(Bun.argv.slice(2), {
      commands: MARKET_MAKING_VERBOSE_COMMANDS,
      env: Bun.env
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
