import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

type LockResult =
  | { acquired: true; stolen: boolean }
  | { acquired: false; holderPid: number | null }

function tryWrite(path: string): boolean {
  try {
    writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { flag: 'wx' })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

function holderPid(path: string): number | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const pid = (parsed as { pid?: unknown }).pid
    return typeof pid === 'number' ? pid : null
  } catch {
    return null
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the pid exists but belongs to another user — alive for our purposes.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Per-(bot, chain) pid lockfile — the one-shot equivalent of single-process nonce discipline: two
 * concurrent ticks would race the same nonce stream. Held by a live pid → not acquired (the caller
 * skips with exit 0; overlap is normal under a loop/cron). Held by a dead pid or unreadable → stolen
 * once, so a crashed tick can never silently stop the bot. Release in a `finally`.
 */
export function acquireLock(path: string): LockResult {
  mkdirSync(dirname(path), { recursive: true })
  if (tryWrite(path)) return { acquired: true, stolen: false }
  const pid = holderPid(path)
  if (pid !== null && pidAlive(pid)) return { acquired: false, holderPid: pid }
  rmSync(path, { force: true })
  if (tryWrite(path)) return { acquired: true, stolen: true }
  // Another process won the steal race — treat as held.
  return { acquired: false, holderPid: holderPid(path) }
}

export function releaseLock(path: string): void {
  rmSync(path, { force: true })
}
