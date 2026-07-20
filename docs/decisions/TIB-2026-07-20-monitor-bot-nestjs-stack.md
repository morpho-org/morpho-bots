# TIB-2026-07-20: monitor-bot NestJS/vitest/t3-env stack

| Field      | Value            |
| ---------- | ---------------- |
| **Status** | Proposed         |
| **Date**   | 2026-07-20       |
| **Author** | @hayden          |
| **Scope**  | App: monitor-bot |

---

## Context

`bots/monitor-bot` is a new bot: a REST-polling → Slack notification service with **no on-chain
interaction** (no keys, no viem clients, no pending-tx queue). The repo baseline — set in
[TIB-2026-04-16-bootstrap-curator-bots](./TIB-2026-04-16-bootstrap-curator-bots.md) and reaffirmed
in [TIB-2026-07-16-revert-to-bots-as-programs](./TIB-2026-07-16-revert-to-bots-as-programs.md) — is
a standalone long-running program assembled from `@repo/bot-kit`, configured via direct `Bun.env`
access (fail-loud, no runtime schema layer), tested with `bun test`.

The maintainer intends monitor-bot to seed a growing family of poller services and has mandated a
different stack for it: NestJS + dependency injection, `vitest`, and `@t3-oss/env-core` + `zod`
config validation. These deviate from three documented conventions. This TIB records the deviations,
the rationale, and — importantly — the containment that keeps them scoped to monitor-bot, so future
readers treat them as a deliberate exception rather than drift.

## Goals / Non-Goals

**Goals**

- Record the mandated stack deviations for monitor-bot and why each is contained to
  `bots/monitor-bot`.
- Keep observability identical to every other bot: monitor-bot reuses `@repo/bot-kit`'s structured
  JSON-lines logger and the BetterStack shipping/heartbeat conventions.
- Prevent the deviations from leaking repo-wide — decorators, `vitest`, and `t3-env` stay confined
  to monitor-bot.

**Non-Goals**

- Change the liquidator bots or the bots-as-programs baseline. This does not touch
  `blue-liquidation`, `midnight-liquidation`, or `@repo/bot-kit`'s runtime model.
- Make NestJS / `vitest` / `t3-env` a repo-wide standard. The mandate is monitor-bot-scoped.
- Wire monitor-bot into the Railway deploy workflows — deferred until it does real work.
- Replace the bot-health Slack alerting deferred in
  [TIB-2026-07-14-betterstack-log-forwarding](./TIB-2026-07-14-betterstack-log-forwarding.md).
  monitor-bot does **protocol-activity** alerting, a distinct surface.

## Current Solution

The repo baseline is a standalone long-running TypeScript program: `main()` in `src/index.ts` loads
config from `Bun.env` (fail-loud, no schema), builds its clients, and drives a block-watcher +
runner loop, all assembled from `@repo/bot-kit`. Tests live under `test/` mirroring `src/` and run
under `bun test`. `blue-liquidation` and `midnight-liquidation` follow this pattern. Doing nothing
would mean monitor-bot forks that program shape for a workload (REST polling, no chain) it does not
fit.

## Proposed Solution

monitor-bot is built on a NestJS application with three intentional deviations from the repo
baseline, each scoped to `bots/monitor-bot`.

### 1. NestJS + DI instead of a plain `@repo/bot-kit` program

The maintainer requires NestJS to manage a growing fleet of poller services: DI-managed
composition, robust restart semantics, and lifecycle-managed graceful shutdown as the foundation
grows. monitor-bot still reuses `@repo/bot-kit`'s structured JSON-lines logger — Nest framework logs
are bridged through a `LoggerService` adapter rather than Nest's default logger — and the BetterStack
shipping/heartbeat conventions are unchanged, so observability behaves like every other bot.

Decorators (`experimentalDecorators` + `emitDecoratorMetadata`) are enabled **only** in
monitor-bot's own `tsconfig`; nothing else in the repo uses them.

### 2. `vitest` instead of `bun test`

Maintainer-mandated, and technically necessary: NestJS constructor DI resolves dependencies by type
via `emitDecoratorMetadata`, but `vitest`'s default esbuild transform cannot emit decorator
metadata. monitor-bot therefore runs `vitest` with `unplugin-swc` / `@swc/core` — the official
NestJS recipe — so the metadata is emitted.

**Containment.** The root `bunfig.toml` carries
`[test] pathIgnorePatterns = ["bots/monitor-bot/**"]`. Without it, bun's built-in test runner shims
in and runs the suite itself — ignoring the `vitest` config, and thus the SWC transform — so the
suite would be double-run, once correctly (under `vitest`) and once broken (under bun). The ignore
pattern stops the bun run; verified on bun 1.3.12. A dedicated CI step,
`bun run --filter @morpho-org/monitor-bot test` in `checks.yml`, gates the `vitest` suite.

### 3. `t3-env` + `zod` config validation instead of direct `Bun.env`

Maintainer-mandated. monitor-bot validates its environment through `@t3-oss/env-core` + `zod` rather
than reading `Bun.env` directly. Code reachable from tests reads `process.env` (not `Bun.env`),
because `vitest` executes under Node where the `Bun` global does not exist; under bun, `Bun.env` and
`process.env` are equivalent, so this is portable across both runtimes.

### Common to all three

- NestJS, `vitest`/SWC, and `t3-env` dependencies are pinned via the root `catalog:` like all other
  externals.
- `CLAUDE.md` and `docs/CONVENTIONS.md` carry scoped exception notes pointing at this TIB.
- monitor-bot is deliberately **not** wired into the Railway deploy workflows yet — deferred until
  it does real work.

## Considered Alternatives

### Alternative 1: A plain `@repo/bot-kit` program (the repo baseline)

Build monitor-bot as a standalone long-running program like the liquidators, polling on an interval
instead of watching blocks.

**Why rejected:** the maintainer wants a DI-managed poller fleet. The plain-program model gives no
lifecycle or DI structure to grow into, so each new poller would re-fork scaffolding rather than
compose within one application.

### Alternative 2: `bun test` with explicit `@Inject` decorators everywhere

Keep `bun test` and work around its inability to emit decorator metadata by annotating every
constructor parameter with `@Inject(Token)` so DI resolves by token instead of by type.

**Why rejected:** the maintainer mandated `vitest`, and the `@Inject` noise on every constructor
parameter diverges from idiomatic Nest, which resolves by type from emitted metadata.

## Assumptions & Constraints

- Under bun, `Bun.env` and `process.env` are equivalent; monitor-bot reads `process.env` so it runs
  unchanged under bun (prod) and Node (vitest).
- The `bunfig.toml` `pathIgnorePatterns` containment holds on **bun 1.3.12**. A bun upgrade that
  changes built-in test-runner discovery should re-verify that the suite is not double-run.
- The deviations stay confined to `bots/monitor-bot`. Decorators, `vitest`, and `t3-env` are not
  adopted elsewhere in the repo.
- Observability parity depends on the `LoggerService` adapter faithfully bridging Nest framework
  logs into `@repo/bot-kit`'s logger.

## Dependencies

- **NestJS**: `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`, `@nestjs/testing`,
  `reflect-metadata`.
- **Config**: `@t3-oss/env-core`, `zod`.
- **Test**: `vitest`, `unplugin-swc`, `@swc/core`.
- **Workspace**: `@repo/bot-kit` (logger + BetterStack shipping/heartbeat), `@repo/utils`.

All externals pinned via the root `catalog:`.

## Observability

monitor-bot reuses `@repo/bot-kit`'s structured JSON-lines logger and the BetterStack
shipping/heartbeat conventions, so it appears in BetterStack like every other bot. Nest framework
logs are routed through a `LoggerService` adapter rather than Nest's default console logger, keeping
log shape consistent across the fleet.

monitor-bot's own function is **protocol-activity alerting** to Slack. This is distinct from the
**bot-health** Slack alerting deferred in
[TIB-2026-07-14-betterstack-log-forwarding](./TIB-2026-07-14-betterstack-log-forwarding.md)
(`tx.confirmed` / `tx.reverted` / `tx.dropped`, sustained `tick.error` / `watcher.error`), which
remains a separate and still-deferred surface.

## Future Considerations

- Wire monitor-bot into the Railway deploy workflows once it does real work, mirroring the per-bot
  `scripts/deploy-railway.ts` pattern the liquidators use.
- As the poller fleet grows, the DI foundation is meant to absorb new pollers within the one NestJS
  application rather than re-scaffolding per bot.
- If a future decision promotes NestJS / `vitest` / `t3-env` to a repo default, this TIB's scoped
  exception notes fold into that broader decision.

## References

- [TIB-2026-04-16-bootstrap-curator-bots](./TIB-2026-04-16-bootstrap-curator-bots.md) — the baseline
  stack (bun test, direct `Bun.env`, standalone programs) this deviates from.
- [TIB-2026-07-16-revert-to-bots-as-programs](./TIB-2026-07-16-revert-to-bots-as-programs.md) — the
  bots-as-programs runtime model monitor-bot departs from.
- [TIB-2026-07-14-betterstack-log-forwarding](./TIB-2026-07-14-betterstack-log-forwarding.md) — the
  deferred bot-health Slack alerting, distinct from monitor-bot's protocol-activity alerting.
- `CLAUDE.md` and `docs/CONVENTIONS.md` — scoped exception notes pointing at this TIB.
