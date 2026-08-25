import type { Hex } from 'viem'

import { cycleHasFailure } from '@repo/monitoring'
import { Command, CommanderError } from 'commander'

import type { BootstrapTransactionSubmittedEvent } from '../../application/bootstrap/position-bootstrap-verbose'
import type { PositionBootstrapMonitorReport } from '../../application/bootstrap/position-bootstrap.service'
import type {
  OfferInvalidationSuccessReport,
  OfferInvalidationTransactionSubmittedEvent
} from '../../application/invalidation/offer-invalidation.service'
import type { LadderMonitorReport } from '../../application/ladder/ladder-quoter.service'
import type { LadderTransactionSubmittedEvent } from '../../application/ladder/ladder-verbose'
import type { MonitoringProjection } from '../../application/monitoring/monitoring-projection.utils'
import type {
  QuoterBotEvent,
  QuoterBotMonitorReport
} from '../../application/quoter-bot/quoter-bot.service'
import type {
  SetupCheckMonitorReport,
  SetupCheckReport
} from '../../application/setup/setup-check.service'
import type { VersionService } from '../../application/version.service'

import { PositionBootstrapHaltedError } from '../../application/bootstrap/position-bootstrap-halted.error'
import { PositionBootstrapMonitorHaltedError } from '../../application/bootstrap/position-bootstrap-monitor-halted.error'
import { LadderCycleHaltedError } from '../../application/ladder/ladder-cycle-halted.error'
import { LadderMonitorHaltedError } from '../../application/ladder/ladder-monitor-halted.error'
import { createMonitoringProjection } from '../../application/monitoring/monitoring-projection.utils'
import { QuoterBotMonitorHaltedError } from '../../application/quoter-bot/quoter-bot-monitor-halted.error'
import { SetupMonitorHaltedError } from '../../application/setup/setup-monitor-halted.error'
import { CliUsageError } from './cli-usage.error'
import { offerInvalidationGroup } from './offer-invalidation-argument.utils'

interface SetupReadinessService {
  assertReady(signal?: AbortSignal): Promise<SetupCheckReport>
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

interface LadderQuoterService {
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

interface QuoterBotMonitorService {
  runContinuously(parameters: {
    signal: AbortSignal
    onEvent?: (event: QuoterBotEvent) => void | Promise<void>
    verbose?: boolean
  }): Promise<QuoterBotMonitorReport>
}

/** CLI-selected runtime and configuration-file options. */
type CliConfigurationOptions = {
  configPath?: string
  readOnly: boolean
  signerEnvironment?: Record<string, string>
  signal: AbortSignal
  writeEvent?: (value: unknown) => void | Promise<void>
}

/** Per-invocation process signal and JSON-compatible continuous-event writer. */
export type CliRuntimeOptions = {
  /** Requests graceful monitoring shutdown without interrupting an in-flight cycle. */
  signal?: AbortSignal
  /** Receives every completed monitoring cycle before the final lifecycle report. */
  writeEvent?: (value: unknown) => void | Promise<void>
}

/** Infrastructure adapter: wires the `morpho-quoter` CLI (commander) to application services. */
export class Cli {
  private readonly program: Command
  private output: unknown
  private hasOutput = false
  private runtime: CliRuntimeOptions = {}
  private readonly monitoring: MonitoringProjection = createMonitoringProjection()

  // The cycle value keeps its existing shape and ships first; the flat monitoring records derived
  // from it follow on the same stream.
  //
  // Monitor loops await this callback while holding the combined writer queue, so a throwing
  // projection would surface as a failed cycle and stop the bot. Deriving and writing the extra
  // records is therefore isolated: telemetry may be lost, but it can never halt quoting. The cycle
  // value itself keeps its original unguarded write so genuine output failures still surface.
  private async writeCycle(
    value: unknown,
    project: (projection: MonitoringProjection) => readonly unknown[]
  ) {
    await this.runtime.writeEvent?.(value)
    try {
      for (const event of project(this.monitoring)) await this.runtime.writeEvent?.(event)
    } catch {
      return
    }
  }

  private get signal() {
    return this.runtime.signal ?? new AbortController().signal
  }

  private eventObserver<Event>(enabled: boolean) {
    return enabled ? (event: Event) => this.runtime.writeEvent?.(event) : undefined
  }

  private capture(output: unknown) {
    this.output = output
    this.hasOutput = true
  }

  /**
   * Configures version, address-only mode, individual workflows, combined monitoring, and invalidation.
   * @param version - Application version provider.
   * @param setup - Lazy readiness-service factory, invoked only for `setup-check`.
   * @param bootstrap - Lazy position-bootstrap factory, invoked only for `bootstrap`.
   * @param ladder - Lazy production or test ladder-service factory.
   * @param invalidation - Optional lazy all-groups or one-group invalidation factory.
   * @param quoterBot - Optional lazy combined setup, bootstrap, and ladder monitor factory.
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
    ) => LadderQuoterService | Promise<LadderQuoterService>,
    invalidation?: (
      options: CliConfigurationOptions
    ) => OfferInvalidationService | Promise<OfferInvalidationService>,
    quoterBot?: (
      options: CliConfigurationOptions
    ) => QuoterBotMonitorService | Promise<QuoterBotMonitorService>
  ) {
    this.program = new Command()
      .name('morpho-quoter')
      .description('Morpho quoter bot CLI')
      .version(version.getVersion(), '-v, --version', 'output the current version')
      .option('-c, --config <path>', 'load configuration from an explicit .yaml or .yml file')
      .option('--json', 'emit machine-parseable JSON Lines instead of human-readable output')
      .option('--readonly', 'use a maker address without signing or submitting transactions')
      .option(
        '--private-key <key>',
        'sign locally (warning: argv may appear in process listings and shell history; prefer MAKER_PRIVATE_KEY)'
      )
      .option('--keystore <path>', 'sign with an encrypted JSON keystore file')
      .option(
        '--password <password>',
        'decrypt the keystore (warning: argv may appear in process listings and shell history; prefer KEYSTORE_PASSWORD or --interactive)'
      )
      .option('--interactive', 'prompt without echoing for the selected keystore password')
      .option('--aws', 'sign remotely with the configured non-exportable AWS KMS key')
      .exitOverride()
      .configureOutput({ writeOut: () => {}, writeErr: () => {} })

    const setupCommand = this.program
      .command('setup-check')
      .description('run quoter readiness checks once or monitor continuously')
      .option('--monitor', 'repeat readiness checks every minute until shutdown')

    setupCommand.action(async () => {
      const options = this.configurationOptions()
      const setupOptions = setupCommand.opts<{ monitor?: boolean }>()
      const setupService = await setup({
        ...options,
        writeEvent: this.runtime.writeEvent
      })
      if (setupOptions.monitor === true) {
        if (!setupService.runContinuously) throw new CliUsageError()
        const result = await setupService.runContinuously({
          signal: this.signal,
          onCycle: report => this.writeCycle(report, monitoring => monitoring.setup(report))
        })
        if (result.status === 'halted') throw new SetupMonitorHaltedError(result)
        this.capture(result)
        return
      }

      this.capture(await setupService.assertReady(this.signal))
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
      const options = this.configurationOptions()
      const bootstrapOptions = bootstrapCommand.opts<{ monitor?: boolean; verbose?: boolean }>()
      const bootstrapService = await bootstrap({
        ...options,
        writeEvent: this.runtime.writeEvent
      })
      const verbose = bootstrapOptions.verbose === true
      const onTransactionSubmitted = this.eventObserver<BootstrapTransactionSubmittedEvent>(verbose)
      if (bootstrapOptions.monitor === true) {
        if (!bootstrapService.runContinuously) throw new CliUsageError()
        const result = await bootstrapService.runContinuously({
          signal: this.signal,
          onCycle: cycle => this.writeCycle(cycle, monitoring => monitoring.bootstrap(cycle)),
          verbose,
          onTransactionSubmitted
        })
        if (result.status === 'halted') {
          throw new PositionBootstrapMonitorHaltedError(result)
        }
        this.capture(result)
        return
      }

      const result = await bootstrapService.runOnce({ verbose, onTransactionSubmitted })
      if (Array.isArray(result) && cycleHasFailure(result)) {
        throw new PositionBootstrapHaltedError(result)
      }
      this.capture(result)
    })

    const ladderCommand = this.program
      .command('ladder')
      .description('run one quoter ladder cycle or monitor continuously')
      .option('--monitor', 'repeat at the configured cadence and clean up owned offers on shutdown')
      .option(
        '--verbose',
        'show config, rates, ladder offers, capacities, state, and transaction hashes'
      )

    ladderCommand.action(async () => {
      const options = this.configurationOptions()
      const ladderOptions = ladderCommand.opts<{ monitor?: boolean; verbose?: boolean }>()
      const ladderService = await ladder({
        ...options,
        writeEvent: this.runtime.writeEvent
      })
      const verbose = ladderOptions.verbose === true
      const onTransactionSubmitted = this.eventObserver<LadderTransactionSubmittedEvent>(verbose)
      if (ladderOptions.monitor === true) {
        if (!ladderService.runContinuously) throw new CliUsageError()
        const result = await ladderService.runContinuously({
          signal: this.signal,
          onCycle: cycle => this.writeCycle(cycle, monitoring => monitoring.ladder(cycle)),
          verbose,
          onTransactionSubmitted
        })
        if (result.status === 'halted') {
          throw new LadderMonitorHaltedError(result)
        }
        this.capture(result)
        return
      }

      const result = await ladderService.runOnce({ verbose, onTransactionSubmitted })
      if (cycleHasFailure(result)) {
        throw new LadderCycleHaltedError(result)
      }
      this.capture(result)
    })

    const startCommand = this.program
      .command('start')
      .description('monitor setup, bootstrap, and ladder together until shutdown')
      .option('--verbose', 'show bootstrap and ladder diagnostics and submitted transaction hashes')

    startCommand.action(async () => {
      if (!quoterBot) throw new CliUsageError()
      const options = this.configurationOptions()
      const startOptions = startCommand.opts<{ verbose?: boolean }>()
      const service = await quoterBot({
        ...options,
        writeEvent: this.runtime.writeEvent
      })
      const result = await service.runContinuously({
        signal: this.signal,
        onEvent: event => this.writeCycle(event, monitoring => monitoring.combined(event)),
        verbose: startOptions.verbose === true
      })
      if (result.status === 'halted') throw new QuoterBotMonitorHaltedError(result)
      this.capture(result)
    })

    const invalidateCommand = this.program
      .command('invalidate')
      .description('invalidate all active maker offer groups or one explicit group')
      .argument('[group-id]', 'optional 0x-prefixed bytes32 offer-group ID')

    invalidateCommand.action(async (rawGroupId?: string) => {
      if (!invalidation) throw new CliUsageError()
      const groupId = offerInvalidationGroup(rawGroupId)
      const options = this.configurationOptions()
      const invalidationService = await invalidation({
        ...options,
        writeEvent: this.runtime.writeEvent
      })
      this.capture(
        await invalidationService.run({
          groupId,
          onTransactionSubmitted: event => this.runtime.writeEvent?.(event)
        })
      )
    })
  }

  private configurationOptions(): CliConfigurationOptions {
    const options = this.program.opts<{
      config?: string
      readonly?: boolean
      privateKey?: string
      keystore?: string
      password?: string
      interactive?: boolean
      aws?: boolean
    }>()
    const readOnly = options.readonly === true
    if (options.password !== undefined && options.interactive === true) throw new CliUsageError()
    if (
      options.keystore === undefined &&
      (options.password !== undefined || options.interactive === true)
    )
      throw new CliUsageError()
    const hasExplicitSigner =
      options.privateKey !== undefined ||
      options.keystore !== undefined ||
      options.password !== undefined ||
      options.interactive === true ||
      options.aws === true
    if (readOnly && hasExplicitSigner) throw new CliUsageError()
    const signerEnvironment: Record<string, string> = {}
    if (options.privateKey !== undefined) {
      signerEnvironment.KEY_STORAGE_METHOD = 'private-key'
      signerEnvironment.MAKER_PRIVATE_KEY = options.privateKey
    }
    if (options.keystore !== undefined) {
      signerEnvironment.KEY_STORAGE_METHOD = 'keystore'
      signerEnvironment.KEYSTORE_PATH = options.keystore
    }
    if (options.password !== undefined) {
      signerEnvironment.KEYSTORE_PASSWORD = options.password
      signerEnvironment.KEYSTORE_INTERACTIVE = 'false'
    }
    if (options.interactive === true) {
      signerEnvironment.KEYSTORE_PASSWORD = ''
      signerEnvironment.KEYSTORE_INTERACTIVE = 'true'
    }
    if (options.aws === true) signerEnvironment.KEY_STORAGE_METHOD = 'aws'
    return {
      configPath: options.config,
      readOnly,
      signerEnvironment:
        Object.keys(signerEnvironment).length === 0 ? undefined : signerEnvironment,
      signal: this.signal
    }
  }

  /**
   * Parses one CLI invocation and returns its captured output.
   * @param argv - User arguments without the executable/runtime prefix.
   * @param runtime - Optional graceful-shutdown signal and continuous-cycle event writer.
   * @returns Version text, a complete setup report, or a structured writer or invalidation result.
   * @throws `CliUsageError` with a constant message and stable code on invalid usage; raw Commander
   * arguments, messages, option details, URLs, and causes are deliberately discarded. Provider and
   * readiness errors pass through.
   * @remarks `setup-check` is read-only, writers run only for their explicit commands, and
   * `--monitor` variants repeat at their configured cadence with owned-offer cleanup on shutdown.
   * `--verbose` adds safe diagnostics, `--readonly` never loads a private key, and `start` runs
   * setup, bootstrap, and ladder monitoring as one fail-together group that drains writer cleanup
   * before settling.
   */
  async run(argv: readonly string[], runtime: CliRuntimeOptions = {}): Promise<unknown> {
    if (argv.length === 0) throw new CliUsageError()
    if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
      return this.program.helpInformation()
    }
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
