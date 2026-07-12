# TIB-2026-07-12: Repo restructure — `apps/` + `packages/` + `deploy/`, bot-kit split, sense/act retirement

| Field          | Value                                                                                                                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**     | Proposed _(flips to Accepted at PR approval)_                                                                                                                                                                    |
| **Date**       | 2026-07-12                                                                                                                                                                                                       |
| **Author**     | @hayden                                                                                                                                                                                                          |
| **Scope**      | Repo-wide (every top-level tree; `@repo/bot-kit`, `@repo/signer`, `@repo/utils`, both bot cores)                                                                                                                 |
| **Supersedes** | [TIB-2026-07-09-cli-restructure](./TIB-2026-07-09-cli-restructure.md) — directory tiers only; [TIB-2026-07-11-queued-daemon](./TIB-2026-07-11-queued-daemon.md) — "Layout: `tools/` vs `services/`" section only |
| **Amends**     | [TIB-2026-07-10-op-commands](./TIB-2026-07-10-op-commands.md) — "internal code keeps the `sense` / `act` vocabulary" clause                                                                                      |

---

## Context

The repo just went through four back-to-back architecture refactors — pipeline CLI (#38–#44), op
commands, signer agent (#45–#46), queued daemon (#47–#51) — and the file/folder structure was
patched after each one but never reconsidered as a whole. The residue: a four-way top-level split
(`bots/` + `packages/` + `tools/` + `services/`) that tracks no single axis — `packages/signer` and
`services/queued` are structurally identical daemons in different tiers; `services/` mixes a
workspace daemon with a non-workspace deploy artifact (`blue-rindexer`); `tools/` has one member;
"bots" means both deployment packaging (`bots/`) and the bot cores (in `packages/`). Inside the
cores, the retired sense/act framework survives as single-file folders (`src/sense/sense.ts`,
`src/act/act.ts`), identifiers (`runSense`, `kind: 'sense'`), and log events (`sense.end`,
`act.skip`), plus vestigial names (`src/tick/` holds no tick loop; `src/wire.ts` holds no wiring;
`formatOpportunityId` names a record kind that no longer exists). `@repo/bot-kit` is a grab-bag of
four unrelated concerns, and `@repo/utils` hides 100% of its code under a meaningless `helpers/`
layer holding the repo's only camelCase filenames.

## Goals / Non-Goals

**Goals**

- **One placement axis.** Every top-level directory answers a single question — do you **run it**
  (`apps/`), **import it** (`packages/`), or **ship it** (`deploy/`).
- **Apps are leaves.** No app imports another app; anything two programs share is a package.
- **Cohesive packages.** `@repo/bot-kit` splits along its real concern boundaries; `@repo/utils`
  loses its `helpers/` indirection.
- **Finish the sense/act retirement.** Files, identifiers, AND log event names — the vocabulary
  the op-commands TIB kept internally is removed end-to-end.
- **Preserve the operator contract.** Bins, commands, record shapes, socket protocols, env vars,
  home layout, cache files, and exit codes are all unchanged; only log event names move.

**Non-Goals**

- **Behavior changes.** No strategy, wire, protocol, or config-semantics change rides along; this
  is a naming-and-placement change.
- **Prod migration.** Deployed Railway services are untouched by the restructure itself; the
  deploy-script re-run is a post-merge runbook item, not part of this work.
- **Opportunistic package renames.** `@repo/queued`, `@repo/home`, `@repo/signer`, and all bins
  keep their names (see Considered Alternatives).
- **New abstractions.** The bot-kit split relocates existing modules; no new seams are designed.

## Current Solution

Four top-level trees: `tools/cli` (the `morpho-bots` CLI), `services/` (`queued` workspace daemon +
`blue-rindexer` non-workspace artifact), `bots/` (`@repo/bots` — Docker image, entrypoint,
compose files, Railway scripts), `packages/` (everything else, including the `morpho-signer`
daemon). `@repo/bot-kit` holds the op seam (`ops.ts`, `records.ts`, `liquidation-id.ts`,
`simulate.ts`), EVM plumbing (`client.ts`, `tx-error.ts`, `logger.ts`), and IPC
(`unix-json-server.ts`) in one package; `@repo/signer` exports a `./client` subpath that
`@repo/queued` imports — a package-to-package edge today that would become an app-to-app edge under
any tiering. The cores keep sense/act as `src/sense/sense.ts` / `src/act/act.ts` with
`runSense`/`runAct` seams, `Sense*`/`Act*` config/cache/counter types, and `sense.*`/`act.*` log
events; `@repo/utils` routes everything through `src/helpers/` with `safeParseUnits.ts`,
`tokenBucket.ts`, `tryCatch.ts`, and a standalone `src/types/index.ts`.

## Proposed Solution

### The three tiers

Top level becomes `apps/` + `packages/` + `deploy/` — run it / import it / ship it. `tools/`,
`services/`, and `bots/` retire. Root workspaces:
`["packages/*", "tools/*", "services/*", "bots"]` → `["packages/*", "apps/*", "deploy"]`.

| Old                                        | New                                                       | Package name                      | bin             |
| ------------------------------------------ | --------------------------------------------------------- | --------------------------------- | --------------- |
| `tools/cli`                                | `apps/cli`                                                | `@repo/cli` (keep)                | `morpho-bots`   |
| `packages/signer` (daemon)                 | `apps/signer`                                             | `@repo/signer` (keep)             | `morpho-signer` |
| `packages/signer/src/{client,protocol}.ts` | `packages/signer-client`                                  | **`@repo/signer-client`** (new)   | —               |
| `services/queued`                          | `apps/queued`                                             | `@repo/queued` (keep)             | `morpho-queued` |
| `bots/`                                    | `deploy/`                                                 | `@repo/bots` → **`@repo/deploy`** | —               |
| `services/blue-rindexer`                   | `deploy/blue-rindexer`                                    | (non-workspace artifact)          | —               |
| `packages/bot-kit`                         | `packages/pipeline` + `packages/evm-kit` + `packages/ipc` | new                               | —               |
| other `packages/*`                         | unchanged                                                 |                                   |                 |

`deploy/blue-rindexer` stays a non-workspace Dockerfile + `rindexer.yaml` artifact — it is a thing
we ship, not a program this repo runs or a library it imports. With `signer-client` extracted,
**no app imports another app** — apps are leaves of the dependency graph.

### bot-kit dissolves into three packages

`@repo/bot-kit` is four concerns in one manifest. It splits by concern, not by consumer:

- **`@repo/pipeline`** — the op seam and its data language: `ops.ts`, `records.ts`,
  `liquidation-id.ts`, `simulate.ts`. Consumers: both cores, `apps/cli`.
- **`@repo/evm-kit`** — chain plumbing with no pipeline opinion: `client.ts` (deployless client),
  `tx-error.ts`, `logger.ts`. Consumers: cores, cli, signer, queued.
- **`@repo/ipc`** — `unix-json-server.ts`, node builtins only. Consumers: signer, queued.

One accepted impurity: **`pipeline → evm-kit` is a type-only edge** — `ops.ts` references
`Logger`/`LogLevel` in the op signatures. Accepted and commented at the import site; the
alternative (moving the logger into `pipeline`) would force the signer and queued daemons to
depend on the liquidation pipeline package just to log.

### signer-client extraction — apps are leaves

`apps/queued` imports `@repo/signer/client` today; once the signer is an app, that is an
app-to-app edge. `packages/signer-client` extracts `client.ts` + `protocol.ts` (+
`test/protocol.test.ts`); `apps/signer` keeps the `@repo/signer` name, gains a
`@repo/signer-client` dep, and **drops its `./client` subpath export** (exports-less, matching
`@repo/queued`). `apps/queued`'s dep flips `@repo/signer` → `@repo/signer-client`.

**Deliberate asymmetry, named here so it isn't "fixed" later:** the "client" package carries the
**shared bidirectional wire protocol**, including the server-side framing helpers
(`errorResponse`, `okResponse`, `parseRequestLine`, `serializeResponse`, `fromWireTx`/`toWireTx`,
`ProtocolError`) — `apps/signer`'s `server.ts` consumes seven runtime symbols from it. The
protocol is genuinely shared wire code with exactly two speakers; splitting it into a third
`signer-protocol` package would be a package per file. `signer-client`'s barrel re-exports
`protocol.ts` wholesale. Its deps stay minimal: viem + `node:net` only.

### sense/act retirement — op-named seams, files, identifiers, and log events

The op-commands TIB renamed the command surface but kept sense/act as internal vocabulary. That
clause is reversed: the vocabulary is retired everywhere.

**Seam** (`packages/pipeline/src/ops.ts`):

| Old                             | New                                               |
| ------------------------------- | ------------------------------------------------- |
| `OpExport`                      | `Operation`                                       |
| `SenseOpExport` / `ActOpExport` | `SourceOperation` / `TransformOperation`          |
| `kind: 'sense'` / `'act'`       | `kind: 'source'` / `'transform'`                  |
| `senseOnce` / `actOnce` methods | one **`run`** field, narrowed by the discriminant |

**Core files** (both cores, tests mirror):

| Old                               | New                                   |
| --------------------------------- | ------------------------------------- |
| `src/sense/sense.ts`              | `src/ops/unhealthy-positions.ts`      |
| `src/act/act.ts`                  | `src/ops/liquidate.ts`                |
| `src/tick/eligibility.ts`         | `src/eligibility.ts`                  |
| `src/wire.ts`                     | `src/position-id.ts`                  |
| `src/state/*` , `src/discovery/*` | flattened into `src/`                 |
| `src/execution/`, `src/sizing/`   | kept — cohesive multi-file subsystems |

**Identifiers become op-named** — files are named after ops, identifiers match (see
Alternative 1 for why not generic `runSource`-style names):

| Old                                         | New                                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `runSense` / `runAct`                       | `findUnhealthyPositions` / `prepareLiquidations`                                         |
| `senseOnce` / `actOnce` exports             | `runUnhealthyPositions` / `runLiquidate`                                                 |
| `SenseConfig` / `ActConfig` (+ loaders)     | `UnhealthyPositionsConfig` / `LiquidateConfig` (+ loaders)                               |
| `…SenseCache` / `…ActCache`                 | `…UnhealthyPositionsCache` / `…LiquidateCache`                                           |
| `SenseCounters` / `ActCounters`             | `UnhealthyPositionsCounters` / `LiquidateCounters`                                       |
| `SENSE_CACHE_VERSION` / `ACT_CACHE_VERSION` | `UNHEALTHY_POSITIONS_CACHE_VERSION` / `LIQUIDATE_CACHE_VERSION` (values unchanged)       |
| `formatOpportunityId`                       | `formatPositionId` (aligns with `PositionRecord`; "opportunity" is stale vocabulary too) |

**Log event names change** — an accepted observability-breaking change (see Observability):

| Old         | New              |
| ----------- | ---------------- |
| `sense.end` | `source.end`     |
| `act.end`   | `transform.end`  |
| `act.skip`  | `transform.skip` |

**`@repo/utils` flattens:** `src/helpers/*` → `src/*`, camelCase → kebab-case
(`safe-parse-units.ts`, `token-bucket.ts`, `try-catch.ts`); `src/types/index.ts` is deleted and
`Result`/`Success`/`Failure` colocate into `try-catch.ts` (barrel-exported, additive); `Id<T>`
becomes local to `deployless-batch-lens.ts`. External surface otherwise unchanged.

### The preserved operator contract

Everything an operator, pipeline, or deployment touches is invariant:

- **Bins:** `morpho-bots`, `morpho-queued`, `morpho-signer`.
- **CLI commands and op names:** `unhealthy-positions`, `liquidate`, `submit`, etc.
- **JSONL record shapes** and versions; **socket protocols** and protocol versions.
- **Env vars** and config sections; **`MORPHO_BOTS_HOME` layout** — cache files are keyed by op
  name and cache versions keep their values, so nothing is orphaned.
- **Exit codes** (0/1/2 contract); **Docker/compose/Railway behavior** (paths inside the repo
  update; images build and run identically).

Only the three log event names change.

### Risks and post-merge runbook

1. **Railway service variables live outside the repo** (highest risk). `RAILWAY_DOCKERFILE_PATH`
   on the existing services (blue `bot-8453`, `bot-4663`, `rindexer`; midnight `bot`) still reads
   `bots/Dockerfile` / `services/blue-rindexer/Dockerfile` after the tier PR merges — dashboard
   redeploys fail until `bun run deploy:railway:blue` / `:midnight` are re-run (the scripts set
   the new value) or the variables are updated manually.
2. **Log-query migration.** Any Better Stack queries/alerts on `sense.end` / `act.*` must move to
   `source.end` / `transform.*` when the vocabulary PR deploys.
3. **In-flight branches conflict wholesale with the tier PR** — land the stack quickly.

### Implementation Phases

Six stacked PRs, each leaving the repo green (`git mv` commits separate from edit commits). TIB
first per the repo TIB process; directory moves next (highest conflict surface); the boundary
split lands before the vocabulary rename so `ops.ts` is edited once, in its final home.

- **PR 1 — `restructure/tib`:** `docs(docs): add repo restructure tib` (this document).
- **PR 2 — `restructure/tiers`:** `refactor(repo): restructure into apps, packages, and deploy tiers`.
- **PR 3 — `restructure/boundaries`:** `refactor(packages): split bot-kit and extract signer-client`.
- **PR 4 — `restructure/vocabulary`:** `refactor(packages): retire sense/act vocabulary for op-named seams`.
- **PR 5 — `restructure/utils-flatten`:** `refactor(utils): flatten helpers layer and kebab-case module names`.
- **PR 6 — `restructure/docs-sweep`:** `docs(docs): refresh doc surfaces after restructure`.

## Superseded & Amended Decisions

1. **[TIB-2026-07-09-cli-restructure](./TIB-2026-07-09-cli-restructure.md) — directory tiers
   superseded.** Its `uis/`(→`interfaces/`→`tools/`) + `services/` + `packages/` split, and the
   later `bots/` packaging addendum, are replaced by `apps/` + `packages/` + `deploy/`. Its
   foundations stand untouched: one-shot processes, unix-loop supervision, the 0/1/2 exit
   contract, `~/.morpho-bots` config merge, state-as-hint — and its cores-in-`packages/`
   rationale carries over unchanged (the cores are libraries; `packages/` is where libraries
   live).
2. **[TIB-2026-07-11-queued-daemon](./TIB-2026-07-11-queued-daemon.md) — "Layout: `tools/` vs
   `services/`" section superseded.** The tools-vs-services process-shape split retires; `queued`
   moves to `apps/queued` and the signer to `apps/signer`, dissolving that section's noted
   signer/queued placement asymmetry. Everything else in that TIB stands.
3. **[TIB-2026-07-10-op-commands](./TIB-2026-07-10-op-commands.md) — internal-vocabulary clause
   reversed.** "Internal code keeps the `sense` / `act` vocabulary — `runSense` / `runAct` stay
   the unit-test seams, and the seam kinds are `'sense'` / `'act'`" becomes full retirement: the
   seam kinds are `'source'` / `'transform'` and every identifier is op-named. The rest of that
   TIB — flat op-named commands, source XOR transform, caller-owned composition, the
   `<domain>:<op>:` ID prefix — stands.

## Considered Alternatives

### Alternative 1: Generic source/transform identifiers (`runSource`, `SourceConfig`)

Rename the sense/act identifiers to the generic kind names instead of op names.

**Why rejected:** The files are named after ops; identifiers should match. Generic names collide
the moment a core gains a second source op (the roadmap sensors) — `SourceConfig` for which
source? Op-named identifiers (`findUnhealthyPositions`, `UnhealthyPositionsConfig`) are collision-
free by construction.

### Alternative 2: Opportunistic package renames (`@repo/queue`, `@repo/operator-files`, `@repo/signer-agent`)

Rename `@repo/queued` → `@repo/queue` (with `Queued*` → `Queue*` types), `@repo/home` →
`@repo/operator-files`, and `@repo/signer` → `@repo/signer-agent` while everything is moving
anyway.

**Why rejected:** The bin stays `morpho-queued` regardless — a package/bin mismatch is worse than
the "-d" suffix, which is deliberate daemon naming (lpd-style) per the queued TIB. "home" matches
the `MORPHO_BOTS_HOME` / `botsHome()` vocabulary; "operator-files" is churn without clarity gain.
Same for `signer-agent`.

### Alternative 3: `blue-rindexer` under `apps/`

Treat the rindexer as an app since it is a long-running indexer.

**Why rejected:** It is a non-workspace Dockerfile + yaml artifact, not a program this repo runs;
putting it in `apps/` recreates exactly the workspace/non-workspace mixing problem `services/`
had. It is a thing we ship — `deploy/blue-rindexer`.

### Alternative 4: One atomic implementation PR

Land the whole restructure (moves + splits + renames) in a single PR after the TIB.

**Why rejected:** Unreviewable — directory moves, package splits, and identifier renames each
want their own diff. Stacked small PRs match repo precedent (#38–#44, #47–#51) and keep every
intermediate state green.

### Alternative 5: Standalone `result.ts` in utils

Give `Result`/`Success`/`Failure` their own module during the flatten.

**Why rejected:** CONVENTIONS.md says avoid standalone type files; the types colocate into
`try-catch.ts`, the module that produces them.

### Alternative 6: Keep the sense/act internal vocabulary (and its log events)

The op-commands TIB's original position: rename only the command surface.

**Why rejected:** The vocabulary no longer names anything real — there is no sense/act framework,
only source and transform ops — and keeping it splits every concept across two names (op-named
files, sense-named identifiers, sense-named log events). Preserving only the log events was
considered as a lighter option and rejected with it: log vocabulary that matches no code sends
future readers hunting for emitters that don't exist. The observability migration is small and
accepted.

## Assumptions & Constraints

- **The operator contract above is the acceptance bar** — any diff that changes a bin, command,
  record shape, protocol version, env var, home path, cache key, or exit code is out of scope for
  this restructure and needs its own decision.
- **Cache versions keep their values** (`UNHEALTHY_POSITIONS_CACHE_VERSION` etc. rename only), and
  cache files are keyed by op name — no cache orphaning, no migration.
- **The `deploy/Dockerfile` install layer must not copy `deploy/` wholesale** — copying
  `deploy/blue-rindexer` before `bun install` reintroduces the cache-busting the current
  Dockerfile deliberately avoids; the install layer copies manifests only.
- **`pipeline → evm-kit` stays type-only.** If a runtime import appears, the split's dependency
  story needs revisiting, not silently widening.
- **Every PR in the stack leaves the repo green** (typecheck, lint, test, knip, Docker builds) —
  the stack is droppable at any rung.
- **Prod keeps running the pre-restructure image** until the deploy scripts are re-run
  (post-merge runbook); nothing here self-deploys.

## Observability

- **Three log event names change** — `sense.end` → `source.end`, `act.end` → `transform.end`,
  `act.skip` → `transform.skip` — an accepted breaking change to the stderr log stream. Migrate
  any Better Stack queries/alerts on the old names when the vocabulary PR deploys; nothing else
  in the log surface moves.
- **Everything else is invariant:** JSONL stdout records, `outcomes.jsonl`, socket `status`
  methods, and exit-code semantics are untouched.

## References

- [TIB-2026-07-09: CLI restructure](./TIB-2026-07-09-cli-restructure.md) — the previous layout
  decision; its tiers are superseded here, its foundations preserved.
- [TIB-2026-07-09: UNIX-pipeable CLI](./TIB-2026-07-09-pipeline-cli.md) — the pipeline whose
  operator contract this restructure preserves.
- [TIB-2026-07-10: Commands are op names](./TIB-2026-07-10-op-commands.md) — op-named commands;
  its internal-vocabulary clause is reversed here, completing the retirement it started.
- [TIB-2026-07-10: Signing agent](./TIB-2026-07-10-signer-agent.md) — the signer whose
  client/protocol module becomes `@repo/signer-client`.
- [TIB-2026-07-11: `queued` daemon](./TIB-2026-07-11-queued-daemon.md) — the daemon moving to
  `apps/queued`; its layout section is superseded here.
- [TIB-2026-07-09: Extract `@repo/swaps` and `@repo/bot-kit`](./TIB-2026-07-09-extract-bot-kit-and-swaps.md)
  — the extraction that created bot-kit, now dissolved along concern boundaries.
- [CONVENTIONS.md](../CONVENTIONS.md) — source of the no-standalone-type-files rule and the
  kebab-case filename convention the utils flatten adopts.

<!--
TIB conventions:
- Once accepted, do not substantively edit this TIB. If the decision needs to change,
  create a new TIB that supersedes this one and update the Status/Superseded by fields.
- Addenda may be appended to record operational updates that affect
  how the TIB is applied without changing the decision itself.
- TIB identifiers use CalVer (YYYY-MM-DD) based on the date the TIB was first drafted.
-->
