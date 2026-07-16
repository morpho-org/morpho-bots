# TIB-2026-07-14: BetterStack log forwarding via a Vector side-car on Railway

| Field      | Value                                                         |
| ---------- | ------------------------------------------------------------- |
| **Status** | Proposed — repo wiring implemented; enable-collection pending |
| **Date**   | 2026-07-14                                                    |
| **Author** | @hayden                                                       |
| **Scope**  | Repo-wide                                                     |

---

## Context

Both liquidation bots already emit clean JSON-line logs to **stderr** with stable event keys
(`packages/evm-kit/src/logger.ts`), and three prior TIBs describe BetterStack forwarding as a
**deferred, additive** layer that ships those keys as-is — explicitly _"not a logging rework"_:

- [TIB-2026-07-13-bot-architecture §8](./TIB-2026-07-13-bot-architecture.md) defers _"loop-level
  log aggregation (the BetterStack follow-up)"_ — more pressing now that each tick is several
  short-lived processes.
- [TIB-2026-06-30-blue-liquidation-bot](./TIB-2026-06-30-blue-liquidation-bot.md) and
  [TIB-2026-05-28-midnight-liquidation-bot](./TIB-2026-05-28-midnight-liquidation-bot.md) both state
  the keys _"are designed to be shipped as-is, so this is an additive forwarding … layer rather than
  a logging rework,"_ deferred to v1.

Two constraints shape the design:

- **Railway has no log-drain feature.** Railway's own third-party-observability guidance is to _run
  a log forwarder such as Vector or Fluent Bit_ — there is no platform setting to forward
  `stdout`/`stderr` off-box. So forwarding must run **inside our deployment**.
- **No Railway/container source pattern exists yet.** The org's existing BetterStack sources are all
  **OpenTelemetry from Vercel apps**; that pattern is trace/metric-shaped and does not transfer to
  bun containers emitting JSON log lines.

## Goals / Non-Goals

**Goals**

- Ship both bots' existing stderr JSON logs to BetterStack for searchable retention **without
  touching application code**.
- **Keep the shipper off the critical path.** For a financial bot, a slow/down/unreachable shipper
  must not affect liquidations _or_ Railway's native log explorer.
- **Fully opt-in**: with the feature's config unset, behaviour is byte-identical to today.
- **One BetterStack source per bot** (`blue-liquidation`, `midnight-liquidation`); chains within a
  bot are distinguished by fields, not by additional sources.
- Preserve the single-key-reader invariant: the shipper never sees the signing key.

**Non-Goals**

- **Not a logging rework.** `createLogger` and every op/daemon are unchanged; no new event keys, no
  app-side identity stamping.
- **Not enable-collection.** Creating the BetterStack sources, dashboards, and alerts, and setting
  the real token/host secrets on Railway, are deploy-time steps done separately (see Future
  Considerations).
- **Not Slack alerting.** The other half of the deferred v1 observability item is tracked separately
  (see [TIB-2026-07-14-slack-ci-notifications](./TIB-2026-07-14-slack-ci-notifications.md)).
- **Not OpenTelemetry.** No traces or metrics; this forwards log lines.

## Current Solution

Both bots emit JSON-line logs to stderr via `createLogger`, and Railway captures each container's
`stdout` + `stderr` in its native explorer. Nothing forwards those lines off-platform, so logs are
searchable only inside Railway, with no long-term retention, cross-bot search, or dashboards.

## Proposed Solution

Run **`vector` as an in-image side-car** that tails the bots' combined stderr — spooled to an
**ephemeral file via `tee`** — and ships it to a **per-bot BetterStack HTTP source**.

- **Decoupled via tee-to-spool.** The entrypoint redirects its stderr through `tee` to **(a)** the
  real stderr (Railway's explorer and `railway logs` keep working exactly as today) **and (b)** a
  bounded spool file that Vector tails (`exec 2> >(tee -a "$SPOOL" >&2)`). Vector shipping is thus
  off the critical path: if Vector is slow, dead, or BetterStack is unreachable, the bot and its
  primary logs are unaffected, and the HTTP sink drops newest rather than backing pressure onto the
  bot.
- **Opt-in contract.** Vector starts **only when `BETTERSTACK_SOURCE_TOKEN` is set** (with
  `BETTERSTACK_INGESTING_HOST` also required). Unset ⇒ byte-identical to today — existing entrypoint
  tests, `QUEUED_DRY_RUN`, and local dev are untouched, so "nothing ships by default" holds. Token
  set **but host missing → fail loud** (structured stderr error, skip Vector), never a silently
  broken shipper.
- **No application code change.** Per-line enrichment (`bot`, `chainId`, and Railway
  service/deployment/environment/replica identity) is done in Vector's VRL `remap` transform, keeping
  this a pure forwarding layer. App-stamped fields win over env fallbacks via merge order; every
  `parse_json`/`get_env_var` is infallible so a non-JSON line or an unset var never drops the
  pipeline.
- **One source per bot.** Blue's two chain services (`bot-8453`, `bot-4663`) share the **one blue**
  source token; the `bot`/`chainId` fields distinguish chains within it. Midnight has its own source.
- **Spool on ephemeral storage, rotated in place.** The spool and Vector's checkpoint `data_dir`
  live under `/tmp` (never `/data`), and a lightweight backgrounded truncate loop caps the spool
  size; Vector detects the in-place truncation via its checkpoint. Minor dup/loss on rotation is
  acceptable because **real stderr is the source of truth**.
- **Ordered, bounded shutdown.** Vector stops **last** (after tick → queued → signer) so final
  buffered lines flush, but its shutdown wait is bounded so a slow shipper can't eat into the queue's
  drain window.

### Implementation Phases

- **Phase 1 — Repo wiring (this TIB).** `deploy/vector.yaml`, the entrypoint tee/spool/rotation +
  gated Vector launch, the Dockerfile side-car binary, the compose/Railway env plumbing, and tests.
  Ships inert: with the token unset, prod is byte-identical to today.
- **Phase 2 — Enable collection (deploy-time, out of scope here).** Create the two BetterStack
  sources, set the real `BETTERSTACK_SOURCE_TOKEN`/`BETTERSTACK_INGESTING_HOST` on Railway, and build
  dashboards/alerts.

## Considered Alternatives

### Alternative 1: App-level HTTP transport in `createLogger`

Add a BetterStack HTTP transport inside the shared logger so every process ships its own lines.

**Why rejected:** it touches the shared logger and, worse, the shutdown path of **every short-lived
per-tick op** — a source/transform process lives for one tick, so an in-process async shipper risks
losing its last batch on exit. The tee-to-spool side-car decouples shipping from process lifetime
entirely and needs zero application change.

### Alternative 2: OpenTelemetry

Emit OTel and use an OTel BetterStack source, matching the org's Vercel apps.

**Why rejected:** OTel is trace/metric-shaped and heavy for plain JSON **logs** spread across many
short-lived bun subprocesses per tick. The bots already emit structured lines designed to ship
as-is; wrapping them in OTel is machinery this workload does not need, even though the org's Vercel
apps use OTel sources.

### Alternative 3: Pipe stderr straight into Vector's stdin (no spool file)

Skip the file and feed the bot's stderr directly into a Vector `stdin` source.

**Why rejected:** if Vector dies, the bot's stderr writes hit **EPIPE**, coupling bot liveness to
the shipper; and routing stderr into Vector instead of the console **blinds Railway's native logs**.
The `tee`-to-file design keeps Railway's explorer whole and isolates Vector failures from the bot.

## Assumptions & Constraints

- **Qualified safety, not zero-risk.** The shipper is off the critical path, **but `tee` does sit on
  fd 2** — a full spool disk or a dead `tee` is a residual risk on the bot's log path. It is
  _mitigated, not eliminated_, by the ephemeral spool location and the truncate-based rotation.
- **Spool never on `/data`.** The spool and checkpoints live on ephemeral `/tmp`, so a runaway spool
  during a BetterStack outage cannot fill the volume that holds queue state and the daemon journal
  (the hot path).
- **Opt-in gate holds.** Token unset ⇒ inert; token set with host missing ⇒ fail loud. No partial
  activation.
- **Blue's two chains share one source token**; the `bot`/`chainId` fields are what separate them
  downstream.
- **Rotation may drop/duplicate a few lines** across a truncate; acceptable because Railway's native
  stderr remains authoritative.

## Security

- **Single-key-reader invariant preserved.** Vector is launched with `SIGNER_PRIVATE_KEY` scrubbed
  from its environment (`env -u SIGNER_PRIVATE_KEY …`), so the shipper never holds the signing key —
  only `morpho-signer` ever reads it. The `tee` redirect is set up before the daemons start so their
  startup lines are spooled, independent of Vector's env.
- **Secret handling.** `BETTERSTACK_SOURCE_TOKEN` is routed through `railway.setSecrets` (skipped
  when undefined); `BETTERSTACK_INGESTING_HOST` is set conditionally as a plain variable. Neither is
  logged; the token reaches Vector only via the sink's bearer auth.
- **Volume isolation.** Ephemeral `/tmp` spool cannot DoS the state/journal volume.
- **No new sensitive surface in the payload.** The lines carry addresses, market ids, tx hashes, and
  bigint amounts as strings — public on-chain data the logger already emits — and the logger never
  logs keys.

## Observability

This decision _is_ an observability feature; its surface:

- **New per-line fields** stamped by Vector's VRL: `bot`, `chainId`, and `railway_service` /
  `railway_deployment` / `railway_environment` / `railway_replica` (each with an `"unknown"`
  fallback so compose runs, which lack the `RAILWAY_*` vars, still enrich cleanly).
- **Two BetterStack sources** (one per bot); blue's chains share one and are told apart by
  `bot`/`chainId`.
- **Existing surfaces unaffected.** Railway's native explorer keeps every line (tee duplicates, not
  redirects), and the stdout JSON-Lines **data plane** is untouched — only stderr is forwarded.

## Future Considerations

- **Enable-collection at deploy time.** Create the two sources, set the real token/host on Railway,
  and build dashboards/alerts. When authoring BetterStack queries, migrate off the retired
  `sense.*`/`act.*` event names and the queue's old `label` field to the current
  `source.*`/`transform.*` events and the `id` join key (per
  [TIB-2026-07-13-bot-architecture](./TIB-2026-07-13-bot-architecture.md)).
- **Slack alerting** for operationally significant events (`tx.confirmed`, `tx.reverted`,
  `tx.dropped`, sustained `tick.error`/`watcher.error`) — the other half of the deferred v1
  observability item, tracked in
  [TIB-2026-07-14-slack-ci-notifications](./TIB-2026-07-14-slack-ci-notifications.md).
- **App-side identity stamping in `createLogger`** — an optional future nicety, unneeded here since
  Railway labels its native explorer and Vector handles BetterStack enrichment.

## References

- [TIB-2026-07-13-bot-architecture](./TIB-2026-07-13-bot-architecture.md) — §8 Observability and the
  deferred BetterStack follow-up this fulfils.
- [TIB-2026-06-30-blue-liquidation-bot](./TIB-2026-06-30-blue-liquidation-bot.md),
  [TIB-2026-05-28-midnight-liquidation-bot](./TIB-2026-05-28-midnight-liquidation-bot.md) — the
  per-bot Observability/Future-Considerations deferrals ("keys designed to ship as-is").
- [TIB-2026-07-14-slack-ci-notifications](./TIB-2026-07-14-slack-ci-notifications.md) — the sibling
  half of the deferred v1 observability work.
- Railway third-party-observability guidance (`/guides/third-party-observability`): run Vector or
  Fluent Bit; Railway has no built-in log drain.
- Implementation surface: `deploy/vector.yaml`, `deploy/docker-entrypoint.sh`, `deploy/Dockerfile`,
  `packages/evm-kit/src/logger.ts`.

## Addenda

### 2026-07-16 — re-pointed at the per-bot layout after the pipeline revert

The op-pipeline architecture was reverted (see
[TIB-2026-07-16-revert-to-bots-as-programs](./TIB-2026-07-16-revert-to-bots-as-programs.md)); the
decision here (opt-in in-image Vector side-car, key-scrubbed, byte-identical when disabled) stands,
but the implementation surface moved:

- `deploy/{vector.yaml,docker-entrypoint.sh,Dockerfile}` are now **per-bot**:
  `bots/<bot>/{vector.yaml,docker-entrypoint.sh,Dockerfile}`. The logger lives in
  `packages/bot-kit/src/logger.ts` (there is no `@repo/evm-kit`).
- The single-key-reader scrub is unchanged in spirit but keyed to the bot's own key env
  (`LIQUIDATOR_PRIVATE_KEY`), not `SIGNER_PRIVATE_KEY` — there is no separate `morpho-signer` process
  anymore; each bot holds its own key in-process.
- BetterStack query guidance to migrate off `sense.*`/`act.*` and onto `source.*`/`transform.*` +
  `id` is moot: those pipeline-era event names never reached production. Author queries against the
  bots' actual in-process event names (e.g. `block.new`, `tick.end`, `tx.confirmed`).
- `createLogger` originally split levels across streams (info/warn to stdout, error to stderr),
  which forced the entrypoint to tee both streams into the spool. Now that stdout is no longer a
  data plane, the logger emits **every level to stderr** and the side-car tees that single stream —
  log capture cannot silently miss a level, and stdout stays reserved for program output.

### 2026-07-16 — replaced the Vector side-car with an in-process loglayer transport

The Vector side-car (this TIB's original design; "Considered Alternatives → Alternative 1:
App-level HTTP transport" was rejected then) has itself been replaced by exactly that app-level
transport, on the same `refactor/revert-bots-as-programs` branch. Alternative 1's rejection turned
on the pipeline era's **many short-lived per-tick op processes**, where an in-process async shipper
risked losing its last batch every tick; the pipeline is gone (see
[TIB-2026-07-16-revert-to-bots-as-programs](./TIB-2026-07-16-revert-to-bots-as-programs.md)) and
each bot is now one **long-running** process, so that objection no longer holds. The deciding factor
is now **wide, typed structured logs**: `createLogger` is backed by `loglayer` composing a stderr
JSON-line sink and `@loglayer/transport-betterstack`, so typed fields (and per-scope context like
`bot`/`chainId`, stamped by the app rather than a VRL) flow end-to-end.

- **Removed:** both bots' `vector.yaml` + `docker-entrypoint.sh`, the Dockerfile Vector binary bake
  / `vector --version` link check / `vector validate` step, and the tee-to-spool + rotation
  machinery. The bot stage runs `bun run start` directly again. Compose and `deploy-railway.ts`
  still pass `BETTERSTACK_*` through — the **bot process** consumes them now.
- **Opt-in contract unchanged:** the transport attaches only when BOTH `BETTERSTACK_SOURCE_TOKEN`
  and `BETTERSTACK_INGESTING_HOST` are set; unset ⇒ no transport, zero network, byte-identical
  stderr. Enrichment the Vector VRL did (`bot`/`chainId`/`RAILWAY_*`) is now app-side context.
- **Accepted trade-off:** shipping is in-process best-effort (batched, retried, then dropped) and
  crash traces / uncaught exceptions no longer reach BetterStack — they remain in Railway's native
  explorer only. Crash detection is therefore covered by a **BetterStack absence/heartbeat alert**
  (no logs from a bot for N minutes) rather than by shipping the trace itself. There is no clean
  flush seam on process exit, so a few batched lines may be lost on shutdown.
