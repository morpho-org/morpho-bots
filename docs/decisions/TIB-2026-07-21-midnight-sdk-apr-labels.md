# TIB-2026-07-21: midnight-sdk APR labels in make-order alerts

| Field      | Value            |
| ---------- | ---------------- |
| **Status** | Proposed         |
| **Date**   | 2026-07-21       |
| **Author** | @jinmel          |
| **Scope**  | App: monitor-bot |

---

## Context

monitor-bot's make-order alerts (the book-offers poller from
[TIB-2026-07-20-book-offer-snapshot-diffing](./TIB-2026-07-20-book-offer-snapshot-diffing.md))
rendered a raw order-book tick in every headline: `Make order posted: 20M USDC lend @ tick 495`. A
Midnight tick encodes a zero-coupon price, not a rate — operators cannot read it, and it does not
match the APRs the Morpho fixed-rate app shows for the same offers. Annualizing a tick correctly
requires Midnight's exact on-chain math (half-down division, `PRICE_ROUNDING_STEP` price snapping),
which the repo did not have.

## Goals / Non-Goals

**Goals**

- Render make-order rates as the annualized APR the Morpho fixed-rate app shows, so operator
  numbers match the app.
- Use the protocol's own tick math — exact parity with on-chain rounding, not a reimplementation.
- Keep the `bunfig.toml` supply-chain gate (`minimumReleaseAge`) intact while adopting the SDK.
- Never surface raw ticks in alert text.

**Non-Goals**

- Taker-side net rates. The label is the maker's gross quote; a taker's realized rate differs by
  the settlement fee.
- Changing bucket identity or dedupe. The tick still keys `bucketKey` in
  `book-offers.poller.ts` — it is only never rendered.
- Adopting `@morpho-org/midnight-sdk` in other bots, or replacing the per-bot openapi-typescript
  artifacts with SDK clients.
- Fixing `formatUint256Percent`'s truncation in `@repo/utils` for other call sites.

## Current Solution

`formatOfferAlert` appended `@ tick ${bucket.tick}` to every make-order headline — the raw protocol
encoding, meaningless without the tick→price→rate conversion in one's head.

## Proposed Solution

### 1. `@morpho-org/midnight-sdk` for the tick math

`@morpho-org/midnight-sdk` is added to the workspace catalog and to `bots/monitor-bot`. Its
`TickLib` is the TypeScript port of Midnight's on-chain `TickLib`, preserving half-down division
(`divHalfDownUnchecked`) and `PRICE_ROUNDING_STEP` snapping — parity we get for free rather than
maintain.

### 2. Version pin 1.2.0, not latest 1.2.1

`bunfig.toml`'s supply-chain gate (`minimumReleaseAge = 259200`, 3 days) blocks 1.2.1 (published
2026-07-20). 1.2.0 (2026-07-16) has identical `TickLib` math, so the catalog deliberately pins the
older version rather than punching a hole in the gate.

### 3. Peer-driven `morpho-ts` bump 2.5.0 → 2.8.0

midnight-sdk peer-depends on `@morpho-org/morpho-ts ^2.8.0`. bun satisfies peers from the catalog
pin regardless of the declared range, and 2.5.0 lacks exports midnight-sdk imports
(`assertNonNegative`) — a runtime import failure, not a resolution error. The catalog therefore
moves to 2.8.0. The only workspace consumer is `createFormat` in `@repo/utils`
(`packages/utils/src/helpers/formatters.ts`), which typechecks and passes its 325 tests on 2.8.0.

### 4. Display semantics: simple APR over the remaining term

`aprLabel` in `bots/monitor-bot/src/pollers/format.ts` computes
`TickLib.tickToApr(tick, maturity − observedAt)` — the simple (non-compounded) APR, annualized the
same way `OfferUtils.getApr` and the Morpho fixed-rate app do. It is the maker's gross quote, and
side-independent: the tick encodes the zero-coupon price identically for bids (lend) and asks
(borrow).

### 5. No tick fallback — ticks never surface

A product call by the maintainer: when the rate cannot be annualized, the `@ …` clause is omitted
entirely rather than falling back to the tick. `aprLabel` returns null when:

- the market has matured — nothing to annualize over (`tickToApr` also throws on ttm ≤ 0);
- `TickLib` rejects the tick — out of Midnight's deployed range 0–6744, or ticks 0–1 whose price
  snaps to zero (`DivisionByZeroError`).

Every computable rate renders at face value, however extreme — a deep low tick (tick 495 over a
year ≈ 166,666,567% APR) shows its astronomical number rather than being suppressed; it is the
offer's actual quote.

The tick still disambiguates the bucket for dedupe via the alert key; it is just never rendered.

### 6. Local `Intl` percent formatter

The label is formatted with a local `Intl.NumberFormat` (`maximumFractionDigits: 2`), not
`@repo/utils`' `formatUint256Percent`, which truncates instead of rounding (2.5076% → `2.5%`).
Adjacent ticks sit ~2.5bp apart at typical rates, so the correctly rounded second decimal carries
signal.

## Considered Alternatives

### Alternative 1: umbrella `@morpho-org/morpho-sdk`

The umbrella package re-exports the same `TickLib` through its `/utils` subpath.

**Why rejected:** it drags in `blue-sdk`, `blue-sdk-viem`, and `zod` as extra dependencies for
math the leaf package ships alone.

### Alternative 2: vendor the math

Port tick→APR locally and skip the dependency.

**Why rejected:** loses parity with on-chain rounding (half-down division, `PRICE_ROUNDING_STEP`
snapping) that the SDK maintains for free; a divergence would be silent and only visible as numbers
disagreeing with the app.

## Assumptions & Constraints

- bun satisfies peer dependencies from the catalog pin regardless of the declared range, so the
  catalog `morpho-ts` must be kept ≥ midnight-sdk's peer floor manually — resolution will not fail
  on a violation, runtime imports will.
- The `minimumReleaseAge` gate stays authoritative: future midnight-sdk bumps take whatever version
  has aged past 3 days, not latest.
- `@repo/utils`' `createFormat` remains the only other workspace `morpho-ts` consumer; a new
  consumer inherits 2.8.0 semantics.

## Dependencies

- `@morpho-org/midnight-sdk` 1.2.0 (catalog) — `TickLib`.
- `@morpho-org/morpho-ts` 2.8.0 (catalog) — midnight-sdk peer (`^2.8.0`), shared with
  `@repo/utils`.
- [TIB-2026-07-20-book-offer-snapshot-diffing](./TIB-2026-07-20-book-offer-snapshot-diffing.md) —
  the poller whose alerts this renders.

## Future Considerations

- Bump midnight-sdk once a newer release ages past the gate — a routine chore; 1.2.1's `TickLib`
  is already known-identical.
- If more percent-rendering call sites appear, fix `formatUint256Percent`'s truncation in
  `@repo/utils` instead of accumulating local formatters.

## References

- [TIB-2026-07-20-book-offer-snapshot-diffing](./TIB-2026-07-20-book-offer-snapshot-diffing.md) —
  make-order snapshot diffing, bucket identity, and the alert surface this decision changes.
- [TIB-2026-07-20-monitor-bot-nestjs-stack](./TIB-2026-07-20-monitor-bot-nestjs-stack.md) —
  monitor-bot's stack context.
- `bots/monitor-bot/src/pollers/format.ts` (`aprLabel`),
  `bots/monitor-bot/src/pollers/book-offers.poller.ts` (`formatOfferAlert`).
