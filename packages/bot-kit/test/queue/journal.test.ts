import type { Hex } from 'viem'

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Settlement } from '../../src/queue/pending-queue'

import { createOutcomeJournal } from '../../src/queue/journal'

const HASH: Hex = `0x${'ab'.repeat(32)}`

function tempPath() {
  return join(mkdtempSync(join(tmpdir(), 'bot-kit-journal-')), 'nested', 'outcomes-8453.jsonl')
}

function readLines(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

describe('createOutcomeJournal', () => {
  it('appends one JSON line per settlement, tagged with chainId and a timestamp', () => {
    const path = tempPath()
    const journal = createOutcomeJournal({ path, chainId: 8453 })
    const confirmed: Settlement = {
      label: 'market:borrower',
      nonce: 7,
      txHash: HASH,
      status: 'confirmed'
    }
    const dropped: Settlement = {
      label: 'market:other',
      nonce: 8,
      txHash: HASH,
      status: 'dropped',
      reason: 'nonce_consumed'
    }
    journal.record(confirmed)
    journal.record(dropped)

    const lines = readLines(path)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({
      kind: 'queue',
      chainId: 8453,
      label: 'market:borrower',
      status: 'confirmed',
      nonce: 7,
      txHash: HASH
    })
    expect(typeof lines[0]?.at).toBe('string')
    expect(lines[0]).not.toHaveProperty('reason') // omitted when absent
    expect(lines[1]).toMatchObject({ status: 'dropped', reason: 'nonce_consumed' })
  })
})
