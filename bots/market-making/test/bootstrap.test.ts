import type { Address, Hex } from 'viem'

import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SetupStateService } from '../src/application/setup/setup-check.service'

import { SetupFailedError } from '../src/application/setup/setup-failed.error'
import { createApplication } from '../src/bootstrap'

const maker: Address = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const midnight: Address = '0x2222222222222222222222222222222222222222'
const loanAsset: Address = '0x3333333333333333333333333333333333333333'
const ratifier: Address = '0xd6e70365C8E8DDa9a4ca662C07bbE663b017755E'
const marketId: Hex = `0x${'55'.repeat(32)}`
const referenceMarketId: Hex = `0x${'77'.repeat(32)}`
const environment = {
  CHAIN_ID: '8453',
  RPC_URL: 'https://rpc.example',
  REFERENCE_RPC_URL: 'https://archive.example',
  MAKER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
  MAKER_ADDRESS: maker,
  MIDNIGHT_ADDRESS: midnight,
  LOAN_ASSET_ADDRESS: loanAsset,
  RATIFIER_ADDRESS: ratifier,
  MARKET_IDS: marketId,
  REFERENCE_MARKET_ID: referenceMarketId,
  NATIVE_RESERVE_WEI: '10',
  MAXIMUM_LEND_EXPOSURE_ASSETS: '100',
  MORPHO_API_BASE_URL: 'https://api.example',
  ROUTER_API_BASE_URL: 'https://router.example'
}

const readyState = (): SetupStateService => {
  return {
    getChainId: async () => 8453,
    getCode: async () => '0x1234',
    getDerivedMaker: async () => maker,
    getNativeBalance: async () => 10n,
    getLoanAllowance: async () => ({ spender: midnight, amount: 100n }),
    getRatifier: async () => ({
      listed: true,
      deployed: true,
      midnightMatches: true,
      ecrecoverSurface: true,
      authorized: true
    }),
    getBook: async id => ({
      id,
      allowlisted: true,
      active: true,
      loanAsset,
      tickSpacing: 4,
      maturity: 2_000n
    }),
    getLatestTimestamp: async () => 1_000n,
    checkReference: async () => ({
      marketId: referenceMarketId,
      referenceReadable: true,
      archiveReadable: true
    }),
    inspectOffers: async () => ({
      unknownNamespaces: [],
      unknownMarketIds: [],
      invertedMarketIds: []
    }),
    checkPositionHealth: async () => ({ status: 'not-required', reason: 'V0 has no debt' })
  }
}

describe('createApplication', () => {
  test('wires configuration, setup service, and operator CLI through the composition root', async () => {
    const application = createApplication(environment, { createState: readyState })

    const output = JSON.parse(await application.run(['setup-check']))

    expect(output.ready).toBe(true)
    expect(output.checks).toHaveLength(9)
  })

  test('wires explicit --config and default working-directory discovery into startup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'market-making-bootstrap-'))
    const configuration = `
chain:
  id: 8453
  rpcUrl: https://yaml-rpc.example
  archiveRpcUrl: https://archive.example
identity:
  makerAddress: "${maker}"
  makerPrivateKey: "${environment.MAKER_PRIVATE_KEY}"
contracts:
  midnightAddress: "${midnight}"
  loanAssetAddress: "${loanAsset}"
  ratifierAddress: "${ratifier}"
apis:
  morphoBaseUrl: https://api.example
  routerBaseUrl: https://router.example
markets:
  allowlist: ["${marketId}"]
  referenceMarketId: "${referenceMarketId}"
setup:
  nativeReserveWei: "10"
  maximumLendExposureAssets: "100"
`
    try {
      await writeFile(join(directory, 'market-making.yml'), configuration)
      await writeFile(
        join(directory, 'explicit.yaml'),
        configuration.replace('yaml-rpc', 'explicit-rpc')
      )
      const observed: string[] = []
      const application = createApplication(
        {},
        {
          cwd: directory,
          createState: config => {
            observed.push(config.rpcUrl)
            return readyState()
          }
        }
      )

      await application.run(['setup-check'])
      await application.run(['--config', 'explicit.yaml', 'setup-check'])

      expect(observed).toEqual(['https://yaml-rpc.example', 'https://explicit-rpc.example'])
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  test('rejects setup-check readiness before any writer workflow can start', async () => {
    const state = readyState()
    state.getChainId = async () => 1
    const application = createApplication(environment, { createState: () => state })

    expect(application.run(['setup-check'])).rejects.toBeInstanceOf(SetupFailedError)
  })
})
