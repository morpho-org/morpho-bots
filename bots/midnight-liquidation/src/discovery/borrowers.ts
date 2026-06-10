import type { Address, Hex } from 'viem'

import { SQL } from 'bun'
import { getAddress, isAddress, isHex } from 'viem'

export type Row = Record<string, unknown>
export type QueryFn = (sql: string) => Promise<readonly Row[]>

/** A candidate position to evaluate: a (market, borrower) pair seen in the indexed events. */
export type BorrowerCandidate = { marketId: Hex; borrower: Address }

// rindexer's no-code Postgres writes one table per indexed event, under a schema named after the
// project (`midnight_liquidation`), with event args as snake_case columns (`user` is quoted, being
// a reserved word). `UpdatePosition` carries both the market id (`id_`) and the position owner.
// This SQL is the documented assumption — confirm the exact schema/table once rindexer has run a
// first time and adjust here; it is intentionally the only place the schema is encoded.
const BORROWERS_SQL = `
  SELECT DISTINCT id_ AS market_id, "user" AS borrower
  FROM midnight_liquidation_midnight.update_position
`

/**
 * Reads the distinct (market, borrower) universe from rindexer's indexed `UpdatePosition` events.
 * The DB handle is injected so the parsing is unit-testable without a live Postgres; the runtime
 * adapter is {@link createPostgresQuery}. Rows with a malformed id or address are skipped.
 */
export async function discoverBorrowers(query: QueryFn): Promise<BorrowerCandidate[]> {
  const rows = await query(BORROWERS_SQL)
  const candidates: BorrowerCandidate[] = []
  for (const row of rows) {
    const marketId = row.market_id
    const borrower = row.borrower
    if (
      typeof marketId === 'string' &&
      isHex(marketId) &&
      typeof borrower === 'string' &&
      isAddress(borrower, { strict: false })
    ) {
      candidates.push({ marketId, borrower: getAddress(borrower) })
    }
  }
  return candidates
}

/** Runtime adapter: a {@link QueryFn} backed by Bun's built-in Postgres client. */
export function createPostgresQuery(databaseUrl: string): QueryFn {
  const db = new SQL(databaseUrl)
  return async sql => db.unsafe(sql)
}
