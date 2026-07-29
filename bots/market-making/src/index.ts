import { createApplication } from './bootstrap'
import { runMarketMakingEntrypoint } from './infrastructure/cli/market-making-entrypoint'

// oxlint-disable-next-line eslint/no-extend-native -- CLI root policy requested by maintainers.
Object.defineProperty(BigInt.prototype, 'toJSON', {
  configurable: true,
  value(this: bigint) {
    return this.toString()
  }
})

process.exitCode = await runMarketMakingEntrypoint(createApplication(), Bun.argv.slice(2), {
  writeOut: value => console.log(value),
  writeError: value => console.error(value)
})
