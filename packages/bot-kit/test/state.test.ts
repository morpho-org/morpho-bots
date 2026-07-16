import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { QueueState } from '../src/state'

import { botStatePaths, loadState, QUEUE_STATE_VERSION, saveState } from '../src/state'

const STATE: QueueState = {
  version: QUEUE_STATE_VERSION,
  queue: {
    pending: [
      {
        nonce: 7,
        txHash: `0x${'ab'.repeat(32)}`,
        request: { to: `0x${'11'.repeat(20)}`, data: '0x' },
        label: 'market:borrower',
        submittedAtBlock: 123456789012345678901n,
        maxFeePerGas: 1_000_000_000n,
        maxPriorityFeePerGas: 1_000_000n,
        attempt: 2
      }
    ]
  }
}

function tempPath() {
  return join(mkdtempSync(join(tmpdir(), 'bot-kit-state-')), 'blue', 'state', '8453.json')
}

describe('saveState / loadState', () => {
  it('round-trips bigint fields and creates parent directories', () => {
    const path = tempPath()
    saveState(path, STATE)
    const { state, reset } = loadState<QueueState>(path, QUEUE_STATE_VERSION)
    expect(reset).toBeNull()
    expect(state).toEqual(STATE) // bigint submittedAtBlock/fees survive
  })

  it('leaves no temp file behind (atomic write)', () => {
    const path = tempPath()
    saveState(path, STATE)
    expect(readdirSync(join(path, '..'))).toEqual(['8453.json'])
    expect(existsSync(`${path}.tmp`)).toBe(false)
  })

  it('returns fresh state for a missing file', () => {
    expect(loadState<QueueState>(tempPath(), QUEUE_STATE_VERSION)).toEqual({
      state: null,
      reset: 'missing'
    })
  })

  it('discards a corrupt file instead of trusting it', () => {
    const path = tempPath()
    saveState(path, STATE)
    writeFileSync(path, '{ truncated mid-wri')
    expect(loadState<QueueState>(path, QUEUE_STATE_VERSION)).toEqual({
      state: null,
      reset: 'corrupt'
    })
  })

  it('discards a version-mismatched file instead of migrating it', () => {
    const path = tempPath()
    saveState(path, STATE)
    expect(loadState<QueueState>(path, QUEUE_STATE_VERSION + 1)).toEqual({
      state: null,
      reset: 'version_mismatch'
    })
  })
})

describe('botStatePaths', () => {
  const original = process.env.BOT_STATE_DIR
  afterEach(() => {
    if (original === undefined) delete process.env.BOT_STATE_DIR
    else process.env.BOT_STATE_DIR = original
  })

  it('namespaces state + outcomes files by bot and chain under BOT_STATE_DIR', () => {
    process.env.BOT_STATE_DIR = '/data/bots'
    expect(botStatePaths('blue-liquidation', 8453)).toEqual({
      stateFile: '/data/bots/blue-liquidation/state-8453.json',
      outcomesFile: '/data/bots/blue-liquidation/outcomes-8453.jsonl'
    })
  })

  it('defaults to ~/.morpho-bots when BOT_STATE_DIR is unset', () => {
    delete process.env.BOT_STATE_DIR
    const { stateFile } = botStatePaths('midnight-liquidation', 8453)
    expect(stateFile.endsWith('/.morpho-bots/midnight-liquidation/state-8453.json')).toBe(true)
  })
})
