import type { Hex } from 'viem'

import { Command, CommanderError } from 'commander'

import type { BootstrapTransactionSubmittedEvent } from '../../application/bootstrap/position-bootstrap-verbose'
import type { PositionBootstrapMonitorReport } from '../../application/bootstrap/position-bootstrap.service'
import type {
  OfferInvalidationSuccessReport,
  OfferInvalidationTransactionSubmittedEvent
} from '../../application/invalidation/offer-invalidation.service'
import type { LadderMonitorReport } from '../../application/ladder/ladder-market-maker.service'
import type { LadderTransactionSubmittedEvent } from '../../application/ladder/ladder-verbose'
import type {
  SetupCheckMonitorReport,
  SetupCheckReport
} from '../../application/setup/setup-check.service'
import type { VersionService } from '../../application/version.service'

import { PositionBootstrapHaltedError } from '../../application/bootstrap/position-bootstrap-halted.error'
import { PositionBootstrapMonitorHaltedError } from '../../application/bootstrap/position-bootstrap-monitor-halted.error'
import { bootstrapCycleHasFailure } from '../../application/bootstrap/position-bootstrap-monitor.utils'
import { LadderCycleHaltedError } from '../../application/ladder/ladder-cycle-halted.error'
import { LadderMonitorHaltedError } from '../../application/ladder/ladder-monitor-halted.error'
import { ladderCycleHasFailure } from '../../application/ladder/ladder-monitor.utils'
import { SetupMonitorHaltedError } from '../../application/setup/setup-monitor-halted.error'
import { CliUsageError } from './cli-usage.error'
import { offerInvalidationGroup } from './offer-invalidation-group.utils'

interface SetupReadinessService {
  assertReady(): Promise<SetupCheckReport>
  runContinuously?(parameters: {
    signal: AbortSignal
    onCycle?: (report: SetupCheckReport) => void | Promise<void>
  }): Promise<SetupCheckMonitorReport>
}

interface PositionBootstrapService {
  runOnce(parameters?: {
    verbose?: boolean
    onTransactionSubmitted?: (event: BootstrapTransactionSubmittedEvent) => void | Promise<void>
  }): Promise<readonly { status: string; [key: string]: unknown }[]>
  runContinuously?(parameters: {
    signal: AbortSignal
    onCycle?: (
      result: readonly { status: string; [key: string]: unknown }[]
    ) => void | Promise<void>
    verbose?: boolean
    onTransactionSubmitted?: (event: BootstrapTransactionSubmittedEvent) => void | Promise<void>
  }): Promise<PositionBootstrapMonitorReport>
}

interface LadderMarketMakerService {
  runOnce(parameters?: {
    verbose?: boolean
    onTransactionSubmitted?: (event: LadderTransactionSubmittedEvent) => void | Promise<void>
  }): Promise<readonly { status: string }[]>
  runContinuously?(parameters: {
    signal: AbortSignal
    onCycle?: (result: readonly { status: string }[]) => void | Promise<void>
    verbose?: boolean
    onTransactionSubmitted?: (event: LadderTransactionSubmittedEvent) => void | Promise<void>
  }): Promise<LadderMonitorReport>
}

interface OfferInvalidationService {
  run(parameters?: {
    groupId?: Hex
    onTransactionSubmitted?: (
      event: OfferInvalidationTransactionSubmittedEvent
    ) => void | Promise<void>
  }): Promise<OfferInvalidationSuccessReport>
}

/** CLI-selected runtime and configuration-file options. */
type CliConfigurationOptions = {
  configPath?: string
  readOnly: boolean
  writeEvent?: (value: unknown) => void | Promise<void>
}

/** Per-invocation process signal and JSON-compatible continuous-event writer. */
export type CliRuntimeOptions = {
  /** Requests graceful monitoring shutdown without interrupting an in-flight cycle. */
  signal?: AbortSignal
  /** Receives every completed monitoring cycle before the final lifecycle report. */
  writeEvent?: (value: unknown) => void | Promise<void>
}

/** Infrastructure adapter: wires the `mm` CLI (commander) to application services. */
export class Cli {
  private readonly program: Command
  private output: unknown
  private hasOutput = false
  private runtime: CliRuntimeOptions = {}

  /**
   * Configures the version, address-only mode, setup-check, bootstrap, ladder, and invalidation commands.
   * @param version - Application version provider.
   * @param setup - Lazy readiness-service factory, invoked only for `setup-check`.
   * @param bootstrap - Lazy position-bootstrap factory, invoked only for `bootstrap`.
   * @param ladder - Lazy production or test ladder-service factory.
   * @param invalidation - Optional lazy all-groups or one-group invalidation factory.
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
    ladder: (
      options: CliConfigurationOptions
    ) => LadderMarketMakerService | Promise<LadderMarketMakerService>,
    invalidation?: (
      options: CliConfigurationOptions
    ) => OfferInvalidationService | Promise<OfferInvalidationService>
  ) {
    this.program = new Command()
      .name('mm')
      .description('Morpho market making bot CLI')
      .version(version.getVersion(), '-v, --version', 'output the current version')
      .option('-c, --config <path>', 'load configuration from an explicit .yaml or .yml file')
      .option('--json', 'emit machine-parseable JSON Lines instead of human-readable output')
      .option('--readonly', 'use a maker address without signing or submitting transactions')
      .exitOverride()
      .configureOutput({ writeOut: () => {}, writeErr: () => {} })

    const setupCommand = this.program
      .command('setup-check')
      .description('run market-maker readiness checks once or monitor continuously')
      .option('--monitor', 'repeat readiness checks every minute until shutdown')

    setupCommand.action(async () => {
      const options = this.program.opts<{ config?: string; readonly?: boolean }>()
      const setupOptions = setupCommand.opts<{ monitor?: boolean }>()
      const setupService = await setup({
        configPath: options.config,
        readOnly: options.readonly === true,
        writeEvent: this.runtime.writeEvent
      })
      if (setupOptions.monitor === true) {
        if (!setupService.runContinuously) throw new CliUsageError()
        const result = await setupService.runContinuously({
          signal: this.runtime.signal ?? new AbortController().signal,
          onCycle: report => this.runtime.writeEvent?.(report)
        })
        if (result.status === 'halted') throw new SetupMonitorHaltedError(result)
        this.output = result
        this.hasOutput = true
        return
      }

      this.output = await setupService.assertReady()
      this.hasOutput = true
    })

    const bootstrapCommand = this.program
      .command('bootstrap')
      .description('run one position-bootstrap cycle or monitor continuously')
      .option('--monitor', 'repeat every minute and clean up owned offers on shutdown')
      .option(
        '--verbose',
        'show config, rates, offers, balances, exposures, and transaction hashes'
      )

    bootstrapCommand.action(async () => {
      const options = this.program.opts<{ config?: string; readonly?: boolean }>()
      const bootstrapOptions = bootstrapCommand.opts<{ monitor?: boolean; verbose?: boolean }>()
      const bootstrapService = await bootstrap({
        configPath: options.config,
        readOnly: options.readonly === true,
        writeEvent: this.runtime.writeEvent
      })
      if (bootstrapOptions.monitor === true) {
        if (!bootstrapService.runContinuously) throw new CliUsageError()
        const result = await bootstrapService.runContinuously({
          signal: this.runtime.signal ?? new AbortController().signal,
          onCycle: cycle => this.runtime.writeEvent?.(cycle),
          verbose: bootstrapOptions.verbose === true,
          onTransactionSubmitted:
            bootstrapOptions.verbose === true
              ? event => this.runtime.writeEvent?.(event)
              : undefined
        })
        if (result.status === 'halted') {
          throw new PositionBootstrapMonitorHaltedError(result)
        }
        this.output = result
        this.hasOutput = true
        return
      }

      const result = await bootstrapService.runOnce({
        verbose: bootstrapOptions.verbose === true,
        onTransactionSubmitted:
          bootstrapOptions.verbose === true ? event => this.runtime.writeEvent?.(event) : undefined
      })
      if (Array.isArray(result) && bootstrapCycleHasFailure(result)) {
        throw new PositionBootstrapHaltedError(result)
      }
      this.output = result
      this.hasOutput = true
    })

    const ladderCommand = this.program
      .command('ladder')
      .description('run one market-maker ladder cycle or monitor continuously')
      .option('--monitor', 'repeat at the configured cadence and clean up owned offers on shutdown')
      .option(
        '--verbose',
        'show config, rates, ladder offers, capacities, state, and transaction hashes'
      )

    ladderCommand.action(async () => {
      const options = this.program.opts<{ config?: string; readonly?: boolean }>()
      const ladderOptions = ladderCommand.opts<{ monitor?: boolean; verbose?: boolean }>()
      const ladderService = await ladder({
        configPath: options.config,
        readOnly: options.readonly === true,
        writeEvent: this.runtime.writeEvent
      })
      if (ladderOptions.monitor === true) {
        if (!ladderService.runContinuously) throw new CliUsageError()
        const result = await ladderService.runContinuously({
          signal: this.runtime.signal ?? new AbortController().signal,
          onCycle: cycle => this.runtime.writeEvent?.(cycle),
          verbose: ladderOptions.verbose === true,
          onTransactionSubmitted:
            ladderOptions.verbose === true ? event => this.runtime.writeEvent?.(event) : undefined
        })
        if (result.status === 'halted') {
          throw new LadderMonitorHaltedError(result)
        }
        this.output = result
        this.hasOutput = true
        return
      }

      const result = await ladderService.runOnce({
        verbose: ladderOptions.verbose === true,
        onTransactionSubmitted:
          ladderOptions.verbose === true ? event => this.runtime.writeEvent?.(event) : undefined
      })
      if (ladderCycleHasFailure(result)) {
        throw new LadderCycleHaltedError(result)
      }
      this.output = result
      this.hasOutput = true
    })

    const invalidateCommand = this.program
      .command('invalidate')
      .description('invalidate all active maker offer groups or one explicit group')
      .argument('[group-id]', 'optional 0x-prefixed bytes32 offer-group ID')

    invalidateCommand.action(async (rawGroupId?: string) => {
      if (!invalidation) throw new CliUsageError()
      const groupId = offerInvalidationGroup(rawGroupId)
      const options = this.program.opts<{ config?: string; readonly?: boolean }>()
      const invalidationService = await invalidation({
        configPath: options.config,
        readOnly: options.readonly === true,
        writeEvent: this.runtime.writeEvent
      })
      this.output = await invalidationService.run({
        groupId,
        onTransactionSubmitted: event => this.runtime.writeEvent?.(event)
      })
      this.hasOutput = true
    })
  }

  /**
   * Parses one CLI invocation and returns its captured output.
   * @param argv - User arguments without the executable/runtime prefix.
   * @param runtime - Optional graceful-shutdown signal and continuous-cycle event writer.
   * @returns Version text, a complete setup report, or a structured writer or invalidation result.
   * @throws `CliUsageError` with a constant message and stable code on invalid usage; raw Commander
   * arguments, messages, option details, URLs, and causes are deliberately discarded. Provider and
   * readiness errors pass through.
   * @remarks `setup-check` remains read-only. `setup-check --monitor` streams non-overlapping
   * readiness reports until shutdown or failed readiness without writes. A failed monitor report
   * exits through `SetupMonitorHaltedError`. Position bootstrap runs only for the explicit
   * `bootstrap` command;
   * `bootstrap --monitor` repeats at the fixed bootstrap cadence and performs strategy cleanup
   * after its signal. `bootstrap --verbose` adds safe configuration, rate, offer, position, and
   * transaction-hash diagnostics. Ladder reconciliation runs only for the explicit `ladder`
   * command; `ladder --monitor` repeats at the shortest configured cadence and cleans owned ladder
   * groups after shutdown, while `ladder --verbose` adds safe configuration, rate, quote, state,
   * and transaction diagnostics. `invalidate` cancels all active maker groups, while
   * `invalidate <group-id>` directly targets one group and streams each submitted hash. With
   * `--readonly`, including when placed after subcommand options, configuration never loads a
   * private key and mutation adapters emit observational results.
   */
  async run(argv: readonly string[], runtime: CliRuntimeOptions = {}): Promise<unknown> {
    if (argv.length === 0) throw new CliUsageError()
    this.output = undefined
    this.hasOutput = false
    this.runtime = runtime
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
