import { Command, CommanderError } from 'commander'

import type { SetupCheckReport } from '../../application/setup-check.service'
import type { VersionService } from '../../application/version.service'

import { CliUsageError } from './cli-usage.error'
import { formatCliResult, formatSetupCheckReport } from './cli.utils'

interface SetupReadinessService {
  assertReady(): Promise<SetupCheckReport>
}

interface PositionBootstrapService {
  runOnce(): Promise<unknown>
}

/** CLI-selected configuration file, if the operator bypasses default discovery. */
type CliConfigurationOptions = { configPath?: string }

/** Infrastructure adapter: wires the `mm` CLI (commander) to application services. */
export class Cli {
  private readonly program: Command
  private output: string | undefined

  /**
   * Configures the version, setup-check, and explicit bootstrap commands.
   * @param version - Application version provider.
   * @param setup - Lazy readiness-service factory, invoked only for `setup-check`.
   * @param bootstrap - Lazy position-bootstrap factory, invoked only for `bootstrap`.
   * @remarks Construction performs no provider calls and does not start writer workflows.
   */
  constructor(
    version: VersionService,
    setup: (
      options: CliConfigurationOptions
    ) => SetupReadinessService | Promise<SetupReadinessService>,
    bootstrap: (
      options: CliConfigurationOptions
    ) => PositionBootstrapService | Promise<PositionBootstrapService>
  ) {
    this.program = new Command()
      .name('mm')
      .description('Morpho market making bot CLI')
      .version(version.getVersion(), '-v, --version', 'output the current version')
      .option('-c, --config <path>', 'load configuration from an explicit .yaml or .yml file')
      .exitOverride()
      .configureOutput({ writeOut: () => {}, writeErr: () => {} })

    this.program
      .command('setup-check')
      .description('run the read-only market-maker readiness checks')
      .action(async () => {
        const options = this.program.opts<{ config?: string }>()
        const setupService = await setup({ configPath: options.config })
        this.output = formatSetupCheckReport(await setupService.assertReady())
      })

    this.program
      .command('bootstrap')
      .description('run one explicit market-maker position-bootstrap cycle')
      .action(async () => {
        const options = this.program.opts<{ config?: string }>()
        const bootstrapService = await bootstrap({ configPath: options.config })
        this.output = formatCliResult(await bootstrapService.runOnce())
      })
  }

  /**
   * Parses one CLI invocation and returns its captured output.
   * @param argv - User arguments without the executable/runtime prefix.
   * @returns Version text, the serialized complete setup report, or the serialized bootstrap result.
   * @throws `CliUsageError` with a constant message and stable code on invalid usage; raw Commander
   * arguments, messages, option details, URLs, and causes are deliberately discarded. Provider and
   * readiness errors pass through.
   * @remarks `setup-check` remains read-only. Position bootstrap runs only for the explicit
   * `bootstrap` command; parsing or invoking any other command cannot start it.
   */
  async run(argv: readonly string[]): Promise<string> {
    if (argv.length === 0) throw new CliUsageError()
    this.output = undefined
    try {
      await this.program.parseAsync(argv, { from: 'user' })
    } catch (error) {
      if (error instanceof CommanderError && error.code === 'commander.version') {
        return error.message
      }
      if (error instanceof CommanderError) {
        throw new CliUsageError()
      }
      throw error
    }

    if (this.output !== undefined) return this.output
    throw new CliUsageError()
  }
}
