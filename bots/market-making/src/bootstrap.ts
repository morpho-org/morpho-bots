import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'

import type { SetupStateService } from './application/setup-check.service'
import type { ConfigService } from './config/config.service'
import type { ChainReader } from './infrastructure/setup-state/viem-setup-state.service'

import { SetupCheckService } from './application/setup-check.service'
import { VersionService } from './application/version.service'
import { ConfigService as RuntimeConfigService } from './config/config.service'
import { Cli } from './infrastructure/cli/cli'
import {
  requestJson,
  ViemSetupStateService
} from './infrastructure/setup-state/viem-setup-state.service'

type Environment = Record<string, string | undefined>

type Dependencies = {
  createState?: (config: ConfigService) => SetupStateService
}

function chainReader(rpcUrl: string, timeout: number): ChainReader {
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

function defaultState(config: ConfigService) {
  return new ViemSetupStateService(
    chainReader(config.rpcUrl, config.requestTimeoutMs),
    chainReader(config.referenceRpcUrl, config.requestTimeoutMs),
    (url, provider) => requestJson(url, provider, config.requestTimeoutMs),
    {
      privateKey: config.privateKey,
      midnight: config.setup.midnight,
      loanAsset: config.setup.loanAsset,
      morphoApiBaseUrl: config.morphoApiBaseUrl,
      routerApiBaseUrl: config.routerApiBaseUrl,
      marketIds: config.setup.marketIds,
      referenceMarketId: config.setup.referenceMarketId,
      v0OfferGroupIds: config.v0OfferGroupIds
    }
  )
}

export function createApplication(
  environment: Environment = Bun.env,
  dependencies: Dependencies = {}
) {
  const cli = new Cli(new VersionService(), () => {
    const config = RuntimeConfigService.from(environment)
    const state = dependencies.createState?.(config) ?? defaultState(config)
    return new SetupCheckService(state, config.setup)
  })

  return {
    run: (argv: readonly string[]) => cli.run(argv)
  }
}
