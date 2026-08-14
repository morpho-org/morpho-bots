# TIB-2026-08-14: Quoter-bot cross-book clearance and bound clamping

| Field          | Value                                            |
| -------------- | ------------------------------------------------ |
| **Status**     | Proposed                                         |
| **Date**       | 2026-08-14                                       |
| **Author**     | @julien                                          |
| **Scope**      | Bot: quoter-bot                                  |
| **Supersedes** | TIB-2026-07-27-midnight-quoter-bot _(partially)_ |

---

## Context

[TIB-2026-07-27](./TIB-2026-07-27-midnight-quoter-bot.md) settled the quoter-bot's own-book edge
cases with two postures. A premium-adjusted bootstrap buy crossing the maker's own book was legal
only as an **exact-tick overlap** against the unique highest-rate _ladder-owned_ sell, netted down
to `expected bootstrap assets − sell remaining assets` (§5, exempted once in the §7 invariants).
And a target or rung outside the configured hard rate range was **fail-loud**: invalidate every V0
root and exit, never clamp (§4 "Bounds and staleness", §9).

Operating the strategy showed both postures are too brittle. The netting design demanded evidence
that live books frequently cannot produce — ownership plus indexed size, tick, and maturity for
exactly one sell; ties, pending offers, or a third-party best sell all failed the cycle closed —
while deliberately resting a standing self-trade tie on the shared tick and coupling bootstrap
sizing to ladder consumption. The fail-loud bounds turned any reference-rate excursion, a bad print
as much as a genuine move, into a full quote teardown and process halt. And because Midnight's tick
curve is logistic, rate-space rules alone cannot guarantee separation: 10 bps is sometimes smaller
than one tick spacing, so two rates 10 bps apart can round onto the same tick.

This TIB records the replacement — clearance repricing, bound clamping, and same-tick merging —
already implemented and tested in `bots/quoter-bot`. It supersedes only the two postures above;
every other TIB-2026-07-27 decision remains in force.

## Goals / Non-Goals

**Goals**

- Keep the maker's own bootstrap buy and ladder sells strictly separated — in rate space _and_ in
  tick space — without exact-tick netting evidence.
- Degrade quoting to the operator's hard rate bounds on a reference excursion instead of halting
  the strategy and cancelling all offers.
- Preserve every fail-closed guard that does not involve the maker's own prospective offers.

**Non-Goals**

- Change the third-party crossing posture: any crossing not caused by the own prospective buy
  still throws.
- Change reference-rate sources, staleness handling, ladder shape math, sizing, or exposure caps.
- Relax static-target validation: a hardcoded target whose full shape cannot fit unclamped still
  fails loud at configuration load.
- Make V0 competitive; it remains a reference implementation.

## Current Solution

The superseded design lived in `bootstrap-overlap.utils.ts` (deleted). Its
`resolveBootstrapProspectiveOffer` accepted a crossing bootstrap buy only when the complete book
proved the crossed sell was the unique lowest-tick **ladder-owned** sell with positive indexed
remaining size and a derivable current effective rate; it then repriced the buy to that exact rate
at the exact sell tick and published only the netted remainder, with a zero or negative remainder
publishing nothing. Every other configuration — ties, unknown ownership, pending offers without
indexed size, malformed evidence — failed closed as `negative-spread`. Independently, the domain
threw on any premium-adjusted or rung rate outside `[minimumRateBps, maximumRateBps]`, and the §9
failure posture required invalidating all V0 roots and exiting.

## Proposed Solution

One shared constant governs both sides:
[`CROSS_BOOK_CLEARANCE_BPS = 10`](../../bots/quoter-bot/src/domain/cross-book.ts) basis points of
rate clearance between own offers that would otherwise cross. Rate-space rules position offers;
tick-space guards make the separation real after rounding.

### 1. Bootstrap buys reprice with clearance

[`resolveBootstrapProspectiveOffer`](../../bots/quoter-bot/src/infrastructure/bootstrap/bootstrap-cross-book.utils.ts)
(replacing the deleted `bootstrap-overlap.utils.ts`) resolves a crossing bootstrap buy by
repricing, not netting: the buy quotes at the highest-rate retained sell's effective (tick-encoded)
rate **plus 10 bps**, clamped into the hard range. Any retained sell counts, regardless of owner —
no ownership, size, or maturity evidence is required. If tick rounding rebounds the repriced buy
onto or past the sell tick, it steps to exactly **one tick spacing below** the sell and adopts that
tick's encoded rate. If no in-range tick clears the sell (the stepped tick leaves the tick domain
or its encoded rate leaves the hard range), the resolver returns `undefined` and the cycle
publishes no bootstrap buy — the stale group is still invalidated — instead of throwing.

### 2. Ladder sells clear the own bootstrap buy

The inverse rule keeps ladder sells out of the live own bootstrap buy, guarded in both spaces:

- **Rate space** — [`generateLadder`](../../bots/quoter-bot/src/domain/ladder/ladder.ts) caps
  every sell (lower-side) domain rate at `LadderMarketState.bootstrapBuyRateBps − 10 bps`, where
  `bootstrapBuyRateBps` is the highest live own bootstrap-buy **nominal** rate rebuilt from durable
  strategy state.
- **Tick space** —
  [`buildLadderTree`](../../bots/quoter-bot/src/infrastructure/ladder/ladder-offer.utils.ts)
  floors every published sell tick at `ownBootstrapBuyTickCeiling + tickSpacing`, the ceiling being
  the highest durably-marked own bootstrap-buy tick in the fresh book
  ([`production-ladder.ts`](../../bots/quoter-bot/src/infrastructure/ladder/production-ladder.ts)).
  The floor is capped at the minimum-rate window tick, so a bound-saturated bootstrap buy and
  ladder sell may still meet at exactly that tick.

The pre-existing exact-tie exemption
([`intentional-overlap.utils.ts`](../../bots/quoter-bot/src/infrastructure/intentional-overlap.utils.ts),
kept) still permits the single durably-owned bootstrap-buy/ladder-sell equality per market — but
clearance repricing makes it reachable only at bound saturation and for legacy published overlaps.

### 3. Hard bounds clamp instead of halting

Rates reaching `minimumRateBps`/`maximumRateBps` saturate instead of throwing:

- **Domain** — [`clampRateBps`](../../bots/quoter-bot/src/domain/cross-book.ts): ladder sells
  settle on the minimum and buys on the maximum; `decidePositionBootstrap` clamps the
  premium-adjusted bootstrap rate rather than throwing `BootstrapConfigurationError`.
- **Tick** — the shared rate/tick window
  ([`tick-window.utils.ts`](../../bots/quoter-bot/src/infrastructure/tick-window.utils.ts)):
  `rateTickWindow` derives the aligned-tick equivalent of the hard range and `clampTickToWindow`
  saturates rounded ticks into it, so the **encoded** rate stays inside the bounds after rounding —
  rate-space clamping alone cannot promise that on a logistic curve. Both the ladder and bootstrap
  offer builders derive ticks through this window; an empty window throws `rate-window-empty`.

The strategy no longer hard-halts on reference-rate excursions; the §9 row "Target or any rung
outside bounds → invalidate all V0 roots and exit; never clamp" is retired. Fail-loud remains where
it belongs: a static hardcoded target whose full shape cannot fit unclamped fails at configuration
load via [`assertLadderShapeAtReference`](../../bots/quoter-bot/src/domain/ladder/ladder.ts).

### 4. Same-tick rungs merge

Clamping makes equal-tick neighbours an expected steady state: saturated rungs share a bound rate,
and the logistic curve rounds distinct rates onto one tick. `buildLadderTree` merges same-side
rungs resolving to one protocol tick into a single offer/group whose cap is the summed rung caps
(in `shared-rung` mode), which the rung-index-based group ownership model already supports — a
group simply owns several rung indexes.

### Fail-closed remainders

Everything that cannot be proven safe still throws:

- a pre-existing crossed retained book, before the prospective buy is even considered;
- a crossing not caused by the own prospective buy — including every third-party crossing — or a
  crossing buy with no retained sell to reprice against;
- missing effective-rate or tick-spacing evidence on an exact-tick projection;
- a repriced projection that still crosses the retained book;
- an empty tick window (`rate-window-empty`) when no aligned tick encodes an in-range rate; and
- ties or missing ownership at the exempted equality (`hasInvalidOwnedBootstrapLadderSpread`).

## Considered Alternatives

### Alternative 1: Keep exact-tick overlap netting

The superseded TIB-2026-07-27 §5 design.

**Why rejected:** Its evidence bar — the unique ladder-owned highest-rate sell with indexed size,
tick, and maturity — routinely fails on live books (ties, pending offers, third-party best sells),
turning benign cycles into `negative-spread` rejections. It also rested a deliberate self-trade tie
on the shared tick and coupled bootstrap sizing to ladder consumption. Clearance needs only the
retained book's ticks, treats any retained sell as evidence, and leaves no own-book tie except at
bound saturation.

### Alternative 2: Keep never-clamp, halt-on-excursion bounds

**Why rejected:** The hard bounds are the operator's declared safe quoting envelope, so the safe
response to a reference excursion is to keep quoting _at_ that envelope, not to cancel every offer
and exit — a halt destroys book continuity for transient bad prints and genuine moves alike. The
published-offer invariant is unchanged (no encoded rate ever leaves the hard range); only the
response moved from teardown to saturation, and the one case where fail-loud is still right — an
operator-pinned static target that cannot fit unclamped — moved to configuration load.

### Alternative 3: Rate-space clearance without tick guards

**Why rejected:** Midnight's logistic tick curve makes 10 bps sometimes smaller than one tick
spacing, so rate arithmetic alone cannot guarantee separation or bound compliance after rounding.
Every rate-space rule is therefore backed in tick space: the shared rate/tick window, the sell tick
floor one spacing above the bootstrap buy, and the bootstrap one-spacing-below fallback.

## Assumptions & Constraints

- `CROSS_BOOK_CLEARANCE_BPS` is a fixed shared constant, not operator configuration; both sides
  derive from it so the own-book gap stays symmetric.
- One tick spacing of separation is sufficient: Midnight matches only at tick equality or
  inversion, so strictly ordered own ticks never self-trade.
- The hard bounds are a quoting envelope, not an anomaly detector. If they are ever repurposed as a
  circuit breaker, clamping must be revisited.
- `minimumRateBps ≤ maximumRateBps` is validated upstream; `clampRateBps` and `clampTickToWindow`
  are pure saturation with no re-validation.
- Group ownership stays rung-index based, so one protocol group owning several merged rungs needs
  no model change.

## Dependencies

- `@morpho-org/midnight-sdk` `TickLib` for rate↔price↔tick conversion in the shared tick window.
- `@repo/offers` `hasNegativeSpread` for retained-book and post-repricing crossing checks
  ([TIB-2026-08-04](./TIB-2026-08-04-extract-quoter-bot-shared-packages.md)).

## Observability

No new log events. The operator-visible symptom of a reference excursion changes: previously a
non-zero exit (alertable as a crash loop), now a book pinned at `minimumRateBps`/`maximumRateBps`
visible in the existing quote-cycle desired/actual diff logs. Alerting keyed on the excursion halt
must instead watch for bound-pinned quotes.

## References

- [TIB-2026-07-27-midnight-quoter-bot](./TIB-2026-07-27-midnight-quoter-bot.md) — §4 "Bounds and
  staleness", §5, §7, and §9: the postures this TIB partially supersedes.
- [`cross-book.ts`](../../bots/quoter-bot/src/domain/cross-book.ts),
  [`bootstrap-cross-book.utils.ts`](../../bots/quoter-bot/src/infrastructure/bootstrap/bootstrap-cross-book.utils.ts),
  [`tick-window.utils.ts`](../../bots/quoter-bot/src/infrastructure/tick-window.utils.ts),
  [`ladder-offer.utils.ts`](../../bots/quoter-bot/src/infrastructure/ladder/ladder-offer.utils.ts),
  [`intentional-overlap.utils.ts`](../../bots/quoter-bot/src/infrastructure/intentional-overlap.utils.ts)
  — the implementation.

<!--
TIB conventions:
- Once accepted, do not substantively edit this TIB. If the decision needs to change,
  create a new TIB that supersedes this one and update the Status/Superseded by fields.
- Addenda may be appended to record operational updates that affect
  how the TIB is applied without changing the decision itself.
- TIB identifiers use CalVer (YYYY-MM-DD) based on the date the TIB was first drafted.
-->
