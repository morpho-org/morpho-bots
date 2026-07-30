import { Command, CommanderError } from 'commander'

import type { SetupCheckReport } from '../../application/setup/setup-check.service'
import type { VersionService } from '../../application/version.service'

import { PositionBootstrapHaltedError } from '../../application/bootstrap/position-bootstrap-halted.error'
import { LadderCycleHaltedError } from '../../application/ladder/ladder-cycle-halted.error'
import { CliUsageError } from './cli-usage.error'

interface SetupReadinessService {
  assertReady(): Promise<SetupCheckReport>
}

interface PositionBootstrapService {
  runOnce(): Promise<unknown>
}

interface LadderMarketMakerService {
  runOnce(): Promise<unknown>
}

/** CLI-selected runtime and configuration-file options. */
type CliConfigurationOptions = { configPath?: string; readOnly: boolean }

/** Infrastructure adapter: wires the `mm` CLI (commander) to application services. */
export class Cli {
  private readonly program: Command
  private output: unknown
  private hasOutput = false

  /**
   * Configures the version, address-only mode, setup-check, bootstrap, and ladder commands.
   * @param version - Application version provider.
   * @param setup - Lazy readiness-service factory, invoked only for `setup-check`.
   * @param bootstrap - Lazy position-bootstrap factory, invoked only for `bootstrap`.
   * @param ladder - Optional lazy ladder factory; omit it to keep `ladder` hidden until runtime
   * adapters are composed.
   * @remarks Construction performs no provider calls and does not start writer workflows. The
   * `--readonly` option is a positive Boolean flag and defaults to write-enabled configuration.
   */
  constructor(
    version: VersionService,
    setup: (
      options: CliConfigurationOptions
    ) => SetupReadinessService | Promise<SetupReadinessService>,
    bootstrap: (
      options: CliConfigurationOptions
    ) => PositionBootstrapService | Promise<PositionBootstrapService>,
    ladder?: (
      options: CliConfigurationOptions
    ) => LadderMarketMakerService | Promise<LadderMarketMakerService>
  ) {
    this.program = new Command()
      .name('mm')
      .description('Morpho market making bot CLI')
      .version(version.getVersion(), '-v, --version', 'output the current version')
      .option('-c, --config <path>', 'load configuration from an explicit .yaml or .yml file')
      .option('--readonly', 'use a maker address without signing or submitting offers')
      .exitOverride()
      .configureOutput({ writeOut: () => {}, writeErr: () => {} })

    this.program
      .command('setup-check')
      .description('run the read-only market-maker readiness checks')
      .action(async () => {
        const options = this.program.opts<{ config?: string; readonly?: boolean }>()
        const setupService = await setup({
          configPath: options.config,
          readOnly: options.readonly === true
        })
        this.output = await setupService.assertReady()
        this.hasOutput = true
      })

    this.program
      .command('bootstrap')
      .description('run one explicit market-maker position-bootstrap cycle')
      .action(async () => {
        const options = this.program.opts<{ config?: string; readonly?: boolean }>()
        const bootstrapService = await bootstrap({
          configPath: options.config,
          readOnly: options.readonly === true
        })
        const result = await bootstrapService.runOnce()
        if (
          Array.isArray(result) &&
          result.some(item =>
            typeof item === 'object' && item !== null && 'status' in item
              ? item.status === 'halted' || item.status === 'failed'
              : false
          )
        ) {
          throw new PositionBootstrapHaltedError(result)
        }
        this.output = result
        this.hasOutput = true
      })

    if (ladder) {
      this.program
        .command('ladder')
        .description('run one explicit market-maker ladder cycle')
        .action(async () => {
          const options = this.program.opts<{ config?: string; readonly?: boolean }>()
          const ladderService = await ladder({
            configPath: options.config,
            readOnly: options.readonly === true
          })
          const result = await ladderService.runOnce()
          if (
            Array.isArray(result) &&
            result.some(item =>
              typeof item === 'object' && item !== null && 'status' in item
                ? item.status === 'halted' || item.status === 'failed'
                : false
            )
          ) {
            throw new LadderCycleHaltedError(result)
          }
          this.output = result
          this.hasOutput = true
        })
    }
  }

  /**
   * Parses one CLI invocation and returns its captured output.
   * @param argv - User arguments without the executable/runtime prefix.
   * @returns Version text, the complete setup report, or a structured writer-cycle result.
   * @throws `CliUsageError` with a constant message and stable code on invalid usage; raw Commander
   * arguments, messages, option details, URLs, and causes are deliberately discarded. Provider and
   * readiness errors pass through.
   * @remarks `setup-check` remains read-only. Position bootstrap runs only for the explicit
   * `bootstrap` command. Ladder reconciliation runs only for the explicit `ladder` command. With
   * `--readonly`, configuration never loads a private key and make adapters suppress mutations.
   */
  async run(argv: readonly string[]): Promise<unknown> {
    if (argv.length === 0) throw new CliUsageError()
    this.output = undefined
    this.hasOutput = false
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

    if (this.hasOutput) return this.output
    throw new CliUsageError()
  }
}
