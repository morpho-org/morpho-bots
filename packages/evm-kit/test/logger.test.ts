import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'

import type { Logger } from '../src/logger'

import { createLogger, isLogLevel, LOG_LEVELS } from '../src/logger'

describe('createLogger', () => {
  // Restore console spies even when an assertion throws first, so a failure in one test
  // cannot leak its captured calls into the next.
  afterEach(() => mock.restore())

  it('drops lines below the minimum level and routes every surviving level to stderr', () => {
    const logger: Logger = createLogger('warn')
    const log = spyOn(console, 'log').mockImplementation(() => undefined)
    const err = spyOn(console, 'error').mockImplementation(() => undefined)

    logger.debug('rindexer.lag')
    logger.info('block.new')
    logger.warn('rindexer.lag')
    logger.error('tick.error')

    expect(log).toHaveBeenCalledTimes(0) // stdout is the data plane — never a log line
    expect(err).toHaveBeenCalledTimes(2) // warn + error both survive the threshold → stderr
  })

  it('serializes bigint fields as decimal strings on stderr', () => {
    const logger = createLogger('debug')
    const err = spyOn(console, 'error').mockImplementation(() => undefined)

    logger.info('tx.sent', { nonce: 7n, maxFee: 300_000_000_000n })

    const line = String(err.mock.calls[0]?.[0])
    expect(JSON.parse(line)).toEqual({
      level: 'info',
      event: 'tx.sent',
      nonce: '7',
      maxFee: '300000000000'
    })
  })

  it('recurses into nested bigint fields', () => {
    const logger = createLogger('debug')
    const err = spyOn(console, 'error').mockImplementation(() => undefined)

    logger.info('tx.bumped', { tx: { nonce: 7n }, attempts: [1n, 2n] })

    const line = String(err.mock.calls[0]?.[0])
    expect(JSON.parse(line)).toEqual({
      level: 'info',
      event: 'tx.bumped',
      tx: { nonce: '7' },
      attempts: ['1', '2']
    })
  })

  it('stamps bound base fields on every emitted line', () => {
    const logger = createLogger('debug', { bot: 'blue', op: 'liquidate', chainId: 8453 })
    const err = spyOn(console, 'error').mockImplementation(() => undefined)

    logger.debug('source.skip', { id: 'blue:liquidate:8453:0xabc:0xdef' })
    logger.error('op.error', { detail: 'boom' })

    expect(JSON.parse(String(err.mock.calls[0]?.[0]))).toEqual({
      bot: 'blue',
      op: 'liquidate',
      chainId: 8453,
      id: 'blue:liquidate:8453:0xabc:0xdef',
      level: 'debug',
      event: 'source.skip'
    })
    expect(JSON.parse(String(err.mock.calls[1]?.[0]))).toEqual({
      bot: 'blue',
      op: 'liquidate',
      chainId: 8453,
      detail: 'boom',
      level: 'error',
      event: 'op.error'
    })
  })

  it('lets a per-call field override a colliding base field', () => {
    const logger = createLogger('debug', { chainId: 8453 })
    const err = spyOn(console, 'error').mockImplementation(() => undefined)

    logger.info('tx.sent', { chainId: 4663 })

    // A single chainId key, taking the per-call value.
    expect(JSON.parse(String(err.mock.calls[0]?.[0]))).toEqual({
      chainId: 4663,
      level: 'info',
      event: 'tx.sent'
    })
  })

  it('never lets base or per-call fields overwrite the reserved level/event keys', () => {
    const logger = createLogger('debug', { level: 'debug', event: 'spoofed.base' })
    const err = spyOn(console, 'error').mockImplementation(() => undefined)

    logger.warn('real.event', { level: 'error', event: 'spoofed.field' })

    expect(JSON.parse(String(err.mock.calls[0]?.[0]))).toEqual({
      level: 'warn',
      event: 'real.event'
    })
  })
})

describe('isLogLevel', () => {
  it('accepts every level in LOG_LEVELS', () => {
    for (const level of LOG_LEVELS) expect(isLogLevel(level)).toBe(true)
  })

  it('rejects unknown strings and non-strings', () => {
    expect(isLogLevel('trace')).toBe(false)
    expect(isLogLevel('INFO')).toBe(false) // case-sensitive
    expect(isLogLevel('')).toBe(false)
    expect(isLogLevel(undefined)).toBe(false)
    expect(isLogLevel(3)).toBe(false)
  })
})
