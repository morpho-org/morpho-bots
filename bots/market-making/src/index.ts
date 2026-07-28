import { VersionService } from './application/version.service'
import { Cli } from './infrastructure/cli/cli'

const cli = new Cli(new VersionService())

try {
  console.log(cli.run(Bun.argv.slice(2)))
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
