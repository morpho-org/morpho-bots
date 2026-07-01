import type { Address, Hex } from 'viem'

import { SQL } from 'bun'
import { getAddress, isAddress } from 'viem'

import type { Network } from '../config'
import type { MarketParams } from '../market'

export type Row = Record<string, unknown>
// Bound params (`$1`, `$2`, …) are passed separately from the SQL so values (e.g. the network name)
// are never string-interpolated — see BORROWER_IDS_SQL. Bun's `SQL.unsafe(sql, values)` supports this.
export type QueryFn = (sql: string, params?: readonly unknown[]) => Promise<readonly Row[]>

/** A discovered (market id, borrower) pair from the indexed Borrow events, before params are resolved. */
type BorrowerId = { id: Hex; borrower: Address }

/** A candidate position to evaluate: a (market, borrower) pair, with the market's immutable params
 * resolved on-chain via `idToMarketParams(id)` (see ../state/market-params.ts). */
export type BorrowerCandidate = { marketParams: MarketParams; borrower: Address }

// rindexer's no-code Postgres writes one table per indexed event, under a schema named after the
// project + contract (`blue_liquidation_morpho`), with event args as snake_case columns. We index
// ONLY `Borrow` (see rindexer.yaml): its indexed `onBehalf` is the position owner and the only
// debt-opening field, so the distinct (id, onBehalf) set is the complete borrower candidate universe.
// Over-inclusion (repaid/closed positions) is harmless — the lens re-reads every candidate fresh;
// under-inclusion would miss a liquidation, so we do NOT prune with Repay/WithdrawCollateral at the
// SQL layer. We deliberately do NOT index `CreateMarket`: no-code rindexer cannot decode its nested
// `MarketParams` struct (it panics), and the params are recoverable on-chain from `idToMarketParams(id)`
// anyway, so the event is unnecessary.
//
// SCHEMA-ENCODING NOTE — this is intentionally the only place the rindexer column layout is encoded.
// The indexed bytes32 `id` is stored as `bytea` (Bun's SQL client returns it as a Uint8Array); the
// address `on_behalf` is a `character(42)` `0x…` string. The startup diagnostic logs the actual
// `borrow` columns for quick verification if discovery ever yields zero candidates while synced.
//
// MULTI-CHAIN — a single rindexer process indexes every chain into this one `borrow` table,
// discriminated by rindexer's standard `network` column. `WHERE b.network = $1` restricts this bot's
// candidate universe to ITS chain. This SQL filter is the CORRECTNESS BOUNDARY: the per-chain on-chain
// reads (idToMarketParams + the lens re-deriving `id` against this chain's own singleton) are only a
// backstop that would drop a foreign-chain id — a future refactor must NOT drop the `network` filter
// on the assumption that the on-chain reads alone suffice (they'd waste an RPC slot per foreign row,
// and a market id that legitimately exists on both chains would otherwise be mis-attributed here).
const BORROWER_IDS_SQL = `
  SELECT DISTINCT
    b.id        AS id,
    b.on_behalf AS borrower
  FROM blue_liquidation_morpho.borrow b
  WHERE b.network = $1
`

function asAddress(value: unknown): Address | null {
  return typeof value === 'string' && isAddress(value, { strict: false }) ? getAddress(value) : null
}

// The indexed bytes32 `id` comes back as a 32-byte `bytea` (Uint8Array) from Bun's SQL client; accept
// a hex string too (defensive, in case a future rindexer stores it as text). Returns a lowercase
// 0x-prefixed 32-byte hex, matching the id that `marketId`/`lensKey` produce.
function asId(value: unknown): Hex | null {
  if (value instanceof Uint8Array) {
    return value.length === 32 ? `0x${Buffer.from(value).toString('hex')}` : null
  }
  if (typeof value === 'string') {
    const hex = value.startsWith('0x') || value.startsWith('0X') ? value : `0x${value}`
    return /^0x[0-9a-fA-F]{64}$/.test(hex) ? (hex.toLowerCase() as Hex) : null
  }
  return null
}

/**
 * Reads the distinct (market id, borrower) universe from rindexer's indexed `Borrow` events for the
 * given `network` (the rindexer network name, e.g. `'base'`). The DB handle is injected so parsing is
 * unit-testable without a live Postgres; the runtime adapter is {@link createPostgresQuery}. Rows
 * with a malformed id or borrower are skipped rather than failing the whole discovery.
 */
export async function discoverBorrowerIds(query: QueryFn, network: Network): Promise<BorrowerId[]> {
  const rows = await query(BORROWER_IDS_SQL, [network])
  const out: BorrowerId[] = []
  for (const row of rows) {
    const id = asId(row.id)
    const borrower = asAddress(row.borrower)
    if (id && borrower) out.push({ id, borrower })
  }
  return out
}

/**
 * The full discovery step for one `network`: the distinct (id, borrower) universe from `Borrow`, with
 * each market's immutable {@link MarketParams} resolved on-chain via `resolveParams` (backed by
 * `idToMarketParams(id)` — see ../state/market-params.ts). A pair whose id doesn't resolve to a market
 * is dropped. `resolveParams` is injected so this composes cleanly and stays unit-testable without a
 * chain.
 */
export async function discoverCandidates(
  query: QueryFn,
  resolveParams: (ids: readonly Hex[]) => Promise<Map<Hex, MarketParams>>,
  network: Network
): Promise<BorrowerCandidate[]> {
  const idPairs = await discoverBorrowerIds(query, network)
  const paramsById = await resolveParams(idPairs.map(pair => pair.id))
  const candidates: BorrowerCandidate[] = []
  for (const { id, borrower } of idPairs) {
    const marketParams = paramsById.get(id)
    if (marketParams) candidates.push({ marketParams, borrower })
  }
  return candidates
}

// rindexer's authoritative indexed head: its internal progress table tracks the last block synced
// per network (`rindexer_internal.<project>_<contract>_<event>`, one row per network, columns
// `network` + `last_synced_block`), and advances with the chain tip during live indexing regardless
// of event activity. We read THIS chain's Borrow progress row (the only event indexed) via
// `WHERE network = $1` — a single row per network, so no aggregate is needed. We deliberately do NOT
// read MAX(block_number) over the event rows — that only moves when a new event is indexed, so during
// quiet periods it freezes while the chain marches on, making the bot over-report lag. (Filtering by
// network is required in multi-chain mode: an unfiltered MAX would report the FURTHEST-ahead chain's
// head to every bot.)
const SYNCED_BLOCK_SQL = `
  SELECT last_synced_block AS head
  FROM rindexer_internal.blue_liquidation_morpho_borrow
  WHERE network = $1
`

/**
 * Best-effort rindexer indexed head for the given `network`, for the freshness/lag signal. Reads
 * rindexer's internal progress table (see {@link SYNCED_BLOCK_SQL}). Returns `null` when the table
 * has no row for this network yet (rindexer has not recorded progress). Callers treat `null` (and a
 * thrown query) as "lag unknown" and proceed — the lens reads every candidate fresh on-chain, so this
 * signal is observability-only.
 */
export async function rindexerSyncedBlock(
  query: QueryFn,
  network: Network
): Promise<bigint | null> {
  const rows = await query(SYNCED_BLOCK_SQL, [network])
  const head = rows[0]?.head
  if (typeof head === 'bigint') return head
  if (typeof head === 'number' || typeof head === 'string') return BigInt(head)
  return null
}

/** What {@link discoveryDiagnostics} found about the rindexer `borrow` table. */
export type TableDiagnostic = {
  /** Table exists in the `blue_liquidation_morpho` schema (rindexer has migrated it). */
  present: boolean
  /** The ACTUAL column names rindexer created, in ordinal order. Compare against what
   * `BORROWER_IDS_SQL` selects (`id`, `on_behalf`) — a mismatch here is the single most likely cause
   * of a failing/empty discovery, and is the reason this is logged at startup. */
  columns: string[]
  /** Row count (`null` if the table is absent). */
  rowCount: number | null
}

export type DiscoveryDiagnostics = { borrow: TableDiagnostic }

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
  // Bun's Postgres client returns a `bigint` column as a decimal string (to avoid precision loss),
  // so accept string too — else the count silently reports null even when the table has rows.
  const rowCount =
    typeof raw === 'bigint' || typeof raw === 'number'
      ? Number(raw)
      : typeof raw === 'string' && /^\d+$/.test(raw)
        ? Number(raw)
        : null
  return { present: true, columns, rowCount }
}

/**
 * Startup self-check for the rindexer schema: reports the ACTUAL column names + row count of the
 * `borrow` table. Logged once at boot so a column-name mismatch (the documented schema-encoding risk
 * in {@link BORROWER_IDS_SQL} — the one thing that can silently break or empty discovery) is
 * diagnosable from Railway logs without a redeploy: eyeball the real columns against the ones the
 * query selects. A thrown probe (table not yet migrated, DB error) reports `present: false` instead
 * of throwing.
 */
export async function discoveryDiagnostics(query: QueryFn): Promise<DiscoveryDiagnostics> {
  try {
    return { borrow: await probeTable(query, 'borrow') }
  } catch {
    return { borrow: { present: false, columns: [], rowCount: null } }
  }
}

/** Runtime adapter: a {@link QueryFn} backed by Bun's built-in Postgres client. Bound params are
 * forwarded to `SQL.unsafe(sql, values)` so values (e.g. the network name) go over the wire as
 * parameters, never string-interpolated. */
export function createPostgresQuery(databaseUrl: string): QueryFn {
  const db = new SQL(databaseUrl)
  return async (sql, params) => db.unsafe(sql, params as never)
}
