# TIB-2026-07-11: `queued` — the per-chain transaction-queue daemon (lpr/lpd split)

| Field      | Value                                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Status** | Proposed _(flips to Accepted at merge — the TIB lands in the daemon PR)_                                                                                                                         |
| **Date**   | 2026-07-11                                                                                                                                                                                       |
| **Author** | @hayden                                                                                                                                                                                          |
| **Scope**  | Repo-wide (`services/queued`, `@repo/bot-kit`, `@repo/home`, `tools/cli`, `bots/`)                                                                                                               |
| **Amends** | [TIB-2026-07-09-pipeline-cli](./TIB-2026-07-09-pipeline-cli.md) — queue run-order + heartbeat clauses; [TIB-2026-07-10-signer-agent](./TIB-2026-07-10-signer-agent.md) — local-key-reader clause |

---

## Context

[TIB-2026-07-09-pipeline-cli](./TIB-2026-07-09-pipeline-cli.md) made `<domain> queue` a stateful
one-shot sink: it reads tx records to EOF, dedupes/re-sims/submits, runs **one** `onBlock(head)`
maintenance pass, persists, and exits. Settlement detection and RBF therefore wait for the next
cron tick — a confirmed tx is invisible until the loop comes back around, and stuck-tx bumping is
quantized to loop cadence. The one-shot also binds the nonce cursor to a `(bot, chain)` process,
so two bots sharing one EOA on one chain would race. This TIB splits the sink the way printing
split `lpr` from `lpd`: a long-lived per-chain daemon owns the transaction lifecycle and watches
blocks continuously; `queue` becomes a thin pipe-stage client that hands records over a Unix
socket. Four user decisions are settled inputs, not open questions: the daemon is a **separate
service with its own bin** (not a CLI subcommand), one instance is **one chain, domain-agnostic**
(any bot, nothing declared upfront), there is **no one-shot fallback**, and armed/disarmed is
**daemon-level state** (`--dry-run`).

## Goals / Non-Goals

**Goals**

- **Settlement and RBF within seconds.** A continuous sweeper (2s while anything is in flight)
  replaces the once-per-cron-tick maintenance pass.
- **One transaction manager per chain.** A domain-agnostic daemon (`morpho-queued --chain <id>`)
  owns dedupe, backoff, re-sim, fee policy, nonce, submit, and replacement for every bot's txs
  against **one EOA and one nonce cursor**.
- **`queue` becomes a relay (lpr).** The CLI stage parses stdin, hands records to the daemon, and
  relays acks — no key, no state, no lock.
- **A monitoring plane.** Every outcome — sync acks and terminal fates — appends to a per-chain
  `outcomes.jsonl`; `tail -f | jq` is the dashboard.
- **Message-format-only coupling.** The CLI and the daemon standardize on a shared protocol module
  in `@repo/bot-kit`; there is no `tools → services` import in either direction.
- **Daemon-level armed/disarmed.** `--dry-run` runs the full pipeline and emits `would_submit`
  without ever constructing a signer or writing state.

**Non-Goals**

- **A one-shot fallback.** User decision: socket dead → the client exits 1 and the unix loop
  retries. Two submit paths would drift; failure is loud, not silently degraded.
- **A `subscribe` method.** YAGNI in v1 — `tail -f outcomes.jsonl | jq` is the monitoring plane;
  adding a method later is additive. The planned TUI is the eventual consumer.
- **A disk spool of unsent txs.** The pipeline TIB's rejected alternative stays rejected: unsent
  records die with the connection and clients re-derive. A submit either enters the pending set or
  is rejected in-band.
- **Prod migration.** Railway keeps running the pre-restructure image; standing principle — build
  the system we want, migrate later.

## Current Solution

`tools/cli/src/commands/queue.ts` runs the one-shot pass: acquire the per-`(bot, chain)` lock →
load state → read stdin to EOF → record outcomes → dedupe → re-sim + submit → one
`onBlock(head)` → persist → release. "The queue is the heartbeat" — maintenance rides the cron
pipe, so an upstream dry spell is what triggers stuck-detection, and a tx that confirms one second
after the pass is unseen until the next tick. The signer key (or agent socket) is resolved
per-invocation from the **bot** config section via `loadQueueConfig`.

## Proposed Solution

### The daemon

`services/queued` (`@repo/queued`, bin `morpho-queued`) is a long-lived foreground daemon serving
exactly one chain. The chain is **explicit** — `--chain` or `CHAIN_ID`, no
sole-configured-chain inference: the daemon owns one chain's nonce cursor, so a second source of
chain truth is a footgun, not a convenience (the bot sections' inference stays for source/transform
ops). It is domain-agnostic via a `BotName`-keyed registry of static-string dynamic imports of the
cores' lens-free `./queue` subpaths (`services/queued/src/domains.ts` — `queuePolicy` +
`CHAIN_MAP`; the chain object is resolved across the union of registered maps, so Robinhood's
`defineChain` comes along without duplication). Keying on `BotName` makes adding a bot a compile
error in the registry — the daemon can never silently drop a domain.

### Layout: `tools/` vs `services/`, and `@repo/home`

- **`interfaces/` is renamed `tools/`** (merged, #47). The split is by process shape:
  **`tools/`** holds operator-invoked one-shot CLIs (`tools/cli`); **`services/`** holds
  long-lived, independently run processes — `queued` joins `blue-rindexer`. `services/` is now
  **partially** a bun workspace: the root glob gained `services/*`, which picks up `queued` and
  skips the rindexer (no `package.json`).
- **A noted asymmetry with `@repo/signer`:** the signing agent is also a long-lived daemon, yet it
  lives in `packages/` as a library whose bin is CLI-hosted (`morpho-bots signer`), while `queued`
  self-bins in `services/`. The signer is a chain-less callable capability the CLI composes;
  `queued` is a per-chain deployable with its own config section, lock, and supervision story. The
  asymmetry is accepted, not accidental — revisit only if the signer grows deployment machinery of
  its own.
- **`@repo/home`** (merged, #48) extracts exactly what daemon and CLI genuinely share: the home
  path helpers + `BotName` (`home.ts`), `saveState`/`loadState`, the pid lock, `queue-state.ts`
  (`QUEUE_STATE_VERSION`, `QueueState`, `readAdvisory`), and `readSettings`/`ConfigError`/
  `warnOnLooseSecrets`. **`mergedEnv`/`mergedSignerEnv` stay in the CLI** and `mergedQueuedEnv`
  lives in `services/queued/src/config.ts` — each merge has a single consumer, so hoisting them
  would be speculative surface. Daemon-only path helpers (`queuedSocketFile`, `queuedLockFile`,
  `outcomesFile`) landed in `@repo/home` with the daemon.

### Wire protocol (`packages/bot-kit/src/queued-protocol.ts`)

The protocol module is **pure data** — envelope types, `QUEUED_PROTOCOL_VERSION = 1`, error codes,
line codecs — with no sockets, framed/validated like `@repo/signer`'s hand-rolled `protocol.ts`
(no zod). Both sides standardize on it and nothing else: the daemon implements its server against
it, and the CLI implements **its own** thin `node:net` client against it. The dependency graph
stays `tools/cli → packages/*` and `services/queued → packages/*` — no shared client library, no
`tools → services` edge. JSON-lines `{v, id, method, params}` / `{v, id, result | error}`;
`MAX_LINE_BYTES = 262144` (tx calldata outgrows the signer's 64 KiB cap); per-connection responses
are serialized so pipelined ingests keep request order; the socket is born 0600 (umask around
listen); a stale socket is connect-probed at startup (alive → exit 2, refused/`ENOENT` → unlink
and bind); `close()` unlinks.

| method   | params                                | result                                                                           |
| -------- | ------------------------------------- | -------------------------------------------------------------------------------- |
| `ping`   | —                                     | `{pong: true}`                                                                   |
| `status` | —                                     | `{chainId, address, armed, pending, wireVersion}` (`address` null when disarmed) |
| `ingest` | `{record: TxRecord \| OutcomeRecord}` | `{outcome?: OutcomeRecord}`                                                      |

- **One `ingest` method.** The record's `kind` already discriminates: `outcome` → backoff
  bookkeeping (statuses in `QUEUE_BACKOFF_STATUSES`), returns `{}`; `tx` → dedupe → re-sim → fee →
  submit, returns the ack outcome. Per-record requests, no batch method — the client sends N
  requests over one connection. Records ride raw, so **two versions coexist on the wire**: the
  protocol envelope `v` and the record `v` (`WIRE_VERSION`); record skew is an in-band error, not
  a framing failure.
- **Error taxonomy:** `bad_request` | `unsupported_version` | `chain_mismatch` | `retry`
  (transient — `send_aborted`, `submit_failed`, `base_fee_unavailable` ride in the message) |
  `internal`. **Per-record errors are request-scoped** — the connection always survives them. The
  client pre-filters chain/domain, so the first three are defense-in-depth it maps to warn+skip;
  `retry`/`internal` map to exit 1. Exit 2 is reserved for handshake-level failures (`status`
  chain mismatch, protocol-`v` mismatch) and stdin record-version skew.
- **Ack vs journal — a loud semantics change.** Sync acks (`submitted`, `would_submit`,
  `deduped_inflight`, `sim_reverted`) return on the connection **and** append to
  `<home>/queued/outcomes-<chainId>.jsonl`. Terminal fates (`confirmed`, `reverted`, `dropped`)
  are **journal-only — they leave the pipe's stdout**, because the pipe that submitted has long
  exited. Everything flows through one `appendOutcome` chokepoint (plain `appendFileSync`; single
  writer, `O_APPEND`); the record shape mirrors the one-shot's `queueOutcome` exactly, so journal
  lines are indistinguishable from the pre-daemon wire. No rotation in v1: append-only, never read
  back, externally rotatable on restart.

### Engine (`services/queued/src/engine.ts`)

- **Per-domain runtimes, one signer.** Each domain gets its own `createPendingQueue` (its policy's
  `settledCooldownBlocks`/`revertReason`, its own `onSettled`) and `createBackoff`, all sharing
  **one** `createSigner` and nonce cursor. `guardedSyncNonce` is injected per-queue and calls
  `signer.syncNonce()` only when **total** pending across every domain is 0 — the multi-domain fix
  for the pending-queue's sync-on-my-empty seam. Labels are `<domain>:<op>:…`, so cross-domain
  collisions are impossible.
- **One promise-chain mutex** over {ingest, sweep, reconcile, shutdown} prevents
  double-`replaceStuck` and makes sharing the signer safe. After a `TxSendError` (the signer
  rolled its cursor back) a `sendAborted` flag NACKs further submits (`retry: send_aborted`) until
  the next sweep completes — the daemon's version of the one-shot's break-the-batch.
- **Signer-agent resilience.** In agent mode `withSignRetry` wraps the injected `LocalAccount` so a
  single `signTransaction` retries **once** on a connect-class failure — a plain `Error` from a
  dead or absent signer socket (the agent restarted mid-life; the client opens one connection per
  request, so the next attempt reconnects). Typed protocol errors (`AgentPolicyError`,
  `AgentResponseError`) are deterministic verdicts and are **never** retried. Local-key accounts
  never touch the socket and are left unwrapped.
- **Dual-cadence sweeper.** A self-rescheduling, never-overlapping timer: `ACTIVE_SWEEP_MS = 2000`
  while any `inflightLabels()` is non-empty (this includes settled-cooldown labels, so midnight's
  20-block cooldown keeps draining), `IDLE_SWEEP_MS = 15000` otherwise; `poke()` schedules an
  immediate sweep after any ingest that actually submitted. `Engine.tick()` exposes one sweep as a
  public seam so a supervisor or test can drive settlement deterministically. Head-fetch failure:
  warn, skip the sweep, reschedule — never crash.
- **Head/baseFee cache, ~2s TTL.** One fetch feeds a whole wave of per-record ingests; sweeps and
  reconciliation pass `force` because stuck-detection needs current chain truth. **Head comes from
  the send endpoint** (`sendRpcUrl ?? rpcUrl`) so stuck-detection sees what receipts see — a
  deviation from the one-shot, which took its head from the read client (changelog-worthy). The
  re-sim `eth_call` stays on the read client, exact bytes, at submit time — the pipeline TIB's
  "simulate the exact bytes you sign" gate moves into the daemon intact.
- **Nonce reconciliation** — every ~45s while pending > 0, plus once at startup (armed) before the
  socket binds, so a restart heals a consumed-nonce zombie before the first ingest claims a nonce.
  `getTransactionCount('latest')` vs tracked nonces; a consumed nonce whose tx has no visible
  receipt → `queue.drop(nonce, head, 'nonce_consumed')` → a terminal `dropped` journal line.
  Armed **agent** mode also re-verifies the agent's address each pass — a mismatch means the agent
  restarted under a different key: persist everything, exit 2 (fatal misconfig). Reconciliation
  never moves the cursor; cursor truth stays with `guardedSyncNonce`. **Kept over an external
  reviewer's defer recommendation**, deliberately: sync-on-empty never fires in a busy daemon
  (that was the one-shot's healing moment), long-uptime nonce drift is the core daemon-unsafe gap,
  and the zombie-cancel and eviction-detection deferrals below both lean on reconciliation as
  their safety net. It stays minimal — one `getTransactionCount` plus receipt re-checks.
- **Dry-run = disarmed daemon state.** `config.signer` is never resolved (the key is **never
  read**); ingest runs the full dedupe → backoff → re-sim → fee pipeline and then acks/journals
  `would_submit` instead of submitting. State files are read once at startup as a backoff/inflight
  seed and **never written**; sweep/reconcile timers never start. There is no `dryInflight` map —
  repeated ticks re-emit `would_submit`, which is honest: nothing is actually in flight.
- **Persistence discipline.** The state files are **unchanged**: per-`(domain, chain)`
  `<home>/<domain>/queue/<chainId>.json`, `QUEUE_STATE_VERSION = 2`, `{version, queue, backoff}` —
  so `readAdvisory` and the transform ops' advisory reads need zero changes, and the single-writer
  doctrine holds with the daemon as sole writer. Persist fires immediately after every successful
  submit (a claimed nonce must survive a crash); everything else is dirty-flag coalesced at the
  end of each mutex section.
- **Lock and lifecycle.** `locks/queued-<chainId>.lock` is held for the daemon's lifetime;
  held-by-live-pid → exit 2 (a second daemon per chain is misconfig); dead-pid steal preserved.
  Startup order: resolve config → take the lock → stale-socket probe → (armed) signer handshake
  (agent address vs `LIQUIDATOR_ADDRESS`; dead agent socket → exit 1, mismatch → exit 2) →
  restore state → (armed) startup reconcile → start timers → bind the socket. SIGTERM/SIGINT:
  stop timers → drain the mutex → persist every runtime → destroy connections, close + unlink the
  socket → release the lock → exit 0.

### The thin client — committed follow-up (next PR)

In **this** PR the CLI still runs the one-shot pass; the flip is the next rung, not an open
question. `<domain> queue` becomes ~150 lines: `mergedEnv` for chain resolution only (no key, no
queue config), TTY stdin → `ping` (pong → 0, dead → 1), otherwise a `status` handshake (daemon
chain or protocol-`v` mismatch → 2) then one `ingest` per stdin record in order, relaying each
returned ack on stdout. Connect/timeout/`retry`/`internal` → 1; per-record errors → warn+skip
(still 0). The one-shot pass, `loadQueueConfig`, and the per-`(bot, chain)` queue locks are
deleted with it. The pipeline text `… | <domain> queue` is unchanged.

### Semantics changes, flagged loudly

1. **Terminal `confirmed`/`reverted`/`dropped` leave the pipe's stdout** — they exist only in
   `outcomes.jsonl`. Anything grepping container stdout for confirmations must move to the journal.
2. **`LIQUIDATOR_PRIVATE_KEY` moves to the `queued` config section.** RPC/chain config is
   _duplicated_ into `queued`; the bot sections keep theirs because source/transform ops still
   read them via `mergedEnv`.
3. **One `maxFeeWei` per chain** — the per-chain daemon flattens any per-bot fee-ceiling
   difference on a shared chain.
4. **Sweep head comes from the send endpoint** (was the read client).
5. **A restored pending tx bumps against the _current_ `maxFeeWei`** — lowering the ceiling and
   restarting can insta-drop a restored tx on the first sweep. Correct, and logged clearly.

### Implementation Phases

- **Rung 0 — `refactor(repo): rename interfaces/ to tools/`** (merged, #47). Mechanical.
- **Rung 1 — `refactor(packages): extract @repo/home and hoist bot-kit queue seams`** (merged,
  #48). `@repo/home`, bot-kit `queue/env.ts` resolvers, `splitIdPrefix` move, `PendingQueue.drop`.
- **Rung 2 — `feat(queued): add per-chain queue daemon service`** (this PR). Protocol module,
  daemon, this TIB.
- **Rung 3 — `feat(cli): replace queue sink with queued thin client`.** The flip + deletions.
- **Rung 4 — `feat(bots): supervise queued daemon in entrypoint and image`.** Same-container
  supervision loop, Dockerfile build layer, compose `QUEUED_DRY_RUN` passthrough, `init`
  scaffolding.

## Amended Decisions

This TIB amends two clauses of [TIB-2026-07-09-pipeline-cli](./TIB-2026-07-09-pipeline-cli.md) and
one of [TIB-2026-07-10-signer-agent](./TIB-2026-07-10-signer-agent.md); everything else stands.

1. **The queue run order** ("acquire lock → load state → read stdin to EOF → … → `onBlock(head)` →
   persist → release") becomes the daemon's split lifecycle: ingest handles records as they
   arrive; settlement/RBF run on the continuous sweeper; persistence is
   submit-immediate + coalesced. The wire contract, outcome vocabulary, re-sim gate,
   single-writer state discipline, and state-file schema all stand.
2. **"The queue is the heartbeat"** — maintenance riding the cron pipe, with empty stdin still
   running a pass — becomes **the daemon is the heartbeat**: the sweeper is the clock, and the
   pipe is pure handoff. The per-`(bot, chain)` lock row of that TIB's state table retires with
   the one-shot (rung 3), replaced by the per-chain daemon lock.
3. **The signer TIB's local-key clause** ("the private key is read by exactly one process — the
   agent when `SIGNER_SOCKET` is set, else the `queue` command") narrows again: else the **queued
   daemon**. The single-key-reader principle is unchanged and strengthened — the CLI never reads
   a key on any path once the thin client lands, and a disarmed daemon never reads one either.

## Considered Alternatives

### Alternative 1: A CLI subcommand (`morpho-bots queue --serve`)

Host the daemon inside `tools/cli` as a mode of the existing command.

**Why rejected:** User decision — the transaction manager is a **service**. A daemon inside the
operator CLI muddles the tools-vs-services split this TIB establishes, drags the CLI's full
op-command surface (and its soltag/lens build machinery) into a process that needs none of it, and
gives the long-lived process the wrong supervision story (`morpho-queued` is what a supervisor
restarts; `morpho-bots` is what an operator types).

### Alternative 2: A per-bot daemon

One daemon per `(bot, chain)`, mirroring today's per-`(bot, chain)` locks.

**Why rejected:** User decision — per-chain, multi-bot. The nonce cursor is a per-EOA-per-chain
resource: two bots sharing one EOA on one chain from two daemons is exactly the second-cursor
hazard the pipeline TIB rejected in its `send` alternative. One daemon per chain makes the shared
cursor structural (`guardedSyncNonce` over the union of domains) instead of coordinated.

### Alternative 3: Thin client with a one-shot fallback

Keep the inline submit path so `queue` degrades gracefully when the daemon is down.

**Why rejected:** User decision — no fallback. Two submit paths drift (two re-sim gates, two fee
policies, two lock disciplines), and a silent fallback hides a dead daemon behind working
liquidations, defeating the monitoring plane. Socket dead → exit 1; the unix loop retries; daemon
boot windows are transient by design.

### Alternative 4: A shared client library

Export a client from `@repo/queued` (or a `@repo/queued-client`) and have the CLI import it.

**Why rejected:** The contract is the **message format**, not code. Sharing only the pure-data
protocol module in `@repo/bot-kit` keeps the dependency graph acyclic (`tools → packages`,
`services → packages`, never `tools → services`), keeps the daemon's module graph out of the CLI
bundle, and mirrors the signer precedent — the client is ~100 lines of `node:net` the CLI owns.

## Assumptions & Constraints

- **One daemon per chain, all bots on that chain share one EOA** — enforced by the lifetime lock;
  a consequence is the single `maxFeeWei` per chain (semantics change 3).
- **The daemon stays the sole writer of the queue state files, schema v2** — the transform ops'
  advisory reads (`readAdvisory`) depend on it; any schema change bumps `QUEUE_STATE_VERSION`
  with version-gated discard as today.
- **Clients pre-filter chain and domain** — the daemon's per-record guards are defense-in-depth,
  which is why warn+skip (not exit) is the client's correct response to them.
- **`outcomes.jsonl` is append-only and never read back by the daemon** — external rotation on
  restart; a consumer that needs replay owns its own offset.
- **Block-denominated knobs still assume ~per-block observation** — now upheld by the 2s active
  sweep rather than loop cadence; `STUCK_BLOCKS` becomes a per-chain daemon knob (default 4).
- **Prod keeps running the pre-restructure image** — nothing here deploys until the separate
  migration effort; the config-section key move is safe for the same reason.

## Observability

- **`outcomes.jsonl` is the monitoring plane** — every ack and every terminal fate, one JSON line
  each, `tail -f | jq`-able; in dry-run the `would_submit` stream is a live feed of what the
  daemon _would_ do. The planned TUI consumes this and `status`.
- **`status` over the socket** reports `{chainId, address, armed, pending, wireVersion}` for
  humans and health checks; TTY `queue` invocations become a `ping`.
- **stderr keeps the structured log stream**: `queued.listening`, `sweep.head_failed`,
  `reconcile.agent_mismatch`/`reconcile.head_failed`, `queued.tx_send_error`, `state.reset`,
  `lock.stolen`, `queued.key_ignored`.
- **The loud change:** terminal outcomes no longer appear in the container's stdout logs — the
  `bots/` entrypoint's header and any log-based alerting must point at the journal (rung 4).

## Security

- **Key custody narrows again.** The daemon is now the sole local-key reader (else keyless via the
  signer agent, with the `LIQUIDATOR_ADDRESS` handshake cross-check and the reconcile-time
  re-verify); the CLI stage is key-free on every path once rung 3 lands. Dry-run never resolves a
  signer backend at all, so a disarmed daemon cannot leak what it never read. The
  `key_ignored` warning ports over for agent-mode configs that still carry a key.
- **Sign-what-you-simulate survives the split.** The re-sim gate runs in the daemon on the exact
  bytes, per record, at submit time — a delayed, replayed, or ad-hoc record still cannot broadcast
  stale calldata.
- **Socket hygiene mirrors the signer:** born 0600 via umask (no chmod race), `sun_path` length
  validated with a clear error, stale sockets probed before stealing, oversize lines answered
  then disconnected, internal throws become `internal` responses — a client can never crash the
  daemon.
- **Untrusted-input surface:** every record is narrowed before use (object shape, numeric wire
  version, chain, registered domain, non-empty id, `to` as a real address and `data` as hex via
  viem's `isAddress`/`isHex`); failures are request-scoped errors, never state mutations.

## Future Considerations — named deferrals

Each deferred deliberately, with the reason recorded so it is not relitigated as an oversight:

1. **Cancel-tx on `reverts_on_replace`/`fee_ceiling`** — needs a signer-policy self-transfer rule
   (the agent is default-deny today); zombies are fee-bounded and reconciliation-covered; its own
   PR later.
2. **Wall-clock stuck detection** — needs a clock seam in the pending queue; mitigated by the
   per-chain `STUCK_BLOCKS` knob; revisit if Robinhood shows unbounded stucks.
3. **Explicit eviction detection** (`getTransactionByHash` null-streak) — `replaceStuck`'s fresh
   broadcast already heals mempool evictions within the stuck window.
4. **A daemon-side `backoff_active` ingest gate** — transform ops already filter via the advisory
   read; the one-shot's vocabulary parity is preserved without a second gate.
5. **`Backoff.prune`** — the leak is tiny and slow (weeks), and eviction semantics interact with
   attempt-count escalation (the 1inch 429 defense); needs its own behavior decision.
6. **A dry-run `dryInflight` dedupe map** — repeated `would_submit` per wave is honest (nothing is
   in flight) and simpler; the journal is a monitoring plane, not a ledger.
7. **`outcomes.jsonl` rotation, a `subscribe` method, hot fee-ceiling retune** — restart-to-retune
   is documented; all three are additive later.
8. **A send-error fast-trigger for reconciliation** — nonce-too-low/already-known/
   replacement-underpriced send errors could trigger an immediate reconcile; deferred to the
   periodic ~45s cadence, which bounds the wedge window acceptably while keeping the trigger
   surface minimal.

## References

- [TIB-2026-07-09: UNIX-pipeable CLI](./TIB-2026-07-09-pipeline-cli.md) — the one-shot queue this
  daemon replaces; its run-order and heartbeat clauses are amended here, its wire contract, state
  schema, and re-sim doctrine carried over intact.
- [TIB-2026-07-10: Signing agent](./TIB-2026-07-10-signer-agent.md) — the protocol/server patterns
  this daemon clones (hand-rolled codecs, 0600 socket, stale-socket probe) and the agent backend
  it consumes; its local-key clause is amended here.
- [TIB-2026-07-10: Commands are op names](./TIB-2026-07-10-op-commands.md) — the flat op namespace
  in which `queue` stays the reserved sink; the `<domain>:<op>:` label prefix the daemon's
  runtimes key on.
- [TIB-2026-07-09: Extract `@repo/swaps` and `@repo/bot-kit`](./TIB-2026-07-09-extract-bot-kit-and-swaps.md)
  — `createPendingQueue`, `createSigner`, backoff, and fee policy the engine composes per domain.

<!--
TIB conventions:
- Once accepted, do not substantively edit this TIB. If the decision needs to change,
  create a new TIB that supersedes this one and update the Status/Superseded by fields.
- Addenda may be appended to record operational updates that affect
  how the TIB is applied without changing the decision itself.
- TIB identifiers use CalVer (YYYY-MM-DD) based on the date the TIB was first drafted.
-->
