import type { Logger, LogLevel } from './logger'
import type { BackoffState } from './queue/backoff'
import type { OpportunityRecord, OutcomeRecord, TxRecord } from './records'

/**
 * The op seam: the shapes a core exposes so the CLI can run each op as its own `<domain> <op>`
 * command. Like {@link ./records} (the wire contract), these are the PIPE SEAM, not a bot shape:
 * they reference only bot-kit's own record/{@link Logger} types plus the generic env table, so a
 * core and the CLI cannot drift on what an op looks like. Defined ONCE here for exactly that reason.
 *
 * Each op is EITHER a **source** ({@link SenseOpExport} — emits opportunity records) or a
 * **transform** ({@link ActOpExport} — maps a specific source's ids/records to tx/outcome records),
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
 * A SOURCE op: emits `opportunity` records for actionable on-chain state, read-only and lockless.
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
      emit: (record: OpportunityRecord) => void
    }
  ) => Promise<{ cache: unknown }>
}

/**
 * A TRANSFORM op: maps ids/records emitted by the source op named in `accepts` to freshly simulated
 * `tx` records (plus diagnostic `outcome`s). `accepts` is the source op's name — the wire `op` field
 * a record must carry to be routed here; the CLI's input collector filters on it so mixed streams
 * stay legal (a transform takes only its own). No signer key: broadcasting is the queue's job.
 */
export type ActOpExport = {
  kind: 'act'
  accepts: string
  cacheVersion: number
  validateConfig: ValidateConfig
  actOnce: (
    env: Env,
    ids: readonly string[],
    opts: {
      cache: unknown
      advisory: { backoff: BackoffState | null; inflightLabels: readonly string[] }
      runStartupChecks: boolean
      logger: Logger
      emit: (record: TxRecord | OutcomeRecord) => void
    }
  ) => Promise<{ cache: unknown }>
}

/** Any op a core exposes in its `OPS` table — a source XOR a transform, discriminated on `kind`. */
export type OpExport = SenseOpExport | ActOpExport
