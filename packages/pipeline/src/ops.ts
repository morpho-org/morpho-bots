// Type-only edge: the op signatures reference the logger's types, nothing at runtime. If a
// runtime import of @repo/evm-kit ever appears here, revisit the split rather than widening it.
import type { Logger, LogLevel } from '@repo/evm-kit'

import type { PositionRecord, TransactionRecord } from './records'

/**
 * The op seam: the shapes a core exposes so the CLI can run each op as its own `<domain> <op>`
 * command. Like {@link ./records} (the wire contract), these are the PIPE SEAM, not a bot shape:
 * they reference only this package's own record types (plus the {@link Logger} type and the generic
 * env table), so a core and the CLI cannot drift on what an op looks like. Defined ONCE here for
 * exactly that reason.
 *
 * Each op is EITHER a source ({@link SenseOpExport} — emits position records) or a transform
 * ({@link ActOpExport} — maps semantic positions to transactions),
 * never both: the two stages are separate pipe processes. The CLI drops the `sense`/`act` verbs at
 * its surface (commands ARE op names), but this seam keeps the internal vocabulary — the `kind`
 * discriminant and the `senseOnce`/`actOnce` entry points — because it is the stable contract the
 * cores' own unit tests (`runSense`/`runAct`) and the CLI's run functions both build against.
 */

/** The generic, file-merged env table every op is handed (the CLI never lets a core read `Bun.env`). */
type Env = Record<string, string | undefined>

/** The stage-config validation each op runs before touching the chain (throws → the CLI exits 2). */
type ValidateConfig = (env: Env) => { logLevel: LogLevel }

/**
 * A source op emits transparent position records for actionable on-chain state.
 * `cacheVersion` gates its disposable cache (a mismatch rebuilds, never migrates); `runStartupChecks`
 * is set only on a cold cache so liveness probes don't run every tick.
 */
export type SenseOpExport = {
  kind: 'sense'
  cacheVersion: number
  validateConfig: ValidateConfig
  senseOnce: (
    env: Env,
    opts: {
      cache: unknown
      runStartupChecks: boolean
      logger: Logger
      emit: (record: PositionRecord) => void
    }
  ) => Promise<{ cache: unknown }>
}

/**
 * A transform validates semantic input records and emits freshly simulated transactions. It has no
 * signer key; broadcasting is the queue's job.
 */
export type ActOpExport = {
  kind: 'act'
  cacheVersion: number
  validateConfig: ValidateConfig
  actOnce: (
    env: Env,
    records: readonly unknown[],
    opts: {
      cache: unknown
      runStartupChecks: boolean
      logger: Logger
      emit: (record: TransactionRecord) => void
    }
  ) => Promise<{ cache: unknown }>
}

/** Any op a core exposes in its `OPS` table — a source XOR a transform, discriminated on `kind`. */
export type OpExport = SenseOpExport | ActOpExport
