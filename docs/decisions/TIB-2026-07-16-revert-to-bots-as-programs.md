# TIB-2026-07-16: Revert to bots-as-programs

| Field          | Value                           |
| -------------- | ------------------------------- |
| **Status**     | Accepted                        |
| **Date**       | 2026-07-16                      |
| **Author**     | @hayden                         |
| **Scope**      | Repo-wide                       |
| **Supersedes** | TIB-2026-07-13-bot-architecture |

---

## Context

[TIB-2026-07-13-bot-architecture](./TIB-2026-07-13-bot-architecture.md) rebuilt both liquidators, in
stacked PRs, into a UNIX pipeline of one-shot **op commands** feeding two long-lived per-chain
daemons (`queued` + `signer`), with a transparent JSON-Lines wire contract, an `OPS` dispatch table
per bot core, and an `apps/` + `packages/` + `deploy/` monorepo shape. The load-bearing motivation
was to make the _next_ bot cheap: composable libraries plus shared daemons a new bot assembles from,
rather than a monolith it forks.

The pipeline shipped and ran for roughly a week. Three things became clear in that window:

- **Production never migrated.** The Railway deployments continued to run the pre-restructure image
  the entire time. The pipeline was never load-bearing in prod, so reverting it costs no operational
  migration.
- **The complexity bought little for two bots.** The wire contract, `OPS` seam, IPC layer, and two
  extra daemons (`queued`, `signer`) added a great deal of surface — sockets, framing, a keyless
  relay, a policy-signer process, `~/.morpho-bots` config/secrets merging, per-tick op caches with
  dump/restore — to serve a modularity goal that only pays off at a bot count we do not have yet.
  For the two backstop liquidators that exist, a long-running program with an in-process runner and
  queue is simpler to reason about, deploy, and debug.
- **The backstop posture never needed the extra machinery.** These are non-competitive,
  reliability-over-latency liquidators. A standalone program polling each block already meets every
  deadline they face; the daemon topology solved a problem the bots do not have.

The feature work that landed _on top of_ the pipeline (swap venues, unwrap seam, typed discovery,
cooldown, queue reconciliation, a signing policy guard, log forwarding) is genuinely valuable and
independent of the pipeline paradigm. So the decision is to revert the architecture while keeping
that progress.

## Goals / Non-Goals

**Goals**

- Return the repo to **standalone long-running bots** — each bot a single TypeScript program with a
  block-watcher + per-tick runner loop and an in-process pending-tx queue — at the pre-pipeline
  baseline (commit `f13d323`).
- **Preserve every feature backport** that is independent of the pipeline paradigm.
- Keep the intentionally-kept daemon-era _improvements_ (queue reconciliation, signing policy guard,
  in-memory cooldown) by re-embedding them in `@repo/bot-kit`, the shared bot runtime.

**Non-Goals**

- Re-litigate the modularity goal. When the bot count grows enough to justify shared daemons, that
  is a fresh decision with fresh evidence — not a reason to keep unused machinery now.
- Change any on-chain behavior, sizing math, or the Executor contract. This is an architecture
  revert plus feature preservation, not a behavior change.

## Current Solution

At acceptance the tree is already reverted and the backports already applied on
`refactor/revert-bots-as-programs`. The monorepo is:

- `/bots/` — one standalone program per bot (`blue-liquidation`, `midnight-liquidation`; `kill-switch`
  is a docs-only proposal). Each owns its `Dockerfile`, `docker-compose.yml`, and
  `scripts/deploy-railway.ts`.
- `/packages/` — `@repo/bot-kit` (shared runtime), `@repo/swaps`, `@repo/contracts`, `@repo/utils`,
  `@repo/typescript-config`.

## Proposed Solution

Revert to the bots-as-programs layout at `f13d323` and backport feature progress on top. Concretely:

### Kept — feature backports (independent of the pipeline)

- **Swap venues + unwrap seam** (swaps): LiFi venue (keyless; optional `LIFI_API_KEY` raises limits),
  a widened 1inch router for Robinhood's divergent deployment, the LiquidSwap venue (HyperEVM), the
  `SwapPlan` / `SwapStep` seam, and ERC-4626 + Pendle PT unwrappers auto-detected before the venue
  swap. Encoders rewritten for the plan/step shape. New env: `ENABLE_LIFI`, `LIFI_API_KEY`,
  `PENDLE_SLIPPAGE_BPS`.
- **Typed OpenAPI discovery client** (midnight): the markets/candidates discovery moved to a typed
  client; whitelist staleness is bounded by `LISTED_MARKETS_MAX_AGE_MS`.
- **Opt-in position-liquidation cooldown**: `POSITION_LIQUIDATION_COOLDOWN_MS` (default `0` =
  disabled), in-memory, via `bot-kit`'s cooldown store — complementary to the block-based backoff.
- **BetterStack log forwarding**: per-bot in-image Vector side-car, opt-in via
  `BETTERSTACK_SOURCE_TOKEN` + `BETTERSTACK_INGESTING_HOST`, byte-identical when disabled.
  _Subsequently replaced (same branch) by an in-process loglayer transport in `@repo/bot-kit`; the
  side-car, spool, and entrypoints were removed — see
  [TIB-2026-07-14-betterstack-log-forwarding](./TIB-2026-07-14-betterstack-log-forwarding.md)
  addendum "2026-07-16 — replaced the Vector side-car"._
- **Deploy CI repointed** at each bot's own `scripts/deploy-railway.ts` via a thin `DEPLOY_ONLY=1`
  mode (re-ship already-provisioned services without holding RPC/keys); no workflow references
  `deploy/` or `@repo/deploy` anymore.

### Re-embedded — daemon-era improvements, adapted into `@repo/bot-kit`

The queue/signer daemons are gone, but the good ideas inside them are worth keeping. They now live
in the shared runtime as plain in-process modules:

- **Reconciled queue state + journal**: the pending-tx queue gained a nonce-consumed reconciler (a
  `drop(nonce, reason)` seam plus a block-cadence sweep that evicts tracked txs whose nonce is
  consumed on-chain with no receipt), a `sendAborted` latch (a hashless claimed nonce is rolled back,
  not counted as submitted), and a balance metric. The queue also gained disk persistence (a versioned
  `state-<chain>.json` under `BOT_STATE_DIR`, reconciled on boot) and a terminal-outcome journal
  (`outcomes-<chain>.jsonl`).

  _2026-07-16 — persistence + journal removed. An external review found the persistence was a net
  liability: restored state was injected without boot-time reconciliation, `loadState` validated only
  JSON + version (semantically corrupt state crashed startup), shutdown snapshotted a pre-send state
  mid-broadcast, and no deployed service mounted a volume — so it never survived a redeploy anyway.
  Settlement audit is already covered by the structured `tx.*` log events (now shipped to BetterStack
  in-process via loglayer), so the file-based journal was redundant. Both were dropped: queue state is
  in-memory only and chain truth wins on restart. The reconciler, `drop()` seam, `sendAborted` latch,
  and balance metric are kept._

- **Default-deny signing policy guard** (`bot-kit/policy.ts`): every prepared transaction must target
  the configured Executor, call selector `0x00000001` (`exec_606BaXt`), carry zero value, and sit
  under fixed fee/gas/calldata-size ceilings — enforced before broadcast. Previously the `signer`
  daemon's job; now an in-process check, since the bot holds its own key again.

### Dropped — pipeline-only machinery

Deliberately removed because each solves a problem that exists only inside the pipeline paradigm:

- **Wire records / `OPS` tables / `@repo/ipc` / the `queued` + `signer` daemons** — the whole
  source→transform→relay→daemon topology. A single program with an in-process runner and queue needs
  none of it.
- **`id`-correlation logging** — the correlation label existed to stitch stdout JSON across separate
  op processes; one process logs its own tick end-to-end.
- **`LIQUIDATOR_ADDRESS` env** — the pipeline needed the liquidator address decoupled from the key
  (held only by the signer daemon); the reverted bot reads `LIQUIDATOR_PRIVATE_KEY` and derives it.
- **Per-tick op caches with dump/restore** — a memoryless per-tick process had to serialize hint
  state between invocations; a long-running process just holds it in memory.

## Considered Alternatives

### Alternative 1: Keep the pipeline and push through the production migration

**Why rejected:** The migration was never completed and the paradigm's payoff (cheap Nth bot) does
not materialize at two bots. Finishing the migration would spend more effort to lock in complexity
we have concrete evidence we do not need.

### Alternative 2: Revert the layout but drop the daemon-era improvements too

**Why rejected:** Durable queue state, the signing policy guard, and the cooldown are valuable on
their own and cheap to keep as in-process `bot-kit` modules. Throwing them out with the daemons would
regress operability for no benefit.

### Alternative 3: Keep the pipeline as an optional mode alongside bots-as-programs

**Why rejected:** Maintaining two runtime architectures doubles the surface with no user for the
second one. If daemons are justified later, that is a clean forward decision, not a permanent fork.

## Assumptions & Constraints

- Production continues running the standalone bots; there is no in-flight daemon deployment to drain.
- The bot count stays small enough that a shared-daemon topology is not yet warranted. If that
  changes materially, revisit with a new TIB.
- `@repo/bot-kit` remains the single home for shared runtime behavior, so a future third bot still
  assembles from libraries rather than forking a monolith.

## References

- [TIB-2026-07-13-bot-architecture](./TIB-2026-07-13-bot-architecture.md) — the pipeline architecture
  this reverts (now Superseded).
- [TIB-2026-04-16-bootstrap-curator-bots](./TIB-2026-04-16-bootstrap-curator-bots.md) — the original
  bots-as-programs scaffold and tooling stack this returns to.
- [TIB-2026-06-30-blue-liquidation-bot](./TIB-2026-06-30-blue-liquidation-bot.md),
  [TIB-2026-07-09-midnight-market-and-venue-selection](./TIB-2026-07-09-midnight-market-and-venue-selection.md)
  — the bot-level decisions the reverted programs implement.
- [TIB-2026-07-14-betterstack-log-forwarding](./TIB-2026-07-14-betterstack-log-forwarding.md),
  [TIB-2026-07-15-ci-deploy-pipeline](./TIB-2026-07-15-ci-deploy-pipeline.md) — the log-forwarding and
  deploy-CI surfaces re-pointed at the per-bot layout.

<!--
TIB conventions:
- Once accepted, do not substantively edit this TIB. If the decision needs to change,
  create a new TIB that supersedes this one and update the Status/Superseded by fields.
- Addenda may be appended to record operational updates that affect
  how the TIB is applied without changing the decision itself.
- TIB identifiers use CalVer (YYYY-MM-DD) based on the date the TIB was first drafted.
-->
