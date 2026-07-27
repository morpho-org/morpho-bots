import { SetupCheckError } from './application/setup-check.service'
import { createApplication } from './bootstrap'
import { formatSetupCheckReport } from './infrastructure/cli/cli'

try {
  const application = createApplication()
  console.log(await application.run(Bun.argv.slice(2)))
} catch (error) {
  console.error(
    error instanceof SetupCheckError
      ? formatSetupCheckReport(error.report)
      : error instanceof Error
        ? error.message
        : error
  )
  process.exit(1)
}
