import type { Hex } from 'viem'

import { withActiveSpan } from '@repo/telemetry'
import { Command, CommanderError } from 'commander'

import type { MarketReport } from '../../application/engine/market-report'
import type { VersionService } from '../../application/quoter-bot/version.service'
import type { SetupCheckReport } from '../../application/setup/setup-check.service'
import type { QuoterRunReport } from '../../errors'
import type {
  OfferInvalidationSuccessReport,
  OfferInvalidationTransactionSubmittedEvent
} from '../invalidation/offer-invalidation'

import { operatorErrorName } from '../../application/monitoring/operator-error-name.utils'
import { setupMonitoringEvents } from '../../application/monitoring/setup-monitoring.utils'
import { CliUsageError } from '../../errors'
import { offerInvalidationGroup } from './offer-invalidation-argument.utils'

interface SetupReadinessService {
  assertReady(signal?: AbortSignal): Promise<SetupCheckReport>
}

/** A strategy command: one run until every market is steady, or a run until the signal. */
interface QuoterRunService {
  runOnce(parameters: { signal: AbortSignal; verbose: boolean }): Promise<readonly MarketReport[]>
  runContinuously(parameters: { signal: AbortSignal; verbose: boolean }): Promise<QuoterRunReport>
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
  signerEnvironment?: Record<string, string>
  signal: AbortSignal
  writeEvent?: (value: unknown) => void
}

/** Per-invocation process signal and JSON-compatible continuous-event writer. */
export type CliRuntimeOptions = {
  /** Requests graceful shutdown, which withdraws everything a continuous run holds. */
  signal?: AbortSignal
  /** Receives every monitoring record before the final report, synchronously. */
  writeEvent?: (value: unknown) => void
  /**
   * Receives a one-shot `setup-check`'s monitoring records, which reach observability sinks without
   * joining its single-report stdout.
   */
  observeRecord?: (value: unknown) => void | Promise<void>
}

/** Infrastructure adapter: wires the `morpho-quoter` CLI (commander) to application services. */
export class Cli {
  private readonly program: Command
  private output: unknown
  private hasOutput = false
  private runtime: CliRuntimeOptions = {}

  private async observeSetupRecords(report: SetupCheckReport) {
    try {
      for (const event of setupMonitoringEvents(report)) await this.runtime.observeRecord?.(event)
    } catch {
      return
    }
  }

  private get signal() {
    return this.runtime.signal ?? new AbortController().signal
  }

  private capture(output: unknown) {
    this.output = output
    this.hasOutput = true
  }

  /**
   * Configures version, address-only mode, individual workflows, combined monitoring, and invalidation.
   * @param version - Application version provider.
   * @param setup - Lazy readiness-service factory, invoked only for `setup-check`.
   * @param bootstrap - Lazy bootstrap-run factory, invoked only for `bootstrap`.
   * @param ladder - Lazy ladder-run factory, invoked only for `ladder`.
   * @param invalidation - Optional lazy all-groups or one-group invalidation factory.
   * @param quoterBot - Optional lazy combined setup, bootstrap, and ladder run factory.
   * @remarks Construction performs no provider calls and does not start writer workflows. The
   * `--readonly` option is a positive Boolean flag and defaults to write-enabled configuration.
   */
  constructor(
    version: VersionService,
    setup: (
      options: CliConfigurationOptions
    ) => SetupReadinessService | Promise<SetupReadinessService>,
    bootstrap: (options: CliConfigurationOptions) => QuoterRunService | Promise<QuoterRunService>,
    ladder: (options: CliConfigurationOptions) => QuoterRunService | Promise<QuoterRunService>,
    invalidation?: (
      options: CliConfigurationOptions
    ) => OfferInvalidationService | Promise<OfferInvalidationService>,
    quoterBot?: (
      options: CliConfigurationOptions
    ) =>
      | Pick<QuoterRunService, 'runContinuously'>
      | Promise<Pick<QuoterRunService, 'runContinuously'>>
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
      .description('run quoter readiness checks once')

    setupCommand.action(async () => {
      const options = this.configurationOptions()
      const setupService = await setup({
        ...options,
        writeEvent: this.runtime.writeEvent
      })
      const report = await withActiveSpan(
        {
          name: 'quoter-bot.cycle',
          attributes: { workflow: 'setup-check' },
          errorName: operatorErrorName
        },
        () => setupService.assertReady(this.signal)
      )
      await this.observeSetupRecords(report)
      this.capture(report)
    })

    for (const [workflow, description, factory] of [
      ['bootstrap', 'run position bootstrap until every market is steady', bootstrap],
      ['ladder', 'run the quoter ladder until every market is steady', ladder]
    ] as const) {
      const command = this.program
        .command(workflow)
        .description(description)
        .option('--monitor', 'quote until shutdown, then withdraw every owned offer')
        .option('--verbose', 'add what each market observed to its printed report')
      command.action(async () => {
        const options = this.configurationOptions()
        const { monitor, verbose } = command.opts<{ monitor?: boolean; verbose?: boolean }>()
        // Deferred so the spans below also cover construction, whose readiness preflight already
        // reaches providers.
        const makeService = () => factory({ ...options, writeEvent: this.runtime.writeEvent })
        const run = { signal: this.signal, verbose: verbose === true }
        if (monitor === true) {
          const service = await withActiveSpan(
            { name: 'quoter-bot.startup', attributes: { workflow }, errorName: operatorErrorName },
            async () => makeService()
          )
          this.capture(await service.runContinuously(run))
          return
        }
        this.capture(
          await withActiveSpan(
            { name: 'quoter-bot.cycle', attributes: { workflow }, errorName: operatorErrorName },
            async () => (await makeService()).runOnce(run)
          )
        )
      })
    }

    const startCommand = this.program
      .command('start')
      .description('monitor setup, bootstrap, and ladder together until shutdown')
      .option('--verbose', 'add what each market observed to the printed report')

    startCommand.action(async () => {
      if (!quoterBot) throw new CliUsageError()
      const options = this.configurationOptions()
      const startOptions = startCommand.opts<{ verbose?: boolean }>()
      const service = await withActiveSpan(
        {
          name: 'quoter-bot.startup',
          attributes: { workflow: 'start' },
          errorName: operatorErrorName
        },
        async () => quoterBot({ ...options, writeEvent: this.runtime.writeEvent })
      )
      this.capture(
        await service.runContinuously({
          signal: this.signal,
          verbose: startOptions.verbose === true
        })
      )
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
   * @param runtime - Optional graceful-shutdown signal and monitoring-record writer.
   * @returns Version text, a complete setup report, each market's report, a run's stop report, or
   * an invalidation result.
   * @throws `CliUsageError` with a constant message and stable code on invalid usage; raw Commander
   * arguments, messages, option details, URLs, and causes are deliberately discarded. Provider and
   * readiness errors pass through.
   * @remarks `setup-check` is read-only and writers run only for their explicit commands. A
   * one-shot strategy command runs until every market is steady and leaves its offers; `--monitor`
   * and `start` quote until shutdown and withdraw everything on stopping. `--verbose` adds what each
   * market observed to printed reports, and `--readonly` never loads a private key.
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
