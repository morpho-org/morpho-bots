import { VersionService } from './application/version.service'
import { Cli } from './infrastructure/cli/cli'

const cli = new Cli(new VersionService())
console.log(cli.run(Bun.argv.slice(2)))
