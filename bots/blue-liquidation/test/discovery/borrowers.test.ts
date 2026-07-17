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

// A distinct Robinhood-network borrower, used to prove the network filter partitions the universe.
const ID_BYTES_RH = new Uint8Array(32).fill(0xcd)
const ID_HEX_RH: Hex = `0x${'cd'.repeat(32)}`
const BORROWER_RH = '0x3333333333333333333333333333333333333333'

const PARAMS: MarketParams = {
  loanToken: getAddress(LOAN),
  collateralToken: getAddress(COLL),
  oracle: getAddress(ORACLE),
  irm: getAddress(IRM),
  lltv: 860000000000000000n
}

// A fake rindexer `borrow` table spanning two chains. The fake honors the bound `$1` network param
// exactly as Postgres would (`WHERE b.network = $1`), so tests using it prove the SQL genuinely
// partitions by network — not merely that the filter text appears in the query string.
const ROWS_BY_NETWORK: Record<string, { id: Uint8Array; borrower: string }[]> = {
  base: [{ id: ID_BYTES, borrower: BORROWER }],
  robinhood: [{ id: ID_BYTES_RH, borrower: BORROWER_RH }]
}
const partitionedQuery: QueryFn = async (_sql, params) => {
  const network = typeof params?.[0] === 'string' ? params[0] : ''
  return ROWS_BY_NETWORK[network] ?? []
}

describe('discoverBorrowerIds', () => {
  it('parses the bytea id to lowercase 0x-hex and checksums the borrower', async () => {
    const query: QueryFn = async () => [{ id: ID_BYTES, borrower: BORROWER }]
    expect(await discoverBorrowerIds(query, 'base')).toEqual([
      { id: ID_HEX, borrower: getAddress(BORROWER) }
    ])
  })

  it('also accepts the id as a hex string (with or without 0x)', async () => {
    const with0x = await discoverBorrowerIds(
      async () => [{ id: ID_HEX, borrower: BORROWER }],
      'base'
    )
    const without = await discoverBorrowerIds(
      async () => [{ id: 'ab'.repeat(32), borrower: BORROWER }],
      'base'
    )
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
    expect(await discoverBorrowerIds(query, 'base')).toHaveLength(1)
  })

  // The load-bearing multi-chain test: a Base-network query must return ONLY Base rows and never a
  // Robinhood row (and vice versa). This exercises the real filtering behavior, so a broken/dropped
  // `WHERE b.network = $1` fails it — unlike a string-contains check on the query text.
  it('partitions the candidate universe by the bound network param', async () => {
    const onBase = await discoverBorrowerIds(partitionedQuery, 'base')
    const onRobinhood = await discoverBorrowerIds(partitionedQuery, 'robinhood')
    expect(onBase).toEqual([{ id: ID_HEX, borrower: getAddress(BORROWER) }])
    expect(onRobinhood).toEqual([{ id: ID_HEX_RH, borrower: getAddress(BORROWER_RH) }])
    expect(onBase.some(pair => pair.borrower === getAddress(BORROWER_RH))).toBe(false)
    expect(onRobinhood.some(pair => pair.borrower === getAddress(BORROWER))).toBe(false)
  })

  it('filters by network via a bound param and does NOT join create_market', async () => {
    let captured = ''
    let capturedParams: readonly unknown[] | undefined
    const query: QueryFn = async (sql, params) => {
      captured = sql
      capturedParams = params
      return []
    }
    await discoverBorrowerIds(query, 'base')
    expect(captured).toContain('blue_liquidation_morpho.borrow')
    expect(captured).toContain('DISTINCT')
    expect(captured).toContain('b.id')
    expect(captured).toContain('b.on_behalf')
    // The network is a bound param ($1), never string-interpolated into the SQL.
    expect(captured).toContain('b.network = $1')
    expect(capturedParams).toEqual(['base'])
    // CreateMarket is no longer indexed — params come from idToMarketParams(id), not a join.
    expect(captured).not.toContain('create_market')
    expect(captured).not.toContain('JOIN')
  })
})

describe('discoverCandidates', () => {
  it('resolves each discovered id to its params and returns (marketParams, borrower)', async () => {
    const query: QueryFn = async () => [{ id: ID_BYTES, borrower: BORROWER }]
    const resolveParams = async (ids: readonly Hex[]) => new Map(ids.map(id => [id, PARAMS]))
    expect(await discoverCandidates(query, resolveParams, 'base')).toEqual([
      { marketParams: PARAMS, borrower: getAddress(BORROWER) }
    ])
  })

  it('drops a pair whose id does not resolve to a market', async () => {
    const query: QueryFn = async () => [{ id: ID_BYTES, borrower: BORROWER }]
    const resolveParams = async () => new Map<Hex, MarketParams>() // resolves nothing
    expect(await discoverCandidates(query, resolveParams, 'base')).toEqual([])
  })

  it('passes the discovered ids to the resolver', async () => {
    const query: QueryFn = async () => [{ id: ID_BYTES, borrower: BORROWER }]
    let seen: readonly Hex[] = []
    const resolveParams = async (ids: readonly Hex[]) => {
      seen = ids
      return new Map(ids.map(id => [id, PARAMS]))
    }
    await discoverCandidates(query, resolveParams, 'base')
    expect(seen).toEqual([ID_HEX])
  })

  it('only surfaces the requested network (composes the partitioning filter)', async () => {
    const resolveParams = async (ids: readonly Hex[]) => new Map(ids.map(id => [id, PARAMS]))
    const onRobinhood = await discoverCandidates(partitionedQuery, resolveParams, 'robinhood')
    expect(onRobinhood).toEqual([{ marketParams: PARAMS, borrower: getAddress(BORROWER_RH) }])
  })
})

describe('rindexerSyncedBlock', () => {
  it('returns the head as a bigint (number, string, or bigint columns)', async () => {
    expect(await rindexerSyncedBlock(async () => [{ head: 12345 }], 'base')).toBe(12345n)
    expect(await rindexerSyncedBlock(async () => [{ head: '12345' }], 'base')).toBe(12345n)
    expect(await rindexerSyncedBlock(async () => [{ head: 12345n }], 'base')).toBe(12345n)
  })

  it('returns null when the table is empty or the head is missing', async () => {
    expect(await rindexerSyncedBlock(async () => [], 'base')).toBeNull()
    expect(await rindexerSyncedBlock(async () => [{ head: null }], 'base')).toBeNull()
  })

  it("reads this network's row from rindexer's progress table, not MAX(block_number)", async () => {
    let captured = ''
    let capturedParams: readonly unknown[] | undefined
    const query: QueryFn = async (sql, params) => {
      captured = sql
      capturedParams = params
      return [{ head: 1n }]
    }
    await rindexerSyncedBlock(query, 'robinhood')
    expect(captured).toContain('rindexer_internal.blue_liquidation_morpho_borrow')
    expect(captured).toContain('last_synced_block')
    expect(captured).toContain('network = $1')
    expect(capturedParams).toEqual(['robinhood'])
    // Not an unfiltered aggregate — that would report the furthest-ahead chain's head to every bot.
    expect(captured).not.toContain('MAX')
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
