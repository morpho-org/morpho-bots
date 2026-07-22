# TIB-2026-07-20: one alert per Take fill via strict leg-pair merging

| Field      | Value            |
| ---------- | ---------------- |
| **Status** | Proposed         |
| **Date**   | 2026-07-20       |
| **Author** | @jinmel          |
| **Scope**  | App: monitor-bot |

---

## Context

A filled offer is **one** on-chain `Take` event, but the transactions API expands it into up to
two items: the buyer's `lend` and the seller's `borrow`. The take-orders poller
(`MarketTransactionsPoller` with `event_types: lend, borrow`) therefore posted two Slack alerts
for every fill — the same trade, twice, with amounts that differ only by the settlement fee. The
API exposes **no shared trade or event id** linking the two legs, so folding them requires
deciding when two items are the same fill without an identifier.

## Goals / Non-Goals

**Goals**

- Alert once per filled offer, naming both counterparties, instead of twice.
- Make the failure mode safe by construction: any uncertainty about whether two legs belong
  together degrades to two single alerts — exactly the pre-merge behavior. A false non-merge is
  noise; a false merge is a wrong alert.
- Preserve filter semantics: `FILTER_USERS` scoping on either the buyer or the seller account
  still surfaces the fill.

**Non-Goals**

- Pairing across ticks. A leg indexed late into a different tick (the `OVERLAP_SECONDS`
  watermark design permits this) alerts singly.
- Pairing a trade leg with an exit-type counterparty leg. When a position crosses zero, one
  side's leg can be an `exit_borrow_secondary`/`exit_lend_secondary` item the take-orders poller
  does not poll; widening its `event_types` to chase those is out of scope.
- Changing alert delivery semantics (at-least-once) or the `TransactionFilter` itself.
- Deduplicating anything other than the two legs of one Take.

## Current Solution

Every `TransactionItem` formatted independently via `formatTransactionAlert` — one fill, two
alerts (`… lend by <buyer>` and `… borrow by <seller>`), each keyed by its own item id.

## Proposed Solution

`mergeTakeLegs` (`bots/monitor-bot/src/pollers/take.ts`) folds a tick's `lend`/`borrow` items
into `TakeEntry`s before formatting; `MarketTransactionsPoller.toAlerts` renders merged pairs
through `formatTakeAlert` (`bots/monitor-bot/src/pollers/format.ts`) and everything else through
the existing per-item path.

### 1. Heuristic pairing key — every shared field, not an id

`takeKey` pairs two legs only when **all** trade-scoped fields the API copies verbatim from the
`Take` event agree — `maker`, `taker`, `buyer`, `seller`, `buyer_assets`, `seller_assets`,
`take_units`, `total_units_delta`, `buyer_pending_fee_increase`, `seller_pending_fee_decrease`,
`payer`, `receiver`, `group`, `consumed` — plus the tx envelope (`chain_id`, `market_id`,
`tx_hash`, `created_at`).

Per-leg attributed fields (`account`, `assets`, `units`) are deliberately **excluded**:
attribution legitimately differs between legs. The two legs always differ by the settlement fee
(`buyer_assets − seller_assets`), and diverge materially when a position crosses zero — part of
the trade then retires existing debt or credit instead of creating it, so a leg's attributed
assets can sit far below the take-level totals.

The key maximizes strictness because the two error directions are asymmetric: a false non-merge
reproduces today's two alerts, a false merge silently claims two unrelated legs are one fill. Any
field disagreement — including an API that starts reformatting a copied field — degrades to
singles, never to a wrong merge.

### 2. Collision safety

Validated against the contract source (`docs/context/repos/midnight-contracts.txt`,
`Midnight.take`, ~lines 1530–1682):

- `consumed` is cumulative per `(maker, group)` and monotonically non-decreasing — each take
  writes back the incremented value, and the manual setter requires `amount >= consumed`. Two
  fills of the **same offer inside one tx** therefore carry different `consumed` values and key
  apart, even though every other trade-scoped field could repeat.
- The only true key collisions are materially identical zero/near-zero-asset takes (nothing to
  increment `consumed` by). There the greedy FIFO pairing — i-th unmatched `lend` with i-th
  unmatched `borrow` under the same key — is harmless: legs identical on every shared field are
  interchangeable by construction.
- One Take can never emit two same-type legs (the buyer leg produces at most one `lend`, the
  seller leg at most one `borrow`), so a key bucket never has to disambiguate lend-vs-lend.

### 3. Either-leg filter semantics

A merged pair is kept when **either** leg passes the `TransactionFilter`
(`MarketTransactionsPoller.toAlerts`). `FILTER_USERS` scoping on either counterparty still
surfaces the fill, and the merged alert then also names the other side — strictly more context
for a watched account than the pre-merge single leg.

### 4. Both legs keep their own attributed amount

`formatTakeAlert` renders `<lend assets> lend by <buyer> + <borrow assets> borrow by <seller>`.
The amounts are not equal (settlement fee) and can differ materially (position-crossing splits —
the buyer leg can be an `exit_borrow_secondary` + `lend` split with attributed assets far below
take-level totals), so eliding either one would misstate the other leg.

### 5. Lossless degradation

Merging can only reduce two alerts to one, never to zero. An unpaired trade leg — counterparty
leg was an exit event type the poller does not fetch, or indexed late into a different tick —
passes through as a single alert on the existing path. The merged alert's key is
`<lendId>+<borrowId>`, preserving the item-id-based idempotency semantics for downstream dedupe.

## Considered Alternatives

### Alternative 1: pair on `tx_hash` + `group` only

A minimal key from the fields most obviously shared by both legs.

**Why rejected:** `group` is offer-scoped, not fill-scoped — it repeats across multiple fills of
the same offer and across distinct takes within one tx. This key false-merges exactly the
multi-fill transactions where correctness matters most.

### Alternative 2: a shared take id from the API

Ask the API to expose the on-chain event identity (e.g. the `Take` log's tx hash + log index) on
both legs, and pair on that.

**Why rejected:** the clean fix long-term, but not available today. Recorded as the trigger for
retiring the heuristic (see Future Considerations).

### Alternative 3: single combined amount in the merged alert

Render one amount (e.g. `buyer_assets`) instead of both legs' attributed figures.

**Why rejected:** the legs genuinely differ (fee wedge, position-crossing splits), so one number
misstates the other leg. Both attributed amounts stay in the sentence.

## Assumptions & Constraints

- The API expands each Take into at most one `lend` and at most one `borrow` item, copying the
  event's trade-scoped fields **verbatim**. If the API begins normalizing or reformatting any
  copied field per leg, merging silently stops — safe (back to two alerts per fill), but the
  point of the change is lost.
- `consumed` stays cumulative and monotonically non-decreasing per `(maker, group)` on-chain; the
  same-offer-same-tx collision argument rests on it.
- Both legs of a fill are usually indexed into the same tick's fetch window; legs split across
  ticks alert singly by design.

## Observability

No new log events. The observable change is the alert `key`: a merged fill carries
`<lendId>+<borrowId>` instead of two separate item ids. Consumers deduping on `key` (the
at-least-once redelivery handle after a Slack failure) see one stable composite key per fill;
redelivery reproduces the same key.

## Future Considerations

- **Adopt a server-side take id when the API grows one.** The pairing key is a heuristic standing
  in for an identifier the API does not expose; a shared id would replace `takeKey` outright and
  delete the collision analysis.
- **Exit-leg counterparties always alert singly.** If curators find lone `lend` legs from
  position-crossing takes confusing, the fix is widening coverage or annotating singles — not
  loosening the key.

## References

- `bots/monitor-bot/src/pollers/take.ts` — `mergeTakeLegs` + `takeKey`.
- `bots/monitor-bot/src/pollers/format.ts` — `formatTakeAlert`.
- `bots/monitor-bot/src/pollers/market-transactions.poller.ts` — `toAlerts`, either-leg filter.
- `bots/monitor-bot/README.md` — "Market transaction pollers", the operator-facing description.
- `docs/context/repos/midnight-contracts.txt` — `Midnight.take` (~lines 1530–1682), the `Take`
  event fields and `consumed` semantics.
- [TIB-2026-07-20-monitor-bot-nestjs-stack](./TIB-2026-07-20-monitor-bot-nestjs-stack.md) — the
  bot's stack and poller foundation.
