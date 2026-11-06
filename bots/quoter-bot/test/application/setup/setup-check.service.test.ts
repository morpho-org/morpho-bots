import type { Hex } from 'viem'

import { SignerAccountError } from '@repo/kit'
import { maxUint256 } from 'viem'
import { describe, expect, test } from 'vitest'

import { setupMonitoringEvents } from '../../../src/application/monitoring/setup-monitoring.utils'
import {
  SetupCheckService,
  type LoanCollateralSetup,
  type SetupCheckConfig,
  type SetupCheckReport,
  type SetupStateService
} from '../../../src/application/setup/setup-check.service'
import { readinessVerdict } from '../../../src/application/setup/setup-check.utils'
import {
  SafeProviderError,
  SetupFailedError,
  ProviderReadError,
  ProviderResponseError
} from '../../../src/errors'

const maker = '0x1111111111111111111111111111111111111111'
const midnight = '0x2222222222222222222222222222222222222222'
const loanAsset = '0x3333333333333333333333333333333333333333'
const ratifier = '0x4444444444444444444444444444444444444444'
const delegatedSigner = '0x9999999999999999999999999999999999999999'
const marketId: Hex = `0x${'55'.repeat(32)}`
const secondMarketId: Hex = `0x${'66'.repeat(32)}`
const referenceMarketId: Hex = `0x${'77'.repeat(32)}`

const config: SetupCheckConfig = {
  chainId: 8453,
  maker,
  signerMode: 'private-key',
  midnight,
  nativeReserve: 10n,
  loanAsset,
  ratifier,
  marketIds: [marketId],
  referenceMarketId,
  requiredAllowance: 5_000_000_000n
}

const readyState = (): SetupStateService => {
  return {
    getChainId: async () => 8453,
    getReferenceChainId: async () => 8453,
    getCode: async () => '0x1234',
    getDerivedSigner: async () => maker,
    getAuthorization: async () => true,
    getNativeBalance: async () => 10n,
    getLoanAllowance: async () => ({ spender: midnight, amount: maxUint256 }),
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
      tickSpacing: 1
    }),
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
    getDebt: async () => 0n,
    getLoanCollateral: async () => undefined
  }
}

const live = () => new AbortController().signal

describe('SetupCheckService', () => {
  test('fails readiness when the archive provider serves a different chain', async () => {
    // Regression: only the current-state reader's chain was checked. A stale Base
    // REFERENCE_RPC_URL paired with CHAIN_ID=1 let the variable-rate strategy derive quotes from
    // Base Blue state and submit them on mainnet whenever the reference market resolved on both.
    // The current-state reader agrees with the configured chain, so the archive mismatch is the
    // only thing that can fail this check.
    const state = {
      ...readyState(),
      getChainId: async () => 1,
      getReferenceChainId: async () => 8453
    }
    const report = await new SetupCheckService(state, { ...config, chainId: 1 }).check()
    const chain = report.checks.find(check => check.name === 'chain')

    expect(chain?.observed).toMatchObject({ configured: 1, connected: 1, referenceConnected: 8453 })
    expect(chain?.status).toBe('failed')
    expect(report.ready).toBe(false)
  })

  test('passes readiness when both providers serve the configured chain', async () => {
    const state = { ...readyState(), getChainId: async () => 1, getReferenceChainId: async () => 1 }
    const report = await new SetupCheckService(state, { ...config, chainId: 1 }).check()
    const chain = report.checks.find(check => check.name === 'chain')

    expect(chain?.status).toBe('passed')
    expect(chain?.observed).toMatchObject({ configured: 1, connected: 1, referenceConnected: 1 })
  })

  test('halts on the first failed readiness report', async () => {
    const state = readyState()
    const service = new SetupCheckService(state, config)

    const first = await service.cycle(live())
    state.getNativeBalance = async () => 9n
    const second = await service.cycle(live())

    expect([first.ready, second.ready]).toEqual([true, false])
    expect(readinessVerdict(0, first).halting).toBe(false)
    expect(readinessVerdict(0, second).halting).toBe(true)
  })

  test('retries a transient provider-only report within one monitor cycle', async () => {
    const state = readyState()
    let balanceReads = 0
    state.getNativeBalance = async () => {
      balanceReads += 1
      if (balanceReads === 1) {
        throw new SafeProviderError({
          kind: 'provider-error',
          provider: 'rpc',
          name: 'TimeoutError',
          code: 'REQUEST_TIMEOUT',
          context: 'request'
        })
      }
      return 10n
    }

    const report = await new SetupCheckService(state, config).cycle(live())

    expect(balanceReads).toBe(2)
    expect(report.ready).toBe(true)
  })

  test('halts once a transient provider outage outlasts the tolerated cycles', async () => {
    const state = readyState()
    state.getNativeBalance = async () => {
      throw new SafeProviderError({
        kind: 'provider-error',
        provider: 'rpc',
        name: 'TimeoutError',
        code: 'REQUEST_TIMEOUT',
        context: 'request'
      })
    }
    const service = new SetupCheckService(state, config)
    const halts: boolean[] = []
    let transientCycles = 0

    for (let cycle = 0; cycle < 10; cycle += 1) {
      const verdict = readinessVerdict(transientCycles, await service.cycle(live()))
      transientCycles = verdict.transientCycles
      halts.push(verdict.halting)
    }

    expect(halts).toEqual([...Array.from({ length: 9 }, () => false), true])
  })

  test('reports readiness for configured markets without reading a block timestamp', async () => {
    // Regression: readiness derived maturity from a latest-block timestamp read, so an unrelated
    // RPC timestamp outage failed every configured market even though maturity is no longer a
    // readiness invariant.
    const reads: string[] = []
    const state = new Proxy(readyState(), {
      get: (target, key) => {
        reads.push(String(key))
        return Reflect.get(target, key)
      }
    })

    const report = await new SetupCheckService(state, config).check()

    expect(report.ready).toBe(true)
    expect(reads).not.toContain('getLatestTimestamp')
  })

  test('fails closed without retrying a transient compound book read', async () => {
    const state = readyState()
    let bookReads = 0
    state.getBook = async () => {
      bookReads += 1
      throw new SafeProviderError({
        kind: 'provider-error',
        provider: 'morpho-api',
        name: 'TimeoutError',
        code: 'REQUEST_TIMEOUT',
        context: 'request'
      })
    }

    const report = await new SetupCheckService(state, config).cycle(live())

    expect(bookReads).toBe(1)
    expect(report.ready).toBe(false)
    expect(readinessVerdict(0, report).halting).toBe(true)
  })

  test('does not retry a generic sanitized provider-read failure', async () => {
    const state = readyState()
    let bookReads = 0
    state.getBook = async () => {
      bookReads += 1
      throw new ProviderReadError('morpho-api', 'market-listing')
    }

    const report = await new SetupCheckService(state, config).cycle(live())

    expect(bookReads).toBe(1)
    expect(readinessVerdict(0, report).halting).toBe(true)
  })

  test('does not retry mixed transient and invariant readiness failures', async () => {
    const state = readyState()
    let bookReads = 0
    state.getBook = async () => {
      bookReads += 1
      throw new SafeProviderError({
        kind: 'provider-error',
        provider: 'morpho-api',
        name: 'TimeoutError',
        code: 'REQUEST_TIMEOUT',
        context: 'request'
      })
    }
    state.getNativeBalance = async () => 9n

    const report = await new SetupCheckService(state, config).cycle(live())

    expect(bookReads).toBe(1)
    expect(readinessVerdict(0, report).halting).toBe(true)
  })

  const timeout = (provider: 'rpc' | 'archive-rpc' | 'morpho-api') =>
    new SafeProviderError({
      kind: 'provider-error',
      provider,
      name: 'TimeoutError',
      code: 'REQUEST_TIMEOUT',
      context: 'request'
    })

  type ReadyState = ReturnType<typeof readyState>
  type Failing = () => Promise<never>

  test.each<{
    name: string
    arrange: (state: ReadyState, fail: Failing) => void
    error: () => Error
  }>([
    {
      name: 'a transient chain read beside missing deployment code',
      arrange: (state, fail) => {
        state.getChainId = fail
        state.getCode = async () => '0x'
      },
      error: () => timeout('rpc')
    },
    {
      name: 'a transient compound reference read',
      arrange: (state, fail) => {
        state.checkReference = fail
      },
      error: () => timeout('archive-rpc')
    },
    {
      name: 'a transient compound offer traversal',
      arrange: (state, fail) => {
        state.inspectOffers = fail
      },
      error: () => timeout('morpho-api')
    },
    {
      name: 'a transient ratifier check that can mask invariant drift',
      arrange: (state, fail) => {
        state.getRatifier = fail
      },
      error: () => timeout('rpc')
    },
    {
      name: 'a deterministic JSON-RPC invalid-input failure',
      arrange: (state, fail) => {
        state.getNativeBalance = fail
      },
      error: () => new ProviderReadError('rpc', 'native-balance', { code: -32_000 })
    },
    {
      name: 'a non-transient provider response',
      arrange: (state, fail) => {
        state.inspectOffers = fail
      },
      error: () =>
        new SafeProviderError({
          kind: 'provider-error',
          provider: 'morpho-api',
          name: 'HttpError',
          status: 400,
          context: 'request'
        })
    }
  ])('fails startup without retrying $name', async ({ arrange, error }) => {
    const state = readyState()
    let reads = 0
    arrange(state, async () => {
      reads += 1
      throw error()
    })

    const failure = await new SetupCheckService(state, config).assertReady().catch(value => value)

    expect(reads).toBe(1)
    expect(failure).toBeInstanceOf(SetupFailedError)
  })

  test('reports only the sanitized book provider failure when a market read fails', async () => {
    const state = readyState()
    state.getBook = async () => {
      throw new SafeProviderError({
        kind: 'provider-error',
        provider: 'morpho-api',
        name: 'TimeoutError',
        code: 'REQUEST_TIMEOUT',
        context: 'request'
      })
    }

    const report = await new SetupCheckService(state, config).cycle(live())

    expect(report.checks.find(check => check.name === 'books')?.observed).toEqual([
      {
        id: marketId,
        reasons: [
          {
            providerError: expect.objectContaining({
              provider: 'morpho-api',
              name: 'TimeoutError'
            })
          }
        ]
      }
    ])
  })

  test('stops transient retries once shutdown interrupts a monitor cycle', async () => {
    const controller = new AbortController()
    const state = readyState()
    let balanceReads = 0
    state.getNativeBalance = async () => {
      balanceReads += 1
      controller.abort()
      throw new SafeProviderError({
        kind: 'provider-error',
        provider: 'rpc',
        name: 'TimeoutError',
        code: 'REQUEST_TIMEOUT',
        context: 'request'
      })
    }

    await new SetupCheckService(state, config).cycle(controller.signal)

    expect(balanceReads).toBe(1)
  })

  test('retries transient provider-only startup readiness before allowing writers', async () => {
    const state = readyState()
    let balanceReads = 0
    state.getNativeBalance = async () => {
      balanceReads += 1
      if (balanceReads < 3) {
        throw new SafeProviderError({
          kind: 'provider-error',
          provider: 'rpc',
          name: 'HttpError',
          status: 503,
          context: 'request'
        })
      }
      return 10n
    }

    const report = await new SetupCheckService(state, config).assertReady()

    expect(balanceReads).toBe(3)
    expect(report.ready).toBe(true)
  })

  test('retries a numeric JSON-RPC server failure before allowing writers', async () => {
    const state = readyState()
    let balanceReads = 0
    state.getNativeBalance = async () => {
      balanceReads += 1
      if (balanceReads === 1) {
        throw new ProviderReadError('rpc', 'native-balance', { code: -32_005 })
      }
      return 10n
    }

    const report = await new SetupCheckService(state, config).assertReady()

    expect(balanceReads).toBe(2)
    expect(report.ready).toBe(true)
  })

  test('stops startup after shutdown even when a transient retry recovers', async () => {
    const controller = new AbortController()
    const state = readyState()
    let balanceReads = 0
    state.getNativeBalance = async () => {
      balanceReads += 1
      if (balanceReads === 1) {
        throw new SafeProviderError({
          kind: 'provider-error',
          provider: 'rpc',
          name: 'TimeoutError',
          code: 'REQUEST_TIMEOUT',
          context: 'request'
        })
      }
      controller.abort()
      return 10n
    }

    const error = await new SetupCheckService(state, config)
      .assertReady(controller.signal)
      .catch(value => value)

    expect(balanceReads).toBe(2)
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ name: 'AbortError' })
  })

  test('stops startup retries after the shutdown signal is aborted', async () => {
    const controller = new AbortController()
    const state = readyState()
    let bookReads = 0
    state.getBook = async () => {
      bookReads += 1
      controller.abort()
      throw new SafeProviderError({
        kind: 'provider-error',
        provider: 'morpho-api',
        name: 'TimeoutError',
        code: 'REQUEST_TIMEOUT',
        context: 'request'
      })
    }

    const error = await new SetupCheckService(state, config)
      .assertReady(controller.signal)
      .catch(value => value)

    expect(bookReads).toBe(1)
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ name: 'AbortError' })
  })

  test('reports every V0 setup check as passed when the maker is ready', async () => {
    const report = await new SetupCheckService(readyState(), config).check()

    expect(report.ready).toBe(true)
    expect(report.checks.map(check => [check.name, check.status])).toEqual([
      ['chain', 'passed'],
      ['signer', 'passed'],
      ['native-balance', 'passed'],
      ['signer-native-balance', 'not-required'],
      ['signer-authorization', 'not-required'],
      ['loan-allowance', 'passed'],
      ['ratifier', 'passed'],
      ['books', 'passed'],
      ['reference', 'passed'],
      ['offers', 'passed'],
      ['position-health', 'not-required']
    ])
  })

  test('checks delegated AWS authorization and gas reserve independently', async () => {
    const state = readyState()
    const balanceReads: string[] = []
    state.getDerivedSigner = async () => delegatedSigner
    state.getNativeBalance = async address => {
      balanceReads.push(address)
      return address === delegatedSigner ? 20n : 0n
    }
    const report = await new SetupCheckService(state, {
      ...config,
      nativeReserve: undefined,
      signerMode: 'aws',
      signerNativeReserve: 20n
    }).check()

    expect(report.ready).toBe(true)
    expect(balanceReads).toEqual([delegatedSigner])
    expect(
      report.checks
        .filter(check =>
          ['signer', 'native-balance', 'signer-native-balance', 'signer-authorization'].includes(
            check.name
          )
        )
        .map(check => [check.name, check.status])
    ).toEqual([
      ['signer', 'passed'],
      ['native-balance', 'not-required'],
      ['signer-native-balance', 'passed'],
      ['signer-authorization', 'passed']
    ])
  })

  test('fails readiness when a maker-signing config has no maker reserve', async () => {
    const report = await new SetupCheckService(readyState(), {
      ...config,
      nativeReserve: undefined
    }).check()

    expect(report.ready).toBe(false)
    expect(report.checks.find(check => check.name === 'native-balance')?.status).toBe('failed')
  })

  test.each([
    [
      'signer-native-balance',
      {
        getNativeBalance: async (address: string) => (address === delegatedSigner ? 19n : 10n)
      }
    ],
    ['signer-authorization', { getAuthorization: async () => false }]
  ])('fails delegated AWS readiness at %s', async (failedName, override) => {
    const state = {
      ...readyState(),
      getDerivedSigner: async () => delegatedSigner,
      getNativeBalance: async (address: string) => (address === delegatedSigner ? 20n : 10n),
      ...override
    } as SetupStateService
    const report = await new SetupCheckService(state, {
      ...config,
      signerMode: 'aws',
      signerNativeReserve: 20n
    }).check()

    expect(report.ready).toBe(false)
    expect(report.checks.find(check => check.name === failedName)?.status).toBe('failed')
  })

  test('skips only private-key derivation and preserves maker observations in read-only mode', async () => {
    const reads: string[] = []
    const unavailable = async (): Promise<never> => {
      reads.push('maker-derivation')
      throw new Error('signer-only read must not run')
    }
    const state = readyState()
    state.getDerivedSigner = unavailable
    state.getNativeBalance = async () => {
      reads.push('native-balance')
      return 10n
    }
    state.getLoanAllowance = async () => {
      reads.push('loan-allowance')
      return { spender: midnight, amount: maxUint256 }
    }
    state.getRatifier = async () => {
      reads.push('ratifier')
      return {
        listed: true,
        deployed: true,
        midnightMatches: true,
        surfaceMatches: true,
        authorized: true
      }
    }

    const report = await new SetupCheckService(state, config, true).check()

    expect(reads).toEqual(['native-balance', 'loan-allowance', 'ratifier'])
    expect(report.ready).toBe(true)
    expect(report.checks.slice(1, 5).map(check => [check.name, check.status])).toEqual([
      ['signer', 'not-required'],
      ['native-balance', 'passed'],
      ['signer-native-balance', 'not-required'],
      ['signer-authorization', 'not-required']
    ])
  })

  test('fails maker readiness when write mode receives no derived signer identity', async () => {
    const state = readyState()
    state.getDerivedSigner = async () => undefined

    const report = await new SetupCheckService(state, config).check()

    expect(report.ready).toBe(false)
    expect(report.checks.find(check => check.name === 'signer')).toEqual({
      name: 'signer',
      status: 'failed',
      observed: { derived: false, matches: false },
      required: 'local signer equals configured maker'
    })
  })

  test('preserves a sanitized signer operation in the maker readiness check', async () => {
    const state = readyState()
    state.getDerivedSigner = async () => {
      throw new SignerAccountError('kms-public-key')
    }

    const report = await new SetupCheckService(state, config).check()

    expect(report.ready).toBe(false)
    expect(report.checks.find(check => check.name === 'signer')).toEqual({
      name: 'signer',
      status: 'failed',
      observed: { kind: 'signer-error', operation: 'kms-public-key' },
      required: 'local signer equals configured maker'
    })
  })

  test('reports compact deployment status instead of Midnight runtime bytecode', async () => {
    const report = await new SetupCheckService(readyState(), config).check()
    const chain = report.checks.find(check => check.name === 'chain')

    expect(chain?.observed).toMatchObject({ midnightCode: 'deployed' })
    expect(JSON.stringify(chain)).not.toContain('0x1234')
  })

  test('preserves a typed provider id when a compound setup read fails', async () => {
    const state = readyState()
    state.getBook = async () => {
      throw new ProviderReadError('morpho-api', 'market-listing')
    }

    const report = await new SetupCheckService(state, config).check()
    const books = report.checks.find(check => check.name === 'books')

    expect(books?.observed).toEqual([
      {
        id: marketId,
        reasons: [
          {
            providerError: expect.objectContaining({
              provider: 'morpho-api',
              context: 'read'
            })
          }
        ]
      }
    ])
  })

  test('preserves a typed response-error provider id in the setup report', async () => {
    const state = readyState()
    state.getBook = async () => {
      throw new ProviderResponseError('morpho-api', 'market-count', 'invalid count')
    }

    const report = await new SetupCheckService(state, config).check()
    const books = report.checks.find(check => check.name === 'books')

    expect(books?.observed).toEqual([
      {
        id: marketId,
        reasons: [
          {
            providerError: expect.objectContaining({
              provider: 'morpho-api',
              context: 'read'
            })
          }
        ]
      }
    ])
  })

  test('preserves a neutral typed provider id for cross-provider validation', async () => {
    const state = readyState()
    state.getBook = async () => {
      throw new ProviderResponseError('provider', 'book-loan-asset', 'providers disagree')
    }

    const report = await new SetupCheckService(state, config).check()
    const books = report.checks.find(check => check.name === 'books')

    expect(books?.observed).toEqual([
      {
        id: marketId,
        reasons: [
          {
            providerError: expect.objectContaining({ provider: 'provider', context: 'read' })
          }
        ]
      }
    ])
  })

  test('attributes untyped offer pagination failures to the Morpho API', async () => {
    const state = readyState()
    state.inspectOffers = async () => {
      throw new Error('pagination failed')
    }

    const report = await new SetupCheckService(state, config).check()
    const offers = report.checks.find(check => check.name === 'offers')

    expect(offers?.observed).toMatchObject({
      error: { provider: 'morpho-api', context: 'read' }
    })
  })

  test('rejects readiness with the failed check and remediation when setup is unsafe', async () => {
    const state = readyState()
    state.getNativeBalance = async () => 9n

    const readiness = new SetupCheckService(state, config).assertReady()

    await expect(readiness).rejects.toBeInstanceOf(SetupFailedError)
    await expect(readiness).rejects.toMatchObject({
      report: {
        ready: false,
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: 'native-balance',
            status: 'failed',
            observed: 9n,
            required: 10n,
            remediation: 'fund the configured maker with native token to at least 10'
          })
        ])
      }
    })
  })

  test('records a provider failure against the exact check without exposing nested credentials', async () => {
    const state = readyState()
    state.checkReference = async () => {
      const providerError = new Error(
        'archive https://rpc-user:rpc-pass@rpc.example/path?apiKey=rpc-secret failed',
        {
          cause: new AggregateError([
            new Error('https://archive.example/path?token=archive-secret'),
            new Error('https://api.example/path?key=morpho-secret'),
            new Error('https://router.example/path?apikey=router-secret')
          ])
        }
      ) as Error & { code: string }
      providerError.name = 'rpc-secret'
      providerError.code = 'archive-secret'
      throw providerError
    }

    const report = await new SetupCheckService(state, config).check()
    const serialized = JSON.stringify(report, (_, value) =>
      typeof value === 'bigint' ? value.toString() : value
    )

    expect(report.ready).toBe(false)
    expect(report.checks.find(check => check.name === 'reference')).toEqual({
      name: 'reference',
      status: 'failed',
      observed: {
        error: {
          kind: 'provider-error',
          provider: 'archive-rpc',
          name: 'ProviderError',
          context: 'read'
        }
      },
      required: {
        marketId: referenceMarketId,
        referenceReadable: true,
        archiveReadable: true
      }
    })
    for (const marker of [
      maker,
      'rpc-user',
      'rpc-pass',
      'rpc-secret',
      'archive-secret',
      'morpho-secret',
      'router-secret'
    ]) {
      expect(serialized).not.toContain(marker)
    }
    expect(report.checks.find(check => check.name === 'offers')?.status).toBe('passed')
  })

  test('runs independent reads concurrently and keeps a complete report after rejections', async () => {
    const started: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const wait = async <T>(name: string, value: T) => {
      started.push(name)
      await gate
      return value
    }
    const state = readyState()
    state.getChainId = () => wait('chain-id', 8453)
    state.getCode = () => wait('code', '0x1234')
    state.getDerivedSigner = () => wait('maker', maker)
    state.getNativeBalance = () => wait('balance', 10n)
    state.getLoanAllowance = () => wait('allowance', { spender: midnight, amount: maxUint256 })
    state.getRatifier = () =>
      wait('ratifier', {
        listed: true,
        deployed: true,
        midnightMatches: true,
        surfaceMatches: true,
        authorized: true
      })
    state.getBook = id =>
      wait(`book:${id}`, {
        id,
        allowlisted: true,
        active: true,
        loanAsset,
        tickSpacing: 1
      })
    state.checkReference = async () => {
      started.push('reference')
      await gate
      throw new Error('archive unavailable')
    }
    state.inspectOffers = () =>
      wait('offers', { unknownNamespaces: [], unknownMarketIds: [], invertedMarketIds: [] })
    state.getDebt = () => wait('position-health', 0n)

    const reportPromise = new SetupCheckService(state, config).check()
    await Promise.resolve()

    expect(started.toSorted()).toEqual(
      [
        'chain-id',
        'code',
        'maker',
        'balance',
        'allowance',
        'ratifier',
        `book:${marketId}`,
        'reference',
        'offers',
        'position-health'
      ].toSorted()
    )
    release()

    const report = await reportPromise
    expect(report.checks.find(check => check.name === 'reference')?.status).toBe('failed')
    expect(report.checks.find(check => check.name === 'offers')?.status).toBe('passed')
  })

  test('converts every rejected provider surface into its named report item', async () => {
    const unavailable = async () => {
      throw new Error('provider unavailable')
    }
    const state = readyState()
    state.getChainId = unavailable
    state.getCode = unavailable
    state.getDerivedSigner = unavailable
    state.getNativeBalance = unavailable
    state.getLoanAllowance = unavailable
    state.getRatifier = unavailable
    state.getBook = unavailable
    state.checkReference = unavailable
    state.inspectOffers = unavailable
    state.getDebt = unavailable

    const error = await new SetupCheckService(state, config).assertReady().catch(value => value)

    expect(error).toBeInstanceOf(SetupFailedError)
    expect(error.name).toBe('SetupFailedError')
    expect(
      error.report.checks.map((check: { name: string; status: string }) => [
        check.name,
        check.status
      ])
    ).toEqual([
      ['chain', 'failed'],
      ['signer', 'failed'],
      ['native-balance', 'failed'],
      ['signer-native-balance', 'not-required'],
      ['signer-authorization', 'not-required'],
      ['loan-allowance', 'failed'],
      ['ratifier', 'failed'],
      ['books', 'failed'],
      ['reference', 'failed'],
      ['offers', 'failed'],
      ['position-health', 'failed']
    ])
  })

  test('rejects a book response whose id differs from the requested configured market', async () => {
    const state = readyState()
    state.getBook = async () => ({
      id: secondMarketId,
      allowlisted: true,
      active: true,
      loanAsset,
      tickSpacing: 1
    })

    const report = await new SetupCheckService(state, config).check()

    expect(report.checks.find(check => check.name === 'books')?.observed).toEqual([
      { id: marketId, reasons: [`provider returned ${secondMarketId}`] }
    ])
  })

  test('fails books when no market is configured', async () => {
    const report = await new SetupCheckService(readyState(), { ...config, marketIds: [] }).check()

    expect(report.checks.find(check => check.name === 'books')).toEqual({
      name: 'books',
      status: 'failed',
      observed: [{ id: '(none)', reasons: ['no markets configured'] }],
      required: 'all configured books valid'
    })
  })

  test('fails the named reference check when the provider reads a different market', async () => {
    const state = readyState()
    state.checkReference = async () => ({
      marketId,
      referenceReadable: true,
      archiveReadable: true
    })

    const report = await new SetupCheckService(state, config).check()

    expect(report.checks.find(check => check.name === 'reference')).toMatchObject({
      name: 'reference',
      status: 'failed',
      observed: { marketId },
      required: { marketId: referenceMarketId }
    })
  })

  test('accepts exact funding thresholds', async () => {
    const exactThresholds = await new SetupCheckService(readyState(), config).check()
    expect(exactThresholds.checks.find(check => check.name === 'native-balance')?.status).toBe(
      'passed'
    )
    expect(exactThresholds.checks.find(check => check.name === 'loan-allowance')?.status).toBe(
      'passed'
    )
  })

  test('keeps an unlimited approval ready after fills have decremented it', async () => {
    const statusFor = async (amount: bigint) => {
      const state = readyState()
      state.getLoanAllowance = async () => ({ spender: midnight, amount })
      const report = await new SetupCheckService(state, config).check()
      return report.checks.find(check => check.name === 'loan-allowance')?.status
    }

    expect(await statusFor(maxUint256)).toBe('passed')
    expect(await statusFor(maxUint256 - 26_780_747_345n)).toBe('passed')
  })

  test('passes at the full-deployment allowance, warns one unit below, and fails at zero', async () => {
    const statusFor = async (amount: bigint) => {
      const state = readyState()
      state.getLoanAllowance = async () => ({ spender: midnight, amount })
      const report = await new SetupCheckService(state, config).check()
      return report.checks.find(check => check.name === 'loan-allowance')?.status
    }

    expect(await statusFor(config.requiredAllowance)).toBe('passed')
    expect(await statusFor(config.requiredAllowance + 1n)).toBe('passed')
    expect(await statusFor(config.requiredAllowance - 1n)).toBe('warning')
    expect(await statusFor(1n)).toBe('warning')
    expect(await statusFor(0n)).toBe('failed')
  })

  test('keeps a below-deployment startup allowance ready so writers can start', async () => {
    const state = readyState()
    state.getLoanAllowance = async () => ({ spender: midnight, amount: 1n })

    await expect(new SetupCheckService(state, config).assertReady()).resolves.toMatchObject({
      ready: true
    })
  })

  test('keeps monitoring while fills drain the allowance below the full deployment', async () => {
    const state = readyState()
    const service = new SetupCheckService(state, config)
    const reports: SetupCheckReport[] = []

    for (const amount of [config.requiredAllowance, config.requiredAllowance - 1n, 0n]) {
      state.getLoanAllowance = async () => ({ spender: midnight, amount })
      reports.push(await service.cycle(live()))
    }

    expect(reports.map(report => readinessVerdict(0, report).halting)).toEqual([
      false,
      false,
      false
    ])
    expect(reports.map(report => report.ready)).toEqual([true, true, true])
    expect(
      reports.map(report => report.checks.find(check => check.name === 'loan-allowance')?.status)
    ).toEqual(['passed', 'warning', 'warning'])
    expect(setupMonitoringEvents(reports[2] as SetupCheckReport)).toContainEqual({
      event: 'setup.check-warning',
      check: 'loan-allowance',
      status: 'warning'
    })
  })

  test('remediates a short approval without presenting the full deployment as a floor', async () => {
    const state = readyState()
    state.getLoanAllowance = async () => ({ spender: midnight, amount: 16_000_000_000n })

    const report = await new SetupCheckService(state, {
      ...config,
      requiredAllowance: 17_000_000_000n
    }).check()

    const allowance = report.checks.find(check => check.name === 'loan-allowance')
    expect(allowance?.status).toBe('warning')
    expect(allowance?.remediation).toEqual(expect.stringContaining('buys shrink'))
    expect(allowance?.remediation).toEqual(expect.stringContaining('17000000000'))
    expect(allowance?.remediation).not.toMatch(/at least|minimum|floor|exactly/i)
  })

  test('reports the observed allowance and required spender and minimum on failure', async () => {
    const state = readyState()
    state.getLoanAllowance = async () => ({ spender: midnight, amount: 0n })

    const report = await new SetupCheckService(state, config).check()

    expect(report.checks.find(check => check.name === 'loan-allowance')).toMatchObject({
      status: 'failed',
      observed: { spender: midnight, amount: 0n },
      required: { spender: midnight, minimum: 1n, fullDeployment: 5_000_000_000n }
    })
  })

  test('passes a zero allowance at startup when no buy is configured', async () => {
    const state = readyState()
    state.getLoanAllowance = async () => ({ spender: midnight, amount: 0n })

    const report = await new SetupCheckService(state, { ...config, requiredAllowance: 0n }).check()

    expect(report.checks.find(check => check.name === 'loan-allowance')).toMatchObject({
      status: 'passed',
      required: { spender: midnight, fullDeployment: 0n }
    })
    expect(
      report.checks.find(check => check.name === 'loan-allowance')?.required
    ).not.toHaveProperty('minimum')
  })

  test('fails an approval granted to a different spender', async () => {
    const state = readyState()
    state.getLoanAllowance = async () => ({ spender: ratifier, amount: maxUint256 })

    const report = await new SetupCheckService(state, config).check()

    expect(report.checks.find(check => check.name === 'loan-allowance')?.status).toBe('failed')
  })

  test('keeps a production-sized approval above the float boundary ready', async () => {
    // Regression: the operator-approved finite allowance exceeds Number.MAX_SAFE_INTEGER, so any
    // check routed through Number silently loses precision and must stay in bigint arithmetic.
    const state = readyState()
    state.getLoanAllowance = async () => ({
      spender: midnight,
      amount: 9_007_199_254_740_991_000_000n
    })

    const report = await new SetupCheckService(state, config).check()

    expect(report.checks.find(check => check.name === 'loan-allowance')?.status).toBe('passed')
  })

  test('warns without blocking readiness when a live group cannot be attributed', async () => {
    const state = readyState()
    state.inspectOffers = async () => ({
      unknownNamespaces: [`0x${'ab'.repeat(32)}`],
      unknownMarketIds: [],
      invertedMarketIds: []
    })

    const report = await new SetupCheckService(state, config).check()

    expect(report.checks.find(check => check.name === 'offers')?.status).toBe('warning')
    expect(report.ready).toBe(true)
  })

  test.each([
    ['unknownMarketIds', { unknownMarketIds: [secondMarketId], invertedMarketIds: [] }],
    ['invertedMarketIds', { unknownMarketIds: [], invertedMarketIds: [marketId] }]
  ])('fails readiness for offers outside the exposure model via %s', async (_name, unsafe) => {
    const state = readyState()
    state.inspectOffers = async () => ({ unknownNamespaces: [], ...unsafe })

    const report = await new SetupCheckService(state, config).check()

    expect(report.checks.find(check => check.name === 'offers')?.status).toBe('failed')
    expect(report.ready).toBe(false)
  })

  test('reports every unsafe book property so the operator can remediate it', async () => {
    const state = readyState()
    state.getBook = async id => ({
      id,
      allowlisted: false,
      active: false,
      loanAsset: ratifier,
      tickSpacing: 0
    })

    const report = await new SetupCheckService(state, config).check()

    expect(report.checks.find(check => check.name === 'books')).toEqual({
      name: 'books',
      status: 'failed',
      observed: [
        {
          id: marketId,
          reasons: [
            'not allowlisted',
            'inactive',
            `unexpected loan asset ${ratifier}`,
            'tick spacing is inaccessible'
          ]
        }
      ],
      required: 'all configured books valid'
    })
  })

  test('returns allowance details and a maker-redacted authorization instruction', async () => {
    const state = readyState()
    state.getLoanAllowance = async () => ({ spender: midnight, amount: 99n })
    state.getRatifier = async () => ({
      listed: true,
      deployed: true,
      midnightMatches: true,
      surfaceMatches: true,
      authorized: false
    })

    const report = await new SetupCheckService(state, config).check()

    expect(report.checks.find(check => check.name === 'loan-allowance')?.remediation).toEqual(
      expect.stringContaining('5000000000 funds one full deployment')
    )
    expect(report.checks.find(check => check.name === 'ratifier')?.remediation).toBe(
      'authorize the configured maker with the selected ratifier'
    )
  })

  test('fails closed for every unsafe V0 setup surface', async () => {
    const state = readyState()
    state.getChainId = async () => 1
    state.getCode = async () => '0x'
    state.getDerivedSigner = async () => ratifier
    state.getNativeBalance = async () => 9n
    state.getLoanAllowance = async () => ({ spender: ratifier, amount: 99n })
    state.getRatifier = async () => ({
      listed: false,
      deployed: false,
      midnightMatches: false,
      surfaceMatches: false,
      authorized: false
    })
    state.getBook = async id => ({
      id,
      allowlisted: false,
      active: false,
      loanAsset: ratifier,
      tickSpacing: 0
    })
    state.checkReference = async () => ({
      marketId: referenceMarketId,
      referenceReadable: false,
      archiveReadable: false
    })
    state.inspectOffers = async () => ({
      unknownNamespaces: ['v0:unknown'],
      unknownMarketIds: [marketId],
      invertedMarketIds: [marketId]
    })

    const report = await new SetupCheckService(state, config).check()

    expect(report.ready).toBe(false)
    expect(
      report.checks.filter(check => check.status === 'failed').map(check => check.name)
    ).toEqual([
      'chain',
      'signer',
      'native-balance',
      'loan-allowance',
      'ratifier',
      'books',
      'reference',
      'offers'
    ])
    expect(report.checks.find(check => check.name === 'position-health')?.status).toBe(
      'not-required'
    )
  })

  test('fails the offers check when an active group remains on an unconfigured market', async () => {
    const state = readyState()
    state.inspectOffers = async () => ({
      unknownNamespaces: [],
      unknownMarketIds: [marketId],
      invertedMarketIds: []
    })

    const report = await new SetupCheckService(state, config).check()

    expect(report.ready).toBe(false)
    expect(report.checks.find(check => check.name === 'offers')).toMatchObject({
      status: 'failed',
      observed: { unknownMarketIds: [marketId] }
    })
  })

  describe('position health', () => {
    const debtConfig: SetupCheckConfig = {
      ...config,
      debt: new Map([
        [marketId, { maximumDebtUnits: 1_000n, stopBorrowingBeforeMaturitySeconds: 0 }]
      ])
    }
    const slot: LoanCollateralSetup = {
      assets: 2_000n,
      lltv: 10n ** 18n,
      oracleRuntimeHash: '0x6c5b423bbd32a1bc423d3992fe58a905f055fd2173a97b69f0468bc3ce51e2df',
      enterGateOpen: true,
      matured: false
    }
    const positionHealth = async (
      setup: SetupCheckConfig,
      reads: { debt?: bigint; loanCollateral?: LoanCollateralSetup | undefined } = {}
    ) => {
      const state = readyState()
      state.getDebt = async () => reads.debt ?? 0n
      state.getLoanCollateral = async () =>
        'loanCollateral' in reads ? reads.loanCollateral : slot
      const report = await new SetupCheckService(state, setup).check()
      return report.checks.find(check => check.name === 'position-health')!
    }

    test('is not required without debt or a market configured to borrow', async () => {
      expect(await positionHealth(config)).toMatchObject({ status: 'not-required', observed: [] })
    })

    test('fails readiness for debt in a market not configured to borrow', async () => {
      expect(await positionHealth(config, { debt: 1n })).toMatchObject({
        status: 'failed',
        observed: [{ id: marketId, debt: 1n, findings: ['debt-not-configured'] }]
      })
    })

    test('passes a qualified market and reports the ceiling it borrows to', async () => {
      expect(await positionHealth(debtConfig, { debt: 400n })).toMatchObject({
        status: 'passed',
        observed: [{ id: marketId, debt: 400n, maximumDebtUnits: 1_000n, debtCeilingUnits: 1_000n }]
      })
    })

    test.each([
      ['loan-collateral-missing', { loanCollateral: undefined }],
      ['loan-collateral-oracle', { loanCollateral: { ...slot, oracleRuntimeHash: undefined } }],
      [
        'loan-collateral-oracle',
        { loanCollateral: { ...slot, oracleRuntimeHash: `0x${'00'.repeat(32)}` } }
      ],
      ['enter-gate-closed', { loanCollateral: { ...slot, enterGateOpen: false } }]
    ] as const)('fails readiness for a configured market with %s', async (finding, reads) => {
      expect(await positionHealth(debtConfig, reads)).toMatchObject({
        status: 'failed',
        observed: [{ id: marketId, findings: [finding] }]
      })
    })

    test.each([
      ['debt-over-maximum', { debt: 1_001n }],
      ['matured-with-debt', { debt: 1n, loanCollateral: { ...slot, matured: true } }]
    ] as const)('warns without failing readiness on %s', async (finding, reads) => {
      expect(await positionHealth(debtConfig, reads)).toMatchObject({
        status: 'warning',
        observed: [{ id: marketId, findings: [finding] }]
      })
    })

    test('reports a lost read in the transient shape rather than masking a proven finding', async () => {
      const state = readyState()
      const timeout = new ProviderReadError('rpc', 'position-debt', { name: 'TimeoutError' })
      state.getDebt = async () => {
        throw timeout
      }
      const lost = await new SetupCheckService(state, debtConfig).check()
      expect(lost.checks.find(check => check.name === 'position-health')).toMatchObject({
        status: 'failed',
        observed: { error: { kind: 'provider-error', name: 'TimeoutError' } }
      })

      state.getDebt = async id => {
        if (id === marketId) return 1n
        throw timeout
      }
      const proven = await new SetupCheckService(state, {
        ...config,
        marketIds: [marketId, secondMarketId]
      }).check()
      expect(proven.checks.find(check => check.name === 'position-health')).toMatchObject({
        status: 'failed',
        observed: [{ id: marketId, findings: ['debt-not-configured'] }]
      })
    })
  })
})
