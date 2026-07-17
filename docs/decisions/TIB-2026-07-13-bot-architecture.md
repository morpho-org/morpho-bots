# TIB-2026-07-13: Off-chain bot architecture — one-shot op pipeline, per-chain daemons, monorepo shape

| Field             | Value                                                                                                                                                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**        | Superseded                                                                                                                                                                                                                                                            |
| **Date**          | 2026-07-13                                                                                                                                                                                                                                                            |
| **Author**        | @hayden                                                                                                                                                                                                                                                               |
| **Scope**         | Repo-wide                                                                                                                                                                                                                                                             |
| **Supersedes**    | TIB-2026-07-09-cli-restructure, TIB-2026-07-09-extract-bot-kit-and-swaps, TIB-2026-07-09-pipeline-cli, TIB-2026-07-10-op-commands, TIB-2026-07-10-signer-agent, TIB-2026-07-11-queued-daemon, TIB-2026-07-12-repo-restructure, TIB-2026-07-13-log-correlation-context |
| **Superseded by** | TIB-2026-07-16-revert-to-bots-as-programs                                                                                                                                                                                                                             |

---

> **Superseded (2026-07-16).** The architecture below was built in stacked PRs, ran for ~a week, and
> was reverted before production ever migrated off the pre-restructure image. The repo is back to
> standalone long-running bots on `@repo/bot-kit`. This TIB is retained as the historical record of
> what was tried and why; see
> [TIB-2026-07-16-revert-to-bots-as-programs](./TIB-2026-07-16-revert-to-bots-as-programs.md) for the
> reversal, what was kept, what was dropped, and what was re-embedded in adapted form.

## Context

Both liquidation bots began as long-lived Railway processes: `main()` wired config from env, built
a protocol pipeline, and handed it to a block-watcher + runner loop, with **all** operational state
(pending-tx queue, backoff, nonce cursor, caches) held in process memory and lost on every restart.
The two bots were copy-pasted-then-specialized from each other — ~27 near-identical `src/` files —
so every fix landed twice, and there was no shared transaction manager, signer, or wire format
between them.

Three forces broke that shape:

- **Modularity as the bot count grows.** The roadmap adds behaviors well beyond the two liquidators
  — dead-oracle market removal, vault ops, Allocator reallocation, a kill-switch revival. Two
  monolithic apps that each own a runner cannot share infrastructure; the logic has to become
  **composable libraries** plus shared daemons that a new bot _assembles from_, rather than a
  monolith it forks. This is the load-bearing motivation — the pipeline, the shared queue/signer
  daemons, and the `packages/` split all exist to make the next bot cheap.
- **No operator story outside Railway.** Running a bot locally against a new chain meant reproducing
  a container environment by hand.
- **Backstop posture.** Both bots are **non-competitive ecosystem-backstop liquidators** —
  "reliability over latency, must not win races" — so the block-driven reactivity the persistent
  runner existed to provide bought nothing. Midnight's post-maturity LIF ramps over ~60 minutes; a
  ~2-second poll cadence sits inside every deadline these bots actually face.

The bots were rebuilt, in stacked PRs, into a UNIX pipeline of one-shot **op commands** feeding two
long-lived daemons.

## Goals / Non-Goals

**Goals**

- **One operator entrypoint, no bespoke supervisor.** A `morpho-bots` CLI is the only way to run
  bots; persistence is plain unix loops/cron.
- **Bot logic as composable libraries.** Each bot core is a set of one-shot ops with zero
  process-lifecycle opinions; a new bot composes the shared daemons, wire format, and libraries
  rather than forking a monolith.
- **Opportunities as inspectable data.** On-chain opportunities flow as JSON Lines on stdout —
  `jq`-able, pasteable, pipeable.
- **One transaction manager per chain, one key-holder behind policy.** A single per-chain daemon
  owns the nonce cursor and broadcast; a single agent holds the signing key behind a default-deny
  policy.
- **Durable-but-reconciled cross-tick state**, so a memoryless per-tick process can still fee-bump a
  stuck transaction.
- **A monorepo layout that tracks one axis** — run it / import it / ship it.

**Non-Goals**

- **Competitive latency.** The backstop posture is a feature; the poll cadence is not a compromise
  to optimize away.
- **Liquidation-strategy changes.** This arc is process-model and repo shape; eligibility, sizing,
  quoting, and encoding are unchanged. (The one strategy change of the period is the separate
  Midnight venue TIB.)
- **Prod migration choreography.** Standing decision throughout: _build the system we want, migrate
  later._ Railway kept running the pre-restructure image; cutover is a post-merge runbook, not part
  of this work.
- **A log-aggregation story.** Deferred; the generic stdout data plane is designed for it, but it is
  not built here.

## Proposed Solution

Nine decisions, each stated as the current shipped behavior plus the rationale that must survive.

### 1. Process model — one-shot, poll-and-pipe

Every command is **one shot**: load config, do one unit of work, emit, exit. Persistence is unix
primitives — `while true; do … ; sleep 2; done` or cron — not a supervisor.

**Exit codes are a contract:** `0` = done or lock-skip (continue), `1` = transient error (continue;
next tick retries), `2` = config/usage/wire-version error (**stop** — a loop that re-runs on exit 2
turns a typo into a silent crash-loop). Per-transaction failures are structured stderr logs, never
exit codes, so exit 1 keeps its precise meaning ("the stage didn't run").

Cross-tick state is a **hint**, reconciled against chain truth at the start of each run (nonce via
`getTransactionCount`, receipt checks). Losing the state file degrades to restart semantics — never
a wrong nonce. This inverted the original "no persisted queue state / chain truth wins" position:
it is **required** by the one-shot model, because a per-tick process with no memory of its pending
transactions could never fee-bump a stuck one, and a stuck nonce blocks the whole stream.

### 2. Monorepo shape — run it / import it / ship it

Top level answers exactly one question per tier:

- **`apps/`** — independently runnable programs, all **leaves** of the dependency graph (no app
  imports another app). `apps/cli` (`@repo/cli`, bin `morpho-bots`), `apps/queued` (`@repo/queued`,
  bin `morpho-queued`), `apps/signer` (`@repo/signer`, bin `morpho-signer`).
- **`packages/`** — libraries: the bot cores plus the shared layers (below).
- **`deploy/`** — deployment packaging. `@repo/deploy` holds the single bot Docker image (which
  AOT-builds the CLI), the pipeline entrypoint loop, docker-compose files, and Railway scripts.
  `deploy/blue-rindexer` is a **non-workspace** artifact (Dockerfile + `rindexer.yaml`) that indexes
  Morpho Blue `Borrow` events into Postgres for blue's discovery.

_Why this axis:_ the layout went through `uis/` → `interfaces/` → `tools/`+`services/`+`bots/`
before settling. The tools-vs-services split sorted by **process shape**, which mis-filed two
structurally identical daemons (`signer`, `queued`) into different tiers and mixed a workspace
daemon with a non-workspace deploy artifact under `services/`. Run/import/ship is the single axis
that resolves all of it; extracting `@repo/signer-client` (below) is what lets the "apps are leaves"
invariant hold.

### 3. The pipeline — ops are source XOR transform; commands **are** op names

A domain (`blue` | `midnight`) exposes a **flat set of ops**. Each op is EITHER a **source** (emits
transparent position JSON) XOR a **transform** (position JSON → transaction JSON) — never both, so a
behavior's two stages are two separately-named, independently-spawnable commands. The command name
**is** the op name; there are no `sense`/`act` verbs. Liquidation is the source
`unhealthy-positions` plus the transform `liquidate`. The prod pipeline:

```
morpho-bots <domain> unhealthy-positions | morpho-bots <domain> liquidate | morpho-queued submit
```

**Caller-owned composition (exogenous).** Which ops run, and how often, is the invoker's business —
several ops means several loop lines. There is no `autonomous` flag and no run-all mode, so an op
added to a core cannot silently change what prod runs. Ops **dispatch at runtime** from each core's
`OPS` table; the CLI keeps no duplicate manifest.

_Why op-names, not verbs:_ once op names are globally unique within a domain, a verb only restates
the kind the name already implies. _Why domain-first_ (`blue unhealthy-positions`, not the reverse):
the op **is** domain code — the domain selects the protocol package, config merge, id codec, and
policy — so the domain is the stronger namespace and reads left-to-right as a pipeline. (Both
choices were validated against an external second opinion at the author's request.)

### 4. Wire contract — transparent JSON Lines; stdout is data, stderr is logs

**stdout carries JSON Lines; ALL logs go to stderr, unconditionally.** stdout is the data plane
everywhere; there is no dual-mode logger. Non-actions and failures are structured stderr logs, not
stdout records.

Records are **transparent, additive JSON**. A position record carries explicit `marketId` and
`borrower`; Blue positions additionally carry the **complete immutable market parameters** — the
hash preimage of the `marketId`, so the transform can cryptographically verify them
(`marketId(params) === suppliedId`) instead of re-reading them from chain.

The correlation id is `${domain}:${op}:${chainId}:${marketId}:${borrower}` and is
**correlation-only**: transforms validate their semantic inputs, tolerate additive fields, re-read
mutable chain state, and **never parse the `id`**. Only the two-segment `<domain>:<op>:` prefix is
generic; the suffix is domain-owned and opaque.

This is enforced by the **perishability doctrine**: opportunity data is second-scale perishable
(lens snapshots, deadline-free aggregator calldata that goes stale in seconds, a post-maturity LIF
decaying per second). So transforms re-derive everything from semantic inputs, producer payloads are
advisory, and the "simulate the exact bytes you sign" gate lives with the broadcaster, not the
producer. Bigints ride as bare decimal strings (jq- and human-friendly); hex values stay `0x`.

### 5. The transaction queue — `apps/queued`, `morpho-queued`

`morpho-queued serve` is a long-lived, **per-chain, domain-agnostic** daemon. It **alone** owns
dedupe, re-simulation, fee policy, the nonce cursor, submit, and continuous settlement/RBF. The
chain is explicit (`--chain` / `CHAIN_ID`); one daemon owns exactly one chain's nonce cursor.

`morpho-queued submit` is a **keyless relay**: it streams transaction JSON directly over the
daemon's Unix socket and receives minimal acknowledgements. A running bot therefore needs **both**
the pipeline loop **and** a `serve` daemon. Queue state is **per-chain, never per-domain**, and
settlement lives in the daemon's journal.

_Why per-chain, not per-bot:_ the nonce cursor is a per-EOA-per-chain resource; two bots sharing one
EOA on one chain from two daemons is a second-cursor race. One daemon per chain makes the shared
cursor structural. _Why a daemon, not a one-shot sink:_ settlement detection and RBF run on a
continuous sweeper rather than being quantized to cron cadence, so a transaction that confirms
between ticks is acted on in seconds. There is **no one-shot fallback** — two submit paths drift,
and a silent fallback would hide a dead daemon behind apparently-working liquidations.

**Sign-what-you-simulate** survives the split as a structural invariant, not a timing assumption:
the daemon re-simulates the exact bytes it will sign, per record, at submit time, so a delayed,
replayed, or ad-hoc transaction line can never broadcast stale/reverting calldata. The ad-hoc path
is `echo '<tx line>' | morpho-queued submit`; there is deliberately no standalone `send` command and
no disk spool of unsent transactions (both are second-cursor / stale-replay hazards).

The daemon **holds no signing key**: when armed it requires a signer agent (`SIGNER_SOCKET`) and
**hard-rejects `LIQUIDATOR_PRIVATE_KEY`** (see §6). `--dry-run` runs the full pipeline and emits
`would_submit` **without ever constructing a signer or writing state** — a disarmed daemon resolves
no signer backend at all, so it cannot leak what it never read. Persisted state is
`QUEUE_STATE_VERSION = 3`: the pending transactions only, discarded (never migrated) on a version
mismatch.

### 6. The signing agent — `apps/signer`, `morpho-signer`

A distinct **one-chain / one-Executor** agent and the **sole key holder**. It is signatures-only:
the nonce cursor, RBF, gas estimation, and broadcast all stay with the queue. The agent does **not**
decode nested Executor calls.

It enforces a **default-deny policy** before every signature: it refuses to start without a valid,
non-empty policy file and signs iff at least one rule passes all its checks. The two load-bearing
checks are **`to == Executor`** and **`value == 0`**:

- The liquidator EOA holds **zero ERC20 approvals anywhere**, so accumulated profits on the EOA can
  only move via a transaction _to the token contract itself_ — which `to == Executor` forbids. This
  is what makes the check principal-protecting.
- ETH attached to an Executor call is **instantly stealable in-batch** via the generic Executor's
  arbitrary multicall, so `value == 0` closes that path.

Everything else — the `chainIds` allowlist, per-rule fee/gas ceilings, optional `maxDataBytes`, and
the outer Executor selector (`0x00000001`) — bounds gas-griefing. Zero value and the selector are
**non-configurable invariants**; after the agent signs, **the queue re-parses the returned raw
transaction, asserts every prepared field matches, and asserts the recovered sender equals the
handshake address before broadcast.** Communication is a versioned JSON-lines RPC (methods
`address`, `signTransaction`) over a Unix domain socket (`@repo/ipc`), the socket born `0600`.

The signing agent is **mandatory for a live daemon** — it is the only process that ever reads a
signing key (`SIGNER_PRIVATE_KEY`). Both `queued` and `signer` are configured only through
argv/environment, use one RPC topology, and **dry-run operation does not start or require the
signer.**

**v1 checks are structural only.** The agent validates the outer selector and a calldata-size
ceiling but does **not decode the nested Executor sub-calls**. Residual risk, stated explicitly: a
compromised client host can still get **arbitrary Executor multicalls** signed, bounded by chain /
`to` / `value` / fee / gas ceilings but not by calldata semantics. Closing this is the deferred
calldata-inspection work — a lint-grade decode, or the real anti-diversion control, agent-side
balance-delta simulation (which requires giving the agent its own RPC).

_Why in-house, not KMS/Web3Signer:_ the value is the **Morpho-specific policy**; a generic signer
makes that policy an external configuration language and brings a far larger surface for a bot that
needs one EOA and one checklist. _Why not a pipe stage:_ a signature binds the **nonce and fees**,
which are decided at broadcast/RBF time inside the queue — a stage would run before those exist. The
signer is a **callable capability** (like `ssh-agent`), not a stream transform.

### 7. Config and cross-tick state — `~/.morpho-bots` (`MORPHO_BOTS_HOME`)

`config.json` (non-secret, freely shareable) and `secrets.json` (`0600`, a **separate file by
decision** — the permission boundary sits on exactly the sensitive bytes). Both are keyed by
env-var names; the CLI flattens them into an env-shaped table layered under `process.env` with a
documented precedence. Missing files are non-fatal (prod stays env-only); a malformed file is exit 2. **Bot packages are banned from reading `Bun.env` directly** — env enters only through an op's
typed config, so the secret flow is auditable at one seam.

Files fall into three keying scopes. **Op caches** are per `(bot, op, chain)`
(`<home>/<bot>/cache/<op>-<chainId>.json`) — Midnight's venue-selector ladders and market
whitelist, Blue's immutable market params — and are **disposable and never gate transaction
validity** (corrupt or missing degrades to a rebuild). The **queue's** state, journal, lock, and
socket are per-**chain** (`<home>/queued/state-<chainId>.json`, `outcomes-<chainId>.jsonl`,
`locks/queued-<chainId>.lock`, `queued-<chainId>.sock`) — that state is the chain-reconciled hint
from §1. The **signer's** socket and policy are **global** (`<home>/signer.sock`,
`signer-policy.json`) — one agent serves all bots and chains. The pipeline ops themselves are
**lock-free** and safe to overlap; the only lock is the per-chain daemon's lifetime pid lock (a
second daemon on the same chain → exit 2).

### 8. Observability — cross-stage log correlation

A single logical decision is now spread across up to five OS processes (source, transform,
`submit`, `serve`, `signer`), each with its own stderr, interleaved in one container log. The
monolith answered "why didn't position X liquidate?" by reading one call stack; the pipeline
restores that with **joinable logs**:

- `createLogger(minLevel, base)` stamps **stage-bound** context — `level`/`event` always last so
  context can never overwrite them. Context is bound per stage to what that stage **legitimately
  owns**: ops bind `{ bot, op, chainId }`; `queued serve`/`submit` bind `{ chainId }`; the signer
  binds nothing (it is domain-agnostic and must not imply knowledge of markets/borrowers).
- The pipeline **`id`** is the join across **ops ↔ queue ↔ journal**. **`nonce`/`txHash`** is the
  join across **queue ↔ signer** — the signer never sees the `id`, so a signer rejection is
  correlated at the queue layer (which knows both), with no wire change and no leak of pipeline
  concepts into the signer.

Deferred: loop-level log aggregation (the BetterStack follow-up) and a single end-to-end harness
over the composed pipeline (today each stage is unit-tested in isolation).

### 9. Shared libraries — protocol-agnostic by invariant

The bot cores (`@repo/blue-liquidation`, `@repo/midnight-liquidation`) each export an `OPS` table.
Everything below them is protocol-agnostic and **never imports a bot's `Config`, lens types, or
pipeline shapes**:

- **`@repo/pipeline`** — the op seam (`ops.ts`: `Operation` = `SourceOperation | TransformOperation`
  discriminated on `kind: 'source' | 'transform'`, with one `run` field), wire records, position
  ids, simulation.
- **`@repo/evm-kit`** — deployless read client, revert decoding, JSON-lines logger.
- **`@repo/ipc`** — the Unix-socket JSON server (node builtins only).
- **`@repo/signer-client`** — the signer's client **and the shared bidirectional wire protocol**
  (including server-side framing helpers). Extracting it is what keeps `apps/` leaves: `apps/queued`
  imports this package, not `apps/signer`.
- **`@repo/swaps`** — venue-agnostic multi-venue quoting, routing, and selection (depends only on a
  structural `QuoteLogger`).
- **`@repo/home`** — the `~/.morpho-bots` layout (paths, config/state/lock/socket helpers).
- **`@repo/contracts`**, **`@repo/utils`**, **`@repo/typescript-config`**.

_History:_ this began as a two-package extraction (`@repo/swaps` + `@repo/bot-kit`) from two
copy-pasted bots, held to a **byte-equivalence** bar (extracted paths were verbatim moves or
optional-parameter supersets whose defaults reproduced each bot's behavior). `@repo/bot-kit` later
grew into four unrelated concerns in one manifest and was **dissolved along those boundaries** into
`pipeline` + `evm-kit` + `ipc`. One accepted impurity: **`pipeline → evm-kit` is a type-only edge**
(op signatures reference `Logger`); moving the logger into `pipeline` would force the signer and
queue daemons to depend on the liquidation pipeline just to log.

### Spawn cost — warm by construction

The deploy image **AOT-builds** the CLI to `dist/main.js` (`Bun.build`, lens bytecode baked in), so
prod spawns pay zero soltag/solc/transpile cost — the first and only exception to the repo's
source-run, no-build ergonomics, confined to the deployment artifact. Dev and test stay source-run.
Measured: ~0.05s per stage spawn from the built artifact versus ~0.44s under the old soltag preload.

## Considered Alternatives

Condensed from the eight superseded TIBs; each was seriously evaluated and rejected.

- **A persistent block-driven runner.** No latency payoff for a backstop liquidator, and it
  reintroduces the process-supervision and in-memory-state-loss problems the one-shot model removes.
  Unix loops and cron are the supervisor.
- **Verb-first grammar / fixed `sense`·`act` verbs / a required op positional.** Once op names are
  globally unique the verb is redundant; the domain is the stronger namespace.
- **A generic `(chain, wallet)`-scoped `queue` command.** Fee policy, decoding, and cooldown are bot
  **policy**, not neutral infrastructure; a generic queue turns that into a hidden control plane. The
  _wire contract_ stays generic, so a neutral queue remains possible later without an envelope
  change.
- **A per-bot queue daemon.** The nonce cursor is per-EOA-per-chain; per-bot recreates the
  second-cursor race that per-chain eliminates.
- **A thin client with a one-shot submit fallback.** Two submit paths drift (two re-sim gates, two
  fee policies); a silent fallback hides a dead daemon behind working liquidations.
- **A standalone `send` command / a disk spool of unsent transactions.** A second nonce cursor
  beside the live queue races replacements; durable storage of _unsent_ perishable calldata is the
  design's only stale-replay path.
- **An off-the-shelf remote signer (KMS, Web3Signer) / signing as a pipe stage.** The value is the
  Morpho-specific policy; and a signature binds nonce+fees that only exist at broadcast time, so the
  signer must be a callable capability, not a stream stage.
- **A dedicated `cores/` top-level tree.** A fourth top-level concept for no boundary gain — the
  import-direction invariant (shared packages never import bot shapes) holds regardless of placement,
  and the cores are libraries, so `packages/` is where they live.
- **One merged config file with secrets inline.** The `0600` boundary must sit on exactly the secret
  bytes, keeping `config.json` shareable.
- **One atomic restructure PR.** Unreviewable; stacked green PRs (moves, then boundary splits, then
  renames) match repo precedent and keep every intermediate state shippable.

## Assumptions & Constraints

- **Backstop posture; cadence ≈ block time.** The block-denominated stuck-detection knob
  (`STUCK_BLOCKS`) assumes roughly per-block observation — now upheld by the daemon's ~2s active
  sweep rather than loop cadence. Chains with very different block times need it retuned.
- **The liquidator EOA never grants ERC20 approvals** — an operational invariant enforced by humans.
  A single manual approval from the EOA silently voids the signer threat model.
- **One daemon per chain; all bots on that chain share one EOA** — a consequence is one fee ceiling
  per chain.
- **The signer's fee ceiling must be ≥ the queue's max fee**, or RBF bumps degrade to policy
  rejections — safe (nothing signs) but degraded (stuck txs stop being replaced).
- **Caches never gate transaction validity** — only latency and recall.
- **Prod keeps running the pre-restructure image** until the deploy scripts are re-run (post-merge
  runbook); nothing here self-deploys. Railway service variables (e.g. `RAILWAY_DOCKERFILE_PATH`)
  live outside the repo and must be updated on cutover.

## Future Considerations

- **Loop-level log aggregation** (BetterStack) — more pressing now that each tick is several
  short-lived processes; includes migrating any queries off the retired `sense.*`/`act.*` event names
  and the queue's old `label` field to the current `source.*`/`transform.*` events and `id`.
- **Signer calldata modules** — the balance-delta-simulation module is the real anti-diversion
  control and the trigger for giving the agent its own RPC.
- **Non-liquidation ops already on the roadmap** — dead-oracle market removal, vault ops, kill-switch
  revival, and an Allocator reallocation bot (the first planned non-liquidation consumer of the
  signer policy seam). Each is a new op, additive to this surface.
- **Uniswap as a rankable swap venue** via a quote-shim service — see the Midnight venue TIB.

## Superseded TIBs

This decision supersedes the following (full text in git history); each is where a piece of the
architecture above originated:

1. **TIB-2026-07-09-cli-restructure** — one-shot processes, unix-loop supervision, the 0/1/2 exit
   contract, `~/.morpho-bots` config/secrets merge, state-as-hint.
2. **TIB-2026-07-09-extract-bot-kit-and-swaps** — the first extraction (`@repo/swaps` + the former
   `@repo/bot-kit`) on a byte-equivalence bar; protocol-agnostic shared packages.
3. **TIB-2026-07-09-pipeline-cli** — decomposition into a pipeable data flow, the JSON-Lines data
   plane, stdout=data/stderr=logs, single-writer queue discipline, the sign-what-you-simulate gate,
   the AOT build.
4. **TIB-2026-07-10-op-commands** — commands **are** op names; source XOR transform; caller-owned
   composition; the `<domain>:<op>:` id prefix.
5. **TIB-2026-07-10-signer-agent** — the keyless queue behind a default-deny policy agent; the
   `to == Executor` / `value == 0` threat model.
6. **TIB-2026-07-11-queued-daemon** — the per-chain `serve`/`submit` split; continuous
   settlement/RBF; the settlement journal.
7. **TIB-2026-07-12-repo-restructure** — the `apps/`+`packages/`+`deploy/` tiers, the bot-kit
   dissolution, the `signer-client` extraction, and the end-to-end `sense`/`act` retirement.
8. **TIB-2026-07-13-log-correlation-context** — stage-bound logger context and the `id` /
   `nonce`·`txHash` join keys.

## References

- [TIB-2026-04-16: Bootstrap curator-bots](./TIB-2026-04-16-bootstrap-curator-bots.md) — tech-stack
  rationale and the env-only convention this arc amended for bot packages.
- [TIB-2026-05-28: Midnight liquidation bot — v0](./TIB-2026-05-28-midnight-liquidation-bot.md) and
  [TIB-2026-06-30: Blue liquidation bot — v0](./TIB-2026-06-30-blue-liquidation-bot.md) — the
  backstop-liquidator posture that makes the poll cadence acceptable, and the protocol pipelines this
  arc repackaged without changing.
- [TIB-2026-07-09: Midnight market whitelist and venue selection](./TIB-2026-07-09-midnight-market-and-venue-selection.md)
  — the one contemporaneous strategy change, kept separate.
- [CONVENTIONS.md](../CONVENTIONS.md), [CLAUDE.md](../../CLAUDE.md) — the living code-organization and
  architecture references this TIB backs.
