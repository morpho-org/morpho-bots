import type { Address, Hex } from 'viem'

import { describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  SetupCheckReport,
  SetupStateService
} from '../src/application/setup/setup-check.service'

import { SetupFailedError } from '../src/application/setup/setup-failed.error'
import { createApplication } from '../src/bootstrap'
import { ConfigValidationError } from '../src/config/config-validation.error'

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
  minimumOfferAssets: '1',
  groupMode: 'shared-rung',
  loopIntervalSeconds: '3600',
  movementToleranceBps: '10',
  minimumRateBps: '100',
  maximumRateBps: '1000'
}
const bootstrapConfiguration = {
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
      surfaceMatches: true,
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

  test('composes explicit invalidation without the offer-readiness gate', async () => {
    const groupId: Hex = `0x${'12'.repeat(32)}`
    const txHash: Hex = `0x${'ab'.repeat(32)}`
    const events: string[] = []
    const application = createApplication(environment, {
      createState: () => {
        throw new Error('setup state must not be constructed')
      },
      createInvalidationPort: config => ({
        mode: () => (config.readOnly ? 'readonly' : 'write'),
        preflight: async () => {
          events.push('preflight')
        },
        listActiveGroupIds: async () => {
          events.push('list')
          return [groupId]
        },
        invalidateBatch: async groupIds => {
          events.push(`invalidateBatch:${groupIds.join(',')}`)
          return txHash
        },
        invalidate: async selectedGroupId => {
          events.push(`invalidate:${selectedGroupId}`)
          return txHash
        },
        forgetGroups: async groupIds => {
          events.push(`forget:${groupIds.join(',')}`)
        }
      })
    })

    expect(await application.run(['invalidate'])).toEqual({
      status: 'applied',
      scope: 'all',
      matchedGroups: 1,
      invalidatedGroups: [{ groupId, txHash }]
    })
    expect(events).toEqual(['preflight', 'list', `invalidateBatch:${groupId}`, `forget:${groupId}`])
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

  test('starts a hardcoded-only bootstrap workflow without Blue reference readiness', async () => {
    const state = readyState()
    const checkReference = mock(async () => {
      throw new Error('Blue archive unavailable')
    })
    state.checkReference = checkReference
    const application = createApplication(
      {
        ...environment,
        REFERENCE_RPC_URL: undefined,
        REFERENCE_MARKET_ID: undefined,
        BOOTSTRAP_MARKETS: JSON.stringify([
          {
            ...bootstrapConfiguration,
            targetRate: { strategy: 'hardcoded', hardcodedRateBps: '400' }
          }
        ]),
        LADDER_MARKETS: JSON.stringify([
          {
            ...ladderConfiguration,
            targetRate: { strategy: 'variable_rate_avg' }
          }
        ])
      },
      {
        createState: () => state,
        createBootstrapAdapters: () => ({
          positions: {
            readPosition: async () => ({
              credit: 100n,
              debt: 0n,
              cashBalance: 0n,
              marketExposure: 100n,
              totalExposure: 100n
            })
          },
          rates: {
            readRate: async () => ({ mode: 'static', rateBps: 400n, observationId: 'static:400' })
          },
          make: {
            reconcile: async () => {},
            hardHalt: async () => {},
            cleanup: async () => {}
          }
        })
      }
    )

    await expect(application.run(['bootstrap'])).resolves.toBeDefined()
    expect(checkReference).not.toHaveBeenCalled()
    await expect(application.run(['ladder'])).rejects.toBeInstanceOf(ConfigValidationError)
  })

  test('keeps Blue reference readiness fail-closed for variable-rate bootstrap workflows', async () => {
    const state = readyState()
    const checkReference = mock(async () => {
      throw new Error('Blue archive unavailable')
    })
    state.checkReference = checkReference
    const application = createApplication(
      {
        ...environment,
        BOOTSTRAP_MARKETS: JSON.stringify([
          {
            ...bootstrapConfiguration,
            targetRate: { strategy: 'variable_rate_avg' }
          }
        ])
      },
      { createState: () => state }
    )

    await expect(application.run(['bootstrap'])).rejects.toBeInstanceOf(SetupFailedError)
    expect(checkReference).toHaveBeenCalledTimes(1)
  })

  test('keeps Blue reference readiness fail-closed for variable-rate ladder workflows', async () => {
    const state = readyState()
    const checkReference = mock(async () => {
      throw new Error('Blue archive unavailable')
    })
    const createLadderAdapters = mock(() => {
      throw new Error('ladder adapters must not start')
    })
    state.checkReference = checkReference
    const application = createApplication(
      {
        ...environment,
        BOOTSTRAP_MARKETS: '[]',
        LADDER_MARKETS: JSON.stringify([
          {
            ...ladderConfiguration,
            targetRate: { strategy: 'variable_rate_avg' }
          }
        ])
      },
      { createState: () => state, createLadderAdapters }
    )

    await expect(application.run(['ladder'])).rejects.toBeInstanceOf(SetupFailedError)
    expect(checkReference).toHaveBeenCalledTimes(1)
    expect(createLadderAdapters).not.toHaveBeenCalled()
  })

  test('starts a hardcoded-only ladder workflow without Blue reference readiness', async () => {
    const state = readyState()
    const checkReference = mock(async () => {
      throw new Error('Blue archive unavailable')
    })
    state.checkReference = checkReference
    const application = createApplication(
      {
        ...environment,
        REFERENCE_RPC_URL: undefined,
        REFERENCE_MARKET_ID: undefined,
        BOOTSTRAP_MARKETS: JSON.stringify([
          {
            ...bootstrapConfiguration,
            targetRate: { strategy: 'variable_rate_avg' }
          }
        ]),
        LADDER_MARKETS: JSON.stringify([
          {
            ...ladderConfiguration,
            targetRate: { strategy: 'hardcoded', hardcodedRateBps: '475' }
          }
        ])
      },
      {
        createState: () => state,
        createLadderAdapters: () => ({
          positions: { readMarket: async () => ({}) },
          rates: { readRate: async () => 475n },
          make: {
            readActive: async () => undefined,
            reconcile: async () => {},
            hardHalt: async () => {},
            cleanup: async () => {}
          }
        })
      }
    )

    await expect(application.run(['ladder'])).resolves.toBeDefined()
    expect(checkReference).not.toHaveBeenCalled()
    await expect(application.run(['bootstrap'])).rejects.toBeInstanceOf(ConfigValidationError)
  })

  test('setup-check composes hardcoded bootstrap and ladder strategies without Blue reference readiness', async () => {
    const state = readyState()
    const checkReference = mock(async () => {
      throw new Error('Blue archive unavailable')
    })
    state.checkReference = checkReference
    const application = createApplication(
      {
        ...environment,
        REFERENCE_RPC_URL: undefined,
        REFERENCE_MARKET_ID: undefined,
        BOOTSTRAP_MARKETS: JSON.stringify([
          {
            ...bootstrapConfiguration,
            targetRate: { strategy: 'hardcoded', hardcodedRateBps: '400' }
          }
        ]),
        LADDER_MARKETS: JSON.stringify([
          {
            ...ladderConfiguration,
            targetRate: { strategy: 'hardcoded', hardcodedRateBps: '475' }
          }
        ])
      },
      { createState: () => state }
    )

    const report = (await application.run(['setup-check'])) as SetupCheckReport

    expect(report.ready).toBe(true)
    expect(report.checks.find(check => check.name === 'reference')).toMatchObject({
      status: 'not-required',
      observed: { reason: 'no variable_rate_avg target-rate strategy is active' }
    })
    expect(checkReference).not.toHaveBeenCalled()
  })

  test('setup-check fails closed when the bootstrap and ladder strategy union requires Blue', async () => {
    const application = createApplication(
      {
        ...environment,
        REFERENCE_RPC_URL: undefined,
        REFERENCE_MARKET_ID: undefined,
        BOOTSTRAP_MARKETS: JSON.stringify([
          {
            ...bootstrapConfiguration,
            targetRate: { strategy: 'variable_rate_avg' }
          }
        ]),
        LADDER_MARKETS: JSON.stringify([
          {
            ...ladderConfiguration,
            targetRate: { strategy: 'hardcoded', hardcodedRateBps: '475' }
          }
        ])
      },
      { createState: readyState }
    )

    await expect(application.run(['setup-check'])).rejects.toBeInstanceOf(ConfigValidationError)
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
            hardHalt: async () => {},
            cleanup: async () => {}
          }
        })
      }
    )

    expect(await application.run(['ladder'])).toEqual([
      { marketId, status: 'applied', action: 'publish', reason: 'publish' }
    ])
    expect(events).toEqual(['readiness', 'ladder'])
  })

  test('default-composes the ladder command and rejects an empty ladder config', async () => {
    let readinessReads = 0
    const state = readyState()
    state.getChainId = async () => {
      readinessReads += 1
      return 8453
    }
    const application = createApplication(environment, { createState: () => state })

    const error = await application.run(['ladder']).catch(value => value)

    expect(error).toMatchObject({
      name: 'LadderConfigurationError',
      field: 'ladder'
    })
    expect(readinessReads).toBe(1)
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
    const events: unknown[] = []
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

    expect(
      await application.run(['--readonly', 'bootstrap'], {
        writeEvent: event => {
          events.push(event)
        }
      })
    ).toEqual([{ marketId, status: 'logged', action: 'publish' }])
    expect(reconcile).not.toHaveBeenCalled()
    expect(hardHalt).not.toHaveBeenCalled()
    expect(events).toEqual([
      expect.objectContaining({ event: 'readonly.make', workflow: 'bootstrap' })
    ])
  })

  test('waits for async read-only bootstrap event writes before completing the command', async () => {
    const writeStarted = Promise.withResolvers<void>()
    const releaseWrite = Promise.withResolvers<void>()
    const application = createApplication(
      {
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
      },
      {
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
            readRate: async () => ({
              mode: 'static',
              rateBps: 500n,
              observationId: 'static:500'
            })
          },
          make: { reconcile: async () => {}, hardHalt: async () => {}, cleanup: async () => {} }
        })
      }
    )
    const run = application.run(['--readonly', 'bootstrap'], {
      writeEvent: async () => {
        writeStarted.resolve()
        await releaseWrite.promise
      }
    })
    await writeStarted.promise
    const state = await Promise.race([
      run.then(() => 'completed' as const),
      Bun.sleep(20).then(() => 'pending' as const)
    ])
    releaseWrite.resolve()

    expect(state).toBe('pending')
    expect(await run).toEqual([{ marketId, status: 'logged', action: 'publish' }])
  })

  test('routes --readonly ladder make operations to terminal output', async () => {
    const reconcile = mock(async () => {})
    const hardHalt = mock(async () => {})
    const validateReconcile = mock(async () => {})
    const events: unknown[] = []
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
            hardHalt,
            cleanup: async () => {}
          },
          validateReconcile
        })
      }
    )

    expect(
      await application.run(['--readonly', 'ladder'], {
        writeEvent: event => {
          events.push(event)
        }
      })
    ).toEqual([{ marketId, status: 'logged', action: 'publish', reason: 'publish' }])
    expect(reconcile).not.toHaveBeenCalled()
    expect(hardHalt).not.toHaveBeenCalled()
    expect(validateReconcile).toHaveBeenCalledWith(
      expect.objectContaining({ marketId, reason: 'publish' })
    )
    expect(events).toEqual([
      expect.objectContaining({ event: 'readonly.make', workflow: 'ladder' })
    ])
  })

  test('rejects the read-only ladder command when an async event write rejects', async () => {
    const writeError = new Error('event sink unavailable')
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
            reconcile: async () => {},
            hardHalt: async () => {},
            cleanup: async () => {}
          }
        })
      }
    )

    expect(
      application.run(['--readonly', 'ladder'], {
        writeEvent: async () => {
          throw writeError
        }
      })
    ).rejects.toMatchObject({
      name: 'LadderCycleHaltedError',
      code: 'LADDER_CYCLE_HALTED'
    })
  })

  test('runs the exact read-only ladder monitor surface without loading or invoking a signer', async () => {
    const reconcile = mock(async () => {})
    const hardHalt = mock(async () => {})
    const cleanup = mock(async () => {})
    const terminal = spyOn(console, 'log').mockImplementation(() => {})
    const controller = new AbortController()
    controller.abort()
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
            hardHalt,
            cleanup
          }
        })
      }
    )

    try {
      expect(
        await application.run(['ladder', '--monitor', '--verbose', '--readonly'], {
          signal: controller.signal
        })
      ).toEqual({
        status: 'stopped',
        reason: 'signal',
        cycles: 0,
        cleanup: { status: 'logged' }
      })
      expect(reconcile).not.toHaveBeenCalled()
      expect(hardHalt).not.toHaveBeenCalled()
      expect(cleanup).not.toHaveBeenCalled()
      expect(terminal).toHaveBeenCalledWith(
        expect.stringContaining('"event":"readonly.make","workflow":"ladder","operation":"cleanup"')
      )
    } finally {
      terminal.mockRestore()
    }
  })

  test('composes the combined start lifecycle and drains both writer cleanups', async () => {
    const bootstrapCleanup = mock(async () => {})
    const ladderCleanup = mock(async () => {})
    const controller = new AbortController()
    controller.abort()
    const application = createApplication(
      {
        ...environment,
        BOOTSTRAP_MARKETS: JSON.stringify([bootstrapConfiguration]),
        LADDER_MARKETS: JSON.stringify([ladderConfiguration])
      },
      {
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
            readRate: async () => ({
              mode: 'static',
              rateBps: 500n,
              observationId: 'static:500'
            })
          },
          make: {
            reconcile: async () => {},
            hardHalt: async () => {},
            cleanup: bootstrapCleanup
          }
        }),
        createLadderAdapters: () => ({
          positions: { readMarket: async () => ({}) },
          rates: { readRate: async () => 500n },
          make: {
            readActive: async () => undefined,
            reconcile: async () => {},
            hardHalt: async () => {},
            cleanup: ladderCleanup
          }
        })
      }
    )

    expect(await application.run(['start'], { signal: controller.signal })).toEqual({
      status: 'stopped',
      reason: 'signal',
      workflows: {
        setupCheck: {
          status: 'fulfilled',
          report: { status: 'stopped', reason: 'signal', cycles: 0 }
        },
        bootstrap: {
          status: 'fulfilled',
          report: {
            status: 'stopped',
            reason: 'signal',
            cycles: 0,
            cleanup: { status: 'applied' }
          }
        },
        ladder: {
          status: 'fulfilled',
          report: {
            status: 'stopped',
            reason: 'signal',
            cycles: 0,
            cleanup: { status: 'applied' }
          }
        }
      }
    })
    expect(bootstrapCleanup).toHaveBeenCalledTimes(1)
    expect(ladderCleanup).toHaveBeenCalledTimes(1)
  })

  test('combined start composes hardcoded bootstrap and ladder workflows without Blue reference readiness', async () => {
    const checkReference = mock(async () => {
      throw new Error('Blue archive unavailable')
    })
    const state = readyState()
    state.checkReference = checkReference
    const started: string[] = []
    const controller = new AbortController()
    controller.abort()
    const application = createApplication(
      {
        ...environment,
        REFERENCE_RPC_URL: undefined,
        REFERENCE_MARKET_ID: undefined,
        BOOTSTRAP_MARKETS: JSON.stringify([
          {
            ...bootstrapConfiguration,
            targetRate: { strategy: 'hardcoded', hardcodedRateBps: '400' }
          }
        ]),
        LADDER_MARKETS: JSON.stringify([
          {
            ...ladderConfiguration,
            targetRate: { strategy: 'hardcoded', hardcodedRateBps: '475' }
          }
        ])
      },
      {
        createState: () => state,
        createBootstrapAdapters: () => {
          started.push('bootstrap')
          return {
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
              readRate: async () => ({
                mode: 'static',
                rateBps: 400n,
                observationId: 'static:400'
              })
            },
            make: {
              reconcile: async () => {},
              hardHalt: async () => {},
              cleanup: async () => {}
            }
          }
        },
        createLadderAdapters: () => {
          started.push('ladder')
          return {
            positions: { readMarket: async () => ({}) },
            rates: { readRate: async () => 475n },
            make: {
              readActive: async () => undefined,
              reconcile: async () => {},
              hardHalt: async () => {},
              cleanup: async () => {}
            }
          }
        }
      }
    )

    const report = await application.run(['start'], { signal: controller.signal })

    expect(report).toMatchObject({
      status: 'stopped',
      workflows: {
        bootstrap: { status: 'fulfilled' },
        ladder: { status: 'fulfilled' }
      }
    })
    expect(started).toEqual(['bootstrap', 'ladder'])
    expect(checkReference).not.toHaveBeenCalled()
  })

  test('combined start fails closed when the bootstrap and ladder strategy union requires Blue', async () => {
    const started: string[] = []
    const application = createApplication(
      {
        ...environment,
        REFERENCE_RPC_URL: undefined,
        REFERENCE_MARKET_ID: undefined,
        BOOTSTRAP_MARKETS: JSON.stringify([
          {
            ...bootstrapConfiguration,
            targetRate: { strategy: 'hardcoded', hardcodedRateBps: '400' }
          }
        ]),
        LADDER_MARKETS: JSON.stringify([
          {
            ...ladderConfiguration,
            targetRate: { strategy: 'variable_rate_avg' }
          }
        ])
      },
      {
        createState: readyState,
        createBootstrapAdapters: () => {
          started.push('bootstrap')
          throw new Error('bootstrap must not start')
        },
        createLadderAdapters: () => {
          started.push('ladder')
          throw new Error('ladder must not start')
        }
      }
    )

    await expect(application.run(['start'])).rejects.toBeInstanceOf(ConfigValidationError)
    expect(started).toEqual([])
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
