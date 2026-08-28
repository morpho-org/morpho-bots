# TIB-2026-08-25: Quoter-bot bootstrap maturity premium

| Field             | Value                                                                  |
| ----------------- | ---------------------------------------------------------------------- |
| **Status**        | Proposed                                                               |
| **Date**          | 2026-08-25                                                             |
| **Author**        | @julien                                                                |
| **Scope**         | Bot: quoter-bot                                                        |
| **Supersedes**    | TIB-2026-07-27-midnight-quoter-bot _(partially)_                       |
| **Superseded by** | TIB-2026-08-25-quoter-ladder-maturity-premium _(ladder non-goal only)_ |

---

> **Partially superseded (2026-08-25).** The "maturity curves for the ladder workflow" non-goal is
> no longer current: the same per-entry model now prices ladder effective centers — see
> [TIB-2026-08-25-quoter-ladder-maturity-premium](./TIB-2026-08-25-quoter-ladder-maturity-premium.md).
> Every other decision in this TIB remains in force.

## Context

[MKT-1787](https://linear.app/morpho-labs/issue/MKT-1787) asks one bot to bootstrap every
allowlisted maturity, with a per-maturity premium — the further the maturity, the higher the
premium — so bootstrap quoting becomes a function of both the market rate and the market's time to
maturity. Under [TIB-2026-07-27](./TIB-2026-07-27-midnight-quoter-bot.md) §5 the bootstrap offer
carries one static premium constrained to zero or negative: a temporary urgency discount, "the
only discounted offer". Priced flat across maturities, that discount systematically adversely
selects the maker on duration — a taker filling a nine-month book at a short-book rate captures the
term spread. The ticket left the premium function's shape TBD.

This TIB records the design already implemented and tested in `bots/quoter-bot`. It supersedes only
the "bootstrap is the discounted offer" posture of TIB-2026-07-27 §5; every other decision there
remains in force.

## Goals / Non-Goals

**Goals**

- Price each bootstrap entry's requested rate from the reference rate _and_ the market's remaining
  time to maturity, with further maturities earning a higher premium.
- Keep the premium function shape extensible so additional shapes land without breaking existing
  configurations.
- Fail loud when a maturity premium is configured but no fresh maturity observation exists — never
  silently quote flat.
- Clock the premium off the block timestamp so decay stays consistent with tick and settlement
  math.

**Non-Goals**

- Maturity curves for the ladder workflow. Bootstrap-only scope; ladder support is deliberately
  deferred.
- Automatic rollover into next maturities — the TIB-2026-07-27 non-goal is preserved.
- A shared cross-entry curve block. Configuration stays per-entry; a fan-out curve is a compatible
  follow-up.
- Changing reference-rate sources, sizing, exposure caps, or the
  [TIB-2026-08-14](./TIB-2026-08-14-quoter-cross-book-clearance.md) saturation semantics.

## Current Solution

Every bootstrap entry quotes `reference rate + premiumBps`, with `premiumBps ≤ 0` enforced by the
domain configuration validation. There is no maturity input anywhere in the bootstrap path: a
one-month and a nine-month book configured identically quote the same spread to reference, and the
whole quote is a discount by construction.

## Proposed Solution

### 1. Per-entry `maturityPremium` tagged union

Each `BOOTSTRAP_MARKETS` / YAML bootstrap entry accepts an optional `maturityPremium` object,
discriminated by `shape` so future shapes extend the union without migrating existing
configurations. The initial and only shape is `linear`
([`maturity-premium.ts`](../../bots/quoter-bot/src/domain/maturity-premium.ts)):

```text
resolved = floor(premiumPerYearBps × secondsToMaturity / 31_536_000)
resolved = min(resolved, maximumPremiumBps)   # optional inclusive cap
resolved = 0                                  # at or past maturity
```

`premiumPerYearBps` must be positive, as must the cap when present
(`maturityPremiumConfigIssue` reports the first structural issue; bootstrap validation converts it
into `BootstrapConfigurationError`). The module is pure and browser-safe, so the playground
([`playground/model.ts`](../../bots/quoter-bot/playground/model.ts)) bundles the exact production
resolver.

### 2. Requested rate composition — the superseded posture

[`effectiveBootstrapPremiumBps`](../../bots/quoter-bot/src/domain/bootstrap/position-bootstrap.ts)
returns `premiumBps + resolveMaturityPremiumBps(…)` and `decidePositionBootstrap` requests
`reference rate + effective premium`, still saturating into the entry's
`[minimumRateBps, maximumRateBps]` per TIB-2026-08-14. The two terms keep opposite signs by
design:

- static `premiumBps` stays constrained `≤ 0` — the urgency discount anchoring the short end; and
- the maturity term is strictly positive-sloped duration compensation.

Net quotes can therefore sit **above** reference at long maturities. This partially supersedes the
TIB-2026-07-27 §5 invariant that the bootstrap offer "lends at a worse rate … the only discounted
offer": a far-maturity bootstrap becomes a fair-value resting offer that may fill slowly, and
`creditTarget` completion is no longer effectively guaranteed for far books. Operators accept
slower fills instead of being systematically adversely selected on duration.

### 3. Maturity observation plumbing

`BootstrapRate` carries an optional `secondsToMaturity`.
[`StrategyBootstrapReferenceRateService`](../../bots/quoter-bot/src/infrastructure/bootstrap/bootstrap-reference-rate.service.ts)
composes an injected per-market maturity read beside the reference-rate read (`Promise.all`),
wired only for entries that configure a maturity premium.
[`production-bootstrap.ts`](../../bots/quoter-bot/src/infrastructure/bootstrap/production-bootstrap.ts)
supplies it as SDK `market.timeToMaturity(block.timestamp)` — the midnight-sdk zero-floored helper
on the **block** timestamp, never wall clock.

The seam fails loud at both ends: the domain throws `BootstrapConfigurationError` when a maturity
premium is configured but the observation is missing, and a maturity read failure propagates as
the existing `reference-read` strategy-wide hard halt. An entry never silently quotes without its
configured duration compensation.

### 4. Bounded churn from integer flooring

Floor division makes the decaying premium a step function — roughly one bps per several days at
typical slopes (e.g. `premiumPerYearBps: 120` steps every ~3 days). The bootstrap make layer
already reconciles requested terms that retain the same canonical Midnight tick to `unchanged`, so
a one-bps step republishes only when it actually moves the tick.

## Considered Alternatives

### Alternative 1: Read maturity through `BootstrapPositionService.readPosition`

Widen the existing position read with the market's maturity.

**Why rejected:** Maturity is market data, not position data. Widening `readPosition` grows a
large fake surface across every position test for a value the reference-rate observation already
has a natural home for.

### Alternative 2: Hand-rolled maturity subtraction

Compute `maturity − timestamp` locally.

**Why rejected:** SDK-first — `Market.timeToMaturity` exists, zero-floors, and matches the
protocol's settlement math. A local re-derivation is a divergence risk with no upside.

### Alternative 3: Wall-clock (`Date.now()`) decay

**Why rejected:** The rest of the tick — reference reads, tick encoding, settlement math — is
clocked on chain state. Wall clock drifts from the block view and makes the premium
non-reproducible from the observation; `block.timestamp` keeps decay clock-consistent.

### Alternative 4: Reject at config load when the cap exceeds `maximumRateBps` headroom

Fail startup when `premiumBps + maximumPremiumBps` could push the requested rate past
`maximumRateBps`.

**Why rejected:** Runtime saturation is the TIB-2026-08-14 contract — the hard range is a quoting
envelope, so a rate excursion clamps rather than halting the strategy. Rejecting the combination
at load would reintroduce fail-loud where clamping is by design, and would forbid legitimate
configurations that only saturate under extreme references.

### Alternative 5: One shared curve for all entries

A single top-level `maturityPremium` block fanned out across markets.

**Why rejected:** The bootstrap schema is all-per-entry, and per-entry configuration keeps
per-market risk caps and premiums explicit. A shared fan-out curve block remains a compatible
follow-up that can layer on top without breaking per-entry overrides.

## Assumptions & Constraints

- The maturity term prices only duration: `premiumPerYearBps` (and the cap when present) is
  strictly positive. A negative-sloped premium would be a new shape, not a sign change.
- Urgency discounting stays in the static `premiumBps ≤ 0` term; the two terms are not
  interchangeable.
- The TIB-2026-08-14 saturation envelope is the safety boundary — no premium composition can move
  an encoded rate outside `[minimumRateBps, maximumRateBps]`.
- Operators accept that far-maturity `creditTarget`s may fill slowly or not at all; bootstrap
  completion is no longer a discount-driven near-certainty.
- `linear` is the only implemented shape; the tagged union is the extension point.

## Dependencies

- `@morpho-org/midnight-sdk` `Market.timeToMaturity` for the zero-floored maturity read.
- [TIB-2026-08-14](./TIB-2026-08-14-quoter-cross-book-clearance.md) rate/tick clamping for the
  saturation semantics the composed rate relies on.

## Observability

No new log events. Verbose bootstrap diagnostics
([`position-bootstrap-verbose.ts`](../../bots/quoter-bot/src/application/bootstrap/position-bootstrap-verbose.ts))
gain `maturityPremiumBps`, and the embedded `referenceRate` observation now carries
`secondsToMaturity`, so an operator can decompose any requested rate into
reference + static premium + maturity premium from a single verbose record.

## Future Considerations

- Additional premium shapes for the tagged union — the ticket deliberately left the function shape
  open.
- A shared fan-out curve block layered over per-entry overrides.
- Maturity curves for the ladder workflow, once bootstrap operation validates the pricing.

## References

- [MKT-1787](https://linear.app/morpho-labs/issue/MKT-1787) — the motivating ticket.
- [TIB-2026-07-27-midnight-quoter-bot](./TIB-2026-07-27-midnight-quoter-bot.md) — §5: the
  discounted-offer posture this TIB partially supersedes.
- [TIB-2026-08-14-quoter-cross-book-clearance](./TIB-2026-08-14-quoter-cross-book-clearance.md) —
  the clamping semantics the composed rate saturates through.
- [`maturity-premium.ts`](../../bots/quoter-bot/src/domain/maturity-premium.ts),
  [`position-bootstrap.ts`](../../bots/quoter-bot/src/domain/bootstrap/position-bootstrap.ts),
  [`bootstrap-reference-rate.service.ts`](../../bots/quoter-bot/src/infrastructure/bootstrap/bootstrap-reference-rate.service.ts),
  [`production-bootstrap.ts`](../../bots/quoter-bot/src/infrastructure/bootstrap/production-bootstrap.ts)
  — the implementation.

<!--
TIB conventions:
- Once accepted, do not substantively edit this TIB. If the decision needs to change,
  create a new TIB that supersedes this one and update the Status/Superseded by fields.
- Addenda may be appended to record operational updates that affect
  how the TIB is applied without changing the decision itself.
- TIB identifiers use CalVer (YYYY-MM-DD) based on the date the TIB was first drafted.
-->
