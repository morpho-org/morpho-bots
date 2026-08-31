# TIB-2026-08-31: Venue selection by USD cost curve

| Field          | Value                                                                                                                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**     | Proposed                                                                                                                                                                                     |
| **Date**       | 2026-08-31                                                                                                                                                                                   |
| **Author**     | @hayden                                                                                                                                                                                      |
| **Scope**      | Package: `@repo/swaps` · Apps: `bots/midnight-liquidation`, `bots/blue-liquidation`                                                                                                          |
| **Supersedes** | [TIB-2026-07-09](./TIB-2026-07-09-midnight-market-and-venue-selection.md) — its `PROBE_LADDER` shape, its "net-of-gas / profitability ranking" non-goal, and its indicative-probe assumption |

---

## Context

[TIB-2026-07-09](./TIB-2026-07-09-midnight-market-and-venue-selection.md) replaced the
hand-maintained routing file with a cached indicative probe and best-of-venues selection. The probe
ladder, the gross ranking, and the 10-minute cache were all reasonable defaults at the time; none of
them had been measured against a real maturity.

The 2026-08-28 15:00 UTC maturity measured them
([TIB-2026-08-28](./TIB-2026-08-28-midnight-send-shortfall-classification.md)). Two things came out
of that window. **Route cost is the deciding economic term** — median 17.6 bps against the oracle
for 0x cbBTC→USDC, against post-maturity incentives of ~20 bps and a loan-as-collateral slot that
pays zero — while quote bias is not (p50 0.0 bps quoted-versus-realized). And the ladder was
measuring the wrong sizes: of 926 planned candidates, **832 (90%)** had a seize below the ladder's
bottom rung.

So the selector has the wrong axis (whole collateral tokens), the wrong range, and the wrong
objective (gross output) for the one term that decides whether a liquidation is fundable. This TIB
changes all three.

## Goals / Non-Goals

**Goals**

- Probe at sizes real seizes actually occupy, on an axis that is comparable across pairs.
- Rank candidates **net of route cost**, and do it **above** the per-position candidate cap.
- Keep the probe cache shareable across markets, so a pair is probed once regardless of how many
  markets trade it.
- Stay inside the ~1 rps per-venue budget and the "only necessary calls" rule that
  [TIB-2026-07-09](./TIB-2026-07-09-midnight-market-and-venue-selection.md) set.
- Fail open, so a bad or cold curve costs no more than the old assumption promised.

**Non-Goals**

- **Gas in the curve.** Gas is not a venue property and does not belong in a per-pair probe; it stays
  a decision-time concern. This is the half of July 9's non-goal that survives.
- **An absolute (dust) profitability floor.** That is BOTS-81 and is orthogonal.
- **Per-pool exclusion (`excludedSources`).** Explicitly deferred in
  [TIB-2026-08-28](./TIB-2026-08-28-midnight-send-shortfall-classification.md); this work is what
  makes per-pool cost observable enough to decide it later.
- **Widening what may be sent.** The gates on a broadcast — the venue-encoded min-out floor checked
  against break-even, the oracle route-quality guard, and the on-chain `simulate()` ok-only rule — are
  unchanged and none of them is derived from the curve. Note carefully that this is **narrower than the
  earlier "the curve only orders and pre-screens"**: decision 7 puts the curve inside the derivation of
  the min-out that is then checked. What survives is that nothing the curve produces is trusted — it is
  a first guess at a denominator, and a floor derived from it is accepted only if the venue's own
  reported minimum clears break-even on its own terms.

## Superseded Decisions

Three clauses of [TIB-2026-07-09](./TIB-2026-07-09-midnight-market-and-venue-selection.md) do not
survive. Each is replaced below, not merely relaxed.

1. **The ladder.** "log-scaled ladder sizes (`PROBE_LADDER`, default `0.01/0.1/1/10/100` whole
   collateral tokens)" → fixed USD decades, converted per pair.
2. **The gross-ranking non-goal.** "**Net-of-gas / profitability ranking.** The probe stores gross
   output only; ranking is best _gross_ output." → ranking is net of interpolated route cost. This is
   a direct reversal; the deferred `minProfit` gate that TIB anticipated is what this becomes.
3. **The probe-proxy assumption.** "Indicative probes are a good-enough proxy for firm-quote ranking.
   A mis-ranked venue costs at most a fall-through to the runner-up" → replaced by an explicit
   coverage tradeoff (fail open), because a curve can now be _incomplete_ in ways a single ranking
   could not be.

## Current Solution

`createVenueSelector` (`packages/swaps/src/venue-selector.ts`) caches per
`(chainId, collateral, loan)`: the ladder in the collateral's base units, and — per rung — a
best-first list of `{ venue, expectedOut }` sorted by gross output. `select` picks the rung nearest
`amountIn` in log space and returns that ranking. `PROBE_LADDER` defaults to
`0.01,0.1,1,10,100` whole collateral tokens, `PROBE_STALE_MS` to 600 000, `PROBE_HTTP_RPS` to 1.
Both liquidators use it.

For cbBTC that ladder spans roughly **$800 to $8M**. The bottom rung is above 90% of real seizes
(median ≈ **$3**), and the top rung reliably logs `probe.venue_error` — no aggregator routes $8M of
cbBTC on Base. In effect the probe spent its budget measuring two rungs that never matched a
position and one that could not be quoted at all.

## Proposed Solution

**1. The ladder becomes fixed decades in USD: $0.01, $0.1, $1, $10, $100, $1k, $10k, $100k — 8
rungs — converted to the collateral's base units per pair.** USD is the axis the seize distribution
actually lives on, and it is pair-independent: the same rung means the same thing for cbBTC and for
USDC, which is what makes cross-candidate comparison meaningful at all. The range is chosen from the
measurement: it covers the $3 median with four rungs below it, and stops at $100k rather than at a
size no venue will quote.

**2. The cache stores the venue _rate_ per rung, and no oracle.** A rate (output per unit input) is a
property of the pair and the venue — not of any market. So the cache stays keyed by
`(chainId, collateral, loan)` and is **shared by every market on that pair**, and **cost in bps is
derived per candidate at read time**, from that candidate's own oracle reference. Two markets on one
pair with different oracles therefore cannot contaminate each other's cost estimate. Storing bps in
the cache would have baked one market's oracle into a pair-keyed entry and quietly done exactly
that.

**3. `PROBE_STALE_MS` drops from 10 minutes to the order of 30–60 s.** A cached rate is a price
_level_, and a level drifts; the old TTL was safe only because the cache stored an ordering.

The asymmetry this leans on is worth stating plainly, because it is what keeps the shorter TTL from
being a correctness requirement: **every venue at a rung is probed within one refresh**, so venue
_ordering_ at a rung is drift-immune at any cache age — all venues are quoted against the same
market conditions. What decays with age is only the **absolute cross-candidate cost level**, which
is what ranking candidates against each other and pre-screening against the incentive both consume.
A stale curve therefore degrades the cost comparison, never the venue pick.

**4. Ranking is net of interpolated route cost, applied _above_ the candidate cap.** Cost between
rungs is interpolated from the two bracketing rungs and subtracted from a candidate's gross surplus
before candidates are ordered. It must run above the `MAX_PLAN_CANDIDATES_PER_POSITION` truncation
(`bots/midnight-liquidation/src/sizing/plan.ts`): truncating by gross order and _then_ applying cost
can drop the cheapest-to-execute candidate before its cost is ever looked at, which is the exact
failure this work is meant to remove.

Removing that cap from sizing leaves the probe fan-out unbounded, though, and those are different
costs: a 16-slot position in two modes is 32 candidates and up to 16 distinct pairs to sweep. So a
**second, looser cap of `2 × MAX_PLAN_CANDIDATES_PER_POSITION` is applied on the gross ordering before
any route is resolved** (`probe_cap` on `preselect.skipped`). It is the one cap that must be applied
blind, because it is what bounds learning the cost at all; twice the plan cap so the priced set stays a
strict superset of what the final cap keeps, leaving the net ordering room to reorder. Candidates past
it are dropped rather than left uncosted — an uncosted candidate fails its whole position open to gross
ordering, so leaving them in would defeat the ranking for exactly the positions the cap exists for.

**5. The curve fails open.** A cold cache, a rung that returned no venue quote, or a size clamped
past the ladder's ends all fall back to **gross-surplus ordering with full venue fall-through** —
the July 9 behavior. This is the replacement for the superseded assumption: a bad probe still costs
at most a fall-through to the runner-up, never a bad fill and never a skipped position. Fail-open is
a decision, not an oversight: the curve is an optimization over an ordering that was already
correct-enough, so it must never be able to _remove_ coverage.

**6. Probe budget: 8 rungs × 3 venues = 24 calls per pair per refresh**, on the isolated probe client
at `PROBE_HTTP_RPS=1`, and only for pairs with a liquidatable position. That is up from 15 calls per
pair, on a shorter TTL — but it stays on the separate rate-limited client, so a probe burst still
cannot queue ahead of a live firm quote. Pairs are O(liquidatable pairs); the number of _candidates_
whose route is resolved at all is bounded by decision 4's `probe_cap`, so one pathological position
cannot turn its slot count into probe traffic.

**The rate budget was never the binding constraint — wall-clock was, and it has to be reasoned about
separately.** The client's token buckets are per venue, so serializing venues multiplied the sweep's
latency by the venue count for no rate-limit benefit: 8 rungs × 3 venues at 1 rps is **~24 s per cold
pair**, against a 45 s TTL. A continuously-liquidatable pair would then have spent more than half of
wall-clock inside a refresh, awaited before any quote ran, during precisely the burst the ordering
exists to win. Two changes bound it:

- **Venues sweep concurrently, rungs serially within a venue.** Worst case becomes one venue's ladder,
  **~8 s** for 8 rungs at 1 rps, and each venue's own bucket is still respected.
- **The warm is started, not awaited.** A pair is warmed for the _next_ tick and the current tick reads
  whatever the cache already holds, so warming leaves the critical path entirely. A first tick on a cold
  pair therefore falls open to gross ordering (decision 5) and converges within a tick or two, which is
  the cheaper side of the trade. `refresh` dedupes an in-flight sweep — returning rather than joining
  it — so neither the following tick nor the quoting layer's own refresh can double-probe a pair being
  warmed, and no caller can be made to wait behind someone else's sweep.

**7. The curve also predicts the firm quote's min-out denominator — inside the encoded-floor
derivation, and this is the one decision here that touches the correctness chain.** It is called out
separately for that reason.

The problem it solves is that an aggregator applies the slippage percentage we send to **its own**
quote, which we do not know yet. Deriving the percentage against the oracle reference therefore lands
its minimum at `quote · breakEven / reference`, below break-even for any route that costs something —
i.e. always — so every aggregator quote cost a **second** HTTP call to re-derive against the output the
first one reported. A trustworthy curve already estimates that output, so it can be used as the
first-pass denominator and the second call saved.

Preconditions, all of them necessary: the venue must be ranked, on an unclamped rung, and the curve
must be **fresher than a prediction-age ceiling** independent of `PROBE_STALE_MS`. The last one is what
keeps the asymmetry in decision 3 honest — ordering survives any cache age, an absolute denominator does
not, and `blue-liquidation` deliberately runs a ten-minute TTL because ordering is all it consumed until
this decision existed. Bounding the consumer rather than shortening that TTL protects both bots and does
not multiply blue's probe traffic.

**Risks, and what bounds each.**

- _The prediction is too high_ → the encoded floor lands **below** break-even. Caught unconditionally:
  the postcondition accepts a quote only when the **venue's own reported minimum** clears break-even, so
  a bad prediction cannot produce a bad fill. It costs the second call back, which is what the
  optimization was trying to save — the neutral outcome.
- _The prediction is too low_ → the encoded floor lands **above** break-even, and this is the hazard
  worth naming. The overshoot factor is `realQuote / prediction`, **unbounded in how pessimistic the
  curve is**: a curve only 0.5% low encodes a floor ~62 bps above break-even, three times the whole
  ~20 bps post-maturity incentive. Every fill in that band reverts at send although the repay would
  have covered it — the exact failure the 2026-08-28 window measured, where a min-out shortfall
  rejected 153 of 167 simulated sends. `clearsFloor` is one-sided and cannot see it.

  So the postcondition is made **symmetric**: past a bound of twice the prediction margin, the second
  pass is spent to re-derive against the venue's real quote and land the floor back on break-even. That
  trades an unbounded economic cost for at most one extra HTTP call, which is the correct direction. The
  bound is set at twice the margin because an accurate curve's overshoot **is** the margin — so the cap
  is the amount deliberately spent plus rounding, not a multiple of the prize.

- _The re-derivation itself fails_ (a 429 or a timeout on the second call) → reported as the
  **transport** failure it is, never as the economic `floor_unmet`. The distinction is load-bearing:
  decision 5's fall-through cap is entitled to stop the venue walk on an economic verdict, so
  mislabelling a transient 429 as one would lose a liquidation the runner-up could have filled. When the
  first quote already cleared the floor and only overshot it, a declined or failed re-quote simply
  leaves that expensive floor standing rather than dropping a fundable fill.

### Implementation Phases

- **Phase 1 — ladder and cache shape.** USD decades converted per pair, rate-per-rung storage, the
  shorter TTL. Ranking stays gross. This phase is observable on its own: `probe.venue_error` should
  vanish from the top rung and the rung nearest a real seize should stop being the bottom one.
- **Phase 2 — net-of-cost ranking and pre-screen.** Derive bps per candidate at read time, order
  above the cap, fail open. This is the phase
  [TIB-2026-08-28](./TIB-2026-08-28-midnight-send-shortfall-classification.md) depends on for
  bounding firm quotes per position per tick.
- **Phase 3 — per-pool cost attribution.** Enough resolution to decide `excludedSources` on evidence
  rather than on the variance intuition that TIB deferred.

## Considered Alternatives

### Alternative 1: Keep the whole-token ladder and just add rungs below it

**Why rejected:** it fixes the range without fixing the axis. A whole-token ladder means something
different for every collateral and drifts with the collateral's price, so the same rung index is not
comparable across pairs and the calibration rots — which is why July 9 already listed per-collateral
ladder calibration as a follow-up. USD decades make the calibration unnecessary instead of
per-collateral.

### Alternative 2: Store cost in bps in the probe cache

**Why rejected:** bps requires an oracle reference, and the cache is keyed by pair, not by market. It
would bake whichever market probed first into an entry every market on that pair then reads. Storing
the rate and deriving bps at read time keeps the cache market-independent, which is what makes
sharing it safe.

### Alternative 3: Keep the 10-minute TTL and correct for drift analytically

**Why rejected:** a drift model is a second thing to be wrong about, for a level that costs 24 calls
on an isolated client to simply re-measure. The measurement is cheaper than the model.

### Alternative 4: Put gas into the curve as well, and rank fully net

**Why rejected:** gas is not a property of the `(pair, venue, size)` the cache is keyed on, so it
would make a shared per-pair entry unshareable. It stays a decision-time term — this preserves
July 9's split rather than reversing all of it.

### Alternative 5: Apply cost below the candidate cap, where the plan already ranks

**Why rejected:** the cap truncates by the ordering it is given. Ordering gross and then costing the
survivors can discard the cheapest candidate before its cost is visible, which reproduces the defect
the curve exists to fix.

## Assumptions & Constraints

- **A pair's venue rate is market-independent.** It is a DEX price, not a protocol oracle. This is
  what licenses sharing one cache entry across every market on the pair; if it were false, the
  sharing in decision 2 would be unsound.
- **All venues at a rung are probed within one refresh**, which is what makes ordering drift-immune
  at any cache age (decision 3). A partial refresh that mixed venues from different refreshes would
  break the asymmetry and make the shorter TTL load-bearing for ordering too.
- **Route cost interpolates acceptably in log space between decade rungs.** Decades are coarse; the
  interpolation is an approximation, and the fail-open path is what bounds being wrong about it.
- **Venue rate limits (~1 rps) hold**, and 24 calls per pair per refresh on the isolated client
  stays inside them for the number of pairs a maturity touches.
- **Seize sizes span decades and cluster small** — measured at the 2026-08-28 maturity (median ≈ $3,
  90% below $800). If a market with a much larger typical seize is listed, the range should be
  re-checked; the decade shape does not need to change.

## Dependencies

- `@repo/swaps` is shared with `blue-liquidation`, which uses the same selector and the same probe
  knobs. The ladder and cache changes land for both bots; the ranking change is per-bot, since Blue
  ranks candidates differently.
- [TIB-2026-08-28](./TIB-2026-08-28-midnight-send-shortfall-classification.md) depends on Phase 2
  landing **first**: running without a retry throttle is bounded only by the pre-screen cutting firm
  quotes per position per tick.

## Observability

- `probe.refreshed` reports the rung set in USD alongside the converted base-unit ladder, so an
  operator can see what was actually priced without knowing the collateral's decimals.
- `probe.venue_error` is expected to stop firing at the top rung — that rung is now $100k rather
  than a size no aggregator will route. Its continued presence there is a real signal rather than
  routine noise.
- Selection logs carry the **derived cost in bps** for the chosen venue and the rung(s) it was
  interpolated from, so a ranking decision can be reconstructed from the log alone.
- **Fail-open is inferable, not signalled by a dedicated event.** There is no `curve.fail_open` line:
  the degradation is read off the events that already exist — `plan.built { routeCostBps: null }` for a
  candidate whose cost could not be derived (cold, clamped, or unpriced), `select.cold_default` for a
  pair with no curve at all, and `probe.warm_failed` / `probe.venue_error` for why. That was the
  deliberate trade: the inference is a one-field filter on a line already emitted per candidate, and a
  second event asserting the same thing can disagree with it. Read `routeCostBps: null` as **the**
  fail-open signal.
- Cache age at selection time is on `select.ok` as `curveAgeMs`, beside `curveCostBps` and
  `firmQuoteCostBps`. Age is what separates the two readings of a probe-fidelity gap — a stale level
  from a bad interpolation — and it is also the field that shows how often decision 7's prediction-age
  ceiling is declining to predict.

## Security

Unchanged trust boundary, but state it precisely: the curve is now an **input to** the min-out
derivation (decision 7), not merely an ordering signal, so "the curve only orders" is no longer the
argument.

What holds instead is that nothing the curve produces is ever trusted. Indicative probe outputs are
still never executed. A curve-derived denominator only decides what slippage we **ask** a venue for; the
quote is then accepted only if the **venue's own reported** minimum clears break-even on its own terms,
and a reconstruction of that minimum never qualifies however large it looks. The oracle route-quality
guard and the on-chain `simulate()` ok-only gate are unchanged. So a wrong, stale, or manipulated probe
can still only cost coverage, a fall-through, or an extra HTTP call — never a bad fill. Fail-open, and
decision 7's two-sided bound, are what keep a degraded curve from becoming either a denial of coverage
or a floor nobody can fill.

## Future Considerations

- **Per-pool cost attribution** (Phase 3), which is the evidence
  [TIB-2026-08-28](./TIB-2026-08-28-midnight-send-shortfall-classification.md) wants before deciding
  `excludedSources`.
- **BOTS-81's absolute floor** consumes the same curve: once cost is derived per candidate, a dust
  gate is a threshold on an existing number rather than new machinery.
- If a listed market's typical seize moves well outside the measured distribution, revisit the rung
  range — not the decade shape.

## Open Questions

- Does the interpolated cost need a rung denser than a decade near the median seize size? Deferrable:
  Phase 1 makes the answer measurable, and fail-open bounds being wrong meanwhile.

## References

- [TIB-2026-07-09: Midnight market whitelist and venue selection](./TIB-2026-07-09-midnight-market-and-venue-selection.md)
  — superseded in the three clauses listed above; its whitelist, key-presence venue enablement,
  probe isolation, and liquidatable-only gating are untouched.
- [TIB-2026-08-28: Midnight send shortfall — classifying a rejected broadcast](./TIB-2026-08-28-midnight-send-shortfall-classification.md)
  — the measurement this responds to, and the decision that depends on Phase 2.
- [TIB-2026-08-28: Midnight loan-as-collateral](./TIB-2026-08-28-midnight-loan-as-collateral.md) —
  the zero-route-cost slot the curve makes comparable to a swapping slot.
- [BOTS-88](https://linear.app/morpho-labs/issue/BOTS-88),
  [BOTS-89](https://linear.app/morpho-labs/issue/BOTS-89),
  [BOTS-90](https://linear.app/morpho-labs/issue/BOTS-90)
