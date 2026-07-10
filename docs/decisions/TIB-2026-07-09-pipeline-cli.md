# TIB-2026-07-09: UNIX-pipeable CLI — `sense | act | queue`

| Field          | Value                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------ |
| **Status**     | Accepted                                                                                   |
| **Date**       | 2026-07-09                                                                                 |
| **Author**     | @hayden                                                                                    |
| **Scope**      | Repo-wide (`interfaces/cli`, both bot cores, `@repo/bot-kit`, `bots/`)                     |
| **Supersedes** | [TIB-2026-07-09-cli-restructure](./TIB-2026-07-09-cli-restructure.md) — command shape only |

---

## Context

[TIB-2026-07-09-cli-restructure](./TIB-2026-07-09-cli-restructure.md) (merged) made
`morpho-bots <bot> tick` the only way to run bots, but the tick stayed monolithic and bot-shaped:
one process discovers, plans, quotes, encodes, simulates, and broadcasts in a single opaque pass.
That shape hides the one thing an operator most wants to see and act on — the actionable
opportunity itself — and it hard-codes "liquidation" into the entrypoint, leaving no seam for the
non-liquidation sensors already on the roadmap (dead-oracle market removal, vault ops, kill-switch
revival). The tick's own dependency graph already factors cleanly at the injected `runTick` seams
(`discover` → `readLens`+`isLiquidatable` → `plan`+`quoteFor` → `encodeExec` → `simulate` →
`queue.submit`), so the decomposition is a repackaging of existing seams, not new strategy.

## Goals / Non-Goals

**Goals**

- **Opportunities as data.** A **sensor** (`<domain> sense`) emits actionable on-chain
  opportunities as JSON Lines on stdout — inspectable with `jq`, pasteable, pipeable — read-only,
  lockless, and secret-free.
- **Composable pipeline.** An **actor** (`<domain> act`) maps opportunity IDs to freshly simulated
  transaction records; a stateful **queue** (`<domain> queue`) signs, broadcasts, and manages
  replacement. Prod becomes the literal pipeline
  `morpho-bots blue sense | morpho-bots blue act | morpho-bots blue queue` in a bash loop.
- **A generic wire contract** (versioned JSON Lines envelope) so future non-liquidation sensors
  slot in without touching the transport.
- **Single-writer state discipline.** The queue is the sole holder of the signer key and the sole
  writer of queue/backoff state; sense and act are lock-free and safe to overlap.
- **Prod pays zero cold-start tax.** An ahead-of-time (AOT) bundle in the `bots/` packaging layer
  removes per-spawn soltag/solc/transpile cost, while dev/test keep the repo's source-run
  ergonomics.

**Non-Goals**

- **Migration / cutover.** Building the target system is the whole scope; the running Railway
  services keep running the old `tick` image untouched. "Build the system we want; worry about
  migration much later" (user decision). No parity harness, no stop-old-first choreography here.
- **A generic `morpho-bots queue`.** The queue command is bot-scoped by decision (see
  Alternatives); the _wire contract_ is generic, leaving a documented path to a generic queue
  later.
- **A `send` command or a disk spool of unsent txs.** Both rejected below; the ad-hoc path is
  `echo '<tx line>' | morpho-bots blue queue`.
- **Building the future sensors.** `severity` / `remediation` / `approvalRequired` / `dedupeKey` /
  `expiresAt` are reserved envelope fields, documented design-only; nothing is scaffolded.
- **A log-aggregation story.** Three processes per tick fragment the stderr stream even further;
  the BetterStack follow-up stays deferred.

## Current Solution

`interfaces/cli` exposes `init`, `blue tick [--chain]`, `midnight tick [--chain]`. Each `tick` is
one shot: `tickOnce(env, opts)` in the bot core runs the whole pipeline and returns `{ counters,
state }`; the CLI persists a single `<bot>/state/<chainId>.json` and exits under the 0/1/2 contract.
`@repo/bot-kit`'s `createLogger` routes `info`/`warn` to **stdout**. Every CLI spawn eagerly
imports solc + typescript via the soltag preload (~0.44s), and prod relies on a warm soltag cache
on the persistent volume to avoid recompiling the lens each tick.

## Proposed Solution

Decompose `tick` into three composable commands over the same bot cores. `tick` and the cores'
`tickOnce` / `runTick` are **deleted** — no test calls `tickOnce` (the fork suites already compose
stages by hand), and a kept composition would be a second, drift-prone wiring.

### Command grammar (domain-first)

```
morpho-bots
├── init                                     # scaffold ~/.morpho-bots (adds new state/cache dirs)
├── <domain> sense [--chain <id>]            # → opportunity lines on stdout; read-only, no lock, secret-free
├── <domain> act   [--chain <id>] [id...]    # stdin records/bare IDs or positional IDs → tx + outcome lines
└── <domain> queue [--chain <id>]            # stateful sink: tx/outcome lines → dedupe, re-sim, sign, broadcast, replace
```

`domain ∈ blue | midnight`. **Grammar is domain-first** (`blue sense`, not `sense blue`).
Verb-first fits only when the verb is one generic implementation parameterized by a resource
(`kubectl get pods`); here `sense` / `act` **are** domain code — the domain selects the protocol
package, config merge, ID codec, and policy — so the domain is the stronger namespace. Validated by
an external second opinion (GPT via codex) at the author's request. The pipeline reads naturally
left to right.

### Wire contract (JSON Lines on stdout; everything else on stderr)

**Envelope, all records:** `v` (int, starts at `1`; unknown → exit 2; additive fields never bump
`v`), `kind` (`opportunity` | `tx` | `outcome`), `id`, `domain`, `op` (`liq` today), `chainId`,
`at` (ISO-8601), `summary` (one human line — the `jq -r .summary` affordance).

- **ID convention:** `<domain>:<op>:<chainId>:<marketId>:<borrower>` — self-describing, pasteable
  into `act` bare, and the opaque dedupe label the queue uses (`Pending.label`). It reuses the
  `${marketId}:${borrower}` lensKey that already keys backoff, backpressure, and settled-cooldown.
  **ID parsing is domain-owned:** each core exports its ID codec; the envelope's separate
  `domain` / `op` / `chainId` fields are authoritative for routing, so generic code never parses
  the ID string and its shape can evolve under `v`.
- **Bigints are bare decimal strings on the wire** (matches the logger's choice, jq- and
  human-friendly); hex values stay `0x`-strings. This is _not_ the `{__bigint__}` tagging used in
  state files — actors never parse sensor numeric payloads (they re-derive from the ID), so a
  lossless round-trip is unnecessary. `{__bigint__}` stays in state files.
- **`kind:"opportunity"`** (sense): emitted only for actionable items (post-lens, liquidatable).
  Its `data` payload is domain-owned and **advisory/diagnostic — never consumed by `act`**.
- **`kind:"tx"`** (act): `{...envelope, to, data, value?, simulated:{status:"ok", block}}`,
  emitted only after a fresh in-process re-derivation (lens → plan → quote → encode → simulate)
  succeeds. `simulated` is **advisory** (act's early filter plus observability); the authoritative
  gate lives in the queue. **No fee fields** — fees are queue policy, computed at broadcast
  (`initialFees(getBaseFee(), maxFeeWei)`) and re-derived on bumps. Bad-debt realizations are
  ordinary tx records (the `summary` marks the mode).
- **`kind:"outcome"`** (act + queue): first-class stdout records —
  `{...envelope, status, reason?, block, txHash?, nonce?}`. Act statuses: `not_liquidatable`,
  `no_swap_path`, `quote_failed`, `backoff_skipped`, `sim_reverted`, `skipped_inflight`, `bad_id`.
  Queue statuses: `submitted`, `deduped_inflight`, `confirmed`, `reverted`, `dropped`. Transient
  infrastructure failures are **not** outcomes — they are stderr logs plus exit 1, as today.
- **Per-stage IO matrix** (no untyped dumping ground; unknown `kind` or wrong domain →
  deterministic warn + skip):

  | Stage | Accepts on stdin                                          | Emits on stdout |
  | ----- | --------------------------------------------------------- | --------------- |
  | sense | —                                                         | `opportunity`   |
  | act   | `opportunity` (matching domain), bare IDs, positional IDs | `tx`, `outcome` |
  | queue | `tx` (submit), `outcome` (backoff), ignores `opportunity` | `outcome`       |

- **Record types live in `@repo/bot-kit`** (new `src/records.ts`) — imported by both cores and the
  CLI. To keep bot-kit free of bot shapes, the envelope types `op` and `status` as open `string`;
  each core exports its own narrowed literal unions (`'liq'`, `'quote_failed'`, …). The status
  vocabularies above are core-owned, not bot-kit-owned.
- **Streaming:** line-buffered emit as records exist; `act` processes stdin incrementally so
  `queue` starts submitting before `act` finishes. EPIPE is verified benign — Bun neither raises
  nor dies on closed-pipe stdout writes, so `sense | head -1` is clean and needs no handling.

**Example records** (Base / blue; 32-byte marketId, calldata, and txHash elided with `…`):

```jsonl
{"v":1,"kind":"opportunity","domain":"blue","op":"liq","chainId":8453,"id":"blue:liq:8453:0x3a85…f1a2:0x9f8c1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f","at":"2026-07-09T18:22:04.113Z","summary":"blue liq 0x9f8c…7e8f WETH/USDC — HF 0.972, seize 0.831 WETH for 1840 USDC","data":{"collateralToken":"0x4200000000000000000000000000000000000006","loanToken":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","seizableCollateral":"831244190000000000","repayAssets":"1840320000"}}
{"v":1,"kind":"tx","domain":"blue","op":"liq","chainId":8453,"id":"blue:liq:8453:0x3a85…f1a2:0x9f8c1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f","at":"2026-07-09T18:22:04.610Z","summary":"blue liq 0x9f8c…7e8f — repay 1840 USDC, swap seized WETH via 1inch","to":"0x5eF2c1B0aA43dC9f27E5aD11b4c8F3a09D6e7c81","data":"0x…","simulated":{"status":"ok","block":18342771}}
{"v":1,"kind":"outcome","domain":"blue","op":"liq","chainId":8453,"id":"blue:liq:8453:0x3a85…f1a2:0x9f8c1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f","at":"2026-07-09T18:22:06.902Z","status":"submitted","block":18342772,"txHash":"0x…","nonce":312}
```

### State, locks, backoff (single-writer discipline)

| path (under `MORPHO_BOTS_HOME`)                                                  | writer                                                                | readers         | lock                    |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------- | ----------------------- |
| `locks/<bot>-<chainId>.lock`                                                     | `queue` (wx-create, dead-pid steal, held → exit 0 + drain/drop stdin) | —               | is the lock             |
| `<bot>/queue/<chainId>.json` = `{version, queue, backoff}`                       | `queue` only (atomic tmp+rename)                                      | `act` read-only | queue's                 |
| `<bot>/cache/sense-<chainId>.json` (blue: marketParams; midnight: listedMarkets) | `sense`, best-effort                                                  | `sense`         | none (last-writer-wins) |
| `<bot>/cache/act-<chainId>.json` (midnight: venueSelector ladders/decimals)      | `act`, best-effort                                                    | `act`           | none (last-writer-wins) |
| `<bot>/state/<chainId>.json`                                                     | **deleted** (version-gated discard ⇒ no migration)                    | —               | —                       |

- **Queue-file versioning:** a CLI-owned `QUEUE_STATE_VERSION` constant (the queue is not a
  `DomainAdapter`, so core-exported state versions do not apply), bumped when
  `PendingQueueState` / `BackoffState` shapes change, with the same version-gated-discard semantics
  as today.
- **Backoff ownership.** `act` _filters_ via `shouldSkip` against a read-only load of the queue
  state file (atomic writes ⇒ never torn; ≤1-tick stale is fine — it only saves quotes/sims) and
  emits `outcome` records for failures; **`queue` records and clears backoff** from those records,
  keeping a single stateful writer. Explicit status → backoff mapping (mirrors today's `runTick`):
  **record** on `quote_failed` and `sim_reverted`; **ignore** `not_liquidatable`, `no_swap_path`,
  `backoff_skipped`, `skipped_inflight`, `bad_id` (recording `no_swap_path` would permanently
  suppress unconfigured pairs); **clear** only when a submit actually entered `pending` — a
  behavior fix versus today, which clears even when the send silently failed. Attempt counts keep
  persisting (the 1inch 1-RPS 429 defense).
- **Inflight backpressure.** `act`'s read of `pending ∪ cooldown` labels is advisory; **`queue` is
  authoritative** — it dedupes every incoming tx label against live `inflightLabels()` and emits
  `deduped_inflight`. Settled-cooldown re-fire protection is preserved.
- **Caches persist and are disposable.** Midnight's venue ladder (~10 rate-limited 1-RPS probes per
  pair) and listedMarkets (fail-closed max-age: stale ⇒ empty ⇒ sense emits nothing) cannot be
  rebuilt per 2s spawn; blue's marketParams are immutable. Caches may affect latency and recall,
  **never transaction validity** — corrupt/missing degrades to rebuild.
- **Concurrency.** sense/act are lock-free and safe to overlap; two queues → the second exits 0
  (lock-skip) and drops its stdin, acceptable because lines are derived, perishable data recreated
  ≤2s later.
- **Nonce & key custody.** Nonce handling is unchanged — the signer cursor is in-process, re-synced
  from `getTransactionCount('pending')` when the queue is empty. **`queue` is the sole holder of
  the signer private key.** `act` still receives venue API keys (0x/1inch) via the merged env
  (quoting needs them); `sense` is genuinely secret-free.

### Queue re-simulates before first broadcast

The invariant is **"the broadcaster simulates the exact bytes it signs."** It must hold
structurally, not by pipeline-timing assumption — that is what makes delayed, replayed, and ad-hoc
tx lines safe. It is cheap: `simulateLiquidationExec` needs only
`{executooor: record.to, eoa: signer.address, data: record.data}`, all present in the record plus
the signer, i.e. one `eth_call` per incoming tx. A sim-revert at the queue yields a `sim_reverted`
outcome plus a backoff record and no broadcast. Replacement rebroadcasts (fee bumps) keep today's
semantics — same bytes, drop on `reverts_on_replace`, no re-sim. (Adopted from the second opinion,
reversing an earlier draft that trusted act's advisory `simulated`.)

**Queue run order:** acquire lock → load state → read stdin to EOF (TTY stdin → skip read,
maintenance-only) → record outcomes → dedupe → re-simulate + submit each (one cached `getBaseFee`
per batch) → `onBlock(head)` → persist → release. Empty stdin still runs maintenance — **the queue
is the heartbeat.** Upstream failure surfaces as EOF, and maintenance still runs, which is strictly
better than today, where a discovery failure aborts the tick before `pendingOnBlock`.

### Core packages: split `tickOnce` → `senseOnce` / `actOnce`

`runTick` splits at its existing seam: `discover` + `readLens` + eligibility → `runSense`;
`readLens` + `plan` + `quote` + `encode` + `simulate` → `runAct`. New public exports per core:
`loadConfig`, `senseOnce(env, opts)`, `actOnce(env, ids, opts)`, `SENSE_STATE_VERSION` /
`ACT_STATE_VERSION`, and config/record types. Cores emit through an injected `emit` callback and
never touch stdout/stderr directly (the module-boundary and env-table rules from the restructure
TIB are unchanged). The CLI's `ADAPTERS` registry becomes
`DOMAINS: Record<DomainName, () => Promise<DomainAdapter>>` exposing `sense` / `act` /
`validateConfig` plus state versions. **`queue` is not a `DomainAdapter`** — the CLI wires
`createSigner` + `createPendingQueue` from bot-kit directly, with midnight's revert decoder and
cooldown supplied via a tiny per-domain queue-policy record (no lens/soltag exposure).

### Logging & spawn cost

- **Logger flip** (`packages/bot-kit/src/logger.ts`): ALL levels → **stderr**, unconditionally (no
  dual-mode trap). **stdout is the data plane everywhere.** `tick.end` counters become per-stage
  `sense.end` / `act.end` / `queue.end` stderr summaries. This reverses the restructure/extract
  logger surface, which routed `info`/`warn` to stdout.
- **Prod: AOT build, no `warm` step.** The soltag preload's `onLoad` transform has the same plugin
  interface `Bun.build` uses, blue's Postgres client is Bun's built-in `SQL` (no native deps), and
  the registry's dynamic imports are static-string — so the CLI bundles cleanly. Extract the
  transform into a shared plugin **factory** used by both the runtime preload and a new `@repo/cli`
  `build` script (`Bun.build`, target `bun`, entry `src/main.ts` → `dist/main.js` with lens
  bytecode baked in). The Dockerfile runs the build as a layer; the entrypoint invokes
  `bun dist/main.js`, so prod spawns pay zero soltag/solc/transpile cost. "Warm by construction."
- **Dev/test stay source-run** (`bun src/main.ts`, `bun test` with preloads); the `bin` keeps
  pointing at `src/main.ts`. As cheap QoL, the preload moves the `soltag/unplugin` import (which
  statically pulls in solc + typescript, the ~0.44s) into `onLoad` behind the disk-cache check, so
  warm local spawns skip it too.

### Entrypoint (`bots/docker-entrypoint.sh`)

`#!/bin/sh` → `#!/bin/bash` (the Debian base has bash) for `PIPESTATUS` — a plain pipe reports only
the last stage's code, and `pipefail` reports only the aggregate. Loop body:

```bash
bun dist/main.js "$BOT" sense | bun dist/main.js "$BOT" act | bun dist/main.js "$BOT" queue
codes=("${PIPESTATUS[@]}")
# any stage exit 2 → loop.fatal to stderr, exit 2 (crash the container visibly)
# any other nonzero → sleep and re-loop (transient)
```

Optionally `timeout` the pipeline at a multiple of `TICK_INTERVAL_S` so a hung stage cannot starve
queue maintenance. The per-process 0/1/2 exit contract is unchanged (0 done/skip, 1 transient, 2
config/usage/wire-version); per-tx failures are outcome records, not exit codes, so exit 1 keeps
its meaning ("the stage didn't run").

### Implementation Phases (PR ladder)

Rapid-iteration mode; `main` stays green each step. (Implementation subagents run with
`model: opus`, per user instruction.)

- **PR0 — this TIB.**
- **PR1 — `feat(bot-kit): add wire records, route all logs to stderr`:** `records.ts`
  (open-string `op` / `status`), the logger flip (including rewriting `createLogger`'s JSDoc, which
  documents the old stdout routing), and the backoff-clear-on-actual-pending fix. Existing
  log-based tests updated.
- **PR2 — `refactor(packages): split bot cores into senseOnce/actOnce`:** both cores; delete
  `tickOnce` / `runTick`; port tick tests to `runSense` / `runAct`.
- **PR3 — `feat(cli): add sense/act/queue commands, delete tick`:** `DomainAdapter` registry, the
  new state/lock partition + `QUEUE_STATE_VERSION`, `init` updates, the shared soltag plugin
  factory + lazy preload + `build` script.
- **PR4 — `feat(bots): add pipeline entrypoint and aot build layer`:** the bash `PIPESTATUS` loop,
  the Dockerfile build layer + `dist/main.js` CMD, compose/README/deploy-script env updates.
- **PR5 — `docs(conventions): document stdout-data/stderr-logs and wire contract`:**
  `CONVENTIONS.md` (the stdout=data / stderr=logs rule, wire-contract conventions, and replacing
  the stale `tickOnce` reference in the Configuration section with `senseOnce` / `actOnce`);
  the `CLAUDE.md` architecture bullet; this TIB flipped to Accepted with measured pipeline latency.

## Superseded & Amended Decisions

1. **Command shape (`<bot> tick`, `tickOnce` / `runTick`) → `sense` / `act` / `queue`,
   `senseOnce` / `actOnce`.** This supersedes the command surface of
   [TIB-2026-07-09-cli-restructure](./TIB-2026-07-09-cli-restructure.md) while **preserving its
   foundations**: one-shot processes, unix loops as the supervisor, state-as-hint reconciled
   against chain truth, the 0/1/2 exit contract, the `~/.morpho-bots` file/env config merge, and
   `MORPHO_BOTS_HOME`. That TIB's pending acceptance criteria (the Railway cutover and PR3 latency
   measurement) are mooted by this supersession; it remains **Proposed** as a historical record.
2. **Logger stdout routing → all-stderr.** The restructure and
   [extract](./TIB-2026-07-09-extract-bot-kit-and-swaps.md) TIBs kept `createLogger` routing
   `info` / `warn` to stdout. That is reversed: all log levels go to stderr, because stdout is now
   the JSON-Lines data plane.
3. **No-build philosophy → first exception (prod-only).** The
   [bootstrap TIB](./TIB-2026-04-16-bootstrap-curator-bots.md)'s source-run, no-build ergonomics
   gain their first exception: a prod-only AOT `Bun.build` bundle in the `bots/` packaging layer.
   Dev and test stay source-run; the exception is confined to the deployment artifact and replaces
   the restructure TIB's "soltag cache must be warm" assumption with "warm by construction."

## Considered Alternatives

### Alternative 1: Verb-first grammar (`sense blue`, `act blue`)

Make `sense` / `act` / `queue` the top-level verbs, parameterized by a domain argument.

**Why rejected:** Verb-first fits only when the verb is a single generic implementation
parameterized by a resource (`kubectl get pods`). Here `sense` and `act` **are** domain code — the
domain selects the protocol package, config merge, ID codec, and policy — so the domain is the
stronger namespace and reads better in help, completion, versioning, and future TUI integration.
Confirmed by an external second opinion at the author's request. Per-stage standalone binaries were
rejected for the same reasons.

### Alternative 2: A generic `(chain, wallet)`-scoped `morpho-bots queue`

One neutral queue command that any domain pipes into, parameterized only by chain and wallet.

**Why rejected:** "Aesthetically appealing and operationally dangerous" (the second opinion). Fee
policy, settled cooldown (`=20` midnight / `0` blue), revert decoding, `SEND_RPC_URL`, and backoff
are bot **policy**, not neutral infrastructure; a generic queue forces that policy onto flags or
into the wire records — a hidden control plane. Instead the queue is a bot-scoped command over the
shared generic engine (`bot-kit`'s `createPendingQueue`), with policy resolved via the existing
`mergedEnv(home, bot, chain)`, and deployment is already one container per `(bot, chain)` with its
own key. The **wire contract stays generic**, so a future generic queue is consumable-lines plus a
state-version bump plus `domain:`-prefixed labels (see Future Considerations).

### Alternative 3: A standalone `send` command

A stateless fire-and-forget sender for ad-hoc transactions, alongside the queue.

**Why rejected:** A second nonce cursor beside the live queue is a hazard — it races replacement
txs and forfeits stuck-detection, fee-bump, and cooldown. The ad-hoc path is instead
`echo '<tx line>' | morpho-bots blue queue`; raw sends are `cast send`.

### Alternative 4: Disk-spool of unsent txs + independent queue drainer

Persist unsent tx records to disk and have the queue drain the spool independently of the pipe.

**Why rejected:** Durable storage of _unsent_ perishable calldata is the design's only stale-replay
path — the one place a signed-then-broadcast record could diverge from current chain state. The
queue's line-oriented stdin keeps a spool possible later as just another producer if it is ever
actually wanted, at no cost now.

### Alternative 5: A `warm` cache-priming command

Add `morpho-bots warm` to compile the lens and prime the soltag cache before the loop starts.

**Why rejected:** In favor of the AOT build — a build layer that bakes the lens bytecode into
`dist/main.js` is "warm by construction," removing the cold-start cost structurally rather than
depending on a warm step having run and a cache dir surviving on the volume.

## Assumptions & Constraints

- **Perishability doctrine.** Opportunity data is single-block/second-scale perishable (lens
  snapshots, deadline-free aggregator calldata stale in seconds, midnight post-maturity LIF
  decaying per second). Therefore **actors re-derive everything from the ID**, sensor payloads are
  advisory, and the "simulate the exact bytes you sign" gate lives with the broadcaster, not the
  producer.
- **Block-denominated timings assume ~per-block cadence.** `STUCK_BLOCKS=4` and
  `SETTLED_COOLDOWN_BLOCKS=20` assume the pipeline runs roughly once per block; the three-process
  pipeline plus the built-artifact spawn cost must be **re-verified against measured pipeline wall
  time and recorded here before this TIB is accepted.** Chains with very different block times need
  these retuned.
- **State-file loss with a tx in flight is safe** — nonce re-sync
  (`getTransactionCount('pending')`) plus the queue re-simulation gate cover correctness; the only
  degradation is one tick of lost settled-cooldown protection.
- **Backoff attempt counts must persist across ticks** — resetting them would collapse the 429
  defense on 1inch's 1-RPS tier.
- **Caches never gate transaction validity** — they affect only latency and recall; a corrupt or
  missing cache degrades to a rebuild.
- **The old Railway services keep running the old `tick` image, untouched** — migration is out of
  scope, so nothing here is deployed until a separate, later effort.

## Observability

- **Three processes per tick fragment the stderr log stream** further than the single-tick model
  did. `sense.end` / `act.end` / `queue.end` per-stage summaries replace `tick.end`. The
  loop-level aggregation story (the BetterStack follow-up both liquidation TIBs mention) stays
  deferred.
- **Outcome records are a first-class observability surface** on stdout — `submitted` / `confirmed`
  / `reverted` / `dropped` / `deduped_inflight` from the queue, and the act-side skip reasons —
  greppable and `jq`-filterable independently of the stderr logs.
- **Per-process exit codes stay the operational signal** (0/1/2); any stage exiting 2 stops the
  loop visibly, and the queue exiting 0 on a held lock is the expected single-writer skip.
- **Build parity is a verification gate:** `dist/main.js` and `src/main.ts` must produce identical
  behavior on the exit-code matrix and one full pipeline run, guarding against bundler drift.

## Security

- **`queue` is the sole signer-key holder.** `sense` is genuinely secret-free (pipeable with zero
  key exposure); `act` receives only venue API keys (0x/1inch) via the merged env. The private key
  never enters the sense or act processes.
- **Single-writer + lock discipline preserved.** The per-`(bot, chain)` pid lockfile keeps exactly
  one queue writing state and broadcasting, the one-shot equivalent of single-process nonce
  discipline; a second queue lock-skips (exit 0) rather than racing.
- **Structural sign-what-you-simulate.** The queue re-simulates the exact bytes it signs, so a
  delayed, replayed, or ad-hoc tx line cannot broadcast stale/reverting calldata.
- **No new durable secret surface.** The rejected disk spool would have persisted unsent signed-
  intent calldata; keeping the pipe line-oriented avoids that stale-replay path.

## Future Considerations

- **Reserved envelope fields for non-liquidation sensors** (design-only, from a PM future-sensor
  review): `severity`, a `remediation` discriminator (`tx` | `none` | `multi-step`),
  `approvalRequired`, `dedupeKey`, and `expiresAt`. Motivating examples: a dead-oracle
  market-removal sensor (`remediation:"tx"`, high `severity`, a `dedupeKey` so one alert per
  market) and a kill-switch revival (`approvalRequired:true`, `remediation:"multi-step"`). Adding
  these is additive and does not bump `v`.
- **TUI as a sense consumer and approval surface.** The planned TUI reads `sense` output directly
  and becomes the human approval surface for `approvalRequired` opportunities — the reason the
  cores are libraries and the wire contract is generic.
- **Generic-queue migration path.** If a neutral `morpho-bots queue` is ever wanted, the wire
  contract already supports it: the work is consumable-lines handling plus a `QUEUE_STATE_VERSION`
  bump plus `domain:`-prefixed labels — no envelope change.
- **Log aggregation** — more pressing now that each tick is three short-lived processes; still the
  deferred BetterStack follow-up.

## References

- [TIB-2026-07-09: CLI restructure](./TIB-2026-07-09-cli-restructure.md) — the one-shot CLI and
  0/1/2 contract this TIB builds on; its command shape and logger-stdout routing are superseded
  here, its foundations preserved.
- [TIB-2026-07-09: Extract `@repo/swaps` and `@repo/bot-kit`](./TIB-2026-07-09-extract-bot-kit-and-swaps.md)
  — `createPendingQueue`, `createSigner`, `simulate`, backoff, and fee policy the queue command
  wires directly; its logger surface is amended by the stderr flip.
- [TIB-2026-04-16: Bootstrap curator-bots](./TIB-2026-04-16-bootstrap-curator-bots.md) — source of
  the no-build philosophy this TIB takes its first (prod-only) exception to.
- [TIB-2026-05-28: Midnight liquidation bot — v0](./TIB-2026-05-28-midnight-liquidation-bot.md),
  [TIB-2026-06-30: Blue liquidation bot — v0](./TIB-2026-06-30-blue-liquidation-bot.md) — the
  backstop-liquidator posture that makes the sleep-loop cadence and per-tick spawn cost acceptable.

## Addenda

### 2026-07-10 — accepted; measured latency

The ladder landed as PRs #38–#43 (TIB, bot-kit records + stderr logger, core split, CLI commands,
pipeline entrypoint + AOT build, this docs sweep). One sequencing deviation from the Implementation
Phases above: `tickOnce` survived PR2 as a deprecated thin composition (the CLI still imported it)
and was deleted in PR3 with the `tick` command, keeping `main` green at every step.

Measured latency (built `dist/main.js` artifact):

- Per-stage spawn: **~0.05s** in-container (`--help`), versus ~0.44s under the old soltag preload —
  the AOT bundle removed the cold-start tax as designed.
- Zero-work `queue` maintenance pass: **~0.09s**, with the zero-RPC fast path confirmed (an
  unreachable RPC URL is never dialed when stdin and the pending set are both empty).
- Full quiet tick (`midnight sense | act | queue`, live Base over a public RPC, zero liquidatable
  positions, fresh home so act paid its one-time startup check): **~1.7s wall** — sense ~1.5s
  (network-bound: discovery API + lens `eth_call`), stages overlapping in the pipe.

Block-cadence re-check (the acceptance gate in Assumptions): at `TICK_INTERVAL_S=2` the effective
cadence is sleep + wall ≈ 3.7s on a public RPC (faster on prod RPCs), i.e. ~2 Base blocks per tick.
`STUCK_BLOCKS=4` / `SETTLED_COOLDOWN_BLOCKS=20` are block-denominated (measured against
`submittedAtBlock` vs the observed head), so a slower tick delays bumping by at most one tick — the
documented and accepted behavior. No retuning needed.

### 2026-07-10 — command grammar and ID-parsing clause amended

[TIB-2026-07-10-op-commands](./TIB-2026-07-10-op-commands.md) amends two clauses of this TIB;
everything else stands. The fixed `sense` / `act` command surface becomes a flat namespace of
uniquely-named ops (each a source XOR transform; liquidation splits into the source
`unhealthy-positions` and the transform `liquidate`, with `queue` reserved). The
"generic code never parses the ID string" rule narrows to "the `<domain>:<op>:` prefix is the generic
part of the contract" — the suffix stays domain-owned and opaque. The internal `sense` / `act`
vocabulary and the `runSense` / `runAct` seams are preserved.

<!--
TIB conventions:
- Once accepted, do not substantively edit this TIB. If the decision needs to change,
  create a new TIB that supersedes this one and update the Status/Superseded by fields.
- Addenda may be appended to record operational updates that affect
  how the TIB is applied without changing the decision itself.
- TIB identifiers use CalVer (YYYY-MM-DD) based on the date the TIB was first drafted.
-->
