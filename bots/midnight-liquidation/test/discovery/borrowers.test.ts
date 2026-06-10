import type { Hex } from 'viem'

import { describe, expect, it } from 'bun:test'
import { getAddress } from 'viem'

import type { QueryFn } from '../../src/discovery/borrowers'

import { discoverBorrowers } from '../../src/discovery/borrowers'

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
