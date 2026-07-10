import type { WireRecord } from '@repo/bot-kit'

import { ensureError } from '@repo/utils'

/**
 * A startup/usage failure (exit 2): the operator must fix config before retrying is useful. Written
 * to stderr — stdout is the JSON-Lines data plane — as a single structured line, before any logger
 * exists (config validation runs before the log level is known).
 */
export function fail(event: string, error: unknown): void {
  console.error(JSON.stringify({ level: 'error', event, error: ensureError(error).message }))
}

/**
 * Writes one wire record to stdout as a single JSON line (line-buffered). Wire records carry only
 * bare decimal strings and `0x`-hex — never raw bigints — so `JSON.stringify` never throws. EPIPE is
 * benign under Bun (a closed-pipe write neither raises nor kills the process), so `sense | head` is
 * clean without special handling.
 */
export function emitLine(record: WireRecord): void {
  process.stdout.write(JSON.stringify(record) + '\n')
}

/**
 * Drains and discards stdin to EOF. Used when the `queue` lock is held: an upstream `act` is still
 * writing derived, perishable lines into this process's pipe, and reading them to EOF lets it finish
 * cleanly rather than seeing a broken pipe. The lines themselves are dropped — the live queue that
 * holds the lock will act on the next tick's fresh data.
 */
export async function drainStdin(): Promise<void> {
  if (process.stdin.isTTY) return
  // Consuming the ReadableStream to completion discards it without buffering the whole input.
  for await (const _chunk of Bun.stdin.stream()) {
    // discard
  }
}
