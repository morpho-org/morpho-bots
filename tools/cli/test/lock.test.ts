import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { acquireLock, releaseLock } from '../src/lock'

function tempLock() {
  return join(mkdtempSync(join(tmpdir(), 'morpho-bots-test-')), 'locks', 'blue-8453.lock')
}

describe('acquireLock / releaseLock', () => {
  it('acquires a free lock and releases it', () => {
    const path = tempLock()
    expect(acquireLock(path)).toEqual({ acquired: true, stolen: false })
    expect(existsSync(path)).toBe(true)
    releaseLock(path)
    expect(existsSync(path)).toBe(false)
  })

  it('does not acquire while a live pid holds it', () => {
    const path = tempLock()
    acquireLock(path) // held by THIS live process
    expect(acquireLock(path)).toEqual({ acquired: false, holderPid: process.pid })
  })

  it('steals from a dead pid', () => {
    const path = tempLock()
    acquireLock(path)
    // Overwrite the holder with a pid that cannot exist (beyond typical pid_max).
    writeFileSync(path, JSON.stringify({ pid: 2 ** 30, startedAt: 0 }))
    expect(acquireLock(path)).toEqual({ acquired: true, stolen: true })
  })

  it('steals an unreadable lockfile', () => {
    const path = tempLock()
    acquireLock(path)
    writeFileSync(path, 'not json')
    expect(acquireLock(path)).toEqual({ acquired: true, stolen: true })
  })
})
