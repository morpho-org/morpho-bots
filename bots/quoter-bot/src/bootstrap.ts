import type { Hex } from 'viem'

import type {
  BootstrapMakeService,
  BootstrapPositionService,
  BootstrapReferenceRateService
} from './application/bootstrap/position-bootstrap.service'
import type { OfferInvalidationPort } from './application/invalidation/offer-invalidation.service'
import type {
  LadderMakeService,
  LadderPositionService,
  LadderReferenceRateService
} from './application/ladder/ladder-quoter.service'
import type { SetupStateService } from './application/setup/setup-check.service'
import type { ConfigService } from './config/config.service'
import type { TargetRateStrategyConfig } from './domain/target-rate'
import type { CliRuntimeOptions } from './infrastructure/cli/cli'

import {
  BOOTSTRAP_MONITOR_INTERVAL_MS,
  PositionBootstrapService
} from './application/bootstrap/position-bootstrap.service'
import { OfferInvalidationService } from './application/invalidation/offer-invalidation.service'
import { LadderQuoterService } from './application/ladder/ladder-quoter.service'
import { botConfiguredEvents } from './application/monitoring/bot-configured.utils'
import { serializeQuoterBotWrites } from './application/quoter-bot/quoter-bot-mutation.utils'
import { QuoterBotService } from './application/quoter-bot/quoter-bot.service'
import { SetupCheckAbortedError } from './application/setup/setup-check-aborted.error'
import { SetupCheckService } from './application/setup/setup-check.service'
import { VersionService } from './application/version.service'
import { ConfigValidationError } from './config/config-validation.error'
import { ConfigService as RuntimeConfigService } from './config/config.service'
import { BootstrapConfigurationError } from './domain/bootstrap/bootstrap-configuration.error'
import { LadderConfigurationError } from './domain/ladder/ladder-configuration.error'
import { requiresVariableRateReference } from './domain/target-rate'
import { createBootstrapGroupOwnership } from './infrastructure/bootstrap/bootstrap-group-ownership.utils'
import { createProductionBootstrapAdapters } from './infrastructure/bootstrap/production-bootstrap'
import { Cli } from './infrastructure/cli/cli'
import { readPasswordInteractively } from './infrastructure/cli/password-prompt.utils'
import { createProductionOfferInvalidationPort } from './infrastructure/invalidation/production-offer-invalidation'
import { createLadderGroupOwnership } from './infrastructure/ladder/ladder-group-ownership.utils'
import { createProductionLadderAdapters } from './infrastructure/ladder/production-ladder'
import { createMakerAccount } from './infrastructure/make/maker-account.utils'
import { ReadOnlyBootstrapMakeService } from './infrastructure/make/read-only-bootstrap-make.service'
import { ReadOnlyLadderMakeService } from './infrastructure/make/read-only-ladder-make.service'
import { createChainReader } from './infrastructure/setup-state/chain-reader.utils'
import { requestJson } from './infrastructure/setup-state/http-json.utils'
import { ViemSetupStateService } from './infrastructure/setup-state/viem-setup-state.service'

type Environment = Record<string, string | undefined>

const readOnlyWriter = (writeEvent?: CliRuntimeOptions['writeEvent']) =>
  writeEvent === undefined ? console.log : (line: string) => writeEvent(JSON.parse(line))

const parseEventWriter = (writeEvent?: CliRuntimeOptions['writeEvent']) =>
  writeEvent === undefined ? undefined : (line: string) => writeEvent(JSON.parse(line))

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

const makerAccountAddress = async (
  identity: Exclude<ConfigService['identity'], { readOnly: true }>
) => (await createMakerAccount(identity)).address

type Dependencies = {
  createState?: (config: ConfigService) => SetupStateService
  /** Replaces provider ports while retaining default application-service composition. */
  createBootstrapAdapters?: (
    config: ConfigService,
    ignoredOfferGroupIds?: readonly Hex[]
  ) => {
    positions: BootstrapPositionService
    rates: BootstrapReferenceRateService
    make: BootstrapMakeService
  }
  /** Replaces production ladder ports while retaining default application-service composition. */
  createLadderAdapters?: (config: ConfigService) => {
    positions: LadderPositionService
    rates: LadderReferenceRateService
    make: LadderMakeService
    validateReconcile?: (parameters: Parameters<LadderMakeService['reconcile']>[0]) => Promise<void>
  }
  /** Replaces the provider, signer, and ownership port for explicit offer invalidation. */
  createInvalidationPort?: (config: ConfigService) => OfferInvalidationPort
  /** Overrides the process working directory used for default configuration discovery. */
  cwd?: string
  /** Overrides hidden terminal password input in tests. */
  readPassword?: () => Promise<string>
}

const defaultState = async (config: ConfigService, ignoredOfferGroupIds: readonly Hex[] = []) => {
  const identity = config.identity
  const identityOptions = identity.readOnly
    ? { readOnly: true as const }
    : {
        readOnly: false as const,
        deriveSignerAddress: () => makerAccountAddress(identity)
      }
  const ownership = createBootstrapGroupOwnership({
    maker: config.setup.maker,
    marketIds: config.setup.marketIds,
    configuredGroupIds: config.v0OfferGroupIds
  })
  const ladderOwnership = createLadderGroupOwnership({
    maker: config.setup.maker,
    strategyMarketIds: config.ladder.map(item => item.marketId)
  })

  return new ViemSetupStateService(
    createChainReader(config.rpcUrl, config.requestTimeoutMs),
    createChainReader(config.referenceRpcUrl ?? config.rpcUrl, config.requestTimeoutMs),
    (url, provider, timeoutMs) =>
      requestJson(url, provider, Math.min(config.requestTimeoutMs, timeoutMs ?? Infinity)),
    {
      ...identityOptions,
      midnight: config.setup.midnight,
      loanAsset: config.setup.loanAsset,
      morphoApiBaseUrl: config.morphoApiBaseUrl,
      marketIds: config.setup.marketIds,
      referenceMarketId: config.setup.referenceMarketId ?? config.setup.marketIds[0]!,
      v0OfferGroupIds: config.v0OfferGroupIds,
      readOwnedGroupIds: async () => [
        ...new Set([...(await ownership.read()), ...(await ladderOwnership.readGroupIds())])
      ],
      ignoredOfferGroupIds,
      readBootstrapGroupIds: ownership.read,
      readLadderSellGroupIds: async () =>
        (await ladderOwnership.read()).flatMap(publication =>
          publication.groups.filter(group => group.side === 'lower').map(group => group.groupId)
        ),
      requestTimeoutMs: config.requestTimeoutMs
    }
  )
}

/**
 * Composes setup-check, position-bootstrap, ladder, combined monitoring, and invalidation dependencies.
 * @param environment - Environment map used for lazy validated configuration.
 * @param dependencies - Optional state and workflow-port factories used by isolated tests.
 * @returns An application exposing a single asynchronous CLI `run` boundary.
 * @remarks Composition is side-effect free. Configuration and provider construction occur lazily
 * for `setup-check`, `bootstrap`, `ladder`, `start`, or `invalidate`. Setup is read-only and preserves
 * concurrent independent reads through `Promise.all`. `--readonly` selects address-only identity
 * before any private-key validation and replaces every workflow mutation port with terminal output.
 * Writer commands first clean up durable ladder groups for removed markets, then assert readiness
 * before running their application service. Setup monitoring emits read-only readiness reports
 * at a one-minute cadence and halts nonzero on the first failed report. Bootstrap monitoring uses
 * the same cadence and invalidates strategy-owned groups after its shutdown signal. Ladder
 * monitoring uses the shortest configured ladder cadence and invalidates active owned ladder groups
 * after shutdown. `start` gates readiness once, launches all three monitors concurrently, and uses
 * one cross-strategy mutation queue so separate writer adapters cannot race signer nonces. Explicit
 * invalidation uses a narrower cancellation preflight so unknown maker
 * groups can be removed without weakening normal readiness. One-shot writers run only for their
 * respective explicit commands.
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
  const loadConfig = (options: {
    configPath?: string
    readOnly: boolean
    signerEnvironment?: Record<string, string>
    signal: AbortSignal
  }) => {
    const effectiveEnvironment = { ...environment }
    const method = options.signerEnvironment?.KEY_STORAGE_METHOD
    if (method === 'private-key') {
      for (const key of [
        'KEYSTORE_PATH',
        'KEYSTORE_PASSWORD',
        'KEYSTORE_INTERACTIVE',
        'AWS_KMS_KEY_ID',
        'AWS_REGION',
        'QUOTER_SIGNER_LAMBDA_ARN'
      ])
        delete effectiveEnvironment[key]
    } else if (method === 'keystore') {
      for (const key of [
        'MAKER_PRIVATE_KEY',
        'AWS_KMS_KEY_ID',
        'AWS_REGION',
        'QUOTER_SIGNER_LAMBDA_ARN'
      ])
        delete effectiveEnvironment[key]
    } else if (method === 'aws') {
      for (const key of [
        'MAKER_PRIVATE_KEY',
        'KEYSTORE_PATH',
        'KEYSTORE_PASSWORD',
        'KEYSTORE_INTERACTIVE',
        'QUOTER_SIGNER_LAMBDA_ARN'
      ])
        delete effectiveEnvironment[key]
    } else if (method === 'middleware') {
      for (const key of [
        'MAKER_PRIVATE_KEY',
        'KEYSTORE_PATH',
        'KEYSTORE_PASSWORD',
        'KEYSTORE_INTERACTIVE',
        'AWS_KMS_KEY_ID',
        'AWS_REGION'
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
  const cli = new Cli(
    new VersionService(),
    async options => {
      const config = await loadConfig(options)
      assertReferenceConfigured(config, [...config.bootstrap, ...config.ladder])
      const state = dependencies.createState?.(config) ?? (await defaultState(config))
      return new SetupCheckService(
        state,
        config.setup,
        config.readOnly,
        requiresVariableRateReference([...config.bootstrap, ...config.ladder])
      )
    },
    async options => {
      const config = await loadConfig(options)
      assertReferenceConfigured(config, config.bootstrap)
      if (options.signal.aborted) throw new SetupCheckAbortedError()
      const ladderAdapters = await (dependencies.createLadderAdapters?.(config) ??
        createProductionLadderAdapters(config))
      if (options.signal.aborted) throw new SetupCheckAbortedError()
      const ignoredOfferGroupIds =
        config.readOnly || config.bootstrap.length === 0 || config.ladder.length === 0
          ? []
          : ((await ladderAdapters.make.cleanupRemovedMarkets?.()) ?? [])
      const state =
        dependencies.createState?.(config) ?? (await defaultState(config, ignoredOfferGroupIds))
      await new SetupCheckService(
        state,
        config.setup,
        config.readOnly,
        requiresVariableRateReference(config.bootstrap)
      ).assertReady(options.signal)
      const injectedAdapters = dependencies.createBootstrapAdapters?.(config, ignoredOfferGroupIds)
      const writeReadOnlyEvent = parseEventWriter(options.writeEvent)
      const adapters =
        injectedAdapters ??
        (await createProductionBootstrapAdapters(
          config,
          writeReadOnlyEvent,
          undefined,
          ignoredOfferGroupIds
        ))
      if (options.signal.aborted) throw new SetupCheckAbortedError()
      const make =
        config.readOnly && injectedAdapters
          ? new ReadOnlyBootstrapMakeService(writeReadOnlyEvent)
          : adapters.make
      return new PositionBootstrapService(
        adapters.positions,
        adapters.rates,
        make,
        config.bootstrap
      )
    },
    async options => {
      const config = await loadConfig(options)
      assertReferenceConfigured(config, config.ladder)
      if (options.signal.aborted) throw new SetupCheckAbortedError()
      const adapters = await (dependencies.createLadderAdapters?.(config) ??
        createProductionLadderAdapters(config))
      if (options.signal.aborted) throw new SetupCheckAbortedError()
      const ignoredOfferGroupIds =
        config.readOnly || config.ladder.length === 0
          ? []
          : ((await adapters.make.cleanupRemovedMarkets?.()) ?? [])
      const state =
        dependencies.createState?.(config) ?? (await defaultState(config, ignoredOfferGroupIds))
      await new SetupCheckService(
        state,
        config.setup,
        config.readOnly,
        requiresVariableRateReference(config.ladder)
      ).assertReady(options.signal)
      const writeReadOnlyEvent = parseEventWriter(options.writeEvent)
      const make = config.readOnly
        ? new ReadOnlyLadderMakeService(
            adapters.make,
            writeReadOnlyEvent,
            adapters.validateReconcile
          )
        : adapters.make
      return new LadderQuoterService(adapters.positions, adapters.rates, make, config.ladder)
    },
    async options => {
      const config = await loadConfig(options)
      const port = await (dependencies.createInvalidationPort?.(config) ??
        createProductionOfferInvalidationPort(config))
      return new OfferInvalidationService(port)
    },
    async options => {
      const config = await loadConfig(options)
      if (config.bootstrap.length === 0) {
        throw new BootstrapConfigurationError(
          'bootstrap',
          'requires at least one configured market for monitoring'
        )
      }
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
      const ladderAdapters = await (dependencies.createLadderAdapters?.(config) ??
        createProductionLadderAdapters(config))
      if (options.signal.aborted) throw new SetupCheckAbortedError()
      const ignoredOfferGroupIds = config.readOnly
        ? []
        : ((await ladderAdapters.make.cleanupRemovedMarkets?.()) ?? [])

      const state =
        dependencies.createState?.(config) ?? (await defaultState(config, ignoredOfferGroupIds))
      const setup = new SetupCheckService(
        state,
        config.setup,
        config.readOnly,
        requiresVariableRateReference([...config.bootstrap, ...config.ladder])
      )
      await setup.assertReady(options.signal)

      const injectedBootstrapAdapters = dependencies.createBootstrapAdapters?.(
        config,
        ignoredOfferGroupIds
      )
      const bootstrapAdapters = await (injectedBootstrapAdapters ??
        createProductionBootstrapAdapters(
          config,
          readOnlyWriter(options.writeEvent),
          undefined,
          ignoredOfferGroupIds
        ))
      if (options.signal.aborted) throw new SetupCheckAbortedError()
      const bootstrapMake =
        config.readOnly && injectedBootstrapAdapters
          ? new ReadOnlyBootstrapMakeService(readOnlyWriter(options.writeEvent))
          : bootstrapAdapters.make

      const ladderMake = config.readOnly
        ? new ReadOnlyLadderMakeService(
            ladderAdapters.make,
            readOnlyWriter(options.writeEvent),
            ladderAdapters.validateReconcile
          )
        : ladderAdapters.make
      const make = serializeQuoterBotWrites({ bootstrap: bootstrapMake, ladder: ladderMake })

      return new QuoterBotService(
        setup,
        new PositionBootstrapService(
          bootstrapAdapters.positions,
          bootstrapAdapters.rates,
          make.bootstrap,
          config.bootstrap
        ),
        new LadderQuoterService(
          ladderAdapters.positions,
          ladderAdapters.rates,
          make.ladder,
          config.ladder
        )
      )
    }
  )

  return {
    run: (argv: readonly string[], runtime?: CliRuntimeOptions) => cli.run(argv, runtime)
  }
}
