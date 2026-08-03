import { createApplication } from './bootstrap'
import { runMarketMakingEntrypoint } from './infrastructure/cli/market-making-entrypoint'

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

try {
  process.exitCode = await runMarketMakingEntrypoint(
    createApplication(),
    Bun.argv.slice(2),
    {
      writeOut: value => console.log(value),
      writeError: value => console.error(value)
    },
    { signal: shutdown.signal }
  )
} finally {
  process.removeListener('SIGINT', requestShutdown)
  process.removeListener('SIGTERM', requestShutdown)
}
