import { parse, stringify } from '@repo/utils'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Why a load produced no state; `null` means the file was read and restored. */
type StateReset = 'missing' | 'corrupt' | 'version_mismatch'

/**
 * Reads a persisted-state file written by {@link saveState}. Anything short of a clean read of the
 * expected version yields `state: null` with the reason — state is a hint (chain truth wins), so a
 * bad file is discarded, never migrated or trusted.
 */
export function loadState<T extends { version: number }>(
  path: string,
  version: number
): { state: T | null; reset: StateReset | null } {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { state: null, reset: 'missing' }
  }
  const parsed = parse<T>(raw)
  if (parsed === undefined || typeof parsed !== 'object' || parsed === null) {
    return { state: null, reset: 'corrupt' }
  }
  if (parsed.version !== version) return { state: null, reset: 'version_mismatch' }
  return { state: parsed, reset: null }
}

/**
 * Atomically persists `state` with the bigint-safe codec: write a sibling temp file, then rename
 * over the target, so a kill mid-write can never leave a truncated file for the next tick to read.
 */
export function saveState(path: string, state: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, stringify(state))
  renameSync(tmp, path)
}
