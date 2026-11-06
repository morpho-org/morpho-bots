import type { KernelState } from '@repo/kernel'

import type { MonitoringEvent } from './application/monitoring/monitoring-event'
import type { SetupStateService } from './application/setup/setup-check.service'
import type { ConfigService } from './config/config.service'
import type { TargetRateStrategyConfig } from './domain/target-rate'
import type { QuoterHosting } from './graph'
import type { BootstrapAdapters } from './infrastructure/bootstrap/production-bootstrap'
import type { CliRuntimeOptions } from './infrastructure/cli/cli'
import type { EngineStarter } from './infrastructure/engine/quoter-runs'
import type { WorldReads } from './infrastructure/engine/world-reads'
import type { OfferInvalidation } from './infrastructure/invalidation/offer-invalidation'
import type { QuoterOwnership } from './infrastructure/kernel/quoter-holdings'
import type { LadderAdapters } from './infrastructure/ladder/production-ladder'
import type { ReferenceRates } from './infrastructure/reference/reference-rates'

import { botConfiguredEvents } from './application/monitoring/bot-configured.utils'
import { VersionService } from './application/quoter-bot/version.service'
import { SetupCheckService } from './application/setup/setup-check.service'
import { ConfigService as RuntimeConfigService } from './config/config.service'
import { journalSettings } from './config/journal-settings.utils'
import { requiresVariableRateReference } from './domain/target-rate'
import {
  SetupCheckAbortedError,
  ConfigValidationError,
  BootstrapConfigurationError,
  LadderConfigurationError
} from './errors'
import { Cli } from './infrastructure/cli/cli'
import { readPasswordInteractively } from './infrastructure/cli/password-prompt.utils'
import { BOOTSTRAP_MONITOR_INTERVAL_MS } from './infrastructure/engine/quoter-cadence'
import { quoterRuns } from './infrastructure/engine/quoter-runs'
import { createOfferInvalidation } from './infrastructure/invalidation/offer-invalidation'
import { createQuoterOwnership } from './infrastructure/kernel/quoter-holdings'
import { readLedgerEntries } from './infrastructure/kernel/quoter-ownership'
import { requestJson } from './infrastructure/provider/http-json.utils'
import { createChainReader } from './infrastructure/setup-state/chain-reader.utils'
import { ViemSetupStateService } from './infrastructure/setup-state/viem-setup-state.service'
import { assertNoLegacyStrategyState } from './infrastructure/strategy-state/strategy-state-file.utils'
import { createSignerAccount } from './kernel'
import { startQuoterEngine } from './run'

type Environment = Record<string, string | undefined>
type MonitoringEventWriter = (event: MonitoringEvent) => void

/**
 * Enforces Blue configuration only for the workflows active in the selected command.
 * @param config - Fully parsed runtime configuration.
 * @param configurations - Bootstrap or ladder configurations active for this invocation.
 * @throws `ConfigValidationError` when an active variable-rate strategy lacks Blue configuration.
 */
const assertReferenceConfigured = (
  config: ConfigService,
  configurations: readonly { targetRate: TargetRateStrategyConfig }[]
) => {
  if (!requiresVariableRateReference(configurations)) return
  if (config.setup.referenceMarketId === undefined) {
    throw new ConfigValidationError(
      'REFERENCE_MARKET_ID',
      'missing',
      'Missing required env var: REFERENCE_MARKET_ID'
    )
  }
  if (config.referenceRpcUrl === undefined) {
    throw new ConfigValidationError(
      'REFERENCE_RPC_URL',
      'missing',
      'Missing required env var: REFERENCE_RPC_URL'
    )
  }
}

const signerAccountAddress = async (
  identity: Exclude<ConfigService['identity'], { readOnly: true }>
) => (await createSignerAccount(identity)).address

type Dependencies = {
  createState?: (config: ConfigService) => SetupStateService
  /** Replaces the production ladder preparation, for tests. */
  createLadderAdapters?: (config: ConfigService) => LadderAdapters
  /** Replaces the production bootstrap preparation, for tests. */
  createBootstrapAdapters?: (config: ConfigService) => BootstrapAdapters
  /** Replaces the chain and API reads every world poll makes, for tests. */
  createWorldReads?: (config: ConfigService) => WorldReads
  /** Replaces the reference rates, for tests. */
  createReferenceRates?: (config: ConfigService) => ReferenceRates
  /** Replaces the `invalidate` command, for tests. */
  createInvalidation?: (config: ConfigService) => Pick<OfferInvalidation, 'run'>
  /** Replaces the kernel a writer command runs for its signer. */
  kernel?: (config: ConfigService) => QuoterHosting
  /** Overrides the process working directory used for default configuration discovery. */
  cwd?: string
  /** Overrides hidden terminal password input in tests. */
  readPassword?: () => Promise<string>
}

const defaultState = (config: ConfigService, ownership: QuoterOwnership) => {
  const identity = config.identity
  const identityOptions = identity.readOnly
    ? { readOnly: true as const }
    : {
        readOnly: false as const,
        deriveSignerAddress: () => signerAccountAddress(identity)
      }

  return new ViemSetupStateService(
    createChainReader(config.rpcUrl, config.requestTimeoutMs, config.chainId),
    createChainReader(
      config.referenceRpcUrl ?? config.rpcUrl,
      config.requestTimeoutMs,
      config.chainId
    ),
    (url, provider, timeoutMs) =>
      requestJson(url, provider, Math.min(config.requestTimeoutMs, timeoutMs ?? Infinity)),
    {
      ...identityOptions,
      chainId: config.chainId,
      midnight: config.setup.midnight,
      loanAsset: config.setup.loanAsset,
      morphoApiBaseUrl: config.morphoApiBaseUrl,
      marketIds: config.setup.marketIds,
      referenceMarketId: config.setup.referenceMarketId ?? config.setup.marketIds[0]!,
      referenceLookbackSeconds: config.referenceLookbackSeconds,
      v0OfferGroupIds: config.v0OfferGroupIds,
      readOwnedGroupIds: async () => ownership.ownedGroupIds(),
      readBootstrapGroupIds: async () => ownership.current().bootstrapGroupIds,
      readWithdrawnGroupIds: async () => ownership.withdrawnGroupIds(),
      readLadderSellGroupIds: async () =>
        ownership
          .current()
          .ladderPublications.flatMap(publication =>
            publication.groups.filter(group => group.side === 'lower').map(group => group.groupId)
          ),
      requestTimeoutMs: config.requestTimeoutMs
    }
  )
}

/**
 * Composes setup-check, position-bootstrap, ladder, combined monitoring, and invalidation.
 * @param environment - Environment map used for lazy validated configuration.
 * @param dependencies - Optional state, reader, and kernel factories used by isolated tests.
 * @returns An application exposing a single asynchronous CLI `run` boundary.
 * @remarks Composition is side-effect free. Every writer command runs the quoter's controller over
 * the kernel for its signer: the controller withdraws what an earlier run left, checks readiness,
 * then quotes until it stops, and a startup failure stops the kernel, which withdraws everything it
 * holds. `--readonly` selects address-only identity and runs the same decisions over a dry kernel
 * that starts from the ledgers on disk and signs nothing.
 */
export const createApplication = (
  environment: Environment = process.env,
  dependencies: Dependencies = {}
): {
  /**
   * Executes one CLI invocation.
   * @param argv - User arguments without runtime/executable prefixes.
   * @param runtime - Optional shutdown signal and continuous-cycle writer forwarded to the CLI.
   * @returns Captured version, setup-check, writer cycle/monitor, combined monitor, or invalidation JSON.
   * @throws On invalid configuration or usage, provider or readiness failure, or a halted cycle.
   */
  run(argv: readonly string[], runtime?: CliRuntimeOptions): Promise<unknown>
} => {
  /** Ownership read from the ledgers on disk, for a command that runs no kernel. */
  const ledgerOwnership = async (config: ConfigService) => {
    const entries = await readLedgerEntries(config.chainId, config.setup.maker)
    const state = { entries, plans: {} } as unknown as KernelState
    return createQuoterOwnership(
      () => state,
      () => [],
      config.v0OfferGroupIds
    )
  }

  const loadConfig = async (options: {
    configPath?: string
    readOnly: boolean
    signerEnvironment?: Record<string, string>
    signal: AbortSignal
  }) => {
    await assertNoLegacyStrategyState()
    const effectiveEnvironment = { ...environment }
    const method = options.signerEnvironment?.KEY_STORAGE_METHOD
    if (method === 'private-key') {
      for (const key of [
        'KEYSTORE_PATH',
        'KEYSTORE_PASSWORD',
        'KEYSTORE_INTERACTIVE',
        'AWS_KMS_KEY_ID',
        'AWS_REGION'
      ])
        delete effectiveEnvironment[key]
    } else if (method === 'keystore') {
      for (const key of ['MAKER_PRIVATE_KEY', 'AWS_KMS_KEY_ID', 'AWS_REGION'])
        delete effectiveEnvironment[key]
    } else if (method === 'aws') {
      for (const key of [
        'MAKER_PRIVATE_KEY',
        'KEYSTORE_PATH',
        'KEYSTORE_PASSWORD',
        'KEYSTORE_INTERACTIVE'
      ])
        delete effectiveEnvironment[key]
    }
    Object.assign(effectiveEnvironment, options.signerEnvironment)
    return RuntimeConfigService.load(effectiveEnvironment, {
      configPath: options.configPath,
      cwd: dependencies.cwd,
      readOnly: options.readOnly,
      readPassword:
        dependencies.readPassword ?? (() => readPasswordInteractively({ signal: options.signal }))
    })
  }

  /**
   * The engine one writer command runs: the signer's kernel for a writer, or a dry kernel from the
   * ledgers on disk for `--readonly`, whose acts are reported as logged, with their condition.
   */
  const engineStarter = async (
    config: ConfigService,
    options: { writeEvent?: CliRuntimeOptions['writeEvent'] },
    strategies: { ladder: boolean; bootstrap: boolean },
    monitorSetup: boolean
  ): Promise<EngineStarter> => {
    const identity = config.identity
    const journal = journalSettings(environment)
    const account = identity.readOnly ? undefined : await createSignerAccount(identity)
    const dryEntries = identity.readOnly
      ? await readLedgerEntries(config.chainId, config.setup.maker)
      : undefined
    const writeEvent = options.writeEvent as MonitoringEventWriter | undefined
    const configurations = [
      ...(strategies.bootstrap ? config.bootstrap : []),
      ...(strategies.ladder ? config.ladder : [])
    ]
    return async run => {
      const engine = await startQuoterEngine({
        config,
        strategies,
        journal,
        ...(account ? { account } : {}),
        ...(writeEvent ? { writeEvent } : {}),
        setup: {
          create: ownership =>
            new SetupCheckService(
              dependencies.createState?.(config) ?? defaultState(config, ownership),
              config.setup,
              config.readOnly,
              requiresVariableRateReference(configurations)
            ),
          monitor: monitorSetup
        },
        adapters: {
          ...(dependencies.createLadderAdapters
            ? { ladder: () => dependencies.createLadderAdapters!(config) }
            : {}),
          ...(dependencies.createBootstrapAdapters
            ? { bootstrap: () => dependencies.createBootstrapAdapters!(config) }
            : {})
        },
        ...(dependencies.createWorldReads ? { world: dependencies.createWorldReads(config) } : {}),
        ...(dependencies.createReferenceRates
          ? { references: dependencies.createReferenceRates(config) }
          : {}),
        ...(dependencies.kernel ? { kernel: dependencies.kernel(config) } : {}),
        ...(dryEntries ? { dryEntries } : {}),
        signal: run.signal,
        ...(run.until ? { until: run.until } : {})
      })
      return engine
    }
  }

  const cli = new Cli(
    new VersionService(),
    async options => {
      const config = await loadConfig(options)
      assertReferenceConfigured(config, [...config.bootstrap, ...config.ladder])
      const state =
        dependencies.createState?.(config) ?? defaultState(config, await ledgerOwnership(config))
      return new SetupCheckService(
        state,
        config.setup,
        config.readOnly,
        requiresVariableRateReference([...config.bootstrap, ...config.ladder])
      )
    },
    async options => {
      const config = await loadConfig(options)
      if (config.bootstrap.length === 0)
        throw new BootstrapConfigurationError(
          'bootstrap',
          'requires at least one configured market'
        )
      assertReferenceConfigured(config, config.bootstrap)
      if (options.signal.aborted) throw new SetupCheckAbortedError()
      const start = await engineStarter(config, options, { ladder: false, bootstrap: true }, false)
      return quoterRuns(start, options.writeEvent)
    },
    async options => {
      const config = await loadConfig(options)
      if (config.ladder.length === 0)
        throw new LadderConfigurationError('ladder', 'requires at least one configured market')
      assertReferenceConfigured(config, config.ladder)
      if (options.signal.aborted) throw new SetupCheckAbortedError()
      const start = await engineStarter(config, options, { ladder: true, bootstrap: false }, false)
      return quoterRuns(start, options.writeEvent)
    },
    async options => {
      const config = await loadConfig(options)
      if (dependencies.createInvalidation) return dependencies.createInvalidation(config)
      const identity = config.identity
      if (identity.readOnly) return createOfferInvalidation(config, {})
      const journal = journalSettings(environment)
      const account = await createSignerAccount(identity)
      const writeEvent = options.writeEvent as MonitoringEventWriter | undefined
      return createOfferInvalidation(config, {
        writer: {
          signer: account.address,
          start: run =>
            startQuoterEngine({
              config,
              strategies: { ladder: false, bootstrap: false },
              journal,
              account,
              ...(writeEvent ? { writeEvent } : {}),
              ...(dependencies.kernel ? { kernel: dependencies.kernel(config) } : {}),
              ...(run.adopt ? { adopt: run.adopt } : {}),
              ...(run.cancel ? { cancel: run.cancel } : {}),
              ...(run.onStartup ? { onStartup: run.onStartup } : {}),
              ...(run.onStartupSent ? { onStartupSent: run.onStartupSent } : {})
            })
        }
      })
    },
    async options => {
      const config = await loadConfig(options)
      if (config.ladder.length === 0) {
        throw new LadderConfigurationError(
          'ladder',
          'requires at least one configured market for monitoring'
        )
      }
      assertReferenceConfigured(config, [...config.bootstrap, ...config.ladder])
      for (const event of botConfiguredEvents({
        loanAsset: config.setup.loanAsset,
        readOnly: config.readOnly,
        bootstrap: config.bootstrap,
        ladder: config.ladder,
        bootstrapIntervalSeconds: BOOTSTRAP_MONITOR_INTERVAL_MS / 1_000
      })) {
        await options.writeEvent?.(event)
      }
      if (options.signal.aborted) throw new SetupCheckAbortedError()
      return quoterRuns(
        await engineStarter(config, options, { ladder: true, bootstrap: true }, true),
        options.writeEvent
      )
    }
  )

  return { run: (argv, runtime) => cli.run(argv, runtime) }
}
