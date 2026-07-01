import type { Address } from 'viem'

import { SQL } from 'bun'
import { getAddress, isAddress } from 'viem'

import type { MarketParams } from '../market'

export type Row = Record<string, unknown>
export type QueryFn = (sql: string) => Promise<readonly Row[]>

/** A candidate position to evaluate: a (market, borrower) pair seen in the indexed events, with the
 * market's immutable params joined in from the CreateMarket registry. */
export type BorrowerCandidate = { marketParams: MarketParams; borrower: Address }

// rindexer's no-code Postgres writes one table per indexed event, under a schema named after the
// project + contract (`blue_liquidation_morpho`), with event args as snake_case columns. We index
// two events (see rindexer.yaml):
//   - `Borrow`  → the (id, onBehalf) candidate universe. `onBehalf` is the position owner and the
//                 only debt-opening field; over-inclusion (repaid/closed positions) is harmless
//                 because the lens re-reads every candidate fresh, under-inclusion would miss a
//                 liquidation, so we do NOT prune with Repay/WithdrawCollateral at the SQL layer.
//   - `CreateMarket` → the id → MarketParams registry. MarketParams are unavailable from the
//                 singleton, so this join is REQUIRED (not an optimization): the lens needs
//                 (loanToken, collateralToken, oracle, irm, lltv) to read state and size.
//
// SCHEMA-ENCODING NOTE — this is intentionally the ONLY place the rindexer column layout is encoded,
// and it must be confirmed against a live rindexer run before go-live (as the sibling midnight bot
// did for its `take` table). Two details are load-bearing and confirmed by the sibling bot's live
// run: (1) an indexed bytes32 arg (`id`) is stored as `bytea`, which Bun's SQL client returns as a
// Buffer, so we never compare it as a hex string — we join `bytea = bytea` directly in SQL, which
// sidesteps the Buffer/hex mismatch entirely (no `id` column is selected out). (2) address args are
// `character(42)` plain `0x…` strings; uint256 args (`lltv`) come back as a numeric string. The
// nested `marketParams` tuple is flattened by rindexer into per-field columns; the field names below
// (`loan_token`, `collateral_token`, `oracle`, `irm`, `lltv`) are the expected snake_case flattening
// — if a live run reveals a `market_params_`-prefixed form, this is the single line to adjust, and
// the aliased SELECT keeps `parseCandidate` below unchanged.
const BORROWERS_SQL = `
  SELECT DISTINCT
    b.on_behalf        AS borrower,
    cm.loan_token      AS loan_token,
    cm.collateral_token AS collateral_token,
    cm.oracle          AS oracle,
    cm.irm             AS irm,
    cm.lltv            AS lltv
  FROM blue_liquidation_morpho.borrow b
  JOIN blue_liquidation_morpho.create_market cm ON b.id = cm.id
`

function asAddress(value: unknown): Address | null {
  return typeof value === 'string' && isAddress(value, { strict: false }) ? getAddress(value) : null
}

// rindexer may return a uint256 as a bigint, a number, or a decimal string; accept all, reject
// anything non-numeric (which would otherwise BigInt-throw and kill the whole tick).
function asUint(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return BigInt(value)
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
  return null
}

/** Parses one joined row into a {@link BorrowerCandidate}, or `null` if any field is malformed. */
function parseCandidate(row: Row): BorrowerCandidate | null {
  const borrower = asAddress(row.borrower)
  const loanToken = asAddress(row.loan_token)
  const collateralToken = asAddress(row.collateral_token)
  const oracle = asAddress(row.oracle)
  const irm = asAddress(row.irm)
  const lltv = asUint(row.lltv)
  if (!borrower || !loanToken || !collateralToken || !oracle || !irm || lltv === null) return null
  return { marketParams: { loanToken, collateralToken, oracle, irm, lltv }, borrower }
}

/**
 * Reads the distinct (market, borrower) universe from rindexer's indexed `Borrow` events, joined to
 * the `CreateMarket` registry for each market's immutable params. The DB handle is injected so the
 * parsing is unit-testable without a live Postgres; the runtime adapter is {@link createPostgresQuery}.
 * Rows with a malformed address or lltv are skipped rather than failing the whole discovery.
 */
export async function discoverBorrowers(query: QueryFn): Promise<BorrowerCandidate[]> {
  const rows = await query(BORROWERS_SQL)
  const candidates: BorrowerCandidate[] = []
  for (const row of rows) {
    const candidate = parseCandidate(row)
    if (candidate) candidates.push(candidate)
  }
  return candidates
}

// rindexer's authoritative indexed head: its internal progress table tracks the last block synced
// per network (`rindexer_internal.<project>_<contract>_<event>`, one row per network, column
// `last_synced_block`), and advances with the chain tip during live indexing regardless of event
// activity. We read the Borrow progress row (both events index the same contract on the same
// network, so their heads track together). We deliberately do NOT read MAX(block_number) over the
// event rows — that only moves when a new event is indexed, so during quiet periods it freezes while
// the chain marches on, making the bot over-report lag. MAX over the progress rows is
// network-agnostic (only `base` here).
const SYNCED_BLOCK_SQL = `
  SELECT MAX(last_synced_block) AS head
  FROM rindexer_internal.blue_liquidation_morpho_borrow
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

/** What {@link discoveryDiagnostics} found about one rindexer event table. */
export type TableDiagnostic = {
  /** Table exists in the `blue_liquidation_morpho` schema (rindexer has migrated it). */
  present: boolean
  /** The ACTUAL column names rindexer created, in ordinal order. Compare against the columns
   * `BORROWERS_SQL` selects (`on_behalf`, `id`, `loan_token`, …) — a mismatch here is the single
   * most likely cause of a failing/empty discovery, and is the reason this is logged at startup. */
  columns: string[]
  /** Row count (`null` if the table is absent). */
  rowCount: number | null
}

export type DiscoveryDiagnostics = {
  borrow: TableDiagnostic
  createMarket: TableDiagnostic
}

const SCHEMA = 'blue_liquidation_morpho'

async function probeTable(query: QueryFn, table: string): Promise<TableDiagnostic> {
  // information_schema gives the real column names WITHOUT depending on the table having data (a
  // `SELECT *` LIMIT 1 would return nothing to key off on an empty table). Quote-safe: the schema +
  // table names are compile-time constants here, not user input.
  const cols = await query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = '${SCHEMA}' AND table_name = '${table}'
     ORDER BY ordinal_position`
  )
  const columns = cols
    .map(row => (typeof row.column_name === 'string' ? row.column_name : null))
    .filter((name): name is string => name !== null)
  if (columns.length === 0) return { present: false, columns: [], rowCount: null }
  const countRows = await query(`SELECT count(*)::bigint AS n FROM ${SCHEMA}.${table}`)
  const raw = countRows[0]?.n
  const rowCount = typeof raw === 'bigint' || typeof raw === 'number' ? Number(raw) : null
  return { present: true, columns, rowCount }
}

/**
 * Startup self-check for the rindexer schema: reports the ACTUAL column names + row counts of the
 * `borrow` and `create_market` tables. Logged once at boot so a column-name mismatch (the documented
 * schema-encoding risk in {@link BORROWERS_SQL} — the one thing that can silently break or empty
 * discovery) is diagnosable from Railway logs without a redeploy: eyeball the real columns against
 * the ones the join selects. Per-table try/catch so a not-yet-migrated table (rindexer still starting)
 * reports `present: false` instead of throwing.
 */
export async function discoveryDiagnostics(query: QueryFn): Promise<DiscoveryDiagnostics> {
  const probe = async (table: string): Promise<TableDiagnostic> => {
    try {
      return await probeTable(query, table)
    } catch {
      return { present: false, columns: [], rowCount: null }
    }
  }
  const [borrow, createMarket] = await Promise.all([probe('borrow'), probe('create_market')])
  return { borrow, createMarket }
}

/** Runtime adapter: a {@link QueryFn} backed by Bun's built-in Postgres client. */
export function createPostgresQuery(databaseUrl: string): QueryFn {
  const db = new SQL(databaseUrl)
  return async sql => db.unsafe(sql)
}
