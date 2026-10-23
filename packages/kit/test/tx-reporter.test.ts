import type { KernelActivity, Notice } from '@repo/kernel'

import { describe, expect, it } from 'vitest'

import type { NotSent, TxCounter } from '../src/tx-reporter'

import { recordLogs, TX_KEY, TX_SCENARIO, txFeesOf } from '../src/testing'
import { createTxReporter } from '../src/tx-reporter'

const intent = (n: number) => `${TX_KEY}#run.${n}`

describe('createTxReporter', () => {
  it('counts each first broadcast at a nonce, and reports each act that ended unsent', () => {
    const { logger } = recordLogs()
    const counted: TxCounter[] = []
    const notSent: NotSent[] = []
    const reportActivity = createTxReporter({
      logger,
      feesOf: txFeesOf,
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
      'broadcast'
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
        status: 'accepted'
      })
      reportActivity([sent('0xaa')])
      reportActivity([{ type: 'notice', intentId, notice }])
      reportActivity([sent('0xbb')])
      expect(counted).toStrictEqual(['broadcast'])
    }
  )
})
