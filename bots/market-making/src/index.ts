import { createApplication } from './bootstrap'
import { runMarketMakingEntrypoint } from './infrastructure/cli/market-making-entrypoint'
import {
  createMarketMakingObservability,
  enhanceMarketMakingArgv,
  installMarketMakingProcessObservers
} from './infrastructure/observability/market-making-observability'

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

const observability = createMarketMakingObservability()
const removeProcessObservers = installMarketMakingProcessObservers(observability)
await observability.start()

try {
  process.exitCode = await runMarketMakingEntrypoint(
    createApplication(),
    enhanceMarketMakingArgv(Bun.argv.slice(2), Bun.env),
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
