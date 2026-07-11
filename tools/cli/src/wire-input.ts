import type { Logger, OutcomeRecord, TxRecord } from '@repo/bot-kit'

import { splitIdPrefix, WIRE_VERSION } from '@repo/bot-kit'

/**
 * One classified stdin line for `act`/`queue`. A line starting with `{` is a JSON wire record; any
 * other non-empty line is a bare id (pasteable into `act`). Blank lines yield `null` (skipped).
 * `version_skew` (a record whose `v` exceeds {@link WIRE_VERSION}) is a deploy error the caller maps
 * to exit 2; `malformed` (unparseable JSON) is warned-and-skipped — the wire is derived data.
 */
type ParsedLine =
  | { kind: 'record'; record: Record<string, unknown> }
  | { kind: 'bare'; id: string }
  | { kind: 'malformed' }
  | { kind: 'version_skew' }

/** Classifies a single raw input line (see {@link ParsedLine}); `null` for a blank line. */
export function parseLine(line: string): ParsedLine | null {
  const trimmed = line.trim()
  if (trimmed === '') return null
  if (!trimmed.startsWith('{')) return { kind: 'bare', id: trimmed }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { kind: 'malformed' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'malformed' }
  }
  const record = parsed as Record<string, unknown>
  // A record from a newer wire version is a deploy skew, not perishable data — exit 2, don't guess.
  if (typeof record.v === 'number' && record.v > WIRE_VERSION) return { kind: 'version_skew' }
  return { kind: 'record', record }
}

/**
 * Collects opportunity ids for a transform op from stdin. A record or bare id is taken only when it
 * belongs to THIS domain AND carries the source op the transform `accepts` (envelope `op` for
 * records, the `<domain>:<op>:` prefix for bare ids) — so a mixed stream stays legal and a transform
 * takes only its own. Everything else (tx/outcome records, foreign domain/op, malformed lines) is
 * warned-and-skipped deterministically. A record from a newer wire version stops the whole pass
 * (`versionSkew` → the caller exits 2).
 */
export function collectActIds(
  input: string,
  domain: string,
  accepts: string,
  logger: Logger
): { ids: string[]; versionSkew: boolean } {
  const ids: string[] = []
  for (const line of input.split('\n')) {
    const parsed = parseLine(line)
    if (!parsed) continue
    if (parsed.kind === 'version_skew') return { ids, versionSkew: true }
    if (parsed.kind === 'malformed') {
      logger.warn('act.skip', { reason: 'malformed_line' })
      continue
    }
    if (parsed.kind === 'bare') {
      const prefix = splitIdPrefix(parsed.id)
      if (prefix.domain === domain && prefix.op === accepts) {
        ids.push(parsed.id)
      } else {
        logger.warn('act.skip', { reason: 'unaccepted', domain: prefix.domain, op: prefix.op })
      }
      continue
    }
    const record = parsed.record
    if (
      record.kind === 'opportunity' &&
      record.domain === domain &&
      record.op === accepts &&
      typeof record.id === 'string'
    ) {
      ids.push(record.id)
    } else {
      logger.warn('act.skip', {
        reason: 'unaccepted',
        kind: record.kind,
        domain: record.domain,
        op: record.op
      })
    }
  }
  return { ids, versionSkew: false }
}

/**
 * Collects the `queue`'s typed inputs from stdin: `tx` records (to submit) and `outcome` records
 * (to drive backoff). Opportunity records and bare ids are ignored with a deterministic warn+skip;
 * records missing required fields are skipped; malformed lines never fail the pass (the wire is
 * derived data), but a wire-version skew does (`versionSkew` → the caller exits 2).
 */
export function collectQueueRecords(
  input: string,
  logger: Logger
): { txs: TxRecord[]; outcomes: OutcomeRecord[]; versionSkew: boolean } {
  const txs: TxRecord[] = []
  const outcomes: OutcomeRecord[] = []
  for (const line of input.split('\n')) {
    const parsed = parseLine(line)
    if (!parsed) continue
    if (parsed.kind === 'version_skew') return { txs, outcomes, versionSkew: true }
    if (parsed.kind === 'malformed') {
      logger.warn('queue.skip', { reason: 'malformed_line' })
      continue
    }
    if (parsed.kind === 'bare') {
      logger.warn('queue.skip', { reason: 'bare_id' })
      continue
    }
    const record = parsed.record
    if (record.kind === 'tx') {
      if (
        typeof record.id === 'string' &&
        typeof record.to === 'string' &&
        typeof record.data === 'string'
      ) {
        txs.push(record as unknown as TxRecord)
      } else {
        logger.warn('queue.skip', { reason: 'tx_missing_fields' })
      }
    } else if (record.kind === 'outcome') {
      if (typeof record.id === 'string' && typeof record.status === 'string') {
        outcomes.push(record as unknown as OutcomeRecord)
      } else {
        logger.warn('queue.skip', { reason: 'outcome_missing_fields' })
      }
    } else {
      logger.warn('queue.skip', { reason: 'unaccepted', kind: record.kind })
    }
  }
  return { txs, outcomes, versionSkew: false }
}
