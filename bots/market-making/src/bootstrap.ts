import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'

import type { SetupStateService } from './application/setup-check.service'
import type { ConfigService } from './config/config.service'
import type { ChainReader } from './infrastructure/setup-state/viem-setup-state.service'

import { SetupCheckService } from './application/setup-check.service'
import { VersionService } from './application/version.service'
import { ConfigService as RuntimeConfigService } from './config/config.service'
import { Cli } from './infrastructure/cli/cli'
import { requestJson } from './infrastructure/setup-state/http-json.utils'
import { ViemSetupStateService } from './infrastructure/setup-state/viem-setup-state.service'

type Environment = Record<string, string | undefined>

type Dependencies = {
  createState?: (config: ConfigService) => SetupStateService
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
  return new ViemSetupStateService(
    chainReader(config.rpcUrl, config.requestTimeoutMs),
    chainReader(config.referenceRpcUrl, config.requestTimeoutMs),
    (url, provider, timeoutMs) =>
      requestJson(url, provider, Math.min(config.requestTimeoutMs, timeoutMs ?? Infinity)),
    {
      privateKey: config.privateKey,
      midnight: config.setup.midnight,
      loanAsset: config.setup.loanAsset,
      morphoApiBaseUrl: config.morphoApiBaseUrl,
      routerApiBaseUrl: config.routerApiBaseUrl,
      marketIds: config.setup.marketIds,
      referenceMarketId: config.setup.referenceMarketId,
      v0OfferGroupIds: config.v0OfferGroupIds,
      requestTimeoutMs: config.requestTimeoutMs
    }
  )
}

/**
 * Composes the market-making CLI and its setup-check dependencies.
 * @param environment - Environment map used for lazy validated configuration.
 * @param dependencies - Optional test adapters; production defaults to viem and HTTP readers.
 * @returns An application exposing a single asynchronous CLI `run` boundary.
 * @remarks Composition is side-effect free. Configuration and provider construction occur lazily
 * for `setup-check`; the setup implementation is read-only and preserves concurrent independent
 * reads through `Promise.all`.
 */
export const createApplication = (
  environment: Environment = Bun.env,
  dependencies: Dependencies = {}
): {
  /**
   * Executes one CLI invocation.
   * @param argv - User arguments without runtime/executable prefixes.
   * @returns Captured version text or setup-check JSON.
   * @throws On invalid configuration, unknown commands, provider failures, or failed readiness.
   */
  run(argv: readonly string[]): Promise<string>
} => {
  const cli = new Cli(new VersionService(), async options => {
    const config = await RuntimeConfigService.load(environment, {
      configPath: options.configPath,
      cwd: dependencies.cwd
    })
    const state = dependencies.createState?.(config) ?? defaultState(config)
    return new SetupCheckService(state, config.setup)
  })

  return {
    run: (argv: readonly string[]) => cli.run(argv)
  }
}
