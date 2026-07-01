import { describe, expect, it } from 'bun:test'
import { getAddress, type Hex } from 'viem'

import type { DiscoveryDiagnostics, QueryFn, TableDiagnostic } from '../../src/discovery/borrowers'
import type { MarketParams } from '../../src/market'

import {
  discoverBorrowerIds,
  discoverCandidates,
  discoveryDiagnostics,
  rindexerSyncedBlock
} from '../../src/discovery/borrowers'

const LOAN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const COLL = '0x4200000000000000000000000000000000000006'
const ORACLE = '0x1111111111111111111111111111111111111111'
const IRM = '0x46415998764C29aB2a25CbeA6254146D50D22687'
const BORROWER = '0x2222222222222222222222222222222222222222'

// The same market id expressed two ways: a 32-byte bytea (how Bun returns it) and a 0x hex string.
const ID_BYTES = new Uint8Array(32).fill(0xab)
const ID_HEX: Hex = `0x${'ab'.repeat(32)}`

const PARAMS: MarketParams = {
  loanToken: getAddress(LOAN),
  collateralToken: getAddress(COLL),
  oracle: getAddress(ORACLE),
  irm: getAddress(IRM),
  lltv: 860000000000000000n
}

describe('discoverBorrowerIds', () => {
  it('parses the bytea id to lowercase 0x-hex and checksums the borrower', async () => {
    const query: QueryFn = async () => [{ id: ID_BYTES, borrower: BORROWER }]
    expect(await discoverBorrowerIds(query)).toEqual([
      { id: ID_HEX, borrower: getAddress(BORROWER) }
    ])
  })

  it('also accepts the id as a hex string (with or without 0x)', async () => {
    const with0x = await discoverBorrowerIds(async () => [{ id: ID_HEX, borrower: BORROWER }])
    const without = await discoverBorrowerIds(async () => [
      { id: 'ab'.repeat(32), borrower: BORROWER }
    ])
    expect(with0x[0]!.id).toBe(ID_HEX)
    expect(without[0]!.id).toBe(ID_HEX)
  })

  it('skips rows with a malformed id or borrower', async () => {
    const query: QueryFn = async () => [
      { id: ID_BYTES, borrower: BORROWER }, // ok
      { id: new Uint8Array(31), borrower: BORROWER }, // wrong byte length
      { id: '0xnothex', borrower: BORROWER },
      { id: ID_BYTES, borrower: 'not-an-address' },
      { id: ID_BYTES, borrower: null }
    ]
    expect(await discoverBorrowerIds(query)).toHaveLength(1)
  })

  it('selects distinct (id, on_behalf) from the borrow table and does NOT join create_market', async () => {
    let captured = ''
    const query: QueryFn = async sql => {
      captured = sql
      return []
    }
    await discoverBorrowerIds(query)
    expect(captured).toContain('blue_liquidation_morpho.borrow')
    expect(captured).toContain('DISTINCT')
    expect(captured).toContain('b.id')
    expect(captured).toContain('b.on_behalf')
    // CreateMarket is no longer indexed — params come from idToMarketParams(id), not a join.
    expect(captured).not.toContain('create_market')
    expect(captured).not.toContain('JOIN')
  })
})

describe('discoverCandidates', () => {
  it('resolves each discovered id to its params and returns (marketParams, borrower)', async () => {
    const query: QueryFn = async () => [{ id: ID_BYTES, borrower: BORROWER }]
    const resolveParams = async (ids: readonly Hex[]) => new Map(ids.map(id => [id, PARAMS]))
    expect(await discoverCandidates(query, resolveParams)).toEqual([
      { marketParams: PARAMS, borrower: getAddress(BORROWER) }
    ])
  })

  it('drops a pair whose id does not resolve to a market', async () => {
    const query: QueryFn = async () => [{ id: ID_BYTES, borrower: BORROWER }]
    const resolveParams = async () => new Map<Hex, MarketParams>() // resolves nothing
    expect(await discoverCandidates(query, resolveParams)).toEqual([])
  })

  it('passes the discovered ids to the resolver', async () => {
    const query: QueryFn = async () => [{ id: ID_BYTES, borrower: BORROWER }]
    let seen: readonly Hex[] = []
    const resolveParams = async (ids: readonly Hex[]) => {
      seen = ids
      return new Map(ids.map(id => [id, PARAMS]))
    }
    await discoverCandidates(query, resolveParams)
    expect(seen).toEqual([ID_HEX])
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

  it("reads rindexer's internal progress table, not MAX(block_number) over event rows", async () => {
    let captured = ''
    const query: QueryFn = async sql => {
      captured = sql
      return [{ head: 1n }]
    }
    await rindexerSyncedBlock(query)
    expect(captured).toContain('rindexer_internal.blue_liquidation_morpho_borrow')
    expect(captured).toContain('last_synced_block')
    expect(captured).not.toContain('block_number')
  })
})

describe('discoveryDiagnostics', () => {
  // A query fake that answers the information_schema column probe + count(*) for the borrow table.
  function schemaQuery(borrow: { columns: string[]; count: number } | undefined) {
    return (async (sql: string) => {
      if (sql.includes('information_schema.columns')) {
        return (borrow?.columns ?? []).map(column_name => ({ column_name }))
      }
      return [{ n: BigInt(borrow?.count ?? 0) }]
    }) satisfies QueryFn
  }

  it('reports the actual columns + row count for the borrow table', async () => {
    const diag: DiscoveryDiagnostics = await discoveryDiagnostics(
      schemaQuery({ columns: ['id', 'caller', 'on_behalf', 'receiver'], count: 42 })
    )
    const expected: TableDiagnostic = {
      present: true,
      columns: ['id', 'caller', 'on_behalf', 'receiver'],
      rowCount: 42
    }
    expect(diag.borrow).toEqual(expected)
  })

  it('parses a string row count (Bun returns count(*)::bigint as a decimal string)', async () => {
    const query: QueryFn = async sql => {
      if (sql.includes('information_schema.columns')) return [{ column_name: 'id' }]
      return [{ n: '42' }] // bigint column comes back as a string, not a JS bigint
    }
    const diag = await discoveryDiagnostics(query)
    expect(diag.borrow.rowCount).toBe(42)
  })

  it('reports a not-yet-migrated table as absent (present:false) without throwing', async () => {
    const diag = await discoveryDiagnostics(schemaQuery(undefined))
    expect(diag.borrow).toEqual({ present: false, columns: [], rowCount: null })
  })

  it('isolates a thrown probe (a DB error reports present:false, does not throw)', async () => {
    const query: QueryFn = async () => {
      throw new Error('relation does not exist')
    }
    const diag = await discoveryDiagnostics(query)
    expect(diag.borrow.present).toBe(false)
  })
})
