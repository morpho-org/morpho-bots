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
})
