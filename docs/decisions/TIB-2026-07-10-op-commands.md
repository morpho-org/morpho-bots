# TIB-2026-07-10: Commands are op names — `<domain> <op>` replaces `sense` / `act`

| Field      | Value                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| **Status** | Accepted                                                                                                  |
| **Date**   | 2026-07-10                                                                                                |
| **Author** | @hayden                                                                                                   |
| **Scope**  | Repo-wide (`interfaces/cli`, both bot cores, `@repo/bot-kit`, `bots/`)                                    |
| **Amends** | [TIB-2026-07-09-pipeline-cli](./TIB-2026-07-09-pipeline-cli.md) — ID-parsing clause + `sense`/`act` verbs |

---

> **Historical design note (2026-07-11):** Flat source/transform op commands remain current. The
> envelope, outcome, ID-routing, cooldown, and bot-scoped queue details below were superseded by
> transparent position JSON and the per-chain `morpho-queued` daemon. Transforms consume semantic
> fields directly and never parse or route through the correlation-only `id`.

> **Amendment note (2026-07-12):** The decision below that "internal code keeps the `sense` / `act`
> vocabulary" (`runSense` / `runAct` seams, seam kinds `'sense'` / `'act'`) is **reversed** by
> [TIB-2026-07-12-repo-restructure](./TIB-2026-07-12-repo-restructure.md): the seam kinds become
> `'source'` / `'transform'`, core identifiers become op-named (`findUnhealthyPositions`,
> `prepareLiquidations`, …), and the `sense.*` / `act.*` log events are renamed. Everything else —
> flat op-named commands, source XOR transform, the `<domain>:<op>:` ID prefix, caller-owned
> composition — stands.

## Context

[TIB-2026-07-09-pipeline-cli](./TIB-2026-07-09-pipeline-cli.md) (merged #38–#43) decomposed the tick
into a pipeable `<domain> sense | act | queue`, but it hard-codes exactly one behavior per domain:
one sensor, one actor, `op: 'liq'` compiled in, surfaced as the fixed verbs `sense` and `act`. Each
domain will grow more behaviors — the non-liquidation sensors already on the roadmap (dead-oracle
market removal, vault ops, kill-switch revival) — so the two-verb surface generalizes now, while the
pipeline is young and liquidation is still its only inhabitant. This TIB and its implementation land
in the same PR, so it is **Accepted** on arrival.

## Goals / Non-Goals

**Goals**

- **Commands are op names.** A domain exposes a flat, uniquely-named set of ops instead of two fixed
  verbs, so a new behavior is a new command with no change to the surface's shape.
- **A source XOR transform per op.** Each op is exactly one pipe stage — a **source** emits
  opportunity records, a **transform** maps ids/records to tx records — so a behavior's two stages
  are two separately-named ops that pipe together.
- **One seam definition.** The source/transform seam is defined once in `@repo/bot-kit` so the cores
  and the CLI cannot drift.
- **Registration without eager core imports.** The CLI knows op names at commander-registration time
  from a static manifest, while implementations lazy-load, preserving `queue`'s lens-free property.
- **Caller-owned composition.** Which ops run, and how often, is the invoker's business — no
  autonomous flag, no run-all mode.

**Non-Goals**

- **Building the roadmap sensors.** The generalization ships with the two liquidation ops per domain
  and nothing else; new sensors are separate later work.
- **A `markets` viewer op.** It was only an illustrative example in the pipeline TIB; it is not built,
  and its would-be envelope field (`remediation`) stays reserved (see below).
- **Routing operator scripts through the domain queue.** Position seeding and similar
  parameterized-intent tools stay operator scripts by wallet-custody decision (see Proposed Solution).
- **Migration / cutover.** As in the pipeline TIB, the running Railway services are untouched; this is
  a build-the-target change.

## Current Solution

After the pipeline TIB, `interfaces/cli` registers `<domain> sense` and `<domain> act` as fixed
verbs. `op` is already first-class on every wire record (`@repo/bot-kit`'s `records.ts`) and on the
`QueuePolicy`, but the cores pin `OP = 'liq'` in `wire.ts`, `collectActIds` filters on domain and
kind (not op), and each core's ID codec owns the whole ID string — the pipeline TIB's rule is that
**generic code never parses the ID**, routing off the envelope's separate `domain` / `op` / `chainId`
fields instead. Cache paths are keyed `(bot, chainId)` per stage (`sense-` / `act-`).

## Proposed Solution

### Commands are op names

A domain exposes a **flat namespace of uniquely-named ops**. Each op is EITHER a **source** (emits
`opportunity` records) or a **transform** (ids/records → `tx` records), never both — the two stages of
one behavior are two separate pipe processes, so they carry two separate names. Liquidation splits
into:

- **`unhealthy-positions`** — the source (renamed from `liq`); today's `senseOnce`.
- **`liquidate`** — the transform, `accepts: 'unhealthy-positions'`; today's `actOnce`.

`queue` is a **reserved name in the same flat namespace** (as are `help` and `init`); a collision
test enforces this. The prod pipeline becomes:

```
morpho-bots midnight unhealthy-positions | morpho-bots midnight liquidate | morpho-bots midnight queue
```

Internal code keeps the `sense` / `act` vocabulary — `runSense` / `runAct` stay the unit-test seams,
and the seam kinds are `'sense'` / `'act'`. Only the CLI surface drops the verbs.

### The wire `op` is the source's name, stable through the chain

`op` is the **source op's name** and does not change as records flow downstream: `liquidate` consumes
and re-emits records carrying `op: 'unhealthy-positions'`, and `queue` keys its outcome labels the
same way. So a full liquidation pipeline's records all read `op: 'unhealthy-positions'`, and IDs
become `<domain>:unhealthy-positions:<chainId>:<marketId>:<borrower>`.

### ID-grammar amendment

The pipeline TIB's rule that generic code never parses the ID is narrowed, not reversed. Wire IDs are:

```
<domain>:<op>:<domain-owned-suffix>
```

The **two-segment `<domain>:<op>:` prefix is now the generic part of the contract** — the CLI may
split it for bare-ID routing in transforms and for deriving a `queue` outcome record's `op` from the
persisted label. The **suffix stays domain-owned and opaque** and may still evolve under `v`. This
retires `QueuePolicy.op`: submit-path outcomes take `op` from the incoming `tx` envelope directly, and
only the `onSettled` path (where just the persisted label survives) splits the prefix, falling back to
`'unknown'` for an unsplittable label.

### Seam types in `@repo/bot-kit` (`src/ops.ts`)

The source/transform seam is defined once, kind-discriminated, so cores and CLI cannot drift:

```ts
type SenseOpExport = { kind: 'sense'; cacheVersion: number; validateConfig(env): { logLevel }; senseOnce(env, opts) };
type ActOpExport = { kind: 'act'; accepts: string; cacheVersion: number; validateConfig(env): { logLevel }; actOnce(env, ids, opts) };
type OpExport = SenseOpExport | ActOpExport;
```

These reference only bot-kit's own record / `Logger` types and the generic env table — the pipe seam,
not a bot shape (the same argument that keeps `records.ts` bot-free). Each core exports an `OPS`
table (`Record<string, OpExport>`) mapping op name to export; the direct `senseOnce` / `actOnce` /
cache-version index exports are removed.

### Static manifest with a sync test

Commander needs command names at registration time, but eagerly importing the cores to enumerate
`OPS` would drag the soltag / lens graph into **every** spawn — including `queue`'s, killing the
lens-free property the pipeline TIB gives `queue` in source-run. So each domain carries a small
**static manifest** — op name plus kind (plus `accepts` for transforms) — while implementations stay
behind a lazy `loadOp(name): Promise<OpExport>`. A **sync test** asserts each domain's manifest matches
the core's `OPS` table exactly (names, kinds, `accepts`) and that no op name collides with a reserved
name. Adding an op is a core implementation plus one manifest line; any drift is a test failure.

Command registration reads the manifest: sources register as `group.command('<op>')` with `--chain`,
transforms as `group.command('<op> [ids...]')`, and help descriptions carry `[source]` / `[transform]`
labels so the flat namespace stays legible. An unknown op is a commander unknown-command → exit 2.

### Caller-policy stance

Which ops run, and how often, is the **invoker's** business. There is no `autonomous` flag and no
run-all mode. The entrypoint pins the ops via env — `SOURCE_OP` (default `unhealthy-positions`) and
`TRANSFORM_OP` (default `liquidate`) — and a deployment that wants another behavior adds another
loop or service line. Composition stays exogenous, so a new op added to a core cannot silently change
what prod runs.

### Design-only — explicitly not built

- **A `markets` viewer op** was only an illustrative example in the pipeline TIB; it is not shipped.
- **The `remediation` envelope field** stays TIB-reserved with no emitter — its only would-be emitter
  was the `markets` viewer, so nothing scaffolds it here.
- **Parameterized-intent sources** such as position seeding stay operator scripts. Seeding uses
  different wallets from the liquidator, so it must not flow through the domain queue, whose lock,
  nonce cursor, and signer key belong to the liquidator. A script that wants managed sending uses
  bot-kit's queue **as a library**, not the domain `queue` command.

## Amended Decisions

This TIB amends exactly two clauses of [TIB-2026-07-09-pipeline-cli](./TIB-2026-07-09-pipeline-cli.md);
everything else in that TIB stands.

1. **The fixed `sense` / `act` command surface** becomes a flat namespace of uniquely-named ops,
   each a source XOR transform. The `sense` / `act` internal vocabulary and the `runSense` / `runAct`
   test seams are preserved.
2. **"Generic code never parses the ID string"** narrows to "the `<domain>:<op>:` prefix is the
   generic part of the contract." The suffix stays domain-owned and opaque; the amendment exists to
   let the CLI route bare IDs and derive settled-outcome ops without a core round-trip, which retires
   `QueuePolicy.op`.

## Considered Alternatives

### Alternative 1: Fixed `sense` / `act` verbs with a required op positional

Keep the two verbs and pass the op as an argument (`midnight sense unhealthy-positions`).

**Why rejected:** Once op names are globally unique, the verb is redundant — it restates the kind the
name already implies, and every invocation carries a word that adds no routing information.

### Alternative 2: Broad `sense` / `act` verbs running all ops of that kind, filtered by `--op`

One `sense` process runs every source, one `act` runs every transform, with `--op` to narrow.

**Why rejected:** A run-all default drags in intersection and mixed-stream machinery — merging
multiple sources' output, splitting it back out by op — for no operational need, since deployments run
one behavior per loop anyway. It also introduces a crash-loop hazard: a shared ops list that reaches a
sense-only op in an act context (or vice versa) fails a whole pass rather than one op. Explicit
per-op commands avoid both.

### Alternative 3: One op owning both stages

A single op that both senses and acts, internally piping its own two halves.

**Why rejected:** Impossible under a name-only command model — the two stages **are** separate pipe
processes with separate stdin/stdout, so they must carry separate names to be independently spawnable
and composable.

### Alternative 4: An `autonomous` registration flag

Mark some ops as safe to run unattended, and let the CLI drive them.

**Why rejected:** That is deployment policy leaking into code. Whether an op runs unattended, and at
what cadence, is the invoker's decision; encoding it in the op registration puts an operational knob
where a new core commit could move it.

## Consequences

- **`QUEUE_STATE_VERSION` bumps.** Persisted queue labels change vocabulary (`liq` →
  `unhealthy-positions`), so the version-gated discard drops old backoff / cooldown entries that would
  never match again. This is safe: queue state is a hint reconciled against chain truth, and nothing in
  prod runs this CLI yet.
- **Old per-stage cache files are orphaned.** The single `opCacheFile(home, bot, op, chainId)` →
  `<bot>/cache/<op>-<chainId>.json` replaces the `sense-` / `act-` paths; the old files are unreachable
  and disposable (caches never gate transaction validity), so there is no migration — just a note in the
  PR body.
- **The operator surface changes.** `morpho-bots midnight sense` becomes
  `morpho-bots midnight unhealthy-positions`, and `act` becomes `liquidate`; compose files and READMEs
  move to the new invocation.

## Assumptions & Constraints

- **Op names are globally unique within a domain and never collide with `queue`, `help`, or `init`.**
  This is the premise that makes the verb redundant; the sync test enforces it.
- **Lazy `loadOp` keeps `queue` lens-free in source-run.** If a future change makes the static manifest
  import a core eagerly, `queue`'s zero-lens spawn cost regresses — the manifest must stay a plain data
  table.
- **The `<domain>:<op>:` prefix is stable and delimiter-safe.** Domain and op names contain no `:`, so
  the two-segment split is unambiguous and the opaque suffix can hold the rest.
- **Caller composition is the only run policy.** With no autonomous flag or run-all mode, an op that is
  written but never wired into a loop simply never runs — coverage is a deployment concern, not a code
  one.

## References

- [TIB-2026-07-09: UNIX-pipeable CLI — `sense | act | queue`](./TIB-2026-07-09-pipeline-cli.md) — the
  pipeline this TIB generalizes; its command surface and ID-parsing clause are amended here, everything
  else preserved.
- [TIB-2026-07-09: CLI restructure](./TIB-2026-07-09-cli-restructure.md) — the one-shot processes,
  unix-loop supervisor, and 0/1/2 exit contract both TIBs build on.
- [TIB-2026-07-09: Extract `@repo/swaps` and `@repo/bot-kit`](./TIB-2026-07-09-extract-bot-kit-and-swaps.md)
  — `createPendingQueue` / `createSigner` the `queue` command wires directly; the seam types join
  `records.ts` as bot-free shared shapes.

<!--
TIB conventions:
- Once accepted, do not substantively edit this TIB. If the decision needs to change,
  create a new TIB that supersedes this one and update the Status/Superseded by fields.
- Addenda may be appended to record operational updates that affect
  how the TIB is applied without changing the decision itself.
- TIB identifiers use CalVer (YYYY-MM-DD) based on the date the TIB was first drafted.
-->
