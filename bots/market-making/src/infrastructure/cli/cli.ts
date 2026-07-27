import { Command, CommanderError } from 'commander'

import type { SetupCheckReport } from '../../application/setup-check.service'
import type { VersionService } from '../../application/version.service'

interface SetupReadinessService {
  assertReady(): Promise<SetupCheckReport>
}

export function formatSetupCheckReport(report: SetupCheckReport) {
  return JSON.stringify(report, (_, item) => (typeof item === 'bigint' ? item.toString() : item))
}

/** Infrastructure adapter: wires the `mm` CLI (commander) to application services. */
export class Cli {
  private readonly program: Command
  private output: string | undefined

  constructor(version: VersionService, setup: () => SetupReadinessService) {
    this.program = new Command()
      .name('mm')
      .description('Morpho market making bot CLI')
      .version(version.getVersion(), '-v, --version', 'output the current version')
      .exitOverride()
      .configureOutput({ writeOut: () => {}, writeErr: () => {} })

    this.program
      .command('setup-check')
      .description('run the read-only market-maker readiness checks')
      .action(async () => {
        this.output = formatSetupCheckReport(await setup().assertReady())
      })
  }

  async run(argv: readonly string[]): Promise<string> {
    if (argv.length === 0) throw new Error('Unknown command: (none)')
    this.output = undefined
    try {
      await this.program.parseAsync(argv, { from: 'user' })
    } catch (error) {
      if (error instanceof CommanderError && error.code === 'commander.version') {
        return error.message
      }
      if (error instanceof CommanderError) throw new Error(error.message, { cause: error })
      throw error
    }

    if (this.output !== undefined) return this.output
    throw new Error('Unknown command: (none)')
  }
}
