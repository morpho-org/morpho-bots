# TIB-2026-08-23: Quoter-bot monitoring event vocabulary

| Field      | Value           |
| ---------- | --------------- |
| **Status** | Proposed        |
| **Date**   | 2026-08-23      |
| **Author** | @haydenshively  |
| **Scope**  | App: quoter-bot |

---

## Context

`quoter-bot`'s only alert today is "the bot crashed." The V2 - Monitoring milestone
([MKT-1785](https://linear.app/morpho-labs/issue/MKT-1785)) asks for alerting on PnL anomalies with
market-making-vs-carry attribution, inventory and exposure, losses, stale reference data, fills, and
halt/guardrail triggers.

**The transport already exists.** `src/index.ts` wires `createBotObservability` from
`@repo/observability`, which uses the same `@repo/bot-kit` `createLogger` + `createHeartbeatMonitor`

- `railwayContext` stack as `blue-liquidation` and `midnight-liquidation`, gated on the same
  both-or-neither `BETTERSTACK_SOURCE_TOKEN` + `BETTERSTACK_INGESTING_HOST` opt-in established in
  [TIB-2026-07-14-betterstack-log-forwarding](./TIB-2026-07-14-betterstack-log-forwarding.md).
  Lifecycle events, process observers, and the heartbeat are live.

**The vocabulary does not.** `packages/observability/src/bot-observability.utils.ts` falls back to
`event: 'bot.action'` for any record lacking an `event` field, and nearly every per-cycle report the
bot emits lacks one. Better Stack therefore receives a stream of `bot.action` records carrying
nested `LadderRunResult[]` and `SetupCheckReport` blobs. No metric expression can aggregate that
shape. The liquidation bots, by contrast, emit a flat named vocabulary — `tick.end`,
`simulate.revert`, `tx.sent` — that aggregates cleanly.

This is a what-to-emit problem, not a plumbing problem.

[TIB-2026-07-27-midnight-quoter-bot](./TIB-2026-07-27-midnight-quoter-bot.md) set V0's observability
floor as "log fills, position, and P&L to console/file — real monitoring is V2." This TIB is that
V2. MKT-1785's hard constraint is **generalizable**: this ships inside the open-source reference
implementation and must monitor whatever instance a third party spins up.

## Goals / Non-Goals

**Goals**

- A flat, named, low-cardinality event vocabulary that Better Stack can aggregate and alert on.
- Visibility into _silent_ degradations. `MKT-1721` and `MKT-1842` deliberately made rate clamps and
  cross-book repricing non-throwing, so a ladder quoting at its bound instead of its target is
  invisible today.
- Fill notifications derived correctly, not approximately.
- Position primitives sufficient for downstream PnL attribution.
- A contract documented well enough that a fork can build its own monitoring against it.

**Non-Goals**

- An in-bot PnL attribution engine. The bot emits no `pnl` or `loss` event at all.
- A per-rung execution ledger.
- A second telemetry stream separate from stdout.
- Checked-in dashboard or alert definitions.
- Slack routing — a Better Stack integration, not bot code.
- V1 signing-middleware rejection events. `sign.rejected` is reserved, not implemented.
- Any change to `@repo/observability` or `@repo/bot-kit`.

## Current Solution

`src/index.ts` composes `createBotObservability({bot: 'quoter-bot', chainId: BASE_CHAIN_ID,
errorName: operatorErrorName})` with `installProcessObservers`. `enhanceVerboseArgv` auto-appends
`--verbose` for `start`, `bootstrap`, and `ladder` when shipping is configured.
`src/infrastructure/cli/quoter-bot-entrypoint.ts` mirrors every `writeEvent` value into both
`observability.record` and the `@repo/logging` CLI presenter.

Named events today: `bot.started`, `bot.stopped`, `bot.unexpected-error`, `heartbeat.failed`,
`quoter-bot.cycle`, `ladder.transaction-submitted`, `bootstrap.transaction-submitted`,
`offer-invalidation.transaction-submitted`, `readonly.make`. Everything else ships as `bot.action`.

## Proposed Solution

### Technical decisions

**Reuse the transport unchanged.** No new dependency and no second sink. The opt-in stays
both-or-neither, so a fork with neither variable set makes zero network calls — that property is
what lets a third party run the reference implementation with no Morpho infrastructure.

**Every shipped record carries `event`.** The `bot.action` fallback becomes unreachable for this
bot. Names are `<domain>.<kebab-verb>`, matching the bot's existing `ladder.transaction-submitted`.
The liquidators use `snake_case` suffixes; the repo is already inconsistent across bots, so
consistency _within_ a bot wins over a cross-bot rename.

**Flat scalar payloads with bounded dimensions.** Better Stack metric expressions cannot aggregate
nested arrays. Grouping dimensions are limited to `workflow`, `marketId` (allowlisted through
`MARKET_IDS`), `side`, `status`, `stage`, `reason`, `check`, `bound`, and `operation`. `txHash` and
`groupId` are trace-only correlation fields and must never be used as dimensions. Error
classification always goes through `operatorErrorName`
(`src/application/operator-error-name.utils.ts`), already the sanitization chokepoint — raw error
text, provider payloads, and URLs never ship.

**`schemaVersion` rides bound logger context, not each event.** `createLogger` already binds `bot`,
`chainId`, and `railwayContext` into every record. Adding `schemaVersion` there stamps the entire
stream at zero per-event cost and lets consumers pin a contract version.

**Units contract, stated once.** Every `*Assets` field is an unsigned raw smallest-unit amount of
the configured `loanAsset`. Every `*Bps` field is an integer basis-point value. Both serialize as
decimal strings, because `packages/bot-kit/src/logger.ts`'s `toJsonSafe` flattens `bigint` before
loglayer sees it. Signed fields are named explicitly and carry their sign convention in the README
table. The bot never reads token decimals and this TIB does not add that read; `loanAsset` ships in
the startup manifest and a consumer wanting human-readable units resolves decimals from the address.

**One stream.** Telemetry flows through the existing `writeEvent` seam, so stdout and Better Stack
stay identical. `--verbose` is already auto-enabled under shipping, so shipped deployments already
compute the inputs these projections need. Splitting the streams is recoverable later if stdout
volume becomes a real problem; doing it pre-emptively is not worth the seam.

**Projection, not new reads.** Every field below already exists in `LadderVerboseDetails`,
`LadderMarketState`, `LadderQuoteSet`, `BootstrapPosition`, the `calculateLadderCapacities` inputs,
or indexed group records. No additional RPC. Two exceptions are new instrumentation and are marked
as such: `cycle.completed.durationMs` needs timing at the cycle boundary, and the guardrail counts
need diagnostics returned from the domain.

**The domain stays pure.** `clampRateBps` returns only a `bigint`; `generateLadder` returns only a
quote set. Clamp, clearance, and truncation counts must therefore be _returned_ as diagnostics
alongside those results and projected into events at the application layer. No logger is injected
into `src/domain/`.

**Guardrails emit aggregates, never per rung.** `MAX_LADDER_RUNG_COUNT` is 512 per side and
`loopIntervalSeconds` may be as low as one second. Per-rung clamp events reach millions of records
per day per market. One record per side per cycle, carrying a count, emitted only when that count is
non-zero.

**Fills come from per-group `consumed` deltas, not quote-set diffs.** See Alternative 2 — the
quote-set diff is incorrect, not merely coarse. Two limitations are inherent and documented rather
than hidden: equal-tick rungs merge into one protocol group and `reconstructOwnedLadderPublication`
prorates a group's remainder across its stored rungs, so the reported rate is the _group's_ rate and
not a per-rung execution ledger; and a restart establishes a fresh baseline, so the first cycle after
one emits nothing.

**PnL primitives only.** Attribution needs cost basis across restarts, which conflicts with the
stateless rebuild-from-chain design that V0 calls "what makes the reference forkable." The bot emits
the inputs; attribution is a downstream computation, editable without a redeploy.

**The heartbeat stays process-level.** `QuoterBotService.runContinuously` is fail-together: any
workflow halt aborts its peers and the process exits. One `BETTERSTACK_HEARTBEAT_URL` therefore
covers all three workflows. It proves process liveness only — it cannot prove that a particular
market was read or quoted — which is why per-market positive anchors exist below.

**Alerting lives in Better Stack.** The bot's job is to emit alertable signals. Alert rules are
configured against the documented contract.

### Event vocabulary

Retained unchanged: `bot.started`, `bot.stopped`, `bot.unexpected-error`, `heartbeat.failed`,
`ladder.transaction-submitted`, `bootstrap.transaction-submitted`,
`offer-invalidation.transaction-submitted`, `readonly.make`.

| Event                          | Fields                                                                                                                                                                            | Why                                                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `bot.configured`               | `marketIds`, `ladderIntervalSeconds`, `bootstrapIntervalSeconds`, `loanAsset`, `referenceMode`, `readOnly`                                                                        | Startup manifest. Anchors every absence alert — a consumer cannot otherwise know the configured market set or cadence |
| `cycle.completed`              | `workflow`, `marketId`, `status`, `stage?`, `action?`, `reason?`, `durationMs` _(new instrumentation)_, `errorName?`                                                              | Per-market cycle health, and the positive per-market anchor absence alerts need                                       |
| `guardrail.rate-clamped`       | `workflow`, `marketId`, `side`, `clampedRungs`, `bound`, `minimumRateBps`, `maximumRateBps`                                                                                       | `clampRateBps` fires silently today. Aggregated per side per cycle                                                    |
| `guardrail.cross-book-cleared` | `workflow`, `marketId`, `side`, `clearedRungs`, `clearanceBps`                                                                                                                    | `CROSS_BOOK_CLEARANCE_BPS` repricing, silent today. Aggregated                                                        |
| `guardrail.exposure-capped`    | `workflow`, `marketId`, `requestedAssets`, `cappedAssets`, `cap`                                                                                                                  | Which inventory limit actually bound                                                                                  |
| `guardrail.rungs-truncated`    | `marketId`, `side`, `configuredRungs`, `fundedRungs`                                                                                                                              | Ladder quietly thinner than configured when budget under-funds rungs                                                  |
| `guardrail.spread-rejected`    | `marketId`, `errorName`                                                                                                                                                           | Negative-spread guard (`BootstrapAdapterError('negative-spread')`)                                                    |
| `guardrail.halted`             | `workflow`, `marketId?`, `stage`, `reason`, `strategyInvalidated`                                                                                                                 | A hard halt pulls every offer. Distinguishes "halted safely" from "process died"                                      |
| `reference.observed`           | `marketId`, `referenceRateBps`, `targetRateBps`, `referenceMode`                                                                                                                  | Reference health. Event time is the staleness anchor                                                                  |
| `position.observed`            | `marketId`, `cashBalanceAssets`, `creditAssets`, `otherMarketCreditAssets`, `reservedAssets`, `marketReservedAssets`, `maturityTimestamp`, and the four derived `*CapacityAssets` | Accounting primitives, not just headroom. The PnL and loss foundation                                                 |
| `bootstrap.progress`           | `marketId`, `creditAssets`, `creditTargetAssets`, `shortfallAssets`, `mode`                                                                                                       | Bootstrap-to-quote transition. `mode` projects `initialTargetCompleted`                                               |
| `book.observed`                | `marketId`, `side`, `state`, `rungs`, `totalAssets`, `bestRateBps`, `worstRateBps`, `centerRateBps`                                                                               | Owned quote state. `state` is `indexed`, `pending-index`, or `empty`                                                  |
| `offer.consumed`               | `marketId`, `side`, `consumedDeltaAssets`, `groupRateBps`, `remainingAssets`, `groupId` _(trace)_                                                                                 | Fills, from monotonic per-group `consumed` deltas. PnL primitive                                                      |
| `setup.ready`                  | `ready`                                                                                                                                                                           | Readiness gauge                                                                                                       |
| `setup.check-failed`           | `check`, `errorName?`                                                                                                                                                             | Which of the nine checks broke                                                                                        |
| `transaction.settled`          | `workflow`, `operation`, `status`, `errorName?`, `txHash` _(trace)_                                                                                                               | `*.transaction-submitted` fires before the receipt; this closes the loop with a failure kind                          |
| `sign.rejected`                | _reserved_                                                                                                                                                                        | V1 guardian/KMS middleware rejections                                                                                 |

**`position.observed` carries balances, not headroom.** `calculateLadderCapacities`
(`src/infrastructure/ladder/ladder-capacity.utils.ts`) returns
`lowerRateCapacityAssets = min(currentCredit, creditSaleCapacityAssets)` and
`higherRateCapacityAssets = min(unreservedCash, lendRoom)` — capped room, from which no position
value can be reconstructed. The actual primitives are that function's own discarded _inputs_
(`balance`, `currentCredit`, `otherMarketCredit`, `reserved`, `marketReserved`); the bootstrap
workflow already models them directly as `BootstrapPosition`. Both capacities and balances ship:
capacities explain the bot's decision, balances support the PnL derivation. `maturityTimestamp` is
required because a fixed-rate credit claim's carry is a function of time to maturity, and without it
carry cannot be separated from trading PnL downstream.

**`setup.check-failed` deliberately omits `observed` and `required`.** Both are typed `unknown` on
`SetupCheck` and may hold objects, violating the flat-scalar rule.

**`book.observed` is named for what it measures.** `readActive` reconstructs durable _owned intent_
from indexed book state plus persisted ownership, and an API-missing group deliberately stays active
to prevent unsafe republication. It is not proof of live-book presence, so the event is not called
`book.quoted` and carries an explicit `state`.

### Alert catalog

| Requested alert       | Signal                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| Crash                 | Missed heartbeat, `bot.unexpected-error`, or `bot.stopped` with `reason != 'signal'`                    |
| Halt / guardrail      | `guardrail.halted`; guardrail counts over a window                                                      |
| Stale reference       | Absence of `reference.observed` per market beyond two intervals, scoped by `bot.configured`             |
| Inventory / exposure  | `position.observed` gauges plus `guardrail.exposure-capped`                                             |
| Fills                 | `offer.consumed`                                                                                        |
| PnL anomalies, losses | Derived downstream from `offer.consumed`, `position.observed`, and `maturityTimestamp`                  |
| Not quoting           | `book.observed` with `state: 'empty'`, or absence of `cycle.completed` for a market in `bot.configured` |

### Implementation Phases

- **Phase 1 — contract:** typed event union and flat projection helpers under `src/application/`,
  declared as arrow constants in `*.utils.ts`; `schemaVersion` bound into logger context.
- **Phase 2 — domain diagnostics:** return clamp, clearance, and truncation counts from
  `generateLadder` and `decidePositionBootstrap` without breaking purity.
- **Phase 3 — accounting primitives:** surface the `calculateLadderCapacities` inputs and
  `maturityTimestamp` alongside the derived capacities.
- **Phase 4 — wire projections:** emit from the ladder, bootstrap, and setup cycle boundaries through
  the existing `writeEvent` seam; add cycle timing; emit `bot.configured` at startup.
- **Phase 5 — consumption diff:** in-process previous-`consumed`-per-group cache and delta emission.
- **Phase 6 — docs:** event and units contract tables in `bots/quoter-bot/README.md` and
  `bots/quoter-bot/docs/reference.md`.

## Considered Alternatives

### Alternative 1: Keep `bot.action` and query the nested JSON in Better Stack

Leave the reports as they are and write metric expressions that reach into nested
`LadderRunResult[]` and `SetupCheckReport` structures.

**Why rejected:** Expressions over nested arrays are fragile, and the report schema is unversioned
and shaped for operator reading rather than aggregation. Every report refactor silently breaks every
alert built on it, with no compile-time or test-time signal.

### Alternative 2: Detect fills by diffing the active quote set between cycles

Compare the `LadderMakeService.readActive` quote set against the previous cycle's and treat any
shrinkage as a fill.

**Why rejected:** Incorrect, not merely coarse. `MidnightLadderMakeService.reconcile` reserves _new_
group IDs and then invalidates the old ones on every `recenter` and `resize`, so the active set
churns for reasons unrelated to takers, and the diff cannot separate the two. Per-group `consumed`
is the correct quantity: `reconstructOwnedLadderPublication` reads `maxAssets` and `consumed` per
indexed group, and `consumed` is monotonic — the bot's own cancel and republish never decrement it.

### Alternative 3: Use the capacity gauges as the PnL primitive

Emit `LadderMarketState`'s four capacity values and let the downstream derive PnL from them.

**Why rejected:** They are headroom, not balances. `calculateLadderCapacities` collapses cash,
credit, reservations, and exposure limits into a single `min`, which is not invertible. No
attribution is recoverable.

### Alternative 4: Emit one guardrail event per affected rung

Emit a `guardrail.rate-clamped` record carrying `requestedRateBps` and `clampedRateBps` for each
rung that hit a bound.

**Why rejected:** 512 rungs per side against a `loopIntervalSeconds` as low as one second produces
millions of records per day per market. Aggregate counts answer the operator's question — "is the
ladder quoting at its bound?" — at three orders of magnitude less volume.

### Alternative 5: A separate telemetry stream

Add an `emit(event, fields)` seam that ships without printing, decoupling stdout cardinality from
Better Stack cardinality.

**Why rejected:** Chosen against for simplicity. The cost is stdout noise, which is recoverable
later; the cost of a second seam is paid immediately and permanently.

### Alternative 6: An on-chain fill indexer

Watch Midnight take/fill logs for per-trade fidelity.

**Why rejected:** Reintroduces the rindexer and Postgres infrastructure the repo deliberately
removed, and a third-party fork cannot run it — a direct conflict with the generalizability
constraint.

### Alternative 7: An in-bot PnL engine with persisted cost basis

Track cost basis across restarts and emit attributed PnL directly.

**Why rejected:** Requires durable state, conflicting with rebuild-from-chain restart semantics.

### Alternative 8: Adopt the liquidators' `snake_case` event names

**Why rejected:** Renames the bot's three already-shipped events for no operator gain, and the repo
has no single cross-bot convention to converge on.

## Assumptions & Constraints

- `MARKET_IDS` stays small enough that `marketId` is a safe grouping dimension.
- `--verbose` remains auto-enabled under shipping through `enhanceVerboseArgv`; the projections read
  verbose-only data.
- Better Stack stays optional. A fork with the variables unset behaves identically minus shipping.
- A restart loses the per-group `consumed` baseline, so the first cycle after one emits no
  `offer.consumed`.
- `scripts/check-jsdoc.ts` requires substantive JSDoc on every new exported symbol, and any new error
  class must satisfy `test/error-convention.test.ts`.

## Future Considerations

- `sign.rejected` lands when the V1 signing middleware
  ([TIB-2026-08-12-quoter-bot-kms-signing-middleware](./TIB-2026-08-12-quoter-bot-kms-signing-middleware.md))
  ships.
- Token decimals are not read today. If human-readable inventory becomes a requirement, add a
  one-shot `decimals()` read at startup and extend `bot.configured` rather than annotating every
  record.
- A Better Stack dashboard and alert set built against this contract, exportable as JSON so a fork
  can import it, is deliberately out of scope here.

## Addendum A (2026-08-25) — the shipped vocabulary as implemented

The decision is unchanged. Implementation and two review rounds moved the vocabulary away from the
table above; `bots/quoter-bot/docs/reference.md` is now the authoritative event contract, and this
records the deltas.

| Change                                                                                                               | Reason                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `bot.configured.marketIds` and `.ladderIntervalSeconds` removed                                                      | One process-wide cadence made slower markets look overdue; both move to `market.configured`              |
| `market.configured` added (`marketId`, `ladder`, `bootstrap`, `ladderIntervalSeconds?`)                              | Per-market absence scoping, and it distinguishes a market missing a cycle from one never configured      |
| `bot.failed` added (`workflow?`, `reason`, `errorName?`)                                                             | Covers a startup readiness failure and the fail-together halt, which no cycle record can describe        |
| `guardrail.cross-book-cleared.clearanceBps` removed                                                                  | `CROSS_BOOK_CLEARANCE_BPS` is a code constant, not an observation                                        |
| `bootstrap.progress.shortfallAssets` removed                                                                         | Exactly `max(creditTargetAssets - creditAssets, 0)` over two shipped fields                              |
| `bootstrap.progress.mode` removed                                                                                    | `initialTargetCompleted` is an internal latch; `cycle.completed.action` already shows the transition     |
| `setup.ready` removed                                                                                                | Restates `cycle.completed { workflow: "setup-check" }.status` once a minute                              |
| `transaction.settled.status` and `errorName?` removed                                                                | A settled transaction is confirmed by definition; the pre-receipt `*.transaction-submitted` names remain |
| `guardrail.spread-rejected.errorName` removed                                                                        | The event name is the signal, and the paired `cycle.completed` carries the classification                |
| `setup.check-failed.errorName` removed                                                                               | `SetupCheck` carries no error classification; `observed`/`required` are `unknown` and not flat scalars   |
| `reference.observed` gained `workflow`; `cycle.completed.marketId` and `guardrail.rate-clamped.side` became optional | Bootstrap shares both projections and reports one rung with no side                                      |

Two deviations from the table remain, both structural rather than deliberate simplifications.
`book.observed.state` is `quoting` or `empty` rather than `indexed` / `pending-index` / `empty`,
because `readActive` reconstructs indexed and not-yet-indexed groups into one quote set and a
pending-index state is not observable at that seam. `reference.observed` carries no `referenceMode`,
because `LadderConfig` does not declare `targetRate`: the strategy is applied above the domain
type the projection reads.

## References

- [MKT-1785 — Monitoring & alerting spec](https://linear.app/morpho-labs/issue/MKT-1785)
- [Quoting bot project — V2 Monitoring](https://linear.app/morpho-labs/project/quoting-bot-628e80069e52/overview)
- [TIB-2026-07-14-betterstack-log-forwarding](./TIB-2026-07-14-betterstack-log-forwarding.md) — the opt-in shipping contract this inherits
- [TIB-2026-07-27-midnight-quoter-bot](./TIB-2026-07-27-midnight-quoter-bot.md) — set the V0 observability floor this replaces
- [TIB-2026-08-14-quoter-cross-book-clearance](./TIB-2026-08-14-quoter-cross-book-clearance.md) — the clearance repricing this makes visible

<!--
TIB conventions:
- Once accepted, do not substantively edit this TIB. If the decision needs to change,
  create a new TIB that supersedes this one and update the Status/Superseded by fields.
- Addenda may be appended to record operational updates that affect
  how the TIB is applied without changing the decision itself.
- TIB identifiers use CalVer (YYYY-MM-DD) based on the date the TIB was first drafted.
-->
