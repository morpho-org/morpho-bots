import type { WireRecord } from '@repo/bot-kit'

import { ensureError } from '@repo/utils'

/**
 * A pre-logger structured error line on stderr — stdout is the JSON-Lines data plane. Used for
 * startup failures before any logger exists (config validation runs before the log level is known);
 * the caller picks the exit code (usually 2 for operator misconfig, 1 for transient bind/probe
 * failures).
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
