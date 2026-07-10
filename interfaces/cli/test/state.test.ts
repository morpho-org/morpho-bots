import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadState, saveState } from '../src/state'

type TestState = { version: number; queue: { nonce: number; fee: bigint }[] }

const STATE: TestState = { version: 1, queue: [{ nonce: 7, fee: 123456789012345678901n }] }

function tempPath() {
  return join(mkdtempSync(join(tmpdir(), 'morpho-bots-test-')), 'blue', 'state', '8453.json')
}

describe('saveState / loadState', () => {
  it('round-trips bigint fields and creates parent directories', () => {
    const path = tempPath()
    saveState(path, STATE)
    const { state, reset } = loadState<TestState>(path, 1)
    expect(reset).toBeNull()
    expect(state).toEqual(STATE) // bigint fee survives
  })

  it('leaves no temp file behind (atomic write)', () => {
    const path = tempPath()
    saveState(path, STATE)
    expect(readdirSync(join(path, '..'))).toEqual(['8453.json'])
    expect(existsSync(`${path}.tmp`)).toBe(false)
  })

  it('returns fresh state for a missing file', () => {
    expect(loadState<TestState>(tempPath(), 1)).toEqual({ state: null, reset: 'missing' })
  })

  it('discards a corrupt file instead of trusting it', () => {
    const path = tempPath()
    saveState(path, STATE)
    writeFileSync(path, '{ truncated mid-wri')
    expect(loadState<TestState>(path, 1)).toEqual({ state: null, reset: 'corrupt' })
  })

  it('discards a version-mismatched file instead of migrating it', () => {
    const path = tempPath()
    saveState(path, STATE)
    expect(loadState<TestState>(path, 2)).toEqual({ state: null, reset: 'version_mismatch' })
  })
})
