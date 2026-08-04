# TIB-2026-08-04: Extract market-making shared packages

| Field      | Value      |
| ---------- | ---------- |
| **Status** | Proposed   |
| **Date**   | 2026-08-04 |
| **Author** | @julien    |
| **Scope**  | Repo-wide  |

---

## Context

The market-making bot
([TIB-2026-07-27](./TIB-2026-07-27-midnight-market-making-bot.md)) accumulated several
general-purpose concerns inside `bots/market-making`: a CLI output presenter buried in
`infrastructure/cli`, an observability composer whose operator error-name projection forced an
infrastructure→application import, three byte-identical `*CycleHasFailure` helpers, a
prospective-spread assertion duplicated between the bootstrap and ladder adapters, and an O(n²)
crossed-book scan. The refactor extracts the reusable parts into shared workspace packages.
Maintainers explicitly required **standalone, focused packages per concern** rather than growing
`@repo/bot-kit` or `@repo/utils`.

## Goals / Non-Goals

**Goals**

- Extract the bot's reusable logging, observability, monitoring, and offers-book logic into four
  standalone workspace packages a future bot (or the crossed-books monitor) can consume directly.
- **Preserve operator-visible behavior exactly** — tests pin event shapes, error names, and
  reports; the extraction must be invisible to operators.
- Break the observability infrastructure→application import by injecting the operator error-name
  projection instead of importing it.
- Keep each package's dependency footprint minimal — zero dependencies wherever possible.

**Non-Goals**

- Extract every duplicated pattern in the bot. The monitor-loop skeleton and the make-service
  reconciliation stack are deliberately deferred (see Considered Alternatives and Future
  Considerations).
- Change any quoting, sizing, rate, or on-chain behavior. This is a structural refactor.

## Current Solution

Everything below lived inside `bots/market-making`: the CLI presenter in
`src/infrastructure/cli/market-making-logger.ts`, `createMarketMakingObservability` (which
imported the application layer's operator error-name projection from infrastructure), three
copies of the cycle-failure check (`bootstrapCycleHasFailure`, `ladderCycleHasFailure`,
`marketMakingCycleHasFailure`), per-adapter spread assertions
(`assertBootstrapProspectiveSpread` / `assertLadderProspectiveSpread`), and an O(n²)
`invertedMarketIds` crossed-book scan.

## Proposed Solution

Four new workspace packages, each a single focused concern:

### `@repo/logging` — zero deps

`createCliLogger`: the CLI presenter — results to stdout, errors to stderr, human or JSON Lines
output, bigint-safe serialization, caller-supplied error event name. Extracted verbatim from the
bot's `market-making-logger.ts`. Deliberately independent of `@repo/bot-kit`'s
loglayer/BetterStack runtime logger: a CLI presenter does not need that dependency set.

### `@repo/observability` — depends on `@repo/bot-kit`

- `createBotObservability`: generalized from `createMarketMakingObservability`. Composes
  `@repo/bot-kit`'s `createLogger` + `createHeartbeatMonitor` + `railwayContext` and ships the
  `bot.started` / `bot.stopped` / `bot.action` / `bot.unexpected-error` events. The operator
  error-name projection is now **injected** by the caller, which removes the old
  infrastructure→application import.
- `installProcessObservers`: process-level signal/rejection observers.
- `enhanceVerboseArgv`: BetterStack-gated `--verbose` injection; the command allowlist is now a
  parameter rather than a hardcoded list.

### `@repo/monitoring` — zero deps

- `waitForMonitorInterval` — abortable interval wait.
- `MonitorOperationQueue` / `createOperationQueue` — failure-tolerant serial queue.
- `cycleHasFailure` — replaces the three byte-identical copies (`bootstrapCycleHasFailure`,
  `ladderCycleHasFailure`, `marketMakingCycleHasFailure`).

### `@repo/offers` — deps: viem (`Hex` type only)

The offers-batcher business case:

- `BookOffer` — the shared offer model.
- `batchProspectiveBook` — projects prospective offers into the retained selected-market book,
  excluding replaced groups.
- `hasNegativeSpread` — crossed-book detection. Unifies the duplicated
  `assertBootstrapProspectiveSpread` / `assertLadderProspectiveSpread`: the pure rule lives here,
  while the bot keeps thin adapters that throw `BootstrapAdapterError` /
  `LadderAdapterError('negative-spread')`, preserving operator-visible behavior.
- `crossedMarketIds` — per-market single-pass crossed-book scan, replacing the O(n²)
  `invertedMarketIds` implementation.

Designed with `bots/midnight-crossed-books/src/domain/order-book.ts` (`{buy, tick: bigint}`) in
mind as a plausible second consumer.

### Adjacent decisions from the same refactor

- **Behavior preservation is a hard constraint**: tests pin event shapes, error names, and
  reports; the extraction changes structure, not observable output.
- **Adapters keep their typed errors**: pure rules move to `@repo/offers`, but each adapter still
  throws its own named error class, so operator-facing failure modes are unchanged.
- **`BASE_CHAIN_ID` deduped** to a single export in
  `bots/market-making/src/config/config.utils.ts`.
- **Audited report allowlist**: the entrypoint's 8-branch `instanceof` ladder is replaced by a
  single `REPORTED_ERRORS` constructor table iterated by `failureDetails`. A structural
  `'report' in error` guard was rejected because it would emit report payloads from unaudited
  errors (a leak-prevention regression, now pinned by a suppression test), and a shared base
  class was ruled out because the error-convention test requires exactly one `extends Error`
  clause per `*.error.ts` file.

## Considered Alternatives

### Alternative 1: Fold into `@repo/bot-kit` and `@repo/utils`

`createCliLogger` fits bot-kit's logging charter and the monitor helpers fit utils, so the
additive-export route was the default candidate.

**Why rejected:** Maintainers explicitly wanted standalone, focused packages per concern.
Folding the CLI presenter into bot-kit would also have coupled it to the runtime kit's
loglayer/BetterStack dependency set, which the presenter does not need.

### Alternative 2: Also extract the `runContinuously` monitor-loop skeleton

The setup-check, position-bootstrap, and ladder services each carry a ~95-line triplicated
monitor-loop skeleton that a generic runner could absorb.

**Why rejected:** Deferred — the three loops have subtly different cleanup semantics, and the
extraction risk outweighed the dedup win inside this refactor.

### Alternative 3: Also extract the make-service reconciliation stack

The reserve→cancel→publish→confirm reconciliation protocol, the secure ownership state stores,
the Midnight tx-policy asserts, and the send-and-confirm helper are all shared-runtime shaped.

**Why rejected:** Deferred as future `@repo/bot-kit` candidates; extracting them now would have
widened this refactor well past its behavior-preservation budget.

## Assumptions & Constraints

- `@repo/logging` and `@repo/monitoring` stay zero-dependency; `@repo/offers` depends only on
  viem's `Hex` type. Adding heavier dependencies to any of them would erode the reason they are
  standalone.
- `@repo/observability` is the only one of the four allowed to depend on `@repo/bot-kit`, since
  it composes bot-kit's logger and heartbeat.
- The maintainer preference for focused per-concern packages holds. If the workspace ever
  consolidates packages instead, this decision should be revisited with a new TIB.
- The error-convention test (exactly one `extends Error` clause per `*.error.ts` file) remains in
  force — it is what rules out a shared error base class.

## Future Considerations

- `bots/midnight-crossed-books` is the intended second consumer of `@repo/offers`; adopting it
  there validates the `BookOffer` model.
- The deferred extractions — the monitor-loop skeleton, the make-service reconciliation
  protocol, secure ownership state stores, Midnight tx-policy asserts, and the send-and-confirm
  helper — are candidates for `@repo/bot-kit` once a second bot needs them.

## References

- [TIB-2026-07-27-midnight-market-making-bot](./TIB-2026-07-27-midnight-market-making-bot.md) —
  the bot this refactor restructures.
- [TIB-2026-07-16-revert-to-bots-as-programs](./TIB-2026-07-16-revert-to-bots-as-programs.md) —
  establishes bots assembling from shared packages rather than forking a monolith; this TIB adds
  four packages to that library surface.
- [TIB-2026-04-16-bootstrap-curator-bots](./TIB-2026-04-16-bootstrap-curator-bots.md) — the
  workspace scaffold the new packages slot into.

<!--
TIB conventions:
- Once accepted, do not substantively edit this TIB. If the decision needs to change,
  create a new TIB that supersedes this one and update the Status/Superseded by fields.
- Addenda may be appended to record operational updates that affect
  how the TIB is applied without changing the decision itself.
- TIB identifiers use CalVer (YYYY-MM-DD) based on the date the TIB was first drafted.
-->
