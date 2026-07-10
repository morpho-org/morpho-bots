# TIB-2026-07-09: Restructure into `uis/` + `services/` + `packages/` with a one-shot CLI

| Field      | Value                                                                |
| ---------- | -------------------------------------------------------------------- |
| **Status** | Proposed                                                             |
| **Date**   | 2026-07-09                                                           |
| **Author** | @hayden                                                              |
| **Scope**  | Repo-wide (new `uis/` + `services/` trees; `bots/*` become packages) |

---

## Context

Both liquidation bots run today as long-lived Railway processes: `main()` wires config from env,
builds the protocol pipeline, and hands it to `@repo/bot-kit`'s block watcher + runner, with all
operational state (pending-tx queue, backoff counters, venue rankings, market caches) held in
process memory and lost on every restart. Three forces push past that shape. First, there is no
operator story outside Railway — running a bot locally against a new chain means reproducing a
container environment by hand. Second, a friendlier operator front-end (a TUI) is planned, and it
needs the bot logic as **libraries**, not as apps that own their own process loop. Third, both
liquidation TIBs ([TIB-2026-05-28](./TIB-2026-05-28-midnight-liquidation-bot.md),
[TIB-2026-06-30](./TIB-2026-06-30-blue-liquidation-bot.md)) define these bots as non-competitive
ecosystem-backstop liquidators — "reliability over latency, must not win races" — so the
block-driven reactivity the persistent runner exists to provide buys nothing. Midnight's
post-maturity LIF ramps over 60 minutes; a two-second polling cadence is comfortably inside every
deadline the bots actually face.

## Goals / Non-Goals

**Goals**

- **One operator entrypoint.** A `morpho-bots` CLI is the only way to run bots — same command on a
  laptop and in prod; persistence via plain unix loops/cron, not a bespoke supervisor.
- **Bot cores as libraries.** Each bot exports a one-shot `tickOnce` consumable by multiple UIs
  (CLI now, TUI later) with zero process-lifecycle opinions.
- **Durable state across ticks.** Per-`(bot, chain)` state files carry the queue, backoff, and
  caches between one-shot invocations — treated as a hint, reconciled against chain truth.
- **File-based local config** (`~/.morpho-bots`) that layers under env, without breaking prod's
  env-only deployment.
- **Extract the rindexer service** out of `bots/blue-liquidation` into its own deployable unit.
- **Prod-safe migration**: a PR ladder in which every step is individually deployable and the
  Railway cutover never runs two funded liquidators on one key.

**Non-Goals**

- **Building the TUI now.** `uis/tui` is design-only in this TIB; nothing is scaffolded.
- **Building the Uniswap quoter now.** `services/uniswap-quoter` is design-only; this TIB records
  the exact `@repo/swaps` seams it will plug into.
- **Changing tick logic.** Eligibility, sizing, quoting, and encoding are untouched — this is a
  process-model and repo-shape change, not a strategy change.
- **Competitive latency.** The bots remain backstop liquidators; the sleep-loop cadence is a
  feature, not a compromise to be optimized away.
- **A log-aggregation story.** Per-tick processes fragment the log stream (see Observability);
  loop-level aggregation is deferred with the BetterStack follow-up both liquidation TIBs mention.

## Current Solution

`/bots/` holds two long-running apps. Each `src/index.ts` reads config from `Bun.env`, runs
startup checks, and enters `@repo/bot-kit`'s watcher + runner loop; venue API keys are read
directly via `Bun.env` in `index.ts`. All state is in-memory. `bots/blue-liquidation` also embeds
`rindexer.yaml` plus the abi/rindexer Docker stages for its discovery indexer.
Deploy-infra extraction was explicitly deferred by
[TIB-2026-07-09 (extract)](./TIB-2026-07-09-extract-bot-kit-and-swaps.md) Phase 4; this TIB is
that follow-up, grown into a repo restructure.

## Proposed Solution

The monorepo moves from `bots/` + `packages/` to **`uis/` + `services/` + `packages/`**:

```
curator-bots/
├── uis/
│   ├── cli/                    # @repo/cli — bin `morpho-bots`; the only way to run bots
│   └── tui/                    # DESIGN-ONLY, future
├── services/
│   ├── blue-rindexer/          # rindexer.yaml + Dockerfile, extracted from blue-liquidation
│   └── uniswap-quoter/         # DESIGN-ONLY, future
└── packages/
    ├── blue-liquidation/       # @repo/blue-liquidation — bot core as a library
    ├── midnight-liquidation/   # @repo/midnight-liquidation — bot core as a library
    ├── bot-kit/ swaps/ utils/ contracts/ typescript-config/
```

`bots/` is deleted at the end of the migration (after the Railway cutover).

### `uis/cli` — `@repo/cli`, bin `morpho-bots`

Built on **commander**. Commands: `init`, `blue tick [--chain]`, `midnight tick [--chain]`. Each
invocation is **one shot**: load config, run one tick, persist state, exit. Persistence is unix
primitives — `while true; do morpho-bots blue tick; sleep 2; done` or cron — not a supervisor.

**Exit codes are a contract:**

| Code | Meaning                 | Loop wrapper behavior                |
| ---- | ----------------------- | ------------------------------------ |
| 0    | tick done, or lock-skip | continue                             |
| 1    | transient tick error    | continue (next tick retries)         |
| 2    | config/usage error      | **stop** — never silently crash-loop |

A loop that keeps re-running on exit 2 turns a typo into an infinite silent crash-loop; wrappers
MUST stop on 2.

### Bot cores become libraries

`bots/blue-liquidation` → `packages/blue-liquidation` (`@repo/blue-liquidation`) and
`bots/midnight-liquidation` → `packages/midnight-liquidation`. Each exports:

```ts
tickOnce(env, { state?, runStartupChecks?, logger? }): Promise<{ counters, state }>
```

— today's `main()` minus the runner loop. **Why cores live under `packages/`:** they are now
libraries consumed by multiple UIs (CLI now, TUI later); a separate `cores/` or `lib-bots/` tree
would add a fourth top-level concept for no boundary gain. The actual module-boundary invariant —
`bot-kit` / `swaps` / `utils` never import bot shapes — is directional and unchanged by where the
bot packages sit.

### `~/.morpho-bots` (overridable via `MORPHO_BOTS_HOME`)

**Config + secrets.** `config.json` (non-secret) and `secrets.json` (`0600`, a **separate file by
deliberate decision** — the permission boundary sits on exactly the sensitive bytes, and
`config.json` stays freely shareable). Both are keyed by the **existing env-var names**, with
per-bot `defaults` and `chains.<id>` sections. The CLI flattens them into an env-shaped table fed
to the bots' unchanged `loadConfig(env)`. Precedence (later wins):

```
config.defaults → config.chains[id] → secrets.defaults → secrets.chains[id] → process.env → --chain
```

Missing files are non-fatal (prod stays env-only); a malformed file is exit 2.

**State files** — a "poor man's DB", one per `(bot, chain)`: bigint-safe stringify/parse from
`@repo/utils`, atomic tmp+rename writes, corrupt/missing → start fresh (chain truth wins).
Sections:

- **Pending queue**, including `settledAt` cooldown.
- **Backoff**, including attempt counts — resetting counts each tick would collapse the 429
  defense on 1inch's 1-RPS tier.
- Blue `marketParams` cache.
- Midnight `listedMarkets` whitelist — `updatedAt` plus a **fail-closed max-age**: if a refresh
  fails past max-age, the whitelist is treated as empty.
- Venue rankings and token decimals.

The state file is a **hint**, reconciled against chain truth at tick start
(`getTransactionCount('pending')` + receipt checks). A lost file degrades to today's restart
semantics — never a wrong nonce.

**Lockfile** — a pid lockfile per `(bot, chain)`, created with the `wx` flag. Live pid → skip,
exit 0. Dead pid → steal once with a loud log.

### `services/blue-rindexer`

`rindexer.yaml` + `Dockerfile` (the abi + rindexer Docker stages) extracted verbatim from
`bots/blue-liquidation`. Not a bun workspace — it is a deploy artifact, not a TS package.

### `services/uniswap-quoter` — design-only, future

A thin HTTP API exposing 0x/1inch-like **price + quote** endpoints wrapping Uniswap QuoterV2 and
routing. It exists so `@repo/swaps` can gain `priceUniswapV3` and Uniswap can join multi-venue
ranking. The adapter seams already exist; the exact integration points are:

- `packages/swaps/src/http-client.ts` — `VENUE_AUTH`'s `'uniswap-v3': () => ({})` arm (no-auth
  today; gains the quoter's auth shape if any).
- `packages/swaps/src/config.ts` — `VENUE_API_KEY_ENV`'s `'uniswap-v3': null` entry.
- `packages/swaps/src/quoting.ts` — `priceByVenue`'s `uniswap-v3` arm, which today throws
  `QuoteError('api_error', 'uniswap-v3 does not support indicative probing')`, stops throwing.
- `packages/swaps/src/quoting.ts` — `composeMultiVenueQuoting`'s `entryFor`, which today throws
  `'uniswap-v3 is not a multi-venue candidate'`, admits Uniswap as a candidate.

### `uis/tui` — design-only, future

A friendlier operator front-end over the same bot-core libraries and `~/.morpho-bots` files. Not
scaffolded now; its existence is why the cores are libraries and why config/state live in files.

### Implementation Phases (PR ladder)

- **PR0 — this TIB.**
- **PR1 — mechanical move.** Bot sources move to `packages/`; thin `bots/` wrappers keep prod
  byte-identical.
- **PR2 — additive state surface.** `dump()` / `initialState` on `createPendingQueue`,
  `createBackoff`, `createVenueSelector`, `createListedMarketFilter`,
  `createMarketParamsResolver`. Purely additive; nothing consumes it yet.
- **PR3 — `uis/cli` + `tickOnce`** (plus the bots' `runner/` → `tick/` rename). Tick latency is
  measured here and recorded in this TIB before it flips to Accepted.
- **PR4 — docker / rindexer service / deploy + Railway cutover.** Cutover discipline:
  - A parallel **unfunded-key parity service** compares `tick.end` / `plan.built` / `simulate.*`
    log streams between old and new.
  - Positions are seeded via `seed:positions` during the parity window — healthy markets produce
    zero liquidation events, so unseeded parity is vacuous.
  - **Midnight first**, then blue.
  - **Stop-old-first**: never two funded liquidators on one key.
  - Old services stay scaled-to-zero for one week before deletion.
- **PR5 — delete `bots/`**, delete bot-kit's runner/watcher, docs sweep — including relocating
  the withdrawn kill-switch TIB from `bots/kill-switch/docs/decisions/` to `docs/decisions/`, and
  landing the supersession notes on the affected TIBs (see below).
- **PR6 — flip this TIB to Accepted** (with the PR3 latency numbers recorded).

## Superseded & Amended Decisions

Three prior decisions change. The supersession/amendment notes on the affected documents land in
**PR5/PR6** — until then the older TIBs and `CONVENTIONS.md` intentionally still read as-is.

1. **Persistent runner → deleted.** Supersedes the runner design in
   [TIB-2026-05-28](./TIB-2026-05-28-midnight-liquidation-bot.md) and amends
   [TIB-2026-07-09 (extract)](./TIB-2026-07-09-extract-bot-kit-and-swaps.md), whose `@repo/bot-kit`
   surface lists "Block watcher + runner". Both `runner/runner.ts` and `runner/watcher.ts` are
   deleted; block-driven reactivity is replaced by sleep-loop polling. Justified because both
   liquidation TIBs define the bots as non-competitive ecosystem-backstop liquidators
   ("reliability over latency, must not win races"), and midnight's post-maturity LIF ramps over
   60 minutes — block-level reactivity has no payoff to lose.
2. **"No persisted queue state / chain truth wins" → persisted-as-hint.** The midnight TIB's
   Alternative 5 explicitly rejected queue persistence. The inversion is **required** by the
   one-shot model: a per-tick process with no memory of its pending txs would never fee-bump a
   stuck tx, and a stuck nonce blocks the entire tx stream. The spirit survives: the state file is
   a hint reconciled against chain truth at tick start, and losing it degrades to today's restart
   semantics.
3. **Env-only config → file-merge.** `CONVENTIONS.md`'s "read `Bun.env.X` at point of use" (from
   the [bootstrap TIB](./TIB-2026-04-16-bootstrap-curator-bots.md) port) is replaced for bot
   packages by the `~/.morpho-bots` merge design above. Bot packages are **banned from direct
   `Bun.env` reads** — env enters only via `tickOnce`'s `env` parameter. In particular, the venue
   API keys currently read via `Bun.env` in each bot's `index.ts` MUST route through the flattened
   table, or `secrets.json` silently breaks. Documented exception: `packages/utils`'s
   deployless-batch-lens `MAX_DEPLOYLESS_BATCH_SIZE` stays env-only.

## Considered Alternatives

### Alternative 1: A dedicated `cores/` (or `lib-bots/`) top-level tree

Keep bot cores out of `packages/` to visually separate "protocol logic" from "shared libraries".

**Why rejected:** A fourth top-level concept with no boundary gain. The invariant that matters —
`bot-kit` / `swaps` / `utils` never import bot shapes — is about import direction, not directory
placement, and holds either way. The cores are libraries consumed by multiple UIs; `packages/` is
where libraries live.

### Alternative 2: One merged config file with secrets inline

A single `~/.morpho-bots/config.json` holding keys alongside RPC URLs and tuning.

**Why rejected:** Deliberate decision to keep `secrets.json` separate with `0600` perms — the
permission boundary sits on exactly the sensitive bytes, and `config.json` stays freely shareable
and diffable without leaking keys.

### Alternative 3: A long-running `morpho-bots <bot> run` command

Keep the watcher/runner but move it inside the CLI, avoiding per-tick process spawn.

**Why rejected:** It reintroduces the process-supervision problem the one-shot model removes
(restarts, crash handling, in-memory state loss) and keeps the runner code alive for a latency
benefit the backstop-liquidator posture explicitly does not want. Unix loops and cron are the
supervisor.

## Assumptions & Constraints

- **Tick cadence ≈ block time.** Block-denominated timings (`STUCK_BLOCKS=4`,
  `SETTLED_COOLDOWN_BLOCKS=20`) assume the tick loop runs roughly once per block;
  `TICK_INTERVAL_S≈2` is the intended prod setting. Chains with very different block times need
  these retuned.
- **soltag cache must be warm.** Per-tick process spawn re-runs the soltag solc lens compile
  unless the cache is warm — the soltag cache dir must live on the persistent volume (prod
  `MORPHO_BOTS_HOME=/data/morpho-bots`) or be warmed at image build. Tick latency is measured in
  PR3 and recorded here before this TIB is Accepted.
- **State-file loss with a tx in flight is safe** — reconciliation
  (`getTransactionCount('pending')` + receipt checks) plus the simulate gate covers correctness;
  the only degradation is settled-cooldown protection lost for one tick.
- **Backoff attempt counts must persist** across ticks; resetting them would collapse the 429
  defense on 1inch's 1-RPS tier.
- **Prod stays env-only.** Missing `~/.morpho-bots` files are non-fatal by design; the file layer
  exists for operators, not for Railway.

## Observability

- **Per-tick processes fragment the log stream** — thousands of short-lived processes instead of
  one continuous one. The loop-level aggregation story is deferred with the BetterStack follow-up
  both liquidation TIBs mention; until then, the loop wrapper's stdout is the stream.
- **Exit codes become an operational signal** (0/1/2 contract above); wrappers stopping on 2 is
  the alarm for config errors.
- **Cutover parity** is judged on the `tick.end` / `plan.built` / `simulate.*` log streams between
  the old runner and the new loop, with positions seeded so the comparison is non-vacuous.

## Security

- `secrets.json` is `0600` and separate from `config.json`; the CLI is the only reader.
- Bot packages cannot read `Bun.env` — every secret enters through `tickOnce`'s `env` parameter,
  making the secret flow auditable at a single seam.
- The pid lockfile prevents two concurrent ticks per `(bot, chain)` — the one-shot equivalent of
  the single-process nonce discipline.
- Cutover is **stop-old-first**: never two funded liquidators on one key; the parity service runs
  with an unfunded key.

## Future Considerations

- **`uis/tui`** — the operator front-end this restructure exists to enable.
- **`services/uniswap-quoter`** — build it against the four `@repo/swaps` seams recorded above,
  letting Uniswap join multi-venue ranking.
- **Log aggregation** — the BetterStack follow-up, more pressing now that ticks are short-lived
  processes.

## References

- [TIB-2026-04-16: Bootstrap curator-bots](./TIB-2026-04-16-bootstrap-curator-bots.md) — source of
  the env-only convention amended here.
- [TIB-2026-05-28: Midnight liquidation bot — v0](./TIB-2026-05-28-midnight-liquidation-bot.md) —
  runner design superseded; its Alternative 5 (no queue persistence) inverted.
- [TIB-2026-06-30: Blue liquidation bot — v0](./TIB-2026-06-30-blue-liquidation-bot.md) — backstop
  posture; origin of the rindexer service being extracted.
- [TIB-2026-07-09: Extract `@repo/swaps` and `@repo/bot-kit`](./TIB-2026-07-09-extract-bot-kit-and-swaps.md)
  — this TIB is its deferred Phase 4 (deploy infra), grown into the restructure; its bot-kit
  runner/watcher surface is amended.
- [TIB-2026-07-09: Midnight markets whitelist + best-of-venues](./TIB-2026-07-09-midnight-markets-whitelist-multi-venue.md)
  — the listedMarkets whitelist and venue rankings persisted by the state files.

## Addenda

### 2026-07-10 — `uis/` renamed to `interfaces/`; packaging isolated in `bots/`

Two layout revisions after the ladder landed (paths in the body above are historical):

- **`uis/` → `interfaces/`.** "UIs" over-implied frontend; `interfaces/` names the same idea —
  operator-facing surfaces (`interfaces/cli` now, a TUI later) — without it. `@repo/cli` and the
  `morpho-bots` bin are unchanged.
- **Bot packaging moved out of the CLI package and the repo root into a new `bots/` workspace
  (`@repo/bots`).** The Dockerfile, `docker-entrypoint.sh`, both `docker-compose.*.yml` files
  (previously at the repo root), and the `deploy-railway-*.ts` scripts now live under `bots/`.
  Rationale: `interfaces/cli` stays a generic, unopinionated interface; everything that wraps its
  one-shot ticks into a persistent liquidation-bot deployment is a _use-case_ and is isolated in
  `bots/`. `bots/` is a real workspace member (the deploy scripts import `@repo/utils`, so it needs
  lockfile/typecheck/knip coverage). Railway services set `RAILWAY_DOCKERFILE_PATH=bots/Dockerfile`;
  compose runs as `docker compose -f bots/docker-compose.<bot>.yml up` with `context: ..`.

<!--
TIB conventions:
- Once accepted, do not substantively edit this TIB. If the decision needs to change,
  create a new TIB that supersedes this one and update the Status/Superseded by fields.
- Addenda may be appended to record operational updates that affect
  how the TIB is applied without changing the decision itself.
- TIB identifiers use CalVer (YYYY-MM-DD) based on the date the TIB was first drafted.
-->
