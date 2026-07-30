import type { Address, Hex } from 'viem'

import { describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SetupStateService } from '../src/application/setup/setup-check.service'

import { SetupFailedError } from '../src/application/setup/setup-failed.error'
import { createApplication } from '../src/bootstrap'
import { CliUsageError } from '../src/infrastructure/cli/cli-usage.error'

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
const ladderConfiguration = {
  marketId,
  quotePremiumBps: '0',
  spreadBps: '200',
  stepBps: '100',
  rungCount: '2',
  sizeSkewBps: '0',
  lowerRateBudgetAssets: '10',
  higherRateBudgetAssets: '10',
  targetMarketExposureAssets: '20',
  maximumTotalExposureAssets: '20',
  groupMode: 'shared-rung',
  loopIntervalSeconds: '3600',
  movementToleranceBps: '10',
  minimumRateBps: '100',
  maximumRateBps: '1000'
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

    const output = await application.run(['setup-check'])

    expect(output).toMatchObject({ ready: true })
    expect((output as { checks: unknown[] }).checks).toHaveLength(9)
  })

  test('mm bootstrap passes readiness before composing one bootstrap cycle', async () => {
    const events: string[] = []
    const state = readyState()
    state.getChainId = async () => {
      events.push('readiness')
      return 8453
    }
    const application = createApplication(environment, {
      createState: () => state,
      createBootstrapAdapters: () => {
        events.push('bootstrap')
        return {
          positions: {
            readPosition: async () => ({
              credit: 0n,
              debt: 0n,
              cashBalance: 0n,
              marketExposure: 0n,
              totalExposure: 0n
            })
          },
          rates: {
            readRate: async () => ({
              mode: 'static',
              rateBps: 500n,
              observationId: 'static:500'
            })
          },
          make: {
            reconcile: async () => {},
            hardHalt: async () => {},
            cleanup: async () => {}
          }
        }
      }
    })

    expect(await application.run(['bootstrap'])).toEqual([])
    expect(events).toEqual(['readiness', 'bootstrap'])
  })

  test('mm ladder passes readiness before running one ladder cycle', async () => {
    const events: string[] = []
    const state = readyState()
    state.getChainId = async () => {
      events.push('readiness')
      return 8453
    }
    const application = createApplication(
      { ...environment, LADDER_MARKETS: JSON.stringify([ladderConfiguration]) },
      {
        createState: () => state,
        createLadderAdapters: () => ({
          positions: {
            readMarket: async () => {
              events.push('ladder')
              return {}
            }
          },
          rates: { readRate: async () => 500n },
          make: {
            readActive: async () => undefined,
            reconcile: async () => {},
            hardHalt: async () => {}
          }
        })
      }
    )

    expect(await application.run(['ladder'])).toEqual([
      { marketId, status: 'applied', action: 'publish', reason: 'publish' }
    ])
    expect(events).toEqual(['readiness', 'ladder'])
  })

  test('keeps the ladder command hidden until runtime adapters are composed', async () => {
    let readinessReads = 0
    const state = readyState()
    state.getChainId = async () => {
      readinessReads += 1
      return 8453
    }
    const application = createApplication(environment, { createState: () => state })

    const error = await application.run(['ladder']).catch(value => value)

    expect(error).toBeInstanceOf(CliUsageError)
    expect(readinessReads).toBe(0)
  })

  test('default-composes PositionBootstrapService when only its production ports are replaced', async () => {
    const application = createApplication(environment, {
      createState: readyState,
      createBootstrapAdapters: () => ({
        positions: {
          readPosition: async () => ({
            credit: 1_000n,
            debt: 0n,
            cashBalance: 1_000n,
            marketExposure: 0n,
            totalExposure: 0n
          })
        },
        rates: {
          readRate: async () => ({ mode: 'static', rateBps: 500n, observationId: 'static:500' })
        },
        make: {
          reconcile: async () => {},
          hardHalt: async () => {},
          cleanup: async () => {}
        }
      })
    })

    expect(await application.run(['bootstrap'])).toEqual([])
  })

  test('wires --readonly without loading a maker private key', async () => {
    const observedModes: boolean[] = []
    const application = createApplication(
      { ...environment, MAKER_PRIVATE_KEY: undefined },
      {
        createState: config => {
          observedModes.push(config.readOnly)
          return readyState()
        }
      }
    )

    const output = await application.run(['--readonly', 'setup-check'])

    expect(observedModes).toEqual([true])
    expect(output).toMatchObject({ ready: true })
    expect(
      (output as { checks: { status: string }[] }).checks.slice(1, 5).map(check => check.status)
    ).toEqual(['not-required', 'passed', 'passed', 'passed'])
  })

  test('routes --readonly bootstrap make operations to terminal output', async () => {
    const reconcile = mock(async () => {})
    const hardHalt = mock(async () => {})
    const terminal = spyOn(console, 'log').mockImplementation(() => {})
    const bootstrapEnvironment = {
      ...environment,
      MAKER_PRIVATE_KEY: undefined,
      BOOTSTRAP_MARKETS: JSON.stringify([
        {
          marketId,
          creditTarget: '100',
          acceptanceAssets: '0',
          offerSize: '10',
          premiumBps: '0',
          maximumMarketExposure: '100',
          maximumTotalExposure: '100',
          minimumRateBps: '100',
          maximumRateBps: '1000',
          autoRefill: false
        }
      ])
    }
    const application = createApplication(bootstrapEnvironment, {
      createState: readyState,
      createBootstrapAdapters: () => ({
        positions: {
          readPosition: async () => ({
            credit: 0n,
            debt: 0n,
            cashBalance: 100n,
            marketExposure: 0n,
            totalExposure: 0n
          })
        },
        rates: {
          readRate: async () => ({ mode: 'static', rateBps: 500n, observationId: 'static:500' })
        },
        make: { reconcile, hardHalt, cleanup: async () => {} }
      })
    })

    try {
      expect(await application.run(['--readonly', 'bootstrap'])).toEqual([
        { marketId, status: 'logged', action: 'publish' }
      ])
      expect(reconcile).not.toHaveBeenCalled()
      expect(hardHalt).not.toHaveBeenCalled()
      expect(terminal).toHaveBeenCalledWith(expect.stringContaining('"event":"readonly.make"'))
    } finally {
      terminal.mockRestore()
    }
  })

  test('routes --readonly ladder make operations to terminal output', async () => {
    const reconcile = mock(async () => {})
    const hardHalt = mock(async () => {})
    const terminal = spyOn(console, 'log').mockImplementation(() => {})
    const application = createApplication(
      {
        ...environment,
        MAKER_PRIVATE_KEY: undefined,
        LADDER_MARKETS: JSON.stringify([ladderConfiguration])
      },
      {
        createState: readyState,
        createLadderAdapters: () => ({
          positions: { readMarket: async () => ({}) },
          rates: { readRate: async () => 500n },
          make: {
            readActive: async () => undefined,
            reconcile,
            hardHalt
          }
        })
      }
    )

    try {
      expect(await application.run(['--readonly', 'ladder'])).toEqual([
        { marketId, status: 'logged', action: 'publish', reason: 'publish' }
      ])
      expect(reconcile).not.toHaveBeenCalled()
      expect(hardHalt).not.toHaveBeenCalled()
      expect(terminal).toHaveBeenCalledWith(
        expect.stringContaining('"event":"readonly.make","workflow":"ladder"')
      )
    } finally {
      terminal.mockRestore()
    }
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
