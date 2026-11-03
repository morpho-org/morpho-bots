import type { KernelActivity, Notice } from '@repo/kernel'

import { describe, expect, it } from 'vitest'

import type { NotSent, TxCounter } from '../src/tx-reporter'

import { recordLogs, TX_KEY, TX_SCENARIO } from '../src/testing'
import { createTxReporter } from '../src/tx-reporter'

const intent = (n: number) => `${TX_KEY}#run.${n}`

describe('createTxReporter', () => {
  it('counts each first broadcast at a nonce, and reports each act that ended unsent', () => {
    const { logger } = recordLogs()
    const counted: TxCounter[] = []
    const notSent: NotSent[] = []
    const reportActivity = createTxReporter({
      logger,
      count: counter => void counted.push(counter),
      reportNotSent: fields => void notSent.push(fields)
    })
    for (const transition of TX_SCENARIO) reportActivity(transition)
    expect(notSent).toStrictEqual([
      {
        id: TX_KEY,
        intentId: intent(3),
        notice: 'refused',
        reason: 'evidence 0xmarket:0xborrower predates our own effect on 0xmarket'
      },
      { id: TX_KEY, intentId: intent(4), notice: 'refused', reason: 'stopped' },
      { id: TX_KEY, intentId: intent(7), notice: 'abandoned', reason: 'deadline passed' }
    ])
    expect(counted).toStrictEqual([
      'broadcast',
      'broadcast',
      'broadcast',
      'broadcast',
      'notSent',
      'notSent',
      'notSent',
      'notSent',
      'broadcast',
      'broadcast'
    ])
  })

  it('logs a successful inclusion as included whatever the outcome, and cancelled only when nothing ran', () => {
    const { lines, logger } = recordLogs()
    const reportActivity = createTxReporter({ logger, reportNotSent: () => {} })
    const intentId = intent(30)
    reportActivity([
      {
        type: 'sent',
        intentId,
        step: 0,
        kind: 'step',
        nonce: 3,
        hash: '0xaa',
        status: 'accepted',
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 1n
      }
    ])
    reportActivity([{ type: 'notice', intentId, notice: 'compensating', reason: 'expired' }])
    const inclusion = { step: 0, hash: '0xaa', block: 7, success: true }
    reportActivity([
      { type: 'included', intentId, ...inclusion },
      { type: 'notice', intentId, notice: 'compensated', reason: 'expired', included: [inclusion] }
    ])
    const other = intent(31)
    reportActivity([
      {
        type: 'sent',
        intentId: other,
        step: 0,
        kind: 'step',
        nonce: 4,
        hash: '0xbb',
        status: 'accepted',
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 1n
      }
    ])
    reportActivity([
      {
        type: 'notice',
        intentId: other,
        notice: 'compensated',
        code: 'cancelled',
        reason: 'expired',
        included: []
      }
    ])
    expect(lines.map(line => [line.event, line.fields.txHash, line.fields.nonce])).toStrictEqual([
      ['tx.sent', '0xaa', 3],
      ['tx.included', '0xaa', 3],
      ['tx.sent', '0xbb', 4],
      ['tx.cancelled', '0xbb', 4]
    ])
  })

  it('logs a step that lands after its act ended once, though a reorg lands it again', () => {
    const { lines, logger } = recordLogs()
    const reportActivity = createTxReporter({ logger, reportNotSent: () => {} })
    const intentId = intent(40)
    const inclusion = { type: 'included', intentId, step: 0, hash: '0xcc', block: 8 } as const
    reportActivity([{ type: 'notice', intentId, notice: 'failed', reason: 'stuck', included: [] }])
    reportActivity([{ ...inclusion, success: true }])
    reportActivity([{ ...inclusion, block: 9, success: true }])
    expect(lines.map(line => [line.event, line.fields.txHash ?? null])).toStrictEqual([
      ['tx.included', '0xcc']
    ])
  })

  it('logs each outcome of a receipt once, so a reorg that turns a revert into a success logs both', () => {
    const { lines, logger } = recordLogs()
    const reportActivity = createTxReporter({ logger, reportNotSent: () => {} })
    const intentId = intent(41)
    const inclusion = { type: 'included', intentId, step: 0, hash: '0xdd' } as const
    reportActivity([{ ...inclusion, block: 8, success: false }])
    reportActivity([{ ...inclusion, block: 9, success: true }])
    reportActivity([{ ...inclusion, block: 10, success: false }])
    reportActivity([{ ...inclusion, block: 11, success: true }])
    expect(lines.map(line => [line.event, line.fields.blockNumber])).toStrictEqual([
      ['tx.reverted', 8],
      ['tx.included', 9]
    ])
  })

  it('forgets the outcomes of a hash once its nonce record is final', () => {
    const { lines, logger } = recordLogs()
    const reportActivity = createTxReporter({ logger, reportNotSent: () => {} })
    const intentId = intent(42)
    const inclusion = { type: 'included', intentId, step: 0, hash: '0xee', success: true } as const
    reportActivity([{ ...inclusion, block: 8 }])
    reportActivity([{ type: 'final', nonce: 3, hashes: ['0xee'] }])
    reportActivity([{ ...inclusion, block: 9 }])
    expect(lines.map(line => [line.event, line.fields.blockNumber])).toStrictEqual([
      ['tx.included', 8],
      ['tx.included', 9]
    ])
  })

  it.each(['advanced', 'stalled', 'known', 'admitted', 'compensating'] satisfies Notice[])(
    'keeps sent hashes through an intermediate %s notice, so a replacement is not counted again',
    notice => {
      const { logger } = recordLogs()
      const counted: TxCounter[] = []
      const reportActivity = createTxReporter({
        logger,
        count: counter => void counted.push(counter),
        reportNotSent: () => {}
      })
      const intentId = intent(20)
      const sent = (hash: string): KernelActivity => ({
        type: 'sent',
        intentId,
        step: 0,
        kind: 'step',
        nonce: 12,
        hash,
        status: 'accepted',
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 1n
      })
      reportActivity([sent('0xaa')])
      reportActivity([{ type: 'notice', intentId, notice }])
      reportActivity([sent('0xbb')])
      expect(counted).toStrictEqual(['broadcast'])
    }
  )
})
