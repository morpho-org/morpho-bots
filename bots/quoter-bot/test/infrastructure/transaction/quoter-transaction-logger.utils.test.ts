import { describe, expect, test } from 'vitest'

import { createQuoterTransactionLogger } from '../../../src/infrastructure/transaction/quoter-transaction-logger.utils'

const hash = (byte: string) => `0x${byte.repeat(64)}` as const

describe('createQuoterTransactionLogger', () => {
  test('projects the initial hash, replacement chain, and terminal drop without provider text', () => {
    const events: unknown[] = []
    const logger = createQuoterTransactionLogger(event => {
      events.push(event)
    })

    logger.warn('tx.broadcast_unknown', {
      nonce: 4,
      txHash: hash('a'),
      reason: 'credentialed https://rpc.example response'
    })
    logger.info('tx.bumped', {
      nonce: 4,
      oldHash: hash('a'),
      newHash: hash('b'),
      attempt: 1,
      maxFee: 99n
    })
    logger.warn('tx.dropped', {
      nonce: 4,
      txHash: hash('b'),
      reason: 'fee_ceiling',
      detail: 'credentialed https://rpc.example response'
    })

    expect(events).toEqual([
      {
        event: 'transaction.lifecycle',
        state: 'broadcast-unknown',
        nonce: 4,
        txHash: hash('a')
      },
      {
        event: 'transaction.lifecycle',
        state: 'replaced',
        nonce: 4,
        txHash: hash('b'),
        previousTxHash: hash('a'),
        attempt: 1
      },
      {
        event: 'transaction.lifecycle',
        state: 'dropped',
        nonce: 4,
        txHash: hash('b'),
        reason: 'fee_ceiling'
      }
    ])
    expect(JSON.stringify(events)).not.toContain('rpc.example')
  })

  test('ignores malformed lifecycle records and writer failures', () => {
    const logger = createQuoterTransactionLogger(() => {
      throw new Error('observer unavailable')
    })
    expect(() => logger.info('tx.sent', { nonce: -1, txHash: 'not-a-hash' })).not.toThrow()
    expect(() => logger.info('tx.sent', { nonce: 1, txHash: hash('a') })).not.toThrow()
  })
})
