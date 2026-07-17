import { BetterStackTransport } from '@loglayer/transport-betterstack'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'

import type { Logger } from '../src/logger'

import { betterStackTransport, createLogger } from '../src/logger'

describe('createLogger', () => {
  // Restore console spies even when an assertion throws first, so a failure in one test
  // cannot leak its captured calls into the next.
  afterEach(() => mock.restore())

  it('drops lines below the configured minimum level', () => {
    const logger: Logger = createLogger('warn')
    const log = spyOn(console, 'log').mockImplementation(() => undefined)
    const err = spyOn(console, 'error').mockImplementation(() => undefined)

    logger.debug('rindexer.lag')
    logger.info('block.new')
    logger.warn('rindexer.lag')
    logger.error('tick.error')

    expect(err).toHaveBeenCalledTimes(2) // warn + error → stderr
    expect(log).not.toHaveBeenCalled() // stdout stays reserved for program output
  })

  it('routes every level to stderr', () => {
    const logger = createLogger('debug')
    const log = spyOn(console, 'log').mockImplementation(() => undefined)
    const err = spyOn(console, 'error').mockImplementation(() => undefined)

    logger.debug('a')
    logger.info('b')
    logger.warn('c')
    logger.error('d')

    expect(err).toHaveBeenCalledTimes(4)
    expect(log).not.toHaveBeenCalled()
  })

  it('serializes bigint fields as decimal strings', () => {
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

  it('stamps bound context onto every line', () => {
    const logger = createLogger('debug', { context: { bot: 'blue-liquidation', chainId: 8453 } })
    const err = spyOn(console, 'error').mockImplementation(() => undefined)

    logger.info('block.new', { height: 42n })
    logger.warn('state.reset')

    const first = JSON.parse(String(err.mock.calls[0]?.[0]))
    const second = JSON.parse(String(err.mock.calls[1]?.[0]))
    expect(first).toEqual({
      level: 'info',
      event: 'block.new',
      bot: 'blue-liquidation',
      chainId: 8453,
      height: '42'
    })
    // Context is present even when the call passes no fields of its own.
    expect(second).toEqual({
      level: 'warn',
      event: 'state.reset',
      bot: 'blue-liquidation',
      chainId: 8453
    })
  })
})

describe('betterStackTransport (opt-in contract)', () => {
  afterEach(() => mock.restore())

  it('attaches only when BOTH env vars are set', () => {
    const err = spyOn(console, 'error').mockImplementation(() => undefined)
    expect(betterStackTransport({})).toBeNull()
    // Both unset stays fully SILENT — no warning line.
    expect(err).not.toHaveBeenCalled()

    const transport = betterStackTransport({
      BETTERSTACK_SOURCE_TOKEN: 'tok',
      BETTERSTACK_INGESTING_HOST: 's1.betterstackdata.com'
    })
    expect(transport).toBeInstanceOf(BetterStackTransport)
  })

  it('token-only fails loud (names the missing host) and attaches no transport', () => {
    const err = spyOn(console, 'error').mockImplementation(() => undefined)
    expect(betterStackTransport({ BETTERSTACK_SOURCE_TOKEN: 'tok' })).toBeNull()

    expect(err).toHaveBeenCalledTimes(1)
    const line = JSON.parse(String(err.mock.calls[0]?.[0])) as Record<string, unknown>
    expect(line.level).toBe('error')
    expect(line.event).toBe('logship.misconfigured')
    expect(line.detail).toContain('BETTERSTACK_INGESTING_HOST')
  })

  it('host-only fails loud (names the missing token) and attaches no transport', () => {
    const err = spyOn(console, 'error').mockImplementation(() => undefined)
    expect(
      betterStackTransport({ BETTERSTACK_INGESTING_HOST: 's1.betterstackdata.com' })
    ).toBeNull()

    expect(err).toHaveBeenCalledTimes(1)
    const line = JSON.parse(String(err.mock.calls[0]?.[0])) as Record<string, unknown>
    expect(line.event).toBe('logship.misconfigured')
    expect(line.detail).toContain('BETTERSTACK_SOURCE_TOKEN')
  })

  it('treats blank/whitespace as unset — a blank token with a host still fails loud', () => {
    const err = spyOn(console, 'error').mockImplementation(() => undefined)
    // Blank/whitespace does not count as set: this is token-unset + host-set → partial config.
    expect(
      betterStackTransport({ BETTERSTACK_SOURCE_TOKEN: '  ', BETTERSTACK_INGESTING_HOST: 'h' })
    ).toBeNull()
    expect(err).toHaveBeenCalledTimes(1)
    const line = JSON.parse(String(err.mock.calls[0]?.[0])) as Record<string, unknown>
    expect(line.detail).toContain('BETTERSTACK_SOURCE_TOKEN')
  })
})

describe('createLogger BetterStack path', () => {
  afterEach(() => mock.restore())

  it('performs zero network activity when the env vars are unset', () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((() =>
      Promise.reject(new Error('network must not be touched'))) as unknown as typeof fetch)
    spyOn(console, 'error').mockImplementation(() => undefined)

    const logger = createLogger('debug', { env: {} })
    logger.info('tx.sent', { nonce: 1n })

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('warns and performs zero network activity under partial (token-only) config', () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((() =>
      Promise.reject(new Error('network must not be touched'))) as unknown as typeof fetch)
    const err = spyOn(console, 'error').mockImplementation(() => undefined)

    const logger = createLogger('debug', { env: { BETTERSTACK_SOURCE_TOKEN: 'tok' } })
    logger.info('tx.sent', { nonce: 1n })

    // The misconfiguration line was emitted at construction, but no transport attached → no network.
    const lines = err.mock.calls.map(call => JSON.parse(String(call[0])) as Record<string, unknown>)
    expect(lines.some(line => line.event === 'logship.misconfigured')).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('serializes nested bigints without throwing when BetterStack is enabled (HTTP mocked)', () => {
    // Mock the HTTP layer so no real request can escape even if a batch were to flush.
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((() =>
      Promise.resolve(new Response(null, { status: 202 }))) as unknown as typeof fetch)
    const err = spyOn(console, 'error').mockImplementation(() => undefined)

    const logger = createLogger('debug', {
      env: {
        BETTERSTACK_SOURCE_TOKEN: 'tok',
        BETTERSTACK_INGESTING_HOST: 's1.betterstackdata.com'
      }
    })

    // The BetterStack transport builds its payload via JSON.stringify synchronously inside
    // shipToLogger — a raw bigint there throws and is routed to onError as a `logship.error` line.
    // With flattening in place this must not happen.
    expect(() => logger.info('tx.bumped', { tx: { nonce: 7n }, attempts: [1n, 2n] })).not.toThrow()

    const lines = err.mock.calls.map(call => JSON.parse(String(call[0])) as Record<string, unknown>)
    // No serialization failure reached the BetterStack transport's onError.
    expect(lines.some(line => line.event === 'logship.error')).toBe(false)
    // The one structured line carries the bigints as decimal strings (correct string form).
    const structured = lines.find(line => line.event === 'tx.bumped')
    expect(structured).toEqual({
      level: 'info',
      event: 'tx.bumped',
      tx: { nonce: '7' },
      attempts: ['1', '2']
    })
    fetchSpy.mockClear()
  })
})
