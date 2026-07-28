import { SetupFailedError } from './application/setup-failed.error'
import { createApplication } from './bootstrap'

// oxlint-disable-next-line eslint/no-extend-native -- CLI root policy requested by maintainers.
Object.defineProperty(BigInt.prototype, 'toJSON', {
  configurable: true,
  value(this: bigint) {
    return this.toString()
  }
})

try {
  const application = createApplication()
  const result = await application.run(Bun.argv.slice(2))
  console.log(typeof result === 'string' ? result : JSON.stringify(result))
} catch (error) {
  console.error(
    error instanceof SetupFailedError
      ? JSON.stringify(error.report)
      : error instanceof Error
        ? error.message
        : error
  )
  process.exit(1)
}
