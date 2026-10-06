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
import type { LadderReadOnlyValidation } from './application/ladder/ladder-verbose'
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
import { cancelOwnedOffersOnStartupFailure } from './application/quoter-bot/startup-cleanup.utils'
import { VersionService } from './application/quoter-bot/version.service'
import { SetupCheckAbortedError } from './application/setup/setup-check-aborted.error'
import { SetupCheckService } from './application/setup/setup-check.service'
import { ConfigValidationError } from './config/config-validation.error'
import { ConfigService as RuntimeConfigService } from './config/config.service'
import { BootstrapConfigurationError } from './domain/bootstrap-configuration.error'
import { LadderConfigurationError } from './domain/ladder-configuration.error'
import { requiresVariableRateReference } from './domain/target-rate'
import { createBootstrapGroupOwnership } from './infrastructure/bootstrap/bootstrap-group-ownership.utils'
import { ReadOnlyBootstrapMakeService } from './infrastructure/bootstrap/bootstrap-make.read-only'
import { createProductionBootstrapAdapters } from './infrastructure/bootstrap/production-bootstrap'
import { Cli } from './infrastructure/cli/cli'
import { readPasswordInteractively } from './infrastructure/cli/password-prompt.utils'
import { createProductionOfferInvalidationPort } from './infrastructure/invalidation/production-offer-invalidation'
import { createLadderGroupOwnership } from './infrastructure/ladder/ladder-group-ownership.utils'
import { ReadOnlyLadderMakeService } from './infrastructure/ladder/ladder-make.read-only'
import { createProductionLadderAdapters } from './infrastructure/ladder/production-ladder'
import { requestJson } from './infrastructure/provider/http-json.utils'
import { createChainReader } from './infrastructure/setup-state/chain-reader.utils'
import { ViemSetupStateService } from './infrastructure/setup-state/viem-setup-state.service'
import { assertCurrentStrategyStates } from './infrastructure/strategy-state/strategy-state-file.utils'
import { createQuoterTransactionExecutor } from './infrastructure/transaction/quoter-transaction-executor'
import { createQuoterTransactionLogger } from './infrastructure/transaction/quoter-transaction-logger.utils'
import { QuoterTransactionError } from './infrastructure/transaction/quoter-transaction.error'
import { createSignerAccount } from './infrastructure/transaction/signer-account.utils'

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

const signerAccountAddress = async (
  identity: Exclude<ConfigService['identity'], { readOnly: true }>
) => (await createSignerAccount(identity)).address

const assertStateHasNoPendingSignerNonce = async (state: SetupStateService) => {
  try {
    const signer = await state.getDerivedSigner()
    if (!signer) throw new QuoterTransactionError('unknown-pending-nonce')
    const { latest, pending } = await state.getTransactionCounts(signer)
    if (latest !== pending) throw new QuoterTransactionError('unknown-pending-nonce')
  } catch (error) {
    if (error instanceof QuoterTransactionError) throw error
    throw new QuoterTransactionError('unknown-pending-nonce')
  }
}

const removedMarketTombstones = async (
  make: Pick<LadderMakeService, 'cleanupRemovedMarkets'>
): Promise<readonly Hex[]> => (await make.cleanupRemovedMarkets?.()) ?? []

/**
 * Runs a writer's post-signer startup, cancelling both strategies' owned offers if it fails.
 * @remarks Read-only startups run unguarded; see {@link cancelOwnedOffersOnStartupFailure}.
 */
const guardWriterStartup = <T>(
  config: ConfigService,
  options: { signal: AbortSignal; writeEvent?: CliRuntimeOptions['writeEvent'] },
  owners: {
    ladder: Pick<LadderMakeService, 'cleanup'>
    bootstrap: () => Promise<Pick<BootstrapMakeService, 'cleanup'>>
  },
  startup: () => Promise<T>
) =>
  config.readOnly
    ? startup()
    : cancelOwnedOffersOnStartupFailure(
        {
          signal: options.signal,
          writeEvent: options.writeEvent,
          ladder: async () => owners.ladder,
          bootstrap: owners.bootstrap
        },
        startup
      )

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
    validateReconcile?: (
      parameters: Parameters<LadderMakeService['reconcile']>[0]
    ) => Promise<LadderReadOnlyValidation | undefined>
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
        deriveSignerAddress: () => signerAccountAddress(identity)
      }
  const ownership = createBootstrapGroupOwnership({
    chainId: config.chainId,
    maker: config.setup.maker,
    marketIds: config.setup.marketIds,
    configuredGroupIds: config.v0OfferGroupIds
  })
  const ladderOwnership = createLadderGroupOwnership({
    chainId: config.chainId,
    maker: config.setup.maker
  })

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
 * before running their application service; a failure in either cancels both strategies' owned offers
 * before the command exits. Setup monitoring emits read-only readiness reports
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
  const loadConfig = async (options: {
    configPath?: string
    readOnly: boolean
    signerEnvironment?: Record<string, string>
    signal: AbortSignal
  }) => {
    await assertCurrentStrategyStates()
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
      const stateOverride = dependencies.createState?.(config)
      const sharedAccount =
        config.identity.readOnly ||
        (dependencies.createBootstrapAdapters && dependencies.createLadderAdapters)
          ? undefined
          : await createSignerAccount(config.identity)
      const sharedExecutor = sharedAccount
        ? createQuoterTransactionExecutor(
            config,
            sharedAccount,
            createQuoterTransactionLogger(options.writeEvent)
          )
        : undefined
      const ladderAdapters = await (dependencies.createLadderAdapters?.(config) ??
        createProductionLadderAdapters(config, sharedAccount, sharedExecutor))
      const writeReadOnlyEvent = parseEventWriter(options.writeEvent)
      const composeBootstrap = (ignoredOfferGroupIds: readonly Hex[]) =>
        dependencies.createBootstrapAdapters?.(config, ignoredOfferGroupIds) ??
        createProductionBootstrapAdapters(
          config,
          writeReadOnlyEvent,
          sharedAccount,
          ignoredOfferGroupIds,
          sharedExecutor
        )
      let adapters: Awaited<ReturnType<typeof composeBootstrap>> | undefined
      return guardWriterStartup(
        config,
        options,
        {
          ladder: ladderAdapters.make,
          bootstrap: async () => (adapters ?? (await composeBootstrap([]))).make
        },
        async () => {
          if (options.signal.aborted) throw new SetupCheckAbortedError()
          if (!config.readOnly) {
            if (stateOverride) await assertStateHasNoPendingSignerNonce(stateOverride)
            else await sharedExecutor!.assertNoPendingNonce()
          }
          const ignoredOfferGroupIds =
            config.readOnly || config.bootstrap.length === 0 || config.ladder.length === 0
              ? []
              : await removedMarketTombstones(ladderAdapters.make)
          const state = stateOverride ?? (await defaultState(config, ignoredOfferGroupIds))
          await new SetupCheckService(
            state,
            config.setup,
            config.readOnly,
            requiresVariableRateReference(config.bootstrap)
          ).assertReady(options.signal)
          adapters = await composeBootstrap(ignoredOfferGroupIds)
          if (options.signal.aborted) throw new SetupCheckAbortedError()
          const make =
            config.readOnly && dependencies.createBootstrapAdapters
              ? new ReadOnlyBootstrapMakeService(writeReadOnlyEvent)
              : adapters.make
          return new PositionBootstrapService(
            adapters.positions,
            adapters.rates,
            make,
            config.bootstrap
          )
        }
      )
    },
    async options => {
      const config = await loadConfig(options)
      assertReferenceConfigured(config, config.ladder)
      if (options.signal.aborted) throw new SetupCheckAbortedError()
      const stateOverride = dependencies.createState?.(config)
      const sharedAccount =
        config.identity.readOnly ||
        (dependencies.createBootstrapAdapters && dependencies.createLadderAdapters)
          ? undefined
          : await createSignerAccount(config.identity)
      const sharedExecutor = sharedAccount
        ? createQuoterTransactionExecutor(
            config,
            sharedAccount,
            createQuoterTransactionLogger(options.writeEvent)
          )
        : undefined
      const adapters = await (dependencies.createLadderAdapters?.(config) ??
        createProductionLadderAdapters(config, sharedAccount, sharedExecutor))
      const writeReadOnlyEvent = parseEventWriter(options.writeEvent)
      return guardWriterStartup(
        config,
        options,
        {
          ladder: adapters.make,
          bootstrap: async () =>
            (
              await (dependencies.createBootstrapAdapters?.(config) ??
                createProductionBootstrapAdapters(
                  config,
                  writeReadOnlyEvent,
                  sharedAccount,
                  [],
                  sharedExecutor
                ))
            ).make
        },
        async () => {
          if (options.signal.aborted) throw new SetupCheckAbortedError()
          if (!config.readOnly) {
            if (stateOverride) await assertStateHasNoPendingSignerNonce(stateOverride)
            else await sharedExecutor!.assertNoPendingNonce()
          }
          const ignoredOfferGroupIds =
            config.readOnly || config.ladder.length === 0
              ? []
              : await removedMarketTombstones(adapters.make)
          const state = stateOverride ?? (await defaultState(config, ignoredOfferGroupIds))
          await new SetupCheckService(
            state,
            config.setup,
            config.readOnly,
            requiresVariableRateReference(config.ladder)
          ).assertReady(options.signal)
          const make = config.readOnly
            ? new ReadOnlyLadderMakeService(
                adapters.make,
                writeReadOnlyEvent,
                adapters.validateReconcile
              )
            : adapters.make
          return new LadderQuoterService(adapters.positions, adapters.rates, make, config.ladder)
        }
      )
    },
    async options => {
      const config = await loadConfig(options)
      const sharedAccount =
        config.identity.readOnly || dependencies.createInvalidationPort
          ? undefined
          : await createSignerAccount(config.identity)
      const sharedExecutor = sharedAccount
        ? createQuoterTransactionExecutor(
            config,
            sharedAccount,
            createQuoterTransactionLogger(options.writeEvent)
          )
        : undefined
      const port = await (dependencies.createInvalidationPort?.(config) ??
        createProductionOfferInvalidationPort(config, sharedAccount, sharedExecutor))
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
      const stateOverride = dependencies.createState?.(config)
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
      const sharedAccount = config.identity.readOnly
        ? undefined
        : await createSignerAccount(config.identity)
      const sharedExecutor = sharedAccount
        ? createQuoterTransactionExecutor(
            config,
            sharedAccount,
            createQuoterTransactionLogger(options.writeEvent)
          )
        : undefined
      const ladderAdapters = await (dependencies.createLadderAdapters?.(config) ??
        createProductionLadderAdapters(config, sharedAccount, sharedExecutor))
      const composeBootstrap = (ignoredOfferGroupIds: readonly Hex[]) =>
        dependencies.createBootstrapAdapters?.(config, ignoredOfferGroupIds) ??
        createProductionBootstrapAdapters(
          config,
          readOnlyWriter(options.writeEvent),
          sharedAccount,
          ignoredOfferGroupIds,
          sharedExecutor
        )
      let bootstrapAdapters: Awaited<ReturnType<typeof composeBootstrap>> | undefined
      return guardWriterStartup(
        config,
        options,
        {
          ladder: ladderAdapters.make,
          bootstrap: async () => (bootstrapAdapters ?? (await composeBootstrap([]))).make
        },
        async () => {
          if (options.signal.aborted) throw new SetupCheckAbortedError()
          if (!config.readOnly) {
            if (stateOverride) await assertStateHasNoPendingSignerNonce(stateOverride)
            else await sharedExecutor!.assertNoPendingNonce()
          }
          const ignoredOfferGroupIds = config.readOnly
            ? []
            : await removedMarketTombstones(ladderAdapters.make)

          const state = stateOverride ?? (await defaultState(config, ignoredOfferGroupIds))
          const setup = new SetupCheckService(
            state,
            config.setup,
            config.readOnly,
            requiresVariableRateReference([...config.bootstrap, ...config.ladder])
          )
          await setup.assertReady(options.signal)

          bootstrapAdapters = await composeBootstrap(ignoredOfferGroupIds)
          if (options.signal.aborted) throw new SetupCheckAbortedError()
          const bootstrapMake =
            config.readOnly && dependencies.createBootstrapAdapters
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
    }
  )

  return {
    run: (argv: readonly string[], runtime?: CliRuntimeOptions) => cli.run(argv, runtime)
  }
}
