import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'

import type { Logger } from '../src/logger'

import { createLogger } from '../src/logger'

describe('createLogger', () => {
  // Restore console spies even when an assertion throws first, so a failure in one test
  // cannot leak its captured calls into the next.
  afterEach(() => mock.restore())

  it('drops lines below the configured minimum level', () => {
    const logger: Logger = createLogger('warn')
    const log = spyOn(console, 'log').mockImplementation(() => undefined)
    const err = spyOn(console, 'error').mockImplementation(() => undefined)

    logger.debug('tick.begin')
    logger.info('tick.begin')
    logger.warn('api.lag')
    logger.error('simulate.revert')

    expect(log).toHaveBeenCalledTimes(1) // warn → stdout
    expect(err).toHaveBeenCalledTimes(1) // error → stderr
  })

  it('serializes bigint fields as decimal strings', () => {
    const logger = createLogger('debug')
    const log = spyOn(console, 'log').mockImplementation(() => undefined)

    logger.info('tx.sent', { nonce: 7n, maxFee: 300_000_000_000n })

    const line = String(log.mock.calls[0]?.[0])
    expect(JSON.parse(line)).toEqual({
      level: 'info',
      event: 'tx.sent',
      nonce: '7',
      maxFee: '300000000000'
    })
  })

  it('recurses into nested bigint fields', () => {
    const logger = createLogger('debug')
    const log = spyOn(console, 'log').mockImplementation(() => undefined)

    logger.info('tx.bumped', { tx: { nonce: 7n }, attempts: [1n, 2n] })

    const line = String(log.mock.calls[0]?.[0])
    expect(JSON.parse(line)).toEqual({
      level: 'info',
      event: 'tx.bumped',
      tx: { nonce: '7' },
      attempts: ['1', '2']
    })
  })
})
