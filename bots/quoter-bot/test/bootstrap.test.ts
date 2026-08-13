import type { Address, Hex } from 'viem'

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, test, vi } from 'vitest'

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

  test('applies CLI signer selection over environment configuration', async () => {
    let method: string | undefined
    const application = createApplication(
      { ...environment, AWS_KMS_KEY_ID: 'alias/cli-selected', AWS_REGION: 'eu-west-1' },
      {
        createState: config => {
          method = config.keyStorageMethod
          return readyState()
        }
      }
    )

    await application.run(['--aws', 'setup-check'])

    expect(method).toBe('aws')
  })

  test('CLI --interactive clears an environment keystore password', async () => {
    let password: string | undefined
    const application = createApplication(
      {
        ...environment,
        MAKER_PRIVATE_KEY: undefined,
        KEY_STORAGE_METHOD: 'keystore',
        KEYSTORE_PATH: '/environment/maker.json',
        KEYSTORE_PASSWORD: 'environment-password'
      },
      {
        readPassword: async () => ' interactive-password ',
        createState: config => {
          password =
            !config.identity.readOnly && config.identity.method === 'keystore'
              ? config.identity.password
              : undefined
          return readyState()
        }
      }
    )

    await application.run(['--keystore', '/cli/maker.json', '--interactive', 'setup-check'])

    expect(password).toBe(' interactive-password ')
  })

  test('CLI --password clears environment interactive mode', async () => {
    let password: string | undefined
    const application = createApplication(
      {
        ...environment,
        MAKER_PRIVATE_KEY: undefined,
        KEY_STORAGE_METHOD: 'keystore',
        KEYSTORE_PATH: '/environment/maker.json',
        KEYSTORE_INTERACTIVE: 'true'
      },
      {
        readPassword: async () => {
          throw new Error('interactive reader must not be called')
        },
        createState: config => {
          password =
            !config.identity.readOnly && config.identity.method === 'keystore'
              ? config.identity.password
              : undefined
          return readyState()
        }
      }
    )

    await application.run([
      '--keystore',
      '/cli/maker.json',
      '--password',
      ' cli-password ',
      'setup-check'
    ])

    expect(password).toBe(' cli-password ')
  })

  test.each([
    ['interactive', 'keystorePassword: yaml-password', ['--interactive'], ' prompted-password '],
    ['password', 'keystoreInteractive: true', ['--password', ' cli-password '], ' cli-password ']
  ])(
    'CLI --%s clears the opposite YAML keystore password mode',
    async (_mode, yamlPasswordMode, cliPasswordMode, expectedPassword) => {
      const directory = await mkdtemp(join(tmpdir(), 'quoter-bot-cli-precedence-'))
      const configPath = join(directory, 'operator.yaml')
      await writeFile(
        configPath,
        `chain:\n  id: 8453\n  rpcUrl: https://rpc.example\n  archiveRpcUrl: https://archive.example\nidentity:\n  makerAddress: ${maker}\n  keyStorageMethod: keystore\n  keystorePath: /yaml/maker.json\n  ${yamlPasswordMode}\ncontracts:\n  midnightAddress: ${midnight}\n  loanAssetAddress: ${loanAsset}\n  ratifierAddress: ${ratifier}\napis:\n  morphoBaseUrl: https://api.example\n  routerBaseUrl: https://router.example\nmarkets:\n  allowlist: [${marketId}]\n  referenceMarketId: ${referenceMarketId}\nsetup:\n  nativeReserveWei: 10\n  maximumLendExposureAssets: 100\n`
      )
      let password: string | undefined
      try {
        const application = createApplication(
          {},
          {
            readPassword: async () => ' prompted-password ',
            createState: config => {
              password =
                !config.identity.readOnly && config.identity.method === 'keystore'
                  ? config.identity.password
                  : undefined
              return readyState()
            }
          }
        )
        await application.run([
          '--config',
          configPath,
          '--keystore',
          '/cli/maker.json',
          ...cliPasswordMode,
          'setup-check'
        ])
        expect(password).toBe(expectedPassword)
      } finally {
        await rm(directory, { recursive: true })
      }
    }
  )

  test('rejects conflicting CLI signer selections', async () => {
    const application = createApplication(environment, { createState: readyState })
    await expect(
      application.run(['--private-key', `0x${'11'.repeat(32)}`, '--aws', 'setup-check'])
    ).rejects.toMatchObject({ field: 'KEY_STORAGE_METHOD', reason: 'conflicting-sources' })
  })

  test('rejects a CLI password without an explicit keystore path', async () => {
    const application = createApplication(environment, { createState: readyState })

    await expect(application.run(['--password', 'secret', 'setup-check'])).rejects.toMatchObject({
      code: 'INVALID_USAGE'
    })
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

  test('quoter-bot bootstrap passes readiness before composing one bootstrap cycle', async () => {
    const events: string[] = []
    const removedGroupId: Hex = `0x${'99'.repeat(32)}`
    const state = readyState()
    state.getChainId = async () => {
      events.push('readiness')
      return 8453
    }
    const environmentWithLadder = {
      ...environment,
      BOOTSTRAP_MARKETS: JSON.stringify([bootstrapConfiguration]),
      LADDER_MARKETS: JSON.stringify([ladderConfiguration])
    }
    const application = createApplication(environmentWithLadder, {
      createState: () => state,
      createLadderAdapters: () => ({
        positions: { readMarket: async () => ({}) },
        rates: { readRate: async () => 500n },
        make: {
          cleanupRemovedMarkets: async () => {
            events.push('cleanup')
            return [removedGroupId]
          },
          readActive: async () => undefined,
          reconcile: async () => {},
          hardHalt: async () => {},
          cleanup: async () => {}
        }
      }),
      createBootstrapAdapters: (_config, ignoredOfferGroupIds) => {
        events.push('bootstrap')
        expect(ignoredOfferGroupIds).toEqual([removedGroupId])
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

    expect(await application.run(['bootstrap'])).toEqual([
      { status: 'observed', marketId, action: 'no-capacity' }
    ])
    expect(events).toEqual(['cleanup', 'readiness', 'bootstrap'])
  })

  test('does not run a bootstrap cycle when shutdown arrives during bootstrap adapter composition', async () => {
    const controller = new AbortController()
    const reconcile = vi.fn(async () => {})
    const application = createApplication(
      {
        ...environment,
        BOOTSTRAP_MARKETS: JSON.stringify([bootstrapConfiguration]),
        LADDER_MARKETS: JSON.stringify([ladderConfiguration])
      },
      {
        createState: readyState,
        createLadderAdapters: () => ({
          positions: { readMarket: async () => ({}) },
          rates: { readRate: async () => 500n },
          make: {
            cleanupRemovedMarkets: async () => [],
            readActive: async () => undefined,
            reconcile: async () => {},
            hardHalt: async () => {},
            cleanup: async () => {}
          }
        }),
        createBootstrapAdapters: () => {
          controller.abort()
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
            make: { reconcile, hardHalt: async () => {}, cleanup: async () => {} }
          }
        }
      }
    )

    await expect(
      application.run(['bootstrap'], { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(reconcile).not.toHaveBeenCalled()
  })

  test('does not clean ladder publications when no bootstrap market is configured', async () => {
    const cleanupRemovedMarkets = vi.fn(async () => [marketId])
    const application = createApplication(
      {
        ...environment,
        BOOTSTRAP_MARKETS: '[]',
        LADDER_MARKETS: JSON.stringify([ladderConfiguration])
      },
      {
        createState: readyState,
        createLadderAdapters: () => ({
          positions: { readMarket: async () => ({}) },
          rates: { readRate: async () => 500n },
          make: {
            cleanupRemovedMarkets,
            readActive: async () => undefined,
            reconcile: async () => {},
            hardHalt: async () => {},
            cleanup: async () => {}
          }
        }),
        createBootstrapAdapters: () => ({
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
            readRate: async () => ({ mode: 'static', rateBps: 500n, observationId: 'static:500' })
          },
          make: {
            reconcile: async () => {},
            hardHalt: async () => {},
            cleanup: async () => {}
          }
        })
      }
    )

    await expect(application.run(['bootstrap'])).resolves.toEqual([])
    expect(cleanupRemovedMarkets).not.toHaveBeenCalled()
  })

  test('does not clean persisted ladder publications for a bootstrap-only configuration', async () => {
    const cleanupRemovedMarkets = vi.fn(async () => [marketId])
    const application = createApplication(
      {
        ...environment,
        BOOTSTRAP_MARKETS: JSON.stringify([bootstrapConfiguration]),
        LADDER_MARKETS: '[]'
      },
      {
        createState: readyState,
        createLadderAdapters: () => ({
          positions: { readMarket: async () => ({}) },
          rates: { readRate: async () => 500n },
          make: {
            cleanupRemovedMarkets,
            readActive: async () => undefined,
            reconcile: async () => {},
            hardHalt: async () => {},
            cleanup: async () => {}
          }
        }),
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
            readRate: async () => ({ mode: 'static', rateBps: 500n, observationId: 'static:500' })
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
    expect(cleanupRemovedMarkets).not.toHaveBeenCalled()
  })

  test('starts a hardcoded-only bootstrap workflow without Blue reference readiness', async () => {
    const state = readyState()
    const checkReference = vi.fn(async () => {
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
    const checkReference = vi.fn(async () => {
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

  test('cleans removed ladder markets before keeping Blue reference readiness fail-closed', async () => {
    const state = readyState()
    const checkReference = vi.fn(async () => {
      throw new Error('Blue archive unavailable')
    })
    const cleanupRemovedMarkets = vi.fn(async () => {})
    const createLadderAdapters = vi.fn(() => ({
      positions: { readMarket: async () => ({}) },
      rates: { readRate: async () => 500n },
      make: {
        cleanupRemovedMarkets,
        readActive: async () => undefined,
        reconcile: async () => {},
        hardHalt: async () => {},
        cleanup: async () => {}
      }
    }))
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
    expect(createLadderAdapters).toHaveBeenCalledTimes(1)
    expect(cleanupRemovedMarkets).toHaveBeenCalledTimes(1)
  })

  test('starts a hardcoded-only ladder workflow without Blue reference readiness', async () => {
    const state = readyState()
    const checkReference = vi.fn(async () => {
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
    const checkReference = vi.fn(async () => {
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

  test('quoter-bot ladder cleans removed markets before readiness and runs one ladder cycle', async () => {
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
            cleanupRemovedMarkets: async () => {
              events.push('cleanup')
            },
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
    expect(events).toEqual(['cleanup', 'readiness', 'cleanup', 'ladder'])
  })

  test('rejects an empty ladder config without cleaning persisted ladder publications', async () => {
    const events: string[] = []
    let readinessReads = 0
    const state = readyState()
    state.getChainId = async () => {
      events.push('readiness')
      readinessReads += 1
      return 8453
    }
    const application = createApplication(environment, {
      createState: () => state,
      createLadderAdapters: () => ({
        positions: { readMarket: async () => ({}) },
        rates: { readRate: async () => 500n },
        make: {
          cleanupRemovedMarkets: async () => {
            events.push('cleanup')
          },
          readActive: async () => undefined,
          reconcile: async () => {},
          hardHalt: async () => {},
          cleanup: async () => {}
        }
      })
    })

    const error = await application.run(['ladder']).catch(value => value)

    expect(error).toMatchObject({
      name: 'LadderConfigurationError',
      field: 'ladder'
    })
    expect(readinessReads).toBe(1)
    expect(events).toEqual(['readiness'])
  })

  test('rejects empty ladder monitoring without cleaning persisted ladder publications', async () => {
    const cleanupRemovedMarkets = vi.fn(async () => {})
    const application = createApplication(environment, {
      createState: readyState,
      createLadderAdapters: () => ({
        positions: { readMarket: async () => ({}) },
        rates: { readRate: async () => 500n },
        make: {
          cleanupRemovedMarkets,
          readActive: async () => undefined,
          reconcile: async () => {},
          hardHalt: async () => {},
          cleanup: async () => {}
        }
      })
    })

    await expect(application.run(['ladder', '--monitor'])).rejects.toMatchObject({
      name: 'LadderConfigurationError',
      field: 'ladder'
    })
    expect(cleanupRemovedMarkets).not.toHaveBeenCalled()
  })

  test('rejects an empty bootstrap before removed-market cleanup', async () => {
    const cleanupRemovedMarkets = vi.fn(async () => {})
    const application = createApplication(environment, {
      createLadderAdapters: () => ({
        positions: { readMarket: async () => ({}) },
        rates: { readRate: async () => 500n },
        make: {
          cleanupRemovedMarkets,
          readActive: async () => undefined,
          reconcile: async () => {},
          hardHalt: async () => {},
          cleanup: async () => {}
        }
      })
    })

    await expect(application.run(['start'])).rejects.toMatchObject({
      name: 'BootstrapConfigurationError',
      field: 'bootstrap'
    })
    expect(cleanupRemovedMarkets).not.toHaveBeenCalled()
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
    const reconcile = vi.fn(async () => {})
    const hardHalt = vi.fn(async () => {})
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
      sleep(20).then(() => 'pending' as const)
    ])
    releaseWrite.resolve()

    expect(state).toBe('pending')
    expect(await run).toEqual([{ marketId, status: 'logged', action: 'publish' }])
  })

  test('routes --readonly ladder make operations to terminal output', async () => {
    const reconcile = vi.fn(async () => {})
    const hardHalt = vi.fn(async () => {})
    const validateReconcile = vi.fn(async () => {})
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

    await expect(
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

  test('does not start the read-only ladder monitor after an aborted setup check', async () => {
    const reconcile = vi.fn(async () => {})
    const hardHalt = vi.fn(async () => {})
    const cleanup = vi.fn(async () => {})
    const terminal = vi.spyOn(console, 'log').mockImplementation(() => {})
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
      await expect(
        application.run(['ladder', '--monitor', '--verbose', '--readonly'], {
          signal: controller.signal
        })
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(reconcile).not.toHaveBeenCalled()
      expect(hardHalt).not.toHaveBeenCalled()
      expect(cleanup).not.toHaveBeenCalled()
      expect(terminal).not.toHaveBeenCalled()
    } finally {
      terminal.mockRestore()
    }
  })

  test('does not compose combined writers or cleanups after an aborted setup check', async () => {
    const bootstrapCleanup = vi.fn(async () => {})
    const ladderCleanup = vi.fn(async () => {})
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

    await expect(application.run(['start'], { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(bootstrapCleanup).not.toHaveBeenCalled()
    expect(ladderCleanup).not.toHaveBeenCalled()
  })

  test('does not enter combined-service cleanup when shutdown arrives during bootstrap adapter composition', async () => {
    const bootstrapCleanup = vi.fn(async () => {})
    const ladderCleanup = vi.fn(async () => {})
    const controller = new AbortController()
    const application = createApplication(
      {
        ...environment,
        BOOTSTRAP_MARKETS: JSON.stringify([bootstrapConfiguration]),
        LADDER_MARKETS: JSON.stringify([ladderConfiguration])
      },
      {
        createState: readyState,
        createBootstrapAdapters: () => {
          controller.abort()
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
                rateBps: 500n,
                observationId: 'static:500'
              })
            },
            make: {
              reconcile: async () => {},
              hardHalt: async () => {},
              cleanup: bootstrapCleanup
            }
          }
        },
        createLadderAdapters: () => ({
          positions: { readMarket: async () => ({}) },
          rates: { readRate: async () => 500n },
          make: {
            cleanupRemovedMarkets: async () => [],
            readActive: async () => undefined,
            reconcile: async () => {},
            hardHalt: async () => {},
            cleanup: ladderCleanup
          }
        })
      }
    )

    await expect(application.run(['start'], { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(bootstrapCleanup).not.toHaveBeenCalled()
    expect(ladderCleanup).not.toHaveBeenCalled()
  })

  test.each(['bootstrap', 'ladder', 'start'])(
    'does not run removed-market cleanup when %s starts with an aborted signal',
    async command => {
      const cleanupRemovedMarkets = vi.fn(async () => [marketId])
      const createLadderAdapters = vi.fn(() => ({
        positions: { readMarket: async () => ({}) },
        rates: { readRate: async () => 500n },
        make: {
          cleanupRemovedMarkets,
          readActive: async () => undefined,
          reconcile: async () => {},
          hardHalt: async () => {},
          cleanup: async () => {}
        }
      }))
      const controller = new AbortController()
      controller.abort()
      const application = createApplication(
        {
          ...environment,
          BOOTSTRAP_MARKETS: JSON.stringify([bootstrapConfiguration]),
          LADDER_MARKETS: JSON.stringify([ladderConfiguration])
        },
        { createState: readyState, createLadderAdapters }
      )

      await expect(application.run([command], { signal: controller.signal })).rejects.toMatchObject(
        {
          name: 'AbortError'
        }
      )
      expect(cleanupRemovedMarkets).not.toHaveBeenCalled()
    }
  )

  test.each(['bootstrap', 'ladder', 'start'])(
    'does not run removed-market cleanup when %s is aborted while creating ladder adapters',
    async command => {
      const cleanupRemovedMarkets = vi.fn(async () => [marketId])
      const controller = new AbortController()
      const createLadderAdapters = vi.fn(() => {
        controller.abort()
        return {
          positions: { readMarket: async () => ({}) },
          rates: { readRate: async () => 500n },
          make: {
            cleanupRemovedMarkets,
            readActive: async () => undefined,
            reconcile: async () => {},
            hardHalt: async () => {},
            cleanup: async () => {}
          }
        }
      })
      const application = createApplication(
        {
          ...environment,
          BOOTSTRAP_MARKETS: JSON.stringify([bootstrapConfiguration]),
          LADDER_MARKETS: JSON.stringify([ladderConfiguration])
        },
        { createState: readyState, createLadderAdapters }
      )

      await expect(application.run([command], { signal: controller.signal })).rejects.toMatchObject(
        {
          name: 'AbortError'
        }
      )
      expect(cleanupRemovedMarkets).not.toHaveBeenCalled()
    }
  )

  test('rejects an empty ladder before cleaning persisted ladder publications', async () => {
    const cleanupRemovedMarkets = vi.fn(async () => [marketId])
    const application = createApplication(
      {
        ...environment,
        BOOTSTRAP_MARKETS: JSON.stringify([bootstrapConfiguration]),
        LADDER_MARKETS: '[]'
      },
      {
        createLadderAdapters: () => ({
          positions: { readMarket: async () => ({}) },
          rates: { readRate: async () => 500n },
          make: {
            cleanupRemovedMarkets,
            readActive: async () => undefined,
            reconcile: async () => {},
            hardHalt: async () => {},
            cleanup: async () => {}
          }
        })
      }
    )

    await expect(application.run(['start'])).rejects.toMatchObject({
      name: 'LadderConfigurationError'
    })
    expect(cleanupRemovedMarkets).not.toHaveBeenCalled()
  })

  test('aborted combined start skips Blue reference readiness and writer composition', async () => {
    const checkReference = vi.fn(async () => {
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

    await expect(application.run(['start'], { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(started).toEqual([])
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
    const directory = await mkdtemp(join(tmpdir(), 'quoter-bot-bootstrap-'))
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
      await writeFile(join(directory, 'quoter-bot.yml'), configuration)
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

    await expect(application.run(['setup-check'])).rejects.toBeInstanceOf(SetupFailedError)
  })
})
