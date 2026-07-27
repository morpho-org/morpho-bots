import type { Hex } from 'viem'

import { describe, expect, test } from 'bun:test'

import {
  SetupCheckError,
  SetupCheckService,
  type SetupCheckConfig,
  type SetupStateService
} from '../../src/application/setup-check.service'

const maker = '0x1111111111111111111111111111111111111111'
const midnight = '0x2222222222222222222222222222222222222222'
const loanAsset = '0x3333333333333333333333333333333333333333'
const ratifier = '0x4444444444444444444444444444444444444444'
const marketId: Hex = `0x${'55'.repeat(32)}`
const secondMarketId: Hex = `0x${'66'.repeat(32)}`

const config: SetupCheckConfig = {
  chainId: 8453,
  maker,
  midnight,
  nativeReserve: 10n,
  loanAsset,
  maximumLendExposure: 100n,
  ratifier,
  marketIds: [marketId]
}

function readyState(): SetupStateService {
  return {
    getChainId: async () => 8453,
    getCode: async () => '0x1234',
    getDerivedMaker: async () => maker,
    getNativeBalance: async () => 10n,
    getLoanAllowance: async () => ({ spender: midnight, amount: 100n }),
    getRatifier: async () => ({ listed: true, supportsEcrecover: true, authorized: true }),
    getBook: async id => ({
      id,
      allowlisted: true,
      active: true,
      loanAsset,
      tickSpacing: 1,
      maturity: 2_000n
    }),
    getLatestTimestamp: async () => 1_000n,
    checkReference: async () => ({ referenceReadable: true, archiveReadable: true }),
    inspectOffers: async () => ({ unknownNamespaces: [], invertedMarketIds: [] }),
    checkPositionHealth: async () => ({ status: 'not-required', reason: 'V0 has no debt' })
  }
}

describe('SetupCheckService', () => {
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

  test('rejects readiness with the failed check and remediation when setup is unsafe', async () => {
    const state = readyState()
    state.getNativeBalance = async () => 9n

    const readiness = new SetupCheckService(state, config).assertReady()

    expect(readiness).rejects.toBeInstanceOf(SetupCheckError)
    expect(readiness).rejects.toMatchObject({
      report: {
        ready: false,
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: 'native-balance',
            status: 'failed',
            observed: 9n,
            required: 10n,
            remediation: `fund ${maker} with native token to at least 10`
          })
        ])
      }
    })
  })

  test('records a provider failure against the exact check instead of losing the report', async () => {
    const state = readyState()
    state.checkReference = async () => {
      throw new Error('archive state unavailable')
    }

    const report = await new SetupCheckService(state, config).check()

    expect(report.ready).toBe(false)
    expect(report.checks.find(check => check.name === 'reference')).toEqual({
      name: 'reference',
      status: 'failed',
      observed: { error: 'archive state unavailable' },
      required: { referenceReadable: true, archiveReadable: true }
    })
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
      wait('ratifier', { listed: true, supportsEcrecover: true, authorized: true })
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
    state.inspectOffers = () => wait('offers', { unknownNamespaces: [], invertedMarketIds: [] })
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

    expect(error).toBeInstanceOf(SetupCheckError)
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

  test('returns exact read-only remediation transactions for allowance and authorization failures', async () => {
    const state = readyState()
    state.getLoanAllowance = async () => ({ spender: midnight, amount: 99n })
    state.getRatifier = async () => ({
      listed: true,
      supportsEcrecover: true,
      authorized: false
    })

    const report = await new SetupCheckService(state, config).check()

    expect(report.checks.find(check => check.name === 'loan-allowance')?.remediation).toEqual({
      to: loanAsset,
      functionName: 'approve',
      args: [midnight, 100n]
    })
    expect(report.checks.find(check => check.name === 'ratifier')?.remediation).toEqual({
      to: midnight,
      functionName: 'setIsAuthorized',
      args: [ratifier, true, maker]
    })
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
      supportsEcrecover: false,
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
    state.checkReference = async () => ({ referenceReadable: false, archiveReadable: false })
    state.inspectOffers = async () => ({
      unknownNamespaces: ['v0:unknown'],
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
