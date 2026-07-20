# TIB-2026-07-20: book-wide make-order coverage via snapshot diffing

| Field      | Value            |
| ---------- | ---------------- |
| **Status** | Proposed         |
| **Date**   | 2026-07-20       |
| **Author** | @jinmel          |
| **Scope**  | App: monitor-bot |

---

## Context

monitor-bot's make-order poller originally read `/v0/midnight/users/{user}/offer-groups`, a
per-maker endpoint. That shape forced a `WATCH_MAKERS` allowlist, and the poller was disabled
outright when the var was unset — so out of the box the bot watched no make orders at all. A
curator wants to see liquidity appear and disappear on markets they care about regardless of who
posted it, which the per-maker shape cannot express.

Make orders are also structurally unlike the market transactions the other four pollers read.
Transactions are an append-only feed with stable ids and a time watermark. Offers are off-chain
EIP-712 signatures exposed as an **active-only** view: no ids, no change feed, no "what changed
since" query. The existing `CursorStore` abstraction assumes a resume position, which does not
exist here.

## Goals / Non-Goals

**Goals**

- Cover the whole protocol book by default, with no maker allowlist and no configuration required
  to get useful alerts.
- Detect make-order posts, size changes, and disappearances from an endpoint that offers no change
  feed.
- Give the poller base class a state concept that is honest about its lifetime, so a future
  persistent `CursorStore` cannot accidentally persist a snapshot.
- Fail loudly rather than emit fabricated alerts when upstream data is truncated.

**Non-Goals**

- Distinguish _why_ an offer disappeared. Cancelled, expired, and fully consumed are
  indistinguishable in a snapshot diff, and this TIB does not try to tell them apart.
- Track individual offers. Identity is a bucket, not a signature — see Proposed Solution.
- Full-depth price levels. Sizing coverage for unit-capped offers stays partial (see Future
  Considerations).
- Alert on takes. The `units` field moving is already covered by the market transaction pollers.
- Persist any poller state. The repo's cross-tick-state philosophy (in-process only, API truth
  wins on restart) is unchanged.

## Current Solution

`OfferGroupsPoller` read `/v0/midnight/users/{user}/offer-groups` once per allowlisted maker and
diffed each maker's offer groups. `WATCH_MAKERS` was a public env var; unset meant the poller did
not register. Coverage was therefore whatever set of addresses an operator had thought to type in,
and a new maker entering the book was invisible until someone noticed and edited the config.

## Proposed Solution

`BookOffersPoller` (`bots/monitor-bot/src/pollers/book-offers.poller.ts`) reads the protocol-wide
book and diffs snapshots.

### 1. Book-driven endpoint pair

Each tick:

1. `/v0/midnight/books` supplies the **active-market universe** (past maturities excluded) plus the
   top price levels per side. `MARKET_IDS` narrows it through the `ids` filter; unset means the
   cursor is walked to sweep every active book.
2. For each market, each populated side expands through
   `/v0/midnight/books/{id}/{side}/takeable-offers` into individual signed offers.

No maker allowlist is involved at any point, and `WATCH_MAKERS` is removed entirely. `MARKET_IDS`
remains the only scoping knob, which is the axis a curator actually thinks in.

Markets are swept in chunks of `MARKET_CONCURRENCY` (8). Per-market expansion is error-isolated: a
market that persistently fails keeps its previous snapshot and retries, so it cannot starve every
other market's alerts. Only a sweep where _every_ market failed aborts the tick.

### 2. Synthetic offer identity

Takeable offers carry no server-side id, and an offer is an immutable signature — a maker changes
one by cancelling and re-signing. Identity is therefore derived from the fields that survive a
re-sign:

```text
(market, side, maker, group, tick)
```

Offers sharing that tuple form one **bucket**, with `max_units` and `max_assets` summed and
`count` retained for display. This is also the number an operator cares about: "this maker has N
at this tick."

The consequence is deliberate: a maker who re-signs at a different size produces a `resized` event
rather than a `closed` followed by a `created`. Comparison is on the signed caps only —
`expiry` and the takeable `units` field are excluded because both churn constantly (offers roll;
takes are the transaction pollers' surface).

The bucket key checksums the maker address, so a casing change in an API response cannot silently
re-key every bucket and read as a total book turnover. A malformed maker address is logged
(`poll.invalid_maker`) and skipped rather than thrown on — failing the market over one bad row
would wedge it forever, never baselining.

### 3. `BootSnapshot` as a state concept distinct from `Cursor`

The base `Poller` depends on a neutral `PollerStateStore` shape
(`bots/monitor-bot/src/polling/poller.ts`). Two concrete stores implement it and do **not** share a
type or a Nest token:

| Store               | Meaning                       | Safe to persist?                  |
| ------------------- | ----------------------------- | --------------------------------- |
| `CursorStore`       | A resume position (watermark) | Yes — a durable impl could replay |
| `BootSnapshotStore` | The previous observation      | **Never**                         |

Calling the book poller's state a "cursor" was simply wrong: there is no position to resume from,
because the state _is_ the previous observation and items come from the diff against it. The name
`BootSnapshot` records the lifetime — exactly one process lifetime. The first tick per market
establishes a silent baseline (`poll.baseline`), because alerting the entire standing book on every
deploy would be pure noise, and a restart drops the snapshot so the next boot re-baselines.

The key invariant, and the reason the two stores stay separate despite sharing a shape today: **a
boot snapshot must never be persisted.** A stale snapshot diffed against live data would report
every change made while the process was down as if it had just happened. Keeping the tokens
separate means a future persistent `CursorStore` cannot pick up boot snapshots by accident.

### 4. Truncation is failure, not data

Three guards, all with the same reasoning — a truncated snapshot fabricates spurious `closed`
events and then re-fabricates the matching `created` events on the next tick:

- **`takeable-offers` at its 1000-offer cap** fails that market. The snapshot is carried, the
  market is retried, `poll.offers_capped` is logged.
- **A books listing that never stops paginating** (`MAX_BOOK_PAGES`) aborts the whole tick, leaving
  state untouched.
- **The `ids` path asserts no cursor came back.** If the API's `ids` and `limit` caps ever diverge,
  a dropped page would silently shrink the market universe and forget every market it omitted.

This is a deliberate divergence from `MarketTransactionsPoller`, which logs and returns partial
data at its own page cap. The asymmetry is intentional: a truncated **transaction page** only
defers items to the next tick, whereas a truncated **market universe** forgets snapshots.

### 5. Empty-side skip, and why it is conditional

Skipping the `takeable-offers` request for a side with no price levels saves up to two round trips
per empty market. But levels are aggregated **executable** liquidity from a different
endpoint than the offers, and `takeable-offers` retains non-executable offers with `units: 0`. A
side can therefore report zero levels while its offers still stand — indexer skew, or every offer
momentarily unexecutable. Skipping in that state would record the side as empty and close every
bucket on it, then re-open them all next tick.

The skip is consequently applied **only when the side was also empty in the previous snapshot**.
Re-checking a side that held buckets costs one request on the tick it actually drains, and nothing
thereafter. (This was caught in review; the unconditional version was the first implementation.)

## Considered Alternatives

### Alternative 1: `/v0/midnight/takeable-offers`

The flat protocol-wide takeable-offers endpoint, which would avoid the two-step books → offers
expansion.

**Why rejected:** its `maker` parameter is required, so it reintroduces exactly the per-maker
allowlist this change exists to remove.

### Alternative 2: Diff `/v0/midnight/books` alone, without expanding to offers

Treat the book listing itself as the signal: diff the per-tick aggregated price levels and alert on
best-price moves and liquidity changes. Roughly 1/20th the request volume, since no per-market
expansion is needed.

**Why rejected:** the aggregated levels carry no `maker`, no `group`, and no `expiry`, so alerts
degrade from "this maker posted N at this tick" to "liquidity at this tick moved" — and only for
the top 3 levels per side. That loses the attribution a curator needs to act.

### Alternative 3: Reuse `CursorStore` for the snapshot

The shapes are identical today, so one store and one token would work.

**Why rejected:** it conflates a resume position with an observation. The moment anyone implements
a persistent `CursorStore` — which the interface explicitly invites — boot snapshots would be
persisted too, and the first restart would emit every change that happened while the process was
down. The type-level separation is the guard.

## Assumptions & Constraints

- An offer's `(market, side, maker, group, tick)` tuple is stable across a cancel-and-re-sign. If
  makers begin re-signing at different ticks routinely, resizes will read as close/create pairs.
- `/v0/midnight/books` lists all and only active markets, and `limit`/`ids` both cap at 20.
- `takeable-offers` is unpaginated and trims to the best-priced 1000. A market legitimately
  exceeding 1000 offers on one side cannot be monitored by this poller at all — it will fail every
  tick, loudly.
- Alert delivery is at-least-once, with a nuance relative to the base class: a failed dispatch
  re-diffs against the stale snapshot next tick, which re-derives still-visible events — but an
  ephemeral change (posted then gone, or resized back) between the failure and the retry is lost.
- Cross-tick state stays in-process. This is a correctness requirement here, not a deferral.

## Dependencies

- Midnight REST API: `/v0/midnight/books`, `/v0/midnight/books/{id}/{side}/takeable-offers`.
- [TIB-2026-07-20-monitor-bot-nestjs-stack](./TIB-2026-07-20-monitor-bot-nestjs-stack.md) — the
  NestJS/DI foundation whose token-based composition makes the two-store split enforceable.

## Observability

New structured log events, all carrying `pollerId: 'make-orders'`:

| Event                | Level | Meaning                                                      |
| -------------------- | ----- | ------------------------------------------------------------ |
| `poll.baseline`      | info  | First snapshot for a market; bucket count. Expected at boot. |
| `poll.market_error`  | warn  | One market's expansion failed; snapshot carried, will retry. |
| `poll.offers_capped` | warn  | `takeable-offers` hit 1000 — that market is unmonitorable.   |
| `poll.pages_capped`  | warn  | Books pagination hit `MAX_BOOK_PAGES`; the tick then aborts. |
| `poll.invalid_maker` | warn  | Malformed maker address in an API row; offer skipped.        |

`poll.offers_capped` and `poll.pages_capped` are the ones worth alerting on — both mean the poller
is silently blind to part of the book rather than degraded. A sustained `poll.market_error` on the
same market means that market never baselines.

A burst of `poll.baseline` lines outside of a deploy indicates markets are dropping in and out of
the book listing.

## Future Considerations

Recorded as deferred, not solved:

- **Unit-capped sizing is partial.** `FILTER_MIN_ASSETS` is denominated in loan-token assets, but
  the books LIST response carries only the top 3 levels per side, so a unit-capped bucket
  (`max_assets = "0"`) can only be sized when its tick is among those 3. Unpriced buckets are
  passed through the filter rather than dropped — a wrong drop loses an alert permanently, a wrong
  pass is only noise. Note that most `closed` events are unpriced, since a bucket usually vanishes
  precisely because its tick drained. Fixing this properly means full-depth levels via
  `books/{id}?depth=` (up to 5821, one request per market); deferred because `FILTER_MIN_ASSETS`
  defaults to off.
- **Listing gaps lose coverage.** A market that leaves the book listing — matured, delisted, or a
  transient gap — has its snapshot forgotten rather than reported as a wall of `closed` alerts, and
  re-baselines quietly if it returns. Changes during the gap are missed.
- **Restart re-baselines every market**, so changes across a restart are invisible. This is the
  direct cost of the never-persist invariant and is accepted.
- **The chunked-concurrency sweep is near-duplicated** between `BookOffersPoller` and
  `MarketTransactionsPoller`. Hoisting a shared helper was identified in review and deferred.

## References

- [TIB-2026-07-20-monitor-bot-nestjs-stack](./TIB-2026-07-20-monitor-bot-nestjs-stack.md) — the
  bot's stack, DI tokens, and poller foundation.
- `bots/monitor-bot/README.md` — "Make-order poller", the operator-facing description of this
  behaviour and its boundaries.
- `bots/monitor-bot/src/pollers/book-offers.poller.ts` — the poller.
- `bots/monitor-bot/src/snapshot/boot-snapshot.store.ts` — the state concept and its never-persist
  invariant.
