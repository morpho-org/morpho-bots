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
const marketId = `0x${'55'.repeat(32)}`

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
