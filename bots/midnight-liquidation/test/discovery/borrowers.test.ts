import type { Hex } from 'viem'

import { describe, expect, it } from 'bun:test'
import { getAddress } from 'viem'

import type { QueryFn } from '../../src/discovery/borrowers'

import { discoverBorrowers, rindexerSyncedBlock } from '../../src/discovery/borrowers'

const MARKET: Hex = `0x${'a'.repeat(64)}`
const BORROWER = '0x1111111111111111111111111111111111111111'

describe('discoverBorrowers', () => {
  it('returns validated (market, borrower) candidates and checksums the address', async () => {
    const query: QueryFn = async () => [{ market_id: MARKET, borrower: BORROWER }]
    expect(await discoverBorrowers(query)).toEqual([
      { marketId: MARKET, borrower: getAddress(BORROWER) }
    ])
  })

  it('casts the bytea id_ column to a 0x hex string (Bun returns bytea as a Buffer)', async () => {
    // Regression guard: rindexer stores id_ as bytea; without the SQL cast every row's market_id
    // comes back as a Buffer, fails the typeof === 'string' guard, and discovery yields zero pairs.
    let captured = ''
    const query: QueryFn = async sql => {
      captured = sql
      return []
    }
    await discoverBorrowers(query)
    expect(captured).toContain("encode(id_, 'hex')")
  })

  it('skips rows with a malformed market id or borrower address', async () => {
    const query: QueryFn = async () => [
      { market_id: MARKET, borrower: BORROWER }, // ok
      { market_id: 'not-hex', borrower: BORROWER }, // bad id
      { market_id: MARKET, borrower: 'not-an-address' }, // bad address
      { market_id: null, borrower: BORROWER } // missing id
    ]
    expect(await discoverBorrowers(query)).toEqual([
      { marketId: MARKET, borrower: getAddress(BORROWER) }
    ])
  })
})

describe('rindexerSyncedBlock', () => {
  it('returns the head as a bigint (number, string, or bigint columns)', async () => {
    expect(await rindexerSyncedBlock(async () => [{ head: 12345 }])).toBe(12345n)
    expect(await rindexerSyncedBlock(async () => [{ head: '12345' }])).toBe(12345n)
    expect(await rindexerSyncedBlock(async () => [{ head: 12345n }])).toBe(12345n)
  })

  it('returns null when the table is empty or the head is missing', async () => {
    expect(await rindexerSyncedBlock(async () => [])).toBeNull()
    expect(await rindexerSyncedBlock(async () => [{ head: null }])).toBeNull()
  })

  it("reads rindexer's internal progress table, not MAX(block_number) over Take rows", async () => {
    // Regression guard: MAX(block_number) over the event table freezes between Take events, so the
    // head must come from rindexer's internal last_synced_block (which tracks the live chain tip).
    let captured = ''
    const query: QueryFn = async sql => {
      captured = sql
      return [{ head: 1n }]
    }
    await rindexerSyncedBlock(query)
    expect(captured).toContain('rindexer_internal.midnight_liquidation_midnight_take')
    expect(captured).toContain('last_synced_block')
    expect(captured).not.toContain('block_number')
  })
})
