import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { QueueState } from '../src/queue-state'

import { QUEUE_STATE_VERSION, readAdvisory } from '../src/queue-state'
import { saveState } from '../src/state'

function tempPath() {
  return join(mkdtempSync(join(tmpdir(), 'morpho-bots-test-')), 'blue', 'queue', '8453.json')
}

const STATE: QueueState = {
  version: QUEUE_STATE_VERSION,
  queue: {
    pending: [
      {
        nonce: 7,
        txHash: `0x${'1'.repeat(64)}`,
        request: { to: '0x0000000000000000000000000000000000000001', data: '0x' },
        label: 'blue:liq:8453:0xmarket:0xpending',
        submittedAtBlock: 100n,
        maxFeePerGas: 1000n,
        maxPriorityFeePerGas: 1000n,
        attempt: 0
      }
    ],
    settledAt: [['blue:liq:8453:0xmarket:0xcooldown', 95n]]
  },
  backoff: [['blue:liq:8453:0xmarket:0xbackedoff', { attempts: 2, until: 120n }]]
}

describe('readAdvisory', () => {
  it('derives backoff + the union of pending and settled labels from the queue state file', () => {
    const path = tempPath()
    saveState(path, STATE)

    const advisory = readAdvisory(path)
    expect(advisory.backoff).toEqual(STATE.backoff) // bigint `until` survives the round trip
    expect(advisory.inflightLabels.toSorted()).toEqual([
      'blue:liq:8453:0xmarket:0xcooldown',
      'blue:liq:8453:0xmarket:0xpending'
    ])
  })

  it('returns an empty advisory for a missing file (no backoff, nothing in flight)', () => {
    expect(readAdvisory(tempPath())).toEqual({ backoff: null, inflightLabels: [] })
  })

  it('returns an empty advisory for a version-mismatched file (discarded, not migrated)', () => {
    const path = tempPath()
    saveState(path, { ...STATE, version: QUEUE_STATE_VERSION + 1 })
    expect(readAdvisory(path)).toEqual({ backoff: null, inflightLabels: [] })
  })
})
