import type { Address, Hex } from 'viem'

import { SQL } from 'bun'
import { getAddress, isAddress, isHex } from 'viem'

export type Row = Record<string, unknown>
export type QueryFn = (sql: string) => Promise<readonly Row[]>

/** A candidate position to evaluate: a (market, borrower) pair seen in the indexed events. */
export type BorrowerCandidate = { marketId: Hex; borrower: Address }

// rindexer's no-code Postgres writes one table per indexed event, under a schema named after the
// project + contract (`midnight_liquidation_midnight`), with event args as snake_case columns. We
// index `Take` — the only path that creates debt — and union its two indexed address columns
// (`taker`, `maker`) as candidate borrowers: the debtor is the offer's seller (`taker` when
// `offerIsBuy` else `maker`), which can't be told apart from the indexed topics alone, so we take
// both and let the lens drop non-debtors (over-inclusion is harmless; under-inclusion would miss a
// liquidation). This SQL is the documented assumption — confirm the exact schema/table once rindexer
// has run a first time and adjust here; it is intentionally the only place the schema is encoded.
const BORROWERS_SQL = `
  SELECT DISTINCT market_id, borrower
  FROM (
    SELECT id_ AS market_id, taker AS borrower FROM midnight_liquidation_midnight.take
    UNION
    SELECT id_ AS market_id, maker AS borrower FROM midnight_liquidation_midnight.take
  ) candidates
`

/**
 * Reads the distinct (market, borrower) universe from rindexer's indexed `Take` events.
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

// Approximates rindexer's indexed head with the max block over Take rows — the same table
// discoverBorrowers reads, so it shares that query's "confirm the exact schema once rindexer has run"
// caveat (here, the `block_number` metadata column). During quiet periods with no Take events this
// trails the true synced head, so it can over-report lag — fine, since the lag signal is
// observability-only (the lens reads every candidate fresh; rindexer lag is coverage latency).
const SYNCED_BLOCK_SQL = `
  SELECT MAX(block_number) AS head
  FROM midnight_liquidation_midnight.take
`

/**
 * Best-effort rindexer indexed head, for the freshness/lag signal. Returns `null` when the table is
 * empty (or the assumed `block_number` column is absent). Callers treat `null` (and a thrown query)
 * as "lag unknown" and proceed — see {@link discoverBorrowers}'s schema caveat.
 */
export async function rindexerSyncedBlock(query: QueryFn): Promise<bigint | null> {
  const rows = await query(SYNCED_BLOCK_SQL)
  const head = rows[0]?.head
  if (typeof head === 'bigint') return head
  if (typeof head === 'number' || typeof head === 'string') return BigInt(head)
  return null
}

/** Runtime adapter: a {@link QueryFn} backed by Bun's built-in Postgres client. */
export function createPostgresQuery(databaseUrl: string): QueryFn {
  const db = new SQL(databaseUrl)
  return async sql => db.unsafe(sql)
}
