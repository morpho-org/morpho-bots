import type { Logger } from '@repo/bot-kit'

import { WIRE_VERSION } from '@repo/bot-kit'
import { describe, expect, it } from 'bun:test'

import {
  collectActIds,
  collectQueueRecords,
  parseLine,
  QUEUE_BACKOFF_STATUSES
} from '../src/wire-input'

const NOOP_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}

// A record one version past this build — the skew that must halt the pass with exit 2 upstream.
const FUTURE_V = WIRE_VERSION + 1

function opportunity(domain: string, id: string): string {
  return JSON.stringify({ v: WIRE_VERSION, kind: 'opportunity', domain, op: 'liq', id })
}

describe('parseLine', () => {
  it('returns null for a blank line', () => {
    expect(parseLine('   ')).toBeNull()
  })

  it('classifies a non-`{` line as a bare id (trimmed)', () => {
    expect(parseLine('  blue:liq:8453:0xabc:0xdef  ')).toEqual({
      kind: 'bare',
      id: 'blue:liq:8453:0xabc:0xdef'
    })
  })

  it('classifies a JSON object as a record', () => {
    const parsed = parseLine('{"v":1,"kind":"tx","id":"x"}')
    expect(parsed?.kind).toBe('record')
  })

  it('classifies unparseable JSON as malformed', () => {
    expect(parseLine('{not json')).toEqual({ kind: 'malformed' })
  })

  it('treats a non-`{` line (e.g. a JSON array) as a bare id — only `{` lines are records', () => {
    expect(parseLine('[1,2,3]')).toEqual({ kind: 'bare', id: '[1,2,3]' })
  })

  it('flags a record from a newer wire version as version_skew', () => {
    expect(parseLine(`{"v":${FUTURE_V},"kind":"tx","id":"x"}`)).toEqual({ kind: 'version_skew' })
  })
})

describe('collectActIds', () => {
  it('collects bare ids verbatim', () => {
    const { ids } = collectActIds(
      'blue:liq:8453:0xa:0xb\nblue:liq:8453:0xc:0xd',
      'blue',
      NOOP_LOGGER
    )
    expect(ids).toEqual(['blue:liq:8453:0xa:0xb', 'blue:liq:8453:0xc:0xd'])
  })

  it('takes the id from an opportunity record of the matching domain', () => {
    const { ids } = collectActIds(opportunity('blue', 'blue:liq:8453:0xa:0xb'), 'blue', NOOP_LOGGER)
    expect(ids).toEqual(['blue:liq:8453:0xa:0xb'])
  })

  it('skips an opportunity record for a different domain', () => {
    const { ids } = collectActIds(
      opportunity('midnight', 'midnight:liq:8453:0xa:0xb'),
      'blue',
      NOOP_LOGGER
    )
    expect(ids).toEqual([])
  })

  it('skips tx and outcome records (not act inputs)', () => {
    const input = [
      '{"v":1,"kind":"tx","domain":"blue","id":"blue:liq:8453:0xa:0xb"}',
      '{"v":1,"kind":"outcome","domain":"blue","id":"blue:liq:8453:0xc:0xd","status":"submitted"}'
    ].join('\n')
    expect(collectActIds(input, 'blue', NOOP_LOGGER).ids).toEqual([])
  })

  it('skips a malformed line without failing', () => {
    const input = ['{bad', 'blue:liq:8453:0xa:0xb'].join('\n')
    const { ids, versionSkew } = collectActIds(input, 'blue', NOOP_LOGGER)
    expect(versionSkew).toBe(false)
    expect(ids).toEqual(['blue:liq:8453:0xa:0xb'])
  })

  it('stops with versionSkew on a newer-version record (caller exits 2)', () => {
    const input = [
      'blue:liq:8453:0xa:0xb',
      `{"v":${FUTURE_V},"kind":"opportunity","domain":"blue","id":"x"}`,
      'blue:liq:8453:0xc:0xd'
    ].join('\n')
    const { ids, versionSkew } = collectActIds(input, 'blue', NOOP_LOGGER)
    expect(versionSkew).toBe(true)
    // Ids seen before the skew are returned; nothing after is processed.
    expect(ids).toEqual(['blue:liq:8453:0xa:0xb'])
  })
})

describe('collectQueueRecords', () => {
  it('collects tx and outcome records and ignores opportunities and bare ids', () => {
    const input = [
      '{"v":1,"kind":"tx","domain":"blue","id":"blue:liq:8453:0xa:0xb","to":"0x01","data":"0x"}',
      '{"v":1,"kind":"outcome","domain":"blue","id":"blue:liq:8453:0xc:0xd","status":"quote_failed"}',
      opportunity('blue', 'blue:liq:8453:0xe:0xf'),
      'a-bare-id'
    ].join('\n')
    const { txs, outcomes, versionSkew } = collectQueueRecords(input, NOOP_LOGGER)
    expect(versionSkew).toBe(false)
    expect(txs).toHaveLength(1)
    expect(txs[0]?.id).toBe('blue:liq:8453:0xa:0xb')
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]?.status).toBe('quote_failed')
  })

  it('skips a tx record missing to/data and an outcome missing status', () => {
    const input = [
      '{"v":1,"kind":"tx","id":"blue:liq:8453:0xa:0xb"}',
      '{"v":1,"kind":"outcome","id":"blue:liq:8453:0xc:0xd"}'
    ].join('\n')
    const { txs, outcomes } = collectQueueRecords(input, NOOP_LOGGER)
    expect(txs).toEqual([])
    expect(outcomes).toEqual([])
  })

  it('stops with versionSkew on a newer-version record', () => {
    const input = `{"v":${FUTURE_V},"kind":"tx","id":"x","to":"0x01","data":"0x"}`
    expect(collectQueueRecords(input, NOOP_LOGGER).versionSkew).toBe(true)
  })
})

describe('QUEUE_BACKOFF_STATUSES', () => {
  it('records only quote_failed and sim_reverted', () => {
    expect(QUEUE_BACKOFF_STATUSES.has('quote_failed')).toBe(true)
    expect(QUEUE_BACKOFF_STATUSES.has('sim_reverted')).toBe(true)
    for (const ignored of [
      'not_liquidatable',
      'no_swap_path',
      'backoff_skipped',
      'skipped_inflight',
      'bad_id',
      'submitted'
    ]) {
      expect(QUEUE_BACKOFF_STATUSES.has(ignored)).toBe(false)
    }
  })
})
