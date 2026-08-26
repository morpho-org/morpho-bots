# TIB-2026-08-25: Quoter-bot ladder maturity premium

| Field          | Value                                                                     |
| -------------- | ------------------------------------------------------------------------- |
| **Status**     | Proposed                                                                  |
| **Date**       | 2026-08-25                                                                |
| **Author**     | @julien                                                                   |
| **Scope**      | Bot: quoter-bot                                                           |
| **Supersedes** | TIB-2026-08-25-quoter-bootstrap-maturity-premium _(ladder non-goal only)_ |

---

## Context

[TIB-2026-08-25-quoter-bootstrap-maturity-premium](./TIB-2026-08-25-quoter-bootstrap-maturity-premium.md)
introduced the per-entry `maturityPremium` tagged union for
[MKT-1787](https://linear.app/morpho-labs/issue/MKT-1787) and deliberately deferred the ladder
workflow: ladder centers stayed a flat `reference + quotePremiumBps`, so a one-month and a
nine-month ladder configured identically quote the same center. That leaves the same duration
adverse selection the bootstrap fix removed — resting two-sided liquidity on a far book at a
short-book center gives takers the term spread — and it splits one bot's term structure across two
inconsistent workflows once bootstrap entries price maturity.

This TIB records extending the exact bootstrap model to ladder entries. It supersedes only the
parent TIB's "maturity curves for the ladder workflow" non-goal; every other decision there remains
in force, and the shared premium model is unchanged.

## Goals / Non-Goals

**Goals**

- Price each ladder's effective center from the reference rate _and_ the market's remaining time to
  maturity: `C = reference + quotePremiumBps + resolved maturity premium`.
- Reuse the parent TIB's pure model (`maturity-premium.ts`), configuration schema, observation
  plumbing, and fail-loud posture without divergence between the two workflows.
- Let `movementToleranceBps` absorb slow curve decay exactly like reference movement, so the
  premium's integer-floored steps do not churn otherwise-resting ladders.

**Non-Goals**

- New premium shapes, a shared fan-out curve block, or automatic rollover — the parent TIB's open
  extension points stay open.
- Changing spread, step, sizing, capacity, grouping, or reconciliation semantics: the premium moves
  only the center; the shape around it is untouched.

## Current Solution

`generateLadder` anchors the center at `reference + quotePremiumBps` with no maturity input, and
`assertLadderShapeAtReference` rejects any hardcoded reference whose full unclamped shape leaves
the hard range at that single static center.

## Proposed Solution

### 1. Same per-entry `maturityPremium`, applied to the center

Ladder entries accept the identical optional `maturityPremium` object (shared
`maturityPremiumValue` parsing, YAML and `LADDER_MARKETS` alike).
[`effectiveLadderPremiumBps`](../../bots/quoter-bot/src/domain/ladder/ladder.ts) mirrors
`effectiveBootstrapPremiumBps`: it returns `quotePremiumBps` plus the resolved maturity term and
throws `LadderConfigurationError` when a premium is configured without a fresh maturity
observation — `generateLadder` resolves it even at a retained center, so a wiring gap can never
quote silently without its configured duration compensation. Unlike bootstrap's `premiumBps ≤ 0`,
`quotePremiumBps` keeps its signed meaning; the maturity term remains strictly positive-sloped.

### 2. Observation plumbing already shared

The ladder rate wiring composes the same `StrategyBootstrapReferenceRateService`, so
[`production-ladder.ts`](../../bots/quoter-bot/src/infrastructure/ladder/production-ladder.ts)
injects the identical per-market maturity read — SDK `market.timeToMaturity(block.timestamp)` on
the latest block, wired only for entries that configure a premium — and the ladder observation
carries `secondsToMaturity` through `readObservation`. A maturity read failure propagates as the
existing `reference-read` strategy-wide hard halt.

### 3. Decay through the existing deadband

The effective center decays as maturity approaches. `shouldRecenter` compares the retained center
against the fresh premium-adjusted center, so `movementToleranceBps` absorbs the decay the same way
it absorbs reference movement: a one-BPS floored step inside the inclusive deadband rests, and a
recenter republishes the whole ladder only when the accumulated movement escapes it.

### 4. Reachability-aware hardcoded shape check

`assertLadderShapeAtReference` adopts the parent TIB's reachability posture, bounded by the
protocol horizon: with a premium the center spans the reachable envelope
`[base, base + highest reachable premium]`, where `highestReachableMaturityPremiumBps` is the
configured cap or, when it does not bind, the premium at Midnight's 100-year `MaturityTooFar`
horizon. Load-time rejection is reserved for shapes pinned outside a hard bound at every
protocol-permitted maturity — the lower-rung check tests the highest reachable center, the
higher-rung check the premium-free base — so an uncapped slope too shallow to ever lift the shape
inside the range fails loud instead of quoting permanently floor-clamped. This is deliberately an
envelope check: its endpoints are attainable, but integer flooring steps premiums by more than one
BPS per second once the slope exceeds `MATURITY_PREMIUM_YEAR_SECONDS`, so a shape that fits only
strictly between attainable steps is still accepted and its rungs saturate at runtime per
TIB-2026-08-14.

## Considered Alternatives

### Alternative 1: Scale rung offsets with maturity instead of the center

Widen `spreadBps`/`stepBps` as a function of time to maturity.

**Why rejected:** MKT-1787 prices duration, not uncertainty: the compensation is a level shift of
the whole two-sided book. The spread/step shape is market-making structure with its own operator
intent; entangling it with the curve would change both sides' distances for a term-premium reason.

### Alternative 2: Recenter immediately on every premium step

Bypass `movementToleranceBps` for maturity-driven center movement.

**Why rejected:** A ladder replacement is market-wide (cancel + republish every group), so churn is
expensive. The deadband is the established churn control and treats all center movement uniformly;
an operator wanting faster curve tracking can lower the tolerance.

### Alternative 3: Reject at load when the cap exceeds hard-range headroom

**Why rejected:** Same as the parent TIB's Alternative 4 — runtime saturation is the
TIB-2026-08-14 contract, and rejecting reachable configurations would reintroduce fail-loud where
clamping is by design.

### Alternative 4: A ladder-local maturity reader

**Why rejected:** The ladder already composes `StrategyBootstrapReferenceRateService`; the maturity
seam landed there for bootstrap. A second reader would duplicate the read path and let the two
workflows drift.

## Assumptions & Constraints

- The parent TIB's model constraints carry over verbatim: strictly positive slope and cap, linear
  as the only shape, block-timestamp clocking, integer flooring.
- The hard range plus cross-book clearance remain the safety boundary — no premium composition can
  publish a rung outside `[minimumRateBps, maximumRateBps]` or across the own bootstrap buy.
- Operators accept that a premium-raised center rests the higher side further above reference; fill
  cadence on far books slows accordingly.

## Dependencies

- [TIB-2026-08-25-quoter-bootstrap-maturity-premium](./TIB-2026-08-25-quoter-bootstrap-maturity-premium.md)
  — the shared model, schema, and observation seam this TIB extends.
- [TIB-2026-08-14](./TIB-2026-08-14-quoter-cross-book-clearance.md) rate/tick clamping for the
  saturation semantics rungs rely on.

## Observability

No new log events. Verbose ladder diagnostics
([`ladder-verbose.ts`](../../bots/quoter-bot/src/application/ladder/ladder-verbose.ts)) gain
`secondsToMaturity` and `maturityPremiumBps` beside the existing `referenceRateBps` and
`targetRateBps`, so an operator can decompose any effective center into
reference + quote premium + maturity premium from a single verbose record.

## Future Considerations

- The parent TIB's open extension points (additional shapes, a shared fan-out curve block) now
  apply to both workflows at once through the shared model.

## References

- [MKT-1787](https://linear.app/morpho-labs/issue/MKT-1787) — the motivating ticket.
- [TIB-2026-08-25-quoter-bootstrap-maturity-premium](./TIB-2026-08-25-quoter-bootstrap-maturity-premium.md)
  — the parent decision, including the superseded ladder non-goal.
- [`ladder.ts`](../../bots/quoter-bot/src/domain/ladder/ladder.ts),
  [`ladder-quoter.service.ts`](../../bots/quoter-bot/src/application/ladder/ladder-quoter.service.ts),
  [`production-ladder.ts`](../../bots/quoter-bot/src/infrastructure/ladder/production-ladder.ts)
  — the implementation.

<!--
TIB conventions:
- Once accepted, do not substantively edit this TIB. If the decision needs to change,
  create a new TIB that supersedes this one and update the Status/Superseded by fields.
- Addenda may be appended to record operational updates that affect
  how the TIB is applied without changing the decision itself.
- TIB identifiers use CalVer (YYYY-MM-DD) based on the date the TIB was first drafted.
-->
