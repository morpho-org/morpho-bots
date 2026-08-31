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
- **Changing the correctness chain.** Firm quote → encoded min-out floor → oracle route-quality
  guard → on-chain `simulate()` is untouched. The curve only orders and pre-screens.

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

**5. The curve fails open.** A cold cache, a rung that returned no venue quote, or a size clamped
past the ladder's ends all fall back to **gross-surplus ordering with full venue fall-through** —
the July 9 behavior. This is the replacement for the superseded assumption: a bad probe still costs
at most a fall-through to the runner-up, never a bad fill and never a skipped position. Fail-open is
a decision, not an oversight: the curve is an optimization over an ordering that was already
correct-enough, so it must never be able to _remove_ coverage.

**6. Probe budget: 8 rungs × 3 venues = 24 calls per pair per refresh**, on the isolated probe client
at `PROBE_HTTP_RPS=1`, and only for pairs with a liquidatable position. That is up from 15 calls per
pair, on a shorter TTL — but it stays on the separate rate-limited client, so a probe burst still
cannot queue ahead of a live firm quote, and it is still O(liquidatable pairs) rather than
O(candidates).

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
- **Fail-open is logged, not silent.** A cold, incomplete, or clamped curve emits an event when it
  falls back to gross ordering; otherwise the degradation is invisible and would be mistaken for the
  curve working.
- Cache-age distribution at selection time, since the shorter TTL is the thing keeping the cost level
  meaningful.

## Security

Unchanged trust boundary. Indicative probe outputs are still never executed: the firm quote's
encoded min-out, the oracle route-quality guard, and the on-chain `simulate()` ok-only gate remain
the whole trust chain. The curve influences only _ordering_ and _pre-screening_, so a wrong, stale,
or manipulated probe can cost coverage or a fall-through — never a bad fill. Fail-open is what keeps
a degraded curve from becoming a denial of coverage.

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
