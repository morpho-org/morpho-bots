import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'

import type {
  BootstrapMakeService,
  BootstrapPositionService,
  BootstrapReferenceRateService
} from './application/bootstrap/position-bootstrap.service'
import type { SetupStateService } from './application/setup/setup-check.service'
import type { ConfigService } from './config/config.service'
import type { ChainReader } from './infrastructure/setup-state/viem-setup-state.service'

import { PositionBootstrapService } from './application/bootstrap/position-bootstrap.service'
import { SetupCheckService } from './application/setup/setup-check.service'
import { VersionService } from './application/version.service'
import { ConfigService as RuntimeConfigService } from './config/config.service'
import { createBootstrapGroupOwnership } from './infrastructure/bootstrap/bootstrap-group-ownership.utils'
import { createProductionBootstrapAdapters } from './infrastructure/bootstrap/production-bootstrap'
import { Cli } from './infrastructure/cli/cli'
import { ReadOnlyBootstrapMakeService } from './infrastructure/make/read-only-bootstrap-make.service'
import { requestJson } from './infrastructure/setup-state/http-json.utils'
import { ViemSetupStateService } from './infrastructure/setup-state/viem-setup-state.service'

type Environment = Record<string, string | undefined>

type PositionBootstrapRunner = {
  runOnce(): Promise<unknown>
}

type LadderRunner = {
  runOnce(): Promise<unknown>
}

type Dependencies = {
  createState?: (config: ConfigService) => SetupStateService
  /** Creates the write-enabled position-bootstrap service; read-only mode always composes guarded ports. */
  createBootstrap?: (config: ConfigService) => PositionBootstrapRunner
  /** Creates the ladder market-maker application service after CLI configuration is loaded. */
  createLadder?: (config: ConfigService) => LadderRunner
  /** Replaces provider ports while retaining default application-service composition. */
  createBootstrapAdapters?: (config: ConfigService) => {
    positions: BootstrapPositionService
    rates: BootstrapReferenceRateService
    make: BootstrapMakeService
  }
  /** Overrides the process working directory used for default configuration discovery. */
  cwd?: string
}

const chainReader = (rpcUrl: string, timeout: number): ChainReader => {
  const client = createPublicClient({ chain: base, transport: http(rpcUrl, { timeout }) })
  return {
    getChainId: () => client.getChainId(),
    getCode: parameters => client.getCode(parameters),
    getBalance: parameters => client.getBalance(parameters),
    getBlock: parameters =>
      parameters.blockNumber === undefined
        ? client.getBlock({ blockTag: 'latest' })
        : client.getBlock({ blockNumber: parameters.blockNumber }),
    readContract: parameters => client.readContract(parameters as never)
  }
}

const defaultState = (config: ConfigService) => {
  const identityOptions = config.identity.readOnly
    ? { readOnly: true as const, maker: config.identity.maker }
    : { readOnly: false as const, privateKey: config.identity.privateKey }
  const ownership = createBootstrapGroupOwnership({
    maker: config.setup.maker,
    marketIds: config.setup.marketIds,
    configuredGroupIds: config.v0OfferGroupIds
  })

  return new ViemSetupStateService(
    chainReader(config.rpcUrl, config.requestTimeoutMs),
    chainReader(config.referenceRpcUrl, config.requestTimeoutMs),
    (url, provider, timeoutMs) =>
      requestJson(url, provider, Math.min(config.requestTimeoutMs, timeoutMs ?? Infinity)),
    {
      ...identityOptions,
      midnight: config.setup.midnight,
      loanAsset: config.setup.loanAsset,
      morphoApiBaseUrl: config.morphoApiBaseUrl,
      routerApiBaseUrl: config.routerApiBaseUrl,
      marketIds: config.setup.marketIds,
      referenceMarketId: config.setup.referenceMarketId,
      v0OfferGroupIds: config.v0OfferGroupIds,
      readOwnedGroupIds: ownership.read,
      requestTimeoutMs: config.requestTimeoutMs
    }
  )
}

/**
 * Composes the market-making CLI, setup-check, position-bootstrap, and optional ladder dependencies.
 * @param environment - Environment map used for lazy validated configuration.
 * @param dependencies - Optional adapters; `createLadder` exposes the ladder application path.
 * @returns An application exposing a single asynchronous CLI `run` boundary.
 * @remarks Composition is side-effect free. Configuration and provider construction occur lazily
 * for `setup-check`, `bootstrap`, or an exposed `ladder` command. Setup is read-only and preserves
 * concurrent independent reads through `Promise.all`. `--readonly` selects address-only identity
 * before any private-key validation and replaces the bootstrap mutation port with terminal output.
 * Writer commands assert readiness before constructing or running their application service; failed
 * readiness rejects without starting the writer. Bootstrap and ladder cycles run only for their
 * respective explicit commands.
 */
export const createApplication = (
  environment: Environment = Bun.env,
  dependencies: Dependencies = {}
): {
  /**
   * Executes one CLI invocation.
   * @param argv - User arguments without runtime/executable prefixes.
   * @returns Captured version text, setup-check JSON, position-bootstrap JSON, or ladder-cycle JSON.
   * @throws On invalid configuration or usage, provider or readiness failure, or a halted writer
   * cycle. Failed readiness prevents the selected writer's `runOnce()` side effect.
   */
  run(argv: readonly string[]): Promise<unknown>
} => {
  const loadConfig = (options: { configPath?: string; readOnly: boolean }) =>
    RuntimeConfigService.load(environment, {
      configPath: options.configPath,
      cwd: dependencies.cwd,
      readOnly: options.readOnly
    })
  const createLadder = dependencies.createLadder
  const cli = new Cli(
    new VersionService(),
    async options => {
      const config = await loadConfig(options)
      const state = dependencies.createState?.(config) ?? defaultState(config)
      return new SetupCheckService(state, config.setup, config.readOnly)
    },
    async options => {
      const config = await loadConfig(options)
      const state = dependencies.createState?.(config) ?? defaultState(config)
      await new SetupCheckService(state, config.setup, config.readOnly).assertReady()
      if (dependencies.createBootstrap && !config.readOnly) {
        return dependencies.createBootstrap(config)
      }
      const injectedAdapters = dependencies.createBootstrapAdapters?.(config)
      const adapters = injectedAdapters ?? createProductionBootstrapAdapters(config)
      const make =
        config.readOnly && injectedAdapters ? new ReadOnlyBootstrapMakeService() : adapters.make
      return new PositionBootstrapService(
        adapters.positions,
        adapters.rates,
        make,
        config.bootstrap
      )
    },
    createLadder
      ? async options => {
          const config = await loadConfig(options)
          const state = dependencies.createState?.(config) ?? defaultState(config)
          await new SetupCheckService(state, config.setup, config.readOnly).assertReady()
          return createLadder(config)
        }
      : undefined
  )

  return {
    run: (argv: readonly string[]) => cli.run(argv)
  }
}
