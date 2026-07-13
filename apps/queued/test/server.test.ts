import type { Logger } from '@repo/evm-kit'

import { describe, expect, it } from 'bun:test'

import type { Engine } from '../src/engine'
import type { QueueAck, QueuedTransaction } from '../src/protocol'

import { EngineError } from '../src/engine'
import { handleQueuedLine } from '../src/server'

const CHAIN_ID = 8453
const ID = 'blue:liquidate:8453:0xmarket:0xborrower'

function spyLogger() {
  const events: { level: string; event: string; fields?: Record<string, unknown> }[] = []
  const make = (level: string) => (event: string, fields?: Record<string, unknown>) =>
    events.push({ level, event, fields })
  const logger: Logger = {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error')
  }
  return { logger, events }
}

// A fake engine whose ingest is supplied per test; the other lifecycle methods are never called here.
function fakeEngine(ingest: (tx: QueuedTransaction) => Promise<QueueAck>): Engine {
  return {
    start: async () => {},
    ingest,
    tick: async () => {},
    shutdown: async () => {}
  }
}

const line = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: 'transaction',
    chainId: CHAIN_ID,
    id: ID,
    to: '0x2222222222222222222222222222222222222222',
    data: '0x',
    value: '0',
    ...overrides
  })

describe('handleQueuedLine', () => {
  it('serializes the engine ack for a valid transaction and logs nothing', async () => {
    const { logger, events } = spyLogger()
    const ack = await handleQueuedLine(line(), {
      chainId: CHAIN_ID,
      engine: fakeEngine(async tx => ({ ok: true, id: tx.id, status: 'submitted' })),
      log: logger
    })
    expect(JSON.parse(ack)).toEqual({ ok: true, id: ID, status: 'submitted' })
    expect(events).toHaveLength(0)
  })

  it('attaches the transaction id to an EngineError ack', async () => {
    const { logger } = spyLogger()
    const ack = await handleQueuedLine(line(), {
      chainId: CHAIN_ID,
      engine: fakeEngine(async () => {
        throw new EngineError('retry', 'signer down')
      }),
      log: logger
    })
    expect(JSON.parse(ack)).toEqual({ ok: false, code: 'retry', error: 'signer down', id: ID })
  })

  it('maps an unexpected ingest throw to an internal ack and queued.internal log, both carrying id', async () => {
    const { logger, events } = spyLogger()
    const ack = await handleQueuedLine(line(), {
      chainId: CHAIN_ID,
      engine: fakeEngine(async () => {
        throw new Error('boom')
      }),
      log: logger
    })
    expect(JSON.parse(ack)).toEqual({
      ok: false,
      code: 'internal',
      error: 'internal queued error',
      id: ID
    })
    expect(events).toContainEqual({
      level: 'error',
      event: 'queued.internal',
      fields: { id: ID, error: 'boom' }
    })
  })

  it('rejects a parseable-but-invalid record with a best-effort id and never ingests', async () => {
    const { logger } = spyLogger()
    let ingested = 0
    const ack = await handleQueuedLine(line({ value: '5' }), {
      chainId: CHAIN_ID,
      engine: fakeEngine(async tx => {
        ingested += 1
        return { ok: true, id: tx.id, status: 'submitted' }
      }),
      log: logger
    })
    const parsed = JSON.parse(ack)
    expect(parsed.ok).toBe(false)
    expect(parsed.code).toBe('bad_request')
    expect(parsed.id).toBe(ID)
    expect(ingested).toBe(0)
  })

  it('rejects a non-JSON line as bad_request with no id', async () => {
    const { logger } = spyLogger()
    const ack = await handleQueuedLine('{bad', {
      chainId: CHAIN_ID,
      engine: fakeEngine(async tx => ({ ok: true, id: tx.id, status: 'submitted' })),
      log: logger
    })
    const parsed = JSON.parse(ack)
    expect(parsed.ok).toBe(false)
    expect(parsed.code).toBe('bad_request')
    expect('id' in parsed).toBe(false)
  })
})
