import { describe, expect, it } from 'bun:test'
import { getAddress } from 'viem'

import type {
  DiscoveryDiagnostics,
  QueryFn,
  Row,
  TableDiagnostic
} from '../../src/discovery/borrowers'

import {
  discoverBorrowers,
  discoveryDiagnostics,
  rindexerSyncedBlock
} from '../../src/discovery/borrowers'

const LOAN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const COLL = '0x4200000000000000000000000000000000000006'
const ORACLE = '0x1111111111111111111111111111111111111111'
const IRM = '0x46415998764C29aB2a25CbeA6254146D50D22687'
const BORROWER = '0x2222222222222222222222222222222222222222'

function row(overrides: Partial<Row> = {}): Row {
  return {
    borrower: BORROWER,
    loan_token: LOAN,
    collateral_token: COLL,
    oracle: ORACLE,
    irm: IRM,
    lltv: '860000000000000000',
    ...overrides
  }
}

describe('discoverBorrowers', () => {
  it('joins Borrow.onBehalf to the CreateMarket registry and checksums every address', async () => {
    const query: QueryFn = async () => [row()]
    expect(await discoverBorrowers(query)).toEqual([
      {
        borrower: getAddress(BORROWER),
        marketParams: {
          loanToken: getAddress(LOAN),
          collateralToken: getAddress(COLL),
          oracle: getAddress(ORACLE),
          irm: getAddress(IRM),
          lltv: 860000000000000000n
        }
      }
    ])
  })

  it('accepts lltv as a bigint, number, or decimal string', async () => {
    const asBigint = await discoverBorrowers(async () => [row({ lltv: 5n })])
    const asNumber = await discoverBorrowers(async () => [row({ lltv: 5 })])
    const asString = await discoverBorrowers(async () => [row({ lltv: '5' })])
    expect(asBigint[0]!.marketParams.lltv).toBe(5n)
    expect(asNumber[0]!.marketParams.lltv).toBe(5n)
    expect(asString[0]!.marketParams.lltv).toBe(5n)
  })

  it('skips rows with a malformed address or lltv', async () => {
    const query: QueryFn = async () => [
      row(), // ok
      row({ borrower: 'not-an-address' }),
      row({ oracle: null }),
      row({ lltv: 'not-a-number' })
    ]
    expect(await discoverBorrowers(query)).toHaveLength(1)
  })

  it('joins the Borrow and CreateMarket tables (schema-encoding guard)', async () => {
    let captured = ''
    const query: QueryFn = async sql => {
      captured = sql
      return []
    }
    await discoverBorrowers(query)
    expect(captured).toContain('blue_liquidation_morpho.borrow')
    expect(captured).toContain('blue_liquidation_morpho.create_market')
    expect(captured).toContain('JOIN')
    // rindexer flattens the nested MarketParams tuple with a `market_params_` prefix (confirmed by the
    // live run's discovery.schema dump); the join must select the prefixed columns, not the bare names.
    expect(captured).toContain('cm.market_params_loan_token')
    expect(captured).toContain('cm.market_params_lltv')
    expect(captured).toContain('b.on_behalf')
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
  // A query fake that answers information_schema column probes + count(*) per table.
  function schemaQuery(tables: Record<string, { columns: string[]; count: number } | undefined>) {
    return (async (sql: string) => {
      const table = /table_name = '(\w+)'/.exec(sql)?.[1]
      if (sql.includes('information_schema.columns')) {
        const t = table ? tables[table] : undefined
        return (t?.columns ?? []).map(column_name => ({ column_name }))
      }
      // count(*) query: `... FROM blue_liquidation_morpho.<table>`
      const counted = /morpho\.(\w+)/.exec(sql)?.[1]
      const t = counted ? tables[counted] : undefined
      return [{ n: BigInt(t?.count ?? 0) }]
    }) satisfies QueryFn
  }

  it('reports the actual columns + row counts for both tables', async () => {
    const diag: DiscoveryDiagnostics = await discoveryDiagnostics(
      schemaQuery({
        borrow: { columns: ['id', 'caller', 'on_behalf', 'receiver'], count: 42 },
        create_market: { columns: ['id', 'loan_token', 'collateral_token'], count: 7 }
      })
    )
    const expectedBorrow: TableDiagnostic = {
      present: true,
      columns: ['id', 'caller', 'on_behalf', 'receiver'],
      rowCount: 42
    }
    expect(diag.borrow).toEqual(expectedBorrow)
    expect(diag.createMarket).toEqual({
      present: true,
      columns: ['id', 'loan_token', 'collateral_token'],
      rowCount: 7
    })
  })

  it('parses a string row count (Bun returns count(*)::bigint as a decimal string)', async () => {
    const query: QueryFn = async sql => {
      if (sql.includes('information_schema.columns')) return [{ column_name: 'id' }]
      return [{ n: '42' }] // bigint column comes back as a string, not a JS bigint
    }
    const diag = await discoveryDiagnostics(query)
    expect(diag.borrow.rowCount).toBe(42)
    expect(diag.createMarket.rowCount).toBe(42)
  })

  it('reports a not-yet-migrated table as absent (present:false) without throwing', async () => {
    const diag = await discoveryDiagnostics(
      schemaQuery({ borrow: undefined, create_market: undefined })
    )
    expect(diag.borrow).toEqual({ present: false, columns: [], rowCount: null })
    expect(diag.createMarket).toEqual({ present: false, columns: [], rowCount: null })
  })

  it('isolates a thrown probe per table (a DB error on one table does not sink the other)', async () => {
    const query: QueryFn = async sql => {
      if (sql.includes("table_name = 'borrow'")) throw new Error('relation does not exist')
      if (sql.includes('information_schema.columns')) return [{ column_name: 'id' }]
      return [{ n: 1n }]
    }
    const diag = await discoveryDiagnostics(query)
    expect(diag.borrow.present).toBe(false)
    expect(diag.createMarket.present).toBe(true)
  })
})
