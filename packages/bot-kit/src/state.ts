import { parse, stringify } from '@repo/utils'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { PendingQueueState } from './queue/pending-queue'

/**
 * Resolves a bot's per-chain state + outcomes file paths under `BOT_STATE_DIR` (default
 * `~/.morpho-bots`). Namespaced by bot and chain so one host can run several bots/chains without
 * collision. On Railway, point `BOT_STATE_DIR` at a mounted volume to persist across restarts.
 */
export function botStatePaths(
  bot: string,
  chainId: number
): { stateFile: string; outcomesFile: string } {
  const dir = process.env.BOT_STATE_DIR?.trim() || join(homedir(), '.morpho-bots')
  return {
    stateFile: join(dir, bot, `state-${chainId}.json`),
    outcomesFile: join(dir, bot, `outcomes-${chainId}.jsonl`)
  }
}

/**
 * The persisted pending-queue schema version. Bump when {@link PendingQueueState} changes shape; a
 * mismatched or corrupt file is discarded (warn `state.reset`), never migrated — the queue
 * reconciles against chain truth on the next `onBlock`.
 */
export const QUEUE_STATE_VERSION = 1

/** The bot's persisted pending transactions, written by {@link saveState}. */
export type QueueState = {
  version: number
  queue: PendingQueueState
}

/** Why a load produced no state; `null` means the file was read and restored. */
export type StateReset = 'missing' | 'corrupt' | 'version_mismatch'

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
 * over the target, so a kill mid-write can never leave a truncated file for the next boot to read.
 */
export function saveState(path: string, state: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, stringify(state))
  renameSync(tmp, path)
}
