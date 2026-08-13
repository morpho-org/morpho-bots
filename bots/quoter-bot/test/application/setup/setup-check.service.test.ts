import type { Hex } from 'viem'

import { describe, expect, test } from 'vitest'

import { SafeProviderError } from '../../../src/application/setup/safe-provider.error'
import {
  SetupCheckService,
  type SetupCheckConfig,
  type SetupCheckReport,
  type SetupStateService
} from '../../../src/application/setup/setup-check.service'
import { SetupFailedError } from '../../../src/application/setup/setup-failed.error'
import { SetupMonitorConfigurationError } from '../../../src/application/setup/setup-monitor-configuration.error'
import { MakerAccountError } from '../../../src/infrastructure/make/maker-account.error'
import { ProviderReadError } from '../../../src/infrastructure/setup-state/provider-read.error'
import { ProviderResponseError } from '../../../src/infrastructure/setup-state/provider-response.error'

const maker = '0x1111111111111111111111111111111111111111'
const midnight = '0x2222222222222222222222222222222222222222'
const loanAsset = '0x3333333333333333333333333333333333333333'
const ratifier = '0x4444444444444444444444444444444444444444'
const marketId: Hex = `0x${'55'.repeat(32)}`
const secondMarketId: Hex = `0x${'66'.repeat(32)}`
const referenceMarketId: Hex = `0x${'77'.repeat(32)}`

const config: SetupCheckConfig = {
  chainId: 8453,
  maker,
  midnight,
  nativeReserve: 10n,
  loanAsset,
  maximumLendExposure: 100n,
  ratifier,
  marketIds: [marketId],
  referenceMarketId
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
      tickSpacing: 1,
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

describe('SetupCheckService', () => {
  test('halts monitoring after emitting the first failed readiness report', async () => {
    const controller = new AbortController()
    const reports: { ready: boolean; report: SetupCheckReport }[] = []
    const state = readyState()
    let nativeBalance = 10n
    state.getNativeBalance = async () => nativeBalance
    const service = new SetupCheckService(state, config)

    const terminal = await service.runContinuously({
      signal: controller.signal,
      intervalMs: 1,
      onCycle: report => {
        reports.push({ ready: report.ready, report })
        if (reports.length === 1) nativeBalance = 9n
      }
    })

    expect(reports.map(report => report.ready)).toEqual([true, false])
    expect(terminal).toMatchObject({ status: 'halted', reason: 'setup-failed', cycles: 2 })
    const lastEmittedReport = reports.at(-1)
    expect(lastEmittedReport).toBeDefined()
    if (terminal.reason === 'setup-failed') {
      expect(terminal.lastReport.ready).toBe(false)
      if (lastEmittedReport) expect(terminal.lastReport).toBe(lastEmittedReport.report)
    }
  })

  test('retries a transient provider-only report before emitting a recovered monitor cycle', async () => {
    const controller = new AbortController()
    const state = readyState()
    let bookReads = 0
    state.getBook = async id => {
      bookReads += 1
      if (bookReads === 1) {
        throw new SafeProviderError({
          kind: 'provider-error',
          provider: 'morpho-api',
          name: 'TimeoutError',
          code: 'REQUEST_TIMEOUT',
          context: 'request'
        })
      }
      return {
        id,
        allowlisted: true,
        active: true,
        loanAsset,
        tickSpacing: 1,
        maturity: 2_000n
      }
    }
    const reports: SetupCheckReport[] = []

    const terminal = await new SetupCheckService(state, config).runContinuously({
      signal: controller.signal,
      intervalMs: 1,
      onCycle: report => {
        reports.push(report)
        controller.abort()
      }
    })

    expect(bookReads).toBe(2)
    expect(reports.map(report => report.ready)).toEqual([true])
    expect(terminal).toEqual({ status: 'stopped', reason: 'signal', cycles: 1 })
  })

  test('halts after three consecutive transient provider-only readiness attempts', async () => {
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
    const reports: SetupCheckReport[] = []

    const terminal = await new SetupCheckService(state, config).runContinuously({
      signal: new AbortController().signal,
      intervalMs: 1,
      onCycle: report => {
        reports.push(report)
      }
    })

    expect(bookReads).toBe(3)
    expect(reports.map(report => report.ready)).toEqual([false])
    expect(terminal).toMatchObject({ status: 'halted', reason: 'setup-failed', cycles: 1 })
  })

  test('does not retry a generic sanitized provider-read failure', async () => {
    const state = readyState()
    let bookReads = 0
    state.getBook = async () => {
      bookReads += 1
      throw new ProviderReadError('morpho-api', 'book-api')
    }

    const terminal = await new SetupCheckService(state, config).runContinuously({
      signal: new AbortController().signal,
      intervalMs: 1
    })

    expect(bookReads).toBe(1)
    expect(terminal).toMatchObject({ status: 'halted', reason: 'setup-failed', cycles: 1 })
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

    const terminal = await new SetupCheckService(state, config).runContinuously({
      signal: new AbortController().signal,
      intervalMs: 1
    })

    expect(bookReads).toBe(1)
    expect(terminal).toMatchObject({ status: 'halted', reason: 'setup-failed', cycles: 1 })
  })

  test('does not retry a timestamp timeout that accompanies a book invariant failure', async () => {
    const state = readyState()
    let bookReads = 0
    let timestampReads = 0
    state.getBook = async id => {
      bookReads += 1
      return {
        id,
        allowlisted: true,
        active: false,
        loanAsset,
        tickSpacing: 1,
        maturity: 2_000n
      }
    }
    state.getLatestTimestamp = async () => {
      timestampReads += 1
      throw new SafeProviderError({
        kind: 'provider-error',
        provider: 'rpc',
        name: 'TimeoutError',
        code: 'REQUEST_TIMEOUT',
        context: 'request'
      })
    }

    const terminal = await new SetupCheckService(state, config).runContinuously({
      signal: new AbortController().signal,
      intervalMs: 1
    })

    expect(bookReads).toBe(1)
    expect(timestampReads).toBe(1)
    expect(terminal).toMatchObject({ status: 'halted', reason: 'setup-failed', cycles: 1 })
    if (terminal.reason === 'setup-failed') {
      expect(terminal.lastReport.checks.find(check => check.name === 'books')?.observed).toEqual([
        {
          id: marketId,
          reasons: [
            'inactive',
            {
              timestampProviderError: {
                kind: 'provider-error',
                provider: 'rpc',
                name: 'TimeoutError',
                code: 'REQUEST_TIMEOUT',
                context: 'request'
              }
            }
          ]
        }
      ])
    }
  })

  test('does not retry transient book outages when the timestamp failure is unknown', async () => {
    const state = readyState()
    let bookReads = 0
    let timestampReads = 0
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
    state.getLatestTimestamp = async () => {
      timestampReads += 1
      throw new ProviderReadError('rpc', 'latest-timestamp')
    }

    const terminal = await new SetupCheckService(state, config).runContinuously({
      signal: new AbortController().signal,
      intervalMs: 1
    })

    expect(bookReads).toBe(1)
    expect(timestampReads).toBe(1)
    expect(terminal).toMatchObject({ status: 'halted', reason: 'setup-failed', cycles: 1 })
    if (terminal.reason === 'setup-failed') {
      expect(terminal.lastReport.checks.find(check => check.name === 'books')?.observed).toEqual([
        {
          id: marketId,
          reasons: [
            {
              providerError: expect.objectContaining({
                provider: 'morpho-api',
                name: 'TimeoutError'
              })
            },
            {
              timestampProviderError: expect.objectContaining({
                provider: 'rpc',
                name: 'ProviderError'
              })
            }
          ]
        }
      ])
    }
  })

  test('stops without emitting setup failure when shutdown interrupts a transient retry', async () => {
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
    const reports: SetupCheckReport[] = []

    const terminal = await new SetupCheckService(state, config).runContinuously({
      signal: controller.signal,
      intervalMs: 1,
      onCycle: report => {
        reports.push(report)
      }
    })

    expect(bookReads).toBe(1)
    expect(reports).toEqual([])
    expect(terminal).toEqual({ status: 'stopped', reason: 'signal', cycles: 0 })
  })

  test('retries transient provider-only startup readiness before allowing writers', async () => {
    const state = readyState()
    let offerReads = 0
    state.inspectOffers = async () => {
      offerReads += 1
      if (offerReads < 3) {
        throw new SafeProviderError({
          kind: 'provider-error',
          provider: 'morpho-api',
          name: 'HttpError',
          status: 503,
          context: 'request'
        })
      }
      return { unknownNamespaces: [], unknownMarketIds: [], invertedMarketIds: [] }
    }

    const report = await new SetupCheckService(state, config).assertReady()

    expect(offerReads).toBe(3)
    expect(report.ready).toBe(true)
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
    expect(error).toBeInstanceOf(SetupFailedError)
  })

  test('does not retry a non-transient provider response at startup', async () => {
    const state = readyState()
    let offerReads = 0
    state.inspectOffers = async () => {
      offerReads += 1
      throw new SafeProviderError({
        kind: 'provider-error',
        provider: 'morpho-api',
        name: 'HttpError',
        status: 400,
        context: 'request'
      })
    }

    const error = await new SetupCheckService(state, config).assertReady().catch(value => value)

    expect(offerReads).toBe(1)
    expect(error).toBeInstanceOf(SetupFailedError)
  })

  test('rejects an invalid setup-monitor interval before any readiness read', async () => {
    const state = readyState()
    let reads = 0
    state.getChainId = async () => {
      reads += 1
      return 8453
    }
    const service = new SetupCheckService(state, config)

    const error = await service
      .runContinuously({ signal: new AbortController().signal, intervalMs: 0 })
      .catch(value => value)

    expect(error).toBeInstanceOf(SetupMonitorConfigurationError)
    expect(reads).toBe(0)
  })

  test('sanitizes an unexpected monitor writer failure', async () => {
    const service = new SetupCheckService(readyState(), config)

    const terminal = await service.runContinuously({
      signal: new AbortController().signal,
      intervalMs: 1,
      onCycle: () => {
        const error = new Error('https://rpc.example/?key=secret')
        error.name = 'https://rpc.example/?key=secret'
        throw error
      }
    })

    expect(terminal).toEqual({
      status: 'halted',
      reason: 'cycle-error',
      cycles: 0,
      cycleErrorName: 'UnknownError'
    })
    expect(JSON.stringify(terminal)).not.toContain('secret')
  })

  test('reports every V0 setup check as passed when the maker is ready', async () => {
    const report = await new SetupCheckService(readyState(), config).check()

    expect(report.ready).toBe(true)
    expect(report.checks.map(check => [check.name, check.status])).toEqual([
      ['chain', 'passed'],
      ['maker', 'passed'],
      ['native-balance', 'passed'],
      ['loan-allowance', 'passed'],
      ['ratifier', 'passed'],
      ['books', 'passed'],
      ['reference', 'passed'],
      ['offers', 'passed'],
      ['position-health', 'not-required']
    ])
  })

  test('skips only private-key derivation and preserves maker observations in read-only mode', async () => {
    const reads: string[] = []
    const unavailable = async (): Promise<never> => {
      reads.push('maker-derivation')
      throw new Error('signer-only read must not run')
    }
    const state = readyState()
    state.getDerivedMaker = unavailable
    state.getNativeBalance = async () => {
      reads.push('native-balance')
      return 10n
    }
    state.getLoanAllowance = async () => {
      reads.push('loan-allowance')
      return { spender: midnight, amount: 100n }
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
      ['maker', 'not-required'],
      ['native-balance', 'passed'],
      ['loan-allowance', 'passed'],
      ['ratifier', 'passed']
    ])
  })

  test('fails maker readiness when write mode receives no derived signer identity', async () => {
    const state = readyState()
    state.getDerivedMaker = async () => undefined

    const report = await new SetupCheckService(state, config).check()

    expect(report.ready).toBe(false)
    expect(report.checks.find(check => check.name === 'maker')).toEqual({
      name: 'maker',
      status: 'failed',
      observed: { derived: false, matches: false },
      required: 'private key derives configured maker'
    })
  })

  test('preserves a sanitized signer operation in the maker readiness check', async () => {
    const state = readyState()
    state.getDerivedMaker = async () => {
      throw new MakerAccountError('kms-public-key')
    }

    const report = await new SetupCheckService(state, config).check()

    expect(report.ready).toBe(false)
    expect(report.checks.find(check => check.name === 'maker')).toEqual({
      name: 'maker',
      status: 'failed',
      observed: { kind: 'signer-error', operation: 'kms-public-key' },
      required: 'private key derives configured maker'
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
      throw new ProviderReadError('morpho-api', 'book-api')
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
      throw new ProviderResponseError('morpho-api', 'book-count', 'invalid count')
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
    state.getDerivedMaker = () => wait('maker', maker)
    state.getNativeBalance = () => wait('balance', 10n)
    state.getLoanAllowance = () => wait('allowance', { spender: midnight, amount: 100n })
    state.getRatifier = () =>
      wait('ratifier', {
        listed: true,
        deployed: true,
        midnightMatches: true,
        surfaceMatches: true,
        authorized: true
      })
    state.getLatestTimestamp = () => wait('timestamp', 1_000n)
    state.getBook = id =>
      wait(`book:${id}`, {
        id,
        allowlisted: true,
        active: true,
        loanAsset,
        tickSpacing: 1,
        maturity: 2_000n
      })
    state.checkReference = async () => {
      started.push('reference')
      await gate
      throw new Error('archive unavailable')
    }
    state.inspectOffers = () =>
      wait('offers', { unknownNamespaces: [], unknownMarketIds: [], invertedMarketIds: [] })
    state.checkPositionHealth = () =>
      wait('position-health', { status: 'not-required' as const, reason: 'V0 has no debt' })

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
        'timestamp',
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
    state.getDerivedMaker = unavailable
    state.getNativeBalance = unavailable
    state.getLoanAllowance = unavailable
    state.getRatifier = unavailable
    state.getLatestTimestamp = unavailable
    state.getBook = unavailable
    state.checkReference = unavailable
    state.inspectOffers = unavailable
    state.checkPositionHealth = unavailable

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
      ['maker', 'failed'],
      ['native-balance', 'failed'],
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
      tickSpacing: 1,
      maturity: 2_000n
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

  test('accepts exact funding thresholds and rejects maturity at the current timestamp', async () => {
    const exactThresholds = await new SetupCheckService(readyState(), config).check()
    expect(exactThresholds.checks.find(check => check.name === 'native-balance')?.status).toBe(
      'passed'
    )
    expect(exactThresholds.checks.find(check => check.name === 'loan-allowance')?.status).toBe(
      'passed'
    )

    const state = readyState()
    state.getBook = async id => ({
      id,
      allowlisted: true,
      active: true,
      loanAsset,
      tickSpacing: 1,
      maturity: 1_000n
    })
    const maturityBoundary = await new SetupCheckService(state, config).check()

    expect(maturityBoundary.checks.find(check => check.name === 'books')?.observed).toEqual([
      { id: marketId, reasons: ['matured at 1000'] }
    ])
  })

  test('reports every unsafe book property so the operator can remediate it', async () => {
    const state = readyState()
    state.getBook = async id => ({
      id,
      allowlisted: false,
      active: false,
      loanAsset: ratifier,
      tickSpacing: 0,
      maturity: 1_000n
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
            'tick spacing is inaccessible',
            'matured at 1000'
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

    expect(report.checks.find(check => check.name === 'loan-allowance')?.remediation).toEqual({
      to: loanAsset,
      functionName: 'approve',
      args: [midnight, 100n]
    })
    expect(report.checks.find(check => check.name === 'ratifier')?.remediation).toBe(
      'authorize the configured maker with the selected ratifier'
    )
  })

  test('fails closed for every unsafe V0 setup surface', async () => {
    const state = readyState()
    state.getChainId = async () => 1
    state.getCode = async () => '0x'
    state.getDerivedMaker = async () => ratifier
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
      tickSpacing: 0,
      maturity: 1_000n
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
      'maker',
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

  test('obtains the V0 position-health result through its reserved port', async () => {
    const report = await new SetupCheckService(readyState(), config).check()

    expect(report.checks.find(check => check.name === 'position-health')).toEqual({
      name: 'position-health',
      status: 'not-required',
      observed: { status: 'not-required', reason: 'V0 has no debt' },
      required: 'not-required for V0'
    })
  })
})
