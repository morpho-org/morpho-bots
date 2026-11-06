import type { Hex } from 'viem'

import { describe, expect, test } from 'vitest'

import type { Outcome } from '../../../src/application/engine/decision'
import type { MarketReport } from '../../../src/application/engine/market-report'

import {
  decisionClassification,
  outcomeReport,
  unavailableReport
} from '../../../src/application/engine/market-report'

const marketId: Hex = `0x${'11'.repeat(32)}`
const ladder = { workflow: 'ladder' as const, marketId, dry: false }
const facts = { bounds: { minimumRateBps: 0n, maximumRateBps: 1_000n }, referenceRateBps: 500n }
const current: MarketReport = {
  workflow: 'ladder',
  marketId,
  status: 'observed',
  action: 'rest',
  facts
}

const outcome = (overrides: Partial<Outcome>): Outcome => ({
  intentId: 'ladder:x#run.0',
  kind: 'replace',
  notice: 'settled',
  payload: { cancel: ['a'], report: { status: 'applied', action: 'replace', reason: 'recenter' } },
  transactions: [],
  ...overrides
})

describe('decisionClassification', () => {
  test('queues an act, and keeps a failure that acts a failure', () => {
    expect(
      decisionClassification({ status: 'applied', action: 'publish', reason: 'x' }, true)
    ).toEqual({ status: 'observed', action: 'queued', reason: 'x' })
    expect(
      decisionClassification({ status: 'failed', stage: 'market-read', invalidated: true }, true)
    ).toEqual({ status: 'failed', stage: 'market-read', invalidated: true })
    expect(decisionClassification({ status: 'observed', action: 'rest' }, false)).toEqual({
      status: 'observed',
      action: 'rest'
    })
  })
})

describe('outcomeReport', () => {
  test('reports a settled act as applied, with what the market read after it', () => {
    expect(outcomeReport(outcome({}), ladder, current)).toEqual({
      workflow: 'ladder',
      marketId,
      status: 'applied',
      action: 'replace',
      reason: 'recenter',
      facts
    })
  })

  test('reports a dry run as logged', () => {
    expect(outcomeReport(outcome({}), { ...ladder, dry: true }, current)).toMatchObject({
      status: 'logged'
    })
  })

  test('keeps the withdrawal of a failed market a failure', () => {
    const failed = outcome({
      kind: 'cancel',
      payload: {
        cancel: ['a'],
        report: { status: 'failed', stage: 'market-read', invalidated: true, errorName: 'X' }
      }
    })
    expect(outcomeReport(failed, ladder, undefined)).toEqual({
      workflow: 'ladder',
      marketId,
      status: 'failed',
      stage: 'market-read',
      invalidated: true,
      errorName: 'X'
    })
  })

  test.each(['refused', 'abandoned', 'compensated', 'failed'] as const)(
    'reports an act that ended %s as failed at act',
    notice => {
      expect(outcomeReport(outcome({ notice }), ladder, current)).toEqual({
        workflow: 'ladder',
        marketId,
        status: 'failed',
        stage: 'act',
        invalidated: false,
        errorName: 'KernelPlanError',
        reason: notice,
        facts
      })
    }
  )

  test("reports a fail-closed withdrawal as the market's unavailable reading, invalidated", () => {
    const withdrawn = outcome({
      kind: 'cancel',
      payload: {
        cancel: ['a'],
        report: unavailableReport('bootstrap', marketId, 'QuoterReadingUnavailableError')
      }
    })
    expect(
      outcomeReport(withdrawn, { workflow: 'bootstrap', marketId, dry: false }, undefined)
    ).toEqual({
      workflow: 'bootstrap',
      marketId,
      status: 'failed',
      stage: 'position-read',
      invalidated: true,
      errorName: 'QuoterReadingUnavailableError'
    })
  })

  test('names each included transaction by its planned step', () => {
    const transactions = [
      { step: 0, hash: '0x01', block: 1 },
      { step: 1, hash: '0x02', block: 2 },
      { step: 2, hash: '0x03', block: 2 }
    ]
    expect(outcomeReport(outcome({ transactions }), ladder, current).transactions).toEqual([
      { operation: 'cancel', txHash: '0x01' },
      { operation: 'ratify', txHash: '0x02' },
      { operation: 'publish', txHash: '0x03' }
    ])
    const publication = outcome({
      payload: { cancel: [], report: { status: 'applied', action: 'publish' } },
      transactions: transactions.slice(0, 2)
    })
    expect(outcomeReport(publication, ladder, current).transactions).toEqual([
      { operation: 'ratify', txHash: '0x01' },
      { operation: 'publish', txHash: '0x02' }
    ])
    const cancel = outcome({
      kind: 'cancel',
      payload: { cancel: ['a', 'b'], report: { status: 'applied' } },
      transactions: transactions.slice(0, 2)
    })
    expect(outcomeReport(cancel, ladder, current).transactions).toEqual([
      { operation: 'cancel', txHash: '0x01' },
      { operation: 'cancel', txHash: '0x02' }
    ])
  })
})
