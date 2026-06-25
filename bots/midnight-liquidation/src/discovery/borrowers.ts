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
// liquidation).
//
// Column types, confirmed against a live rindexer run: `id_` (the bytes32 market id) is stored as
// `bytea`, which Bun's SQL client returns as a Buffer — not the `0x` hex string the parser/lens
// expect — so we cast it in SQL with `'0x' || encode(id_, 'hex')`. Without this every row fails the
// `typeof === 'string'` guard below and discovery silently yields zero candidates. `taker`/`maker`
// are `character(42)` (no padding at 42 chars), already plain `0x…` strings. This is intentionally
// the only place the schema is encoded.
const BORROWERS_SQL = `
  SELECT DISTINCT market_id, borrower
  FROM (
    SELECT '0x' || encode(id_, 'hex') AS market_id, taker AS borrower FROM midnight_liquidation_midnight.take
    UNION
    SELECT '0x' || encode(id_, 'hex') AS market_id, maker AS borrower FROM midnight_liquidation_midnight.take
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

// rindexer's authoritative indexed head: its internal progress table tracks the last block synced
// per network (`rindexer_internal.<project>_<contract>_<event>`, one row per network, column
// `last_synced_block`), and advances with the chain tip during live indexing regardless of event
// activity. We deliberately do NOT read MAX(block_number) over the Take rows here — that only moves
// when a new Take is indexed, so during quiet periods it freezes at the last event's block while the
// chain marches on, making the bot over-report lag by thousands of blocks (it looks "stuck" the
// moment historical indexing completes). MAX over the rows is network-agnostic (only `base` here).
const SYNCED_BLOCK_SQL = `
  SELECT MAX(last_synced_block) AS head
  FROM rindexer_internal.midnight_liquidation_midnight_take
`

/**
 * Best-effort rindexer indexed head, for the freshness/lag signal. Reads rindexer's internal
 * progress table (see {@link SYNCED_BLOCK_SQL}). Returns `null` when the table is empty (rindexer
 * has not yet recorded progress). Callers treat `null` (and a thrown query) as "lag unknown" and
 * proceed — the lens reads every candidate fresh on-chain, so this signal is observability-only.
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
