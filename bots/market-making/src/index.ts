import { SetupFailedError } from './application/setup-failed.error'
import { createApplication } from './bootstrap'
import { formatSetupCheckReport } from './infrastructure/cli/cli.utils'

try {
  const application = createApplication()
  console.log(await application.run(Bun.argv.slice(2)))
} catch (error) {
  console.error(
    error instanceof SetupFailedError
      ? formatSetupCheckReport(error.report)
      : error instanceof Error
        ? error.message
        : error
  )
  process.exit(1)
}
