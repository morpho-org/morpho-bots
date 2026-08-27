# BOTS-35 (item 3): Midnight liquidation slippage guard

| Field        | Value                                                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Status       | Exploration complete, economics verified against production logs; recommend re-scoping BOTS-35 to correctness fixes only                  |
| Linear issue | [BOTS-35](https://linear.app/morpho-labs/issue/BOTS-35/fixmidnight-liquidation-order-by-profit-fix-allowance-and-slippage) — third defect |
| Scope        | `bots/midnight-liquidation` sizing + quoting seam, `@repo/swaps` min-out derivation, operator documentation                               |
| Prod config  | Base 8453, venues `['lifi', '0x']`, `SLIPPAGE_BPS` unset → default `100`                                                                  |

## Objective

BOTS-35's acceptance criterion for this item is: _"The slippage guard is retuned (or made adaptive)
so it does not reject economically sound fills during a maturity burst."_

Exploration establishes that the guard was not mis-tuned in one direction. It is **simultaneously too
loose to protect the repay and too tight to be usable as a gate**: at `SLIPPAGE_BPS = 100` the min-out
floor sits below break-even (so shortfalls surface at the repay instead), while gating on that same
floor would demand 100 bps of headroom against a tier whose lifetime maximum can be 60 bps. Retuning
it in either direction cannot produce a won position, because the binding constraint was never the
guard.

A swap-funded liquidation has only `lif − 1` of headroom, which post-maturity ramps from zero over an
hour, so early attempts are unprofitable by construction. But the decisive finding is narrower and is
now measured: **our execution cost on the position that mattered exceeded the headroom for the entire
window in which it was available.** We did not lose it to a mis-tuned guard, and we did not lose it to
sampling. Nor — measured, not assumed — to price impact: at ~$10k, size-related impact on cbBTC→USDC is
approximately zero. What remains is size-independent cost, most likely oracle-versus-DEX basis plus
venue coverage, and that is where the competitive question actually sits.

This document records the evidence, then proposes the change that satisfies the criterion's _intent_.

> **Evidence provenance.** The economics below are **verified against production logs** (Better Stack
> source 2607569, s3 archive, 2026-07-31 14:59–15:10), obtained by the BOTS-35 item 2 session. The
> viability predicate `cost_bps ≤ (maxLif − 1)·t/3600` predicts **13 of 13** simulate outcomes at
> t+138–144, including two dust rejections, and the log fit brackets `maxLif − 1 ≥ 432 bps`
> independently confirming the 438.4 bps tier lookup. Still _not_ verified: the winner's t+123 s strike
> is ticket-derived (no on-chain `Liquidate` event was checked). Ticket counts are slightly off —
> 131 allowance reverts, not 120; 157 `tx.submit_failed`, not 133.

## The mechanism behind `Error(return too low)`

The revert string is not ours; no such string exists in this repository or in the Midnight contracts.
It is a venue router's min-out revert, bubbled verbatim by `Executor._revert`. The path that surfaces
it as `tx.submit_failed` rather than `simulate.revert` is:

1. `runTick` calls `simulate` — an `eth_call` at the then-current head
   (`packages/bot-kit/src/simulate.ts`). It returns `ok`.
2. The `ok`-only gate opens and `runTick` calls `submit`
   (`bots/midnight-liquidation/src/runner/tick.ts:216`).
3. `submit` → `PendingQueue.submitLocked` → the injected `send`, which begins with
   `prepareTransactionRequest` (`packages/bot-kit/src/signer.ts:110`). That performs an
   **`eth_estimateGas` against a newer block**.
4. In a burst, the pool moved between (1) and (3). The baked-in `amountOutMinimum` no longer clears,
   the estimate reverts, `send` throws, and the queue logs `tx.submit_failed` with the decoded router
   reason.

So `simulate.ok` followed by `tx.submit_failed: Error(return too low)` is a _stale-quote_ signature,
not a configuration error. The **157** observed `tx.submit_failed` events (the ticket says 133) are
sends whose quote aged out before gas estimation — though `tx.*` carries no borrower or id, so they
cannot be attributed to positions.

Two adjacent defects sit on the same lines and are worth naming, though neither is this item:

- `submit` returns `boolean`, and `runTick` ignores it: a failed submit still runs `backoff.clear(label)`
  and `counters.submitted += 1`. That both inflates the `submitted` metric and removes the only
  brake on immediate re-attempt — the direct cause of the _thrash_ as distinct from the individual
  failures. PR #134 fixes this properly, returning a `SubmitOutcome` so only `kind: 'sent'` clears
  backoff.
- The two error strings in this incident share one economic cause (see the next section) but have
  **different amplifiers**, so they need one economic fix and two accounting fixes. The allowance
  failures were at the _simulate_ stage, where `backoff.record` fires and does suppress (**131**
  observed, t+13 → t+595 — backoff working as designed); the min-out failures were at the _send_ stage,
  where `backoff.clear` fires instead and suppresses nothing (**157** observed). Only the send-stage
  amplifier is what PR #134 fixes.
- `cooldown.mark(label)` is called on quote failure and sim revert but not on submit failure, so the
  opt-in cooldown cannot damp this loop either (it is also disabled by default:
  `POSITION_LIQUIDATION_COOLDOWN_MS=0`).

## Why retuning cannot win the position

Midnight's post-maturity liquidation incentive is not constant. `lifAt`
(`bots/midnight-liquidation/src/sizing/lif.ts`) mirrors the contract: in post-maturity mode LIF ramps
**linearly from WAD to `maxLif` over `TIME_TO_MAX_LIF` = 3600 s**. And `maxLif` is itself small,
derived on-chain as `WAD² / (WAD − cursor·(WAD − lltv))` (`midnight-contracts.txt:874`).

A seize-exact plan pins `seizedAssets`; the contract derives the repay as
`ceil(ceil(seized·price/SCALE)·WAD/LIF)`. So the swap must return at least `oracleValue / LIF` or the
repay transfer fails and the whole transaction reverts atomically. The economic headroom available to
cover DEX execution cost is therefore exactly `LIF − 1`.

The incident market is **determined, not inferred**. The ticket names `0x168e3125…a47937`; the markets
API returns `maturity 1785510000 = 2026-07-31T15:00:00Z` (matching the ticket exactly), loan USDC,
and a **single** collateral slot: cbBTC at `lltv 0.860 / cursor 0.30`, so `maxLif = 1.043841` and a
headroom ceiling of 420.0 bps. Every number below for the incident uses that tier.

Computed from the live markets API for the three cbBTC/USDC collateral tiers on Base:

Headroom is the ratio `(lif − 1)/lif`, not `lif − 1`. The two are interchangeable early in the ramp
(where every decision in this incident was made) but diverge by ~4% at full ramp, and the clamped value
is the hard ceiling that matters:

| lltv  | cursor | maxLif   | @ t+60s | @ t+123s | @ t+300s | @ t+600s | ceiling (t ≥ 3600 s) |
| ----- | ------ | -------- | ------- | -------- | -------- | -------- | -------------------- |
| 0.860 | 0.30   | 1.043841 | 7.3 bps | 15.0 bps | 36.4 bps | 72.6 bps | **420.0 bps**        |
| 0.915 | 0.30   | 1.026167 | 4.4 bps | 8.9 bps  | 21.8 bps | 43.4 bps | **255.1 bps**        |
| 0.980 | 0.30   | 1.006036 | 1.0 bps | 2.1 bps  | 5.0 bps  | 10.1 bps | **60.0 bps**         |

On the incident tier the $10,004 fill was lost at **t+123 s**, where headroom was 14.98 bps. Our
observed quotes on that size never came in below 16.37 bps (see below), so the position was never
affordable to us while it was available.

Consequences that follow directly:

- **Widening `SLIPPAGE_BPS` is futile.** It moves the failure from the router's min-out revert to the
  protocol's repay shortfall. Same skipped position, one block later, more gas burned on estimates.
- **Tightening it is also irrelevant.** The binding constraint was never the guard.
- **We cannot lose principal to a loose guard.** If the swap under-delivers, the repay fails and the
  transaction reverts; the Executor's structural sweeps mean a successful exec ends at zero balance.
  The only exposure to a loose guard is sandwich extraction of the surplus, which is real but is a
  late-ramp concern, not an early-ramp one.

### The realized execution cost is an interval, and it overlaps the winner's

Our first `simulate.ok` was t+138 s. But attempts were not continuous — the backoff schedule
(base 2 / max 64 blocks, ~2 s Base blocks) puts them at t = 13/17/25/41/73/137/265/393 s. So:

```text
attempt t+73s   → headroom  8.89 bps   (failed)
attempt t+137s  → headroom 16.68 bps   (first simulate.ok at t+138s)
⇒ our realized execution cost ∈ (8.89, 16.68] bps
winner struck at t+123s   → their total cost ≤ 14.98 bps
```

**The ranges overlap.** So the evidence does not support "the winner executed more cheaply than we
could", and an earlier draft of this document was wrong to say the winners were "almost certainly
inventory-funded". A swap-funded liquidator with ~15 bps execution, polling every block, explains the
t+123 s strike completely — note that a 15 bps cost puts the deterministic crossover at exactly
t+123 s. Inventory funding remains a plausible and strategically interesting answer, but it is not
what this incident demonstrates.

### What lost the position: our cost exceeded headroom the whole time it was available

**Verified from production `select.ok` lines.** Every quote the $10,004 position (`0x5b878f8e…`) ever
received:

| t     | quoted cost | headroom then | viable |
| ----- | ----------- | ------------- | ------ |
| +14 s | 17.37 bps   | 1.70 bps      | no     |
| +21 s | 18.29 bps   | 2.56 bps      | no     |
| +29 s | 16.37 bps   | 3.53 bps      | no     |
| +43 s | 18.75 bps   | 5.24 bps      | no     |
| +75 s | 25.12 bps   | 9.13 bps      | no     |

It never appears in `simulate.ok`, all window. Headroom at the winner's t+123 s strike was 14.98 bps;
the position's **best-ever** quote was 16.37 bps. Its `t_cross` was ~134 s at that best cost and ~206 s
at its last. So it was not viable at t+123 s under any observed quote — perfect per-block polling would
not have taken it. The winner cleared ≤ 14.98 bps; our cheapest route on that size was 16.37 bps. They
were genuinely cheaper, by 1.4–10 bps.

### The cost was NOT price impact — measured

At t+138–144 the eleven positions we won cost 7.85–10.4 bps and were $0.05–$80; the $10k position cost
16.4–25.1 bps. That looks like a size penalty, and an earlier draft of this document read it as one.
**It is not.** Measured against the marginal (smallest-probe) rate via LiFi, cbBTC→USDC on Base:

| notional   | impact vs marginal | routed via |
| ---------- | ------------------ | ---------- |
| $80        | 0.00 bps           | fly        |
| $845       | 1.13 bps           | fly        |
| $8,448     | −1.74 bps          | fly        |
| $84,483    | 1.26 bps           | kyberswap  |
| $422,417   | 2.88 bps           | kyberswap  |
| $844,834   | 10.63 bps          | fly        |
| $1,689,667 | 18.84 bps          | fly        |

Size-related impact at ~$10k is **approximately zero**. So almost none of the observed 16–25 bps was
price impact, and slicing a trade whose impact is already zero recovers nothing. The residual must be
size-independent:

- **oracle-versus-DEX basis** at that moment — the likeliest candidate, and precisely the offset this
  measurement excludes by construction;
- **route/venue coverage** — prod runs `['lifi','0x']`, while these probes routed via `fly` and
  `kyberswap`, neither of which the bot quotes;
- **a confound to check**: whether the eleven cheap positions were even the same collateral. If they
  were cbETH or wstETH rather than cbBTC, the 7.85–10.4 vs 16.4–25.1 gap is different-basis, not
  different-size. `select.ok` carries `collateral`, so this is answerable from the logs.

Caveats: this measures **today's calm liquidity**, not 31 Jul during the burst — though a pool that
absorbs $1.7M at 19 bps does not move on the burst's total $11,424, so drainage is an implausible
explanation. Readings under ~2 bps are routing noise between probes; treat them as zero.

### Partial sizing: structurally sound, no live instance

Headroom is hard-capped, because `lif = min(maxLif, …)`: the ceiling is `(maxLif − 1)/maxLif` = **420.0
bps** for the incident tier. A position whose swap cost exceeds that is **permanently** unliquidatable
single-shot — not "unprofitable for a while", never, at any `t`. That is exact and independent of any
curve fit. Since repayment is what makes lender funds withdrawable
(`_marketState.withdrawable += repaidUnits`), the harm is stranded lender capital rather than bad debt;
a purely underwater position is fine regardless, since bad-debt realization is the `(0,0)` plan and
needs no swap.

The largest live single position is real and large — **$1,005,266**, borrower `0xC6877a6534…`, market
`0x549cd072daf9…`, from the candidates endpoint. But at the _measured_ curve ~$1M costs ~11 bps, so it
clears comfortably inside the ramp. On a concave curve the 420 bps breakpoint sits orders of magnitude
above the entire current book ($1.98M). **So the argument is structurally valid with no instance at any
plausible near-term book size**, and it should be re-derived from a measured curve, not a fit, before
being scheduled.

If it is ever built, three things make it plumbing rather than a project:

1. **The protocol permits it.** `liquidationLocked` reads `UtilsLib.tGet(LIQUIDATION_LOCK_SLOT, …)`,
   i.e. `tload` — **transient storage**, set at `Midnight.sol:1647` and cleared at `:1678` inside the
   same call. It is a re-entrancy guard, transaction-scoped; nothing rate-limits liquidation across
   blocks. Post-maturity mode also skips the RCF cap (`if (!postMaturityMode && lltv < WAD)`), leaving
   debt as the only ceiling.
2. **It does not need repay-exact.** Seize-exact accepts an arbitrary `seizedAssets`, so passing a
   partial amount instead of `wholeSlotPlan`'s `bestCollateralAmt` gives depth-aware sizing while
   keeping the deterministic sell-side amount that LiFi and 0x require for fixed-amount calldata.
   This supersedes an earlier note in this document that depth-aware sizing was repay-exact's one
   surviving merit — repay-exact now has no argument left.
3. **The size ladder already exists.** `PROBE_LADDER` defaults to `['0.01','0.1','1','10','100']` whole
   collateral tokens and `select(pair, amountIn)` returns per-venue estimates _for a size_. The venue
   selector already measures the cost-versus-size curve; the bot ranks venues with it and discards the
   size dimension.

Because the cost is size-independent, the two candidates that survive are **additional venues** (better
price discovery — cheap, and the probes routed via `fly`/`kyberswap`, which the bot does not quote) and
**inventory funding** (removes basis and impact exposure entirely, at the price of holding collateral
risk). Both deserve their own issues.

One inequality worth recording without over-reading it: if basis was 16–25 bps for us and the winner
cleared at ≤14.98 bps while facing the same basis, they were plausibly not swapping at all. That
partially revives inventory funding as the explanation — but it is a hypothesis resting on a single
inequality, and two diagnoses in this document have already been overturned by exactly that kind of
reasoning.

### The backoff gap is real, observed, and was not decisive here

An earlier draft of this document argued the backoff schedule lost the position. The `select.ok` series
above refutes that: the position's best-ever quote (16.37 bps) exceeded the headroom at the winner's
strike (14.98 bps), so per-block polling would not have taken it either. The gap is nonetheless real
and observed — quoted at t+75 s, next attempt scheduled ~t+137 s, winner struck at t+123 s squarely
inside the hole — and it remains worth fixing on its own merits.

The cause is a category error: exponential backoff treats a **deterministically improving** condition
as a random failure. Headroom is `(lif − 1)/lif` with `lif` rising linearly in known chain time, so
the moment it clears is a closed form, not something to be discovered by retrying:

```text
t_cross = 3600 · cost_bps / (maxLif − 1)_bps          // per (market, collateral tier)

cost  5 bps → t+41s        cost 15 bps → t+123s
cost 10 bps → t+82s        cost 30 bps → t+246s
```

Backing off doubles the wait exactly when waiting is least justified. This makes the gate two-sided:
suppress attempts before `t_cross` (killing the thrash), and attempt **every block** from `t_cross`
onward without economic backoff. An economic failure below `t_cross` carries no information beyond the
clock; one above it is noise, not grounds to sleep 64 seconds. Transport failures keep their existing
backoff.

## What the prize is actually worth

The liquidator's entire margin is the LIF bonus, so the gross prize is `notional × headroom`, not
notional. On the incident position:

```text
t+123s (winner strikes)   headroom 14.98 bps  →  gross $14.94
t+143s (our first ok)     headroom 17.41 bps  →  gross $17.37
our net at our best observed cost (16.37 bps) →  $1.04
```

The whole maturity — $11,424 repaid at 15–25 bps clearing headroom — was worth **$17–29 gross**, split
across every liquidator that participated. Our reported $138.74 was notional, worth cents of margin.

Sizing the entire book from the markets API (186 distinct markets, deduped):

```text
outstanding notional   USDC $1,805,977 + WETH $175,737   ≈ $1.98M
markets carrying debt  81 of 186
maturities             2026-07-17 .. 2027-07-17 (364-day span)
```

Every market's whole debt becomes liquidatable at its maturity and the maturities span ~one year, so
roughly one turnover per year. At 15–25 bps clearing headroom that is a total pool of
**$2,973 – $4,954 per year, shared across all liquidators.** The pool is ≈0.2% of notional per
turnover, so it scales: $10M book → ~$20k/yr, $100M → ~$200k/yr.

### This changes the objective, not just the budget

The bot's purpose is protocol safety, not profit — if nobody liquidates, bad debt accrues. The prize
pool does not justify the bot's existence; it justifies (or does not) **competing for contested
positions.** The logs separate those cleanly:

- The $10k position was cleared promptly, by someone, 123 s after maturity. From the protocol's
  perspective that is a healthy outcome. Our loss was ~$1.40 of margin, not a safety event.
- The eleven positions we won were $0.05–$80 — the ones no other liquidator had an economic reason to
  touch. That is the bot **working as a backstop**, not failing.

So BOTS-35's premise that a 1.2%-of-notional share is a defect measures share-of-value against third
parties. On coverage — the metric that bears on protocol safety — we did the part nobody else would and
a cheaper competitor did the part they were better at. That premise deserves challenging on its own,
separately from the three real bugs.

**Consequence for this plan.** Changes #3 and #4 below are correct but are worth ~$1.41 on the position
that prompted them; the honest case for them is rate-limit budget and legibility, not revenue. Change
#2's gate avoids 824 `plan.built` and 81 wasted aggregator quotes per burst, which is real load. All of
it should stay default-off at this book size. Depth-aware partial sizing, split routing, extra venues
and inventory funding should be **shelved** and revisited on book size, not on this incident.

## Items 2 and 3 are one root cause, and the ticket's item-2 premise is wrong

BOTS-35 item 2 states: _"The executor uses a just-in-time exact-amount approve (approve 0, then
approve exactly what's needed, in the same transaction), so the pre-flight simulation appears to be
running against state where that approval hasn't been applied"_, and leaves the 15:02:18 recovery
unexplained.

That premise does not match the encoder. `approvePair`
(`packages/swaps/src/execution/executor-calls.ts:50`) emits `approve(spender, 0)` then
`approve(spender, <live balanceOf>)`, the amount argument spliced at exec by
`balanceOfPlaceholder(token, executor, ERC20_AMOUNT_OFFSET)`. It is **balance-based over-approval,
not an exact amount** — stated at `encode-call.ts:104-106`, precisely because `repaidUnits` is
recomputed on-chain and is not staticcall-readable. So there is no "state where the approval hasn't
been applied": the approve reads the balance in the same transaction, after the swap steps.

Therefore `allowance == balance`, exactly, and:

```text
ERC20: transfer amount exceeds allowance  ⟺  loan balance after swap < derived repay
```

The allowance revert is a balance shortfall wearing an allowance error message. There is no
allowance-provisioning bug, and the 15:02:18 recovery needs no internal-state explanation — the swap
simply began clearing the repay as `lif` ramped.

This consolidates the ticket: **items 2 and 3 are the same root cause at two points inside one
transaction.** `Error(return too low)` is the router refusing mid-swap; `exceeds allowance` is the
repay failing post-swap. Both say the swap did not produce enough, which is the marginality this
document quantifies. They differ only in amplifier — the simulate-stage failures were
backoff-suppressed (`backoff.record` fires), the send-stage ones were not (`backoff.clear` fires
instead) — so they need two accounting fixes but one economic fix.

### Drift bounds: basis versus outright vol

Two distinct exposures, easily conflated:

- **Will the repay clear?** Price-independent to first order. `requiredRepay` and the swap's actual
  output both scale with price, so only oracle-versus-DEX _basis_ drift matters.
- **Will the router min-out clear?** Full outright vol exposure, because `amountOutMinimum` is a frozen
  integer compared against a price-scaling actual output. This is defect #3's error string.

A gate whose two sides are computed from the _same_ lens read at the _same_ instant is price-level
invariant and therefore basis-only — the frozen-integer reading applies to the calldata that has
already been minted, not to the decision. Which is why quote age, not price level, is the variable to
control.

### Drift bounds on any repay-vs-output gate

A gate comparing `amountOutMinimum >= requiredRepay` at quote time is not a structural guarantee.
The output side is pinned by the router, but `requiredRepay_exec = seized · price_exec / lif_exec`
is not. Over the ~2-block sim→exec gap on Base:

```text
lif protection (0.86 tier):  (maxLif − 1) · 4/3600 = 438.4bps × 0.00111 ≈ 0.49 bps
BTC 1σ price move over 4s:   0.40/√(31.5e6/4)                          ≈ 1.42 bps
```

Price dominates the ramp's protection by roughly 3× at 1σ, and is two-sided. Such a gate removes the
_systematic_ failure — the bulk of it — but leaves a random residual, and closing that residual needs
a vol-sized buffer, which is a tuned number. State the claim as "the revert stops being systematic",
never as "unreachable".

## Design decisions

1. **Replace the cosmetic guard with an economic one.** The min-out floor stops being
   `quote·(1 − SLIPPAGE_BPS)` and becomes a function of the repay the contract will derive. A floor
   defined as "break-even plus a retained-surplus share" cannot, by construction, reject a fill that
   was economically sound — which is the acceptance criterion, met by definition rather than by
   calibration.
2. **Add a pre-quote profitability gate, and treat it as the primary deliverable.** The gate compares
   oracle-referenced headroom against an operator-set expected execution cost, before spending an API
   call, a simulation, or a gas estimate. This is what converts 138 seconds of doomed thrash into a
   single correctly-timed attempt once the ramp has cleared cost.
3. **The gate needs two floors, not one — a ratio floor AND an absolute floor.** Headroom is
   **scale-invariant** (see below), so a bps threshold is blind to position size: at t+123 s a $10k
   cap-bound plan and a $1 plan both show 8.93 bps, but their absolute surpluses are $8.94 and
   $0.00089. Gas is a fixed cost, so only the absolute floor can reject dust. The ratio floor answers
   "is the ramp far enough along?"; the absolute floor answers "is this position big enough?". The
   ticket's own aside — eight fills moving $0.00 in aggregate — is the absolute floor missing, and it
   is adjacent to BOTS-81.
4. **The ratio floor stays in loan-token units; the absolute floor needs valuation.** Unlike the Blue
   gate (`docs/plans/crtr-2806-blue-profitability-gate.md`, which explicitly non-goals Midnight), the
   ratio arithmetic needs no price provider: the Midnight oracle converts collateral → loan natively.
   The absolute floor does need a loan-token → USD step to compare against gas, which is the
   `usdValueOf` snapshot BOTS-35 item 1 is already building from
   `GET /markets/midnight/tokens`. Consume that rather than adding a second price path.
5. **Do not paper over the stale-quote window.** Re-quoting immediately before `submit` would close it
   but costs an API round trip in a latency race we are already losing. The profitability gate makes
   the window matter far less, because attempts only happen when headroom exceeds execution cost by a
   margin. Revisit only if evidence shows late-ramp attempts still aging out.
6. **`SLIPPAGE_BPS` remains, as a ceiling.** The derived floor is clamped so it never permits _more_
   slippage than the operator's configured maximum. Operators keep one comprehensible safety knob.
7. **The execution-cost estimate is one operator-owned value, not a tuned constant.** Both this gate
   and the post-quote check in BOTS-35 item 2 compare against an estimate of DEX + gas cost. Two
   independent estimates would drift, so it is a single env knob with a documented default of `0`
   (gate off). The incident implies roughly 10 bps realized for cbBTC→USDC at $10k, but one maturity
   is one data point and that number is not hardcoded.

### Headroom is scale-invariant, and therefore hoistable

Substituting the contract's own derivations for a cap-bound plan (`capBoundPlan`, `plan.ts:88`):

```text
capEff       = cap · (BPS − marginBps) / BPS
seizedAssets = maxSeizeForCap(capEff, price, lif)  ≈ capEff · lif / price
seizedValue  = seizedAssets · price / SCALE        ≈ capEff · lif
repaidUnits  = impliedRepaidUnits(seized, …)       ≈ capEff
headroom     = (seizedValue − repaidUnits) / seizedValue = (lif − 1) / lif
```

`capEff` cancels. Verified numerically against the real `mulDivUp`/`mulDivDown` paths: the lltv 0.915
tier at t+123 s yields **8.9325 bps at `SEIZE_CAP_MARGIN_BPS` of both 0 and 30**, identical to four
decimals. Two consequences:

- **`SEIZE_CAP_MARGIN_BPS` does not eat the headroom.** It shrinks the position by 0.3% and the
  absolute surplus by 0.3% — three cents on an $8.94 surplus — and moves the break-even instant by
  zero seconds. It is doing exactly the one-block-oracle-drift job its docstring claims and should be
  left alone. (An earlier draft of this analysis claimed otherwise by comparing a margin on _size_
  against a margin on _rate_; that was wrong.)
- **The ratio floor is not a per-candidate quantity.** It depends only on the market's maturity, the
  chosen slot's `maxLif`, the mode, and chain time — not on the borrower, the size, the collateral
  amount, or the price. So it is one value per `(maturity, maxLif, mode)` group per block: a few
  divisions per tick, hoistable out of the candidate loop. It also rejects all-or-nothing within a
  group, which is the correct behavior and matches the incident (all 14 candidates failed identically
  at t+13 s because they shared one `lif`). Tests must assert the **group** property or they pass
  vacuously.
- In normal mode `lifAt` returns the full `maxLif` immediately, so headroom is 60–438 bps and the
  ratio floor is a no-op. It bites post-maturity plans essentially only.

## Non-goals

- Inventory-funded liquidation. It is very likely the actual competitive answer, and it deserves its
  own issue and TIB — it changes custody, capital, and risk posture, not a guard.
- Candidate ordering (BOTS-35 item 1) and the allowance revert (item 2).
- Gas-cost modelling or a USD price provider for Midnight.
- Venue selection, private submission, or MEV-aware bidding.

## Proposed changes

### 1. Expose the derived repay from sizing

`impliedRepaidUnits` is currently module-private in `bots/midnight-liquidation/src/sizing/plan.ts:61`,
and `LiquidationPlan` carries `repaidUnits: 0n` for every seize-exact plan. The quoting layer needs
the value the contract _will_ derive.

Add the LIF-at-plan-time and the derived repay to the plan, so the number is computed once, in the
module that owns the contract-mirroring arithmetic:

```ts
export type LiquidationPlan = {
  collateralIndex: number
  seizedAssets: bigint
  repaidUnits: bigint
  postMaturityMode: boolean
  /** LIF the plan was sized at — `lifAt` for this mode and block timestamp. */
  lif: bigint
  /** Repay the contract will ceil-derive for `seizedAssets` at `lif`; the swap's break-even output. */
  impliedRepaidUnits: bigint
}
```

`planSurplus` already computes exactly this pair internally; the change is to surface it rather than
recompute it. **Open verification item:** `repaidUnits` are _units_, not assets. Both markets sampled
have `current_settlement_fee_wad: 0` and `continuous_fee_rate: 0`, so units and assets coincide today,
but the units→assets conversion must be confirmed against `midnight-contracts.txt:1819` before the
floor is trusted as a loan-token amount.

### 2. Pre-quote profitability gate in the tick

Before the `quoteFor` call, and only for non-bad-debt plans. Two independent floors:

```ts
// Ratio floor — group-level, hoisted out of the candidate loop (one value per maturity/maxLif/mode).
const headroomBps = ((referenceAmountOut - plan.impliedRepaidUnits) * BPS) / referenceAmountOut
// Absolute floor — per-candidate, the only one that can reject dust.
const surplusUsd = usdValueOf(loanToken, referenceAmountOut - plan.impliedRepaidUnits)
```

- Bad-debt realizations bypass both floors (they perform no swap), matching the existing
  `isBadDebtRealization` branch.
- Marks the cooldown, so a position below threshold is not re-evaluated every block for an hour.

**Placement is settled.** PR #134 is being closed as superseded, with its essentials absorbed into the
BOTS-35 item 1 PR — so `planWithReason()`, `PlanSkipReason`, `plan.skipped` and `LEVEL_BY_REASON` will
exist. The ratio floor folds in as the `insufficient_headroom` variant: no new counter, no new event.
#134's sum identities stay intact, with the skip absorbed by
`liquidatable === inflightSkipped + planSkipped + planned`, because the candidate never enters the
worked set. The gate is pure arithmetic over `PlanInput` — `blockTimestamp`, `maturity` and
`bestCollateralMaxLif` are all already there, so `PlanInput` needs no widening, and the threshold
arrives via the existing `PlanOptions`.

Requirements on that seam, agreed with the item 1 fork:

- **Plan-skip must record neither backoff nor cooldown**, which is today's behavior
  (`if (!liquidationPlan) continue`). This is load-bearing: see change #4. A per-reason suppression
  policy, if one is ever added, must default to "no suppression".
- `LEVEL_BY_REASON` maps `insufficient_headroom` to **`debug`**. Because headroom is a group property
  it fires identically for every candidate in a group — 14 identical lines per tick is the same defect
  as the 133 identical warnings the post-mortem had to read. The ramp-curve telemetry comes instead
  from one group-level line at `info`, cadence-gated by #134's `createBlockSampler`, whose
  edge-triggered semantics ("a quiet stretch never consumes the window, so the first occurrence after
  any gap is always reported") are exactly right for this.
- Payload for this reason: `headroomBps`, `lif`, `maxLif`, `secondsSinceMaturity`, `tCrossSeconds`.
  `tCrossSeconds` is what makes the line actionable rather than merely diagnostic — it says when the
  position _will_ be viable.

Event naming is agreed with the BOTS-35 item 2 fork, split by pipeline stage to match the existing
`plan.*` / `quote.*` / `simulate.*` convention: this gate is `plan.headroom_insufficient`; their
post-quote check (real swap output vs required repay) is `quote.unprofitable` / `quoteUnprofitable`,
a sibling of `quoteFailed` in #134's identity. The two are filter-then-verify, not duplicates: this
one is a cheap necessary condition computed from the oracle, theirs is the accurate check that costs
the API call this one is trying to save.

### 3. Economic min-out floor in `@repo/swaps`

`QuoteParameters` gains an optional absolute floor alongside `referenceAmountOut`:

```ts
/** Absolute break-even output; the min-out floor must not sit below this. Omitted → legacy behavior. */
minAcceptableAmountOut?: bigint
```

Per-venue derivation, matching how each venue actually binds its floor:

- **uniswap-v3** encodes `amountOutMinimum` locally
  (`packages/swaps/src/venues/uniswap-v3.ts:50`) → set it to
  `max(minAcceptableAmountOut, referenceAmountOut·(1 − slippageBps))`. Direct.
- **lifi / 0x / 1inch / liquidswap** have their floor baked by the API from a `slippage` parameter, so
  an absolute floor is not directly expressible. Derive the _percentage_ instead, from the venue
  estimate the probe cache already holds (`select()` returns `expectedAmountOut` per venue — no extra
  API call):

  ```ts
  const allowedBps = ((estimate - minAcceptableAmountOut) * BPS) / estimate
  const effectiveSlippageBps = clamp(allowedBps, 0, slippageBps)
  ```

  This is the largest slippage that still keeps the aggregator's own min-out above break-even, so it
  is simultaneously adaptive and never looser than the operator's ceiling. On a cold probe cache, fall
  back to `referenceAmountOut` as the denominator — the same oracle reference uniswap-v3 already uses.

**Quote freshness is load-bearing here, and the probe cache is not a substitute.** `amountOutMinimum`
is a frozen integer in calldata while the actual output scales with price, so the guarantee decays with
quote age: over ~2 blocks the residual is oracle-versus-DEX basis, but over minutes it becomes outright
price vol. `PROBE_STALE_MS` defaults to `600_000` — ten minutes, most of the ramp — so a probe estimate
may not be used as the denominator for the derived slippage. Use the firm quote that is actually being
broadcast, and never reuse a quote across the ramp.

The strongest justification for the floor is not the diagnostic one (both paths revert; the floor just
names the cause and burns slightly less gas). It is that the floor makes **`SLIPPAGE_BPS` monotone and
safe to widen**: today, raising it loosens the router's protection and pushes shortfalls onto the
repay, so the knob has a perverse range. With the floor, widening it can never take min-out below
break-even.

### 4. Exempt economic failures from backoff, and schedule on `t_cross`

The change with the clearest link to the lost position. Today an economic failure records exponential
backoff, so the bot sampled t+73 s then t+137 s across a crossover that was computable in advance.

- A plan below `t_cross` is skipped **without** `backoff.record` — it is not a failure, and the wait is
  already known exactly. The cooldown (or a scheduled wake at `t_cross`) carries it instead.
- From `t_cross` onward the position is attempted **every block** with no economic backoff. Only
  transport-class failures (`api_error`, `rate_limited`, `timeout`, RPC faults) keep today's backoff.
- This is the one item that requires distinguishing failure classes. `QuoteFailureReason` already
  separates `no_route` / `bad_route` from `timeout` / `rate_limited` / `api_error`, so the seam exists;
  the sim-revert path is the one that currently conflates them.

### 5. Configuration surface

| Env                  | Default | Meaning                                                                                                 |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------- |
| `EXECUTION_COST_BPS` | `0`     | Estimated DEX + gas cost. The ratio floor. Shared with the BOTS-35 item 2 gate — one estimate, not two. |
| `MIN_NET_PROFIT_USD` | `0`     | The absolute floor. Rejects dust, which the ratio floor structurally cannot.                            |
| `SLIPPAGE_BPS`       | `100`   | Unchanged in name and default; now a **ceiling** on the derived min-out floor rather than the floor.    |

Both gates default off, keeping the open-source posture the repo already takes with
`ALLOW_BAD_DEBT_ONLY` and `POSITION_LIQUIDATION_COOLDOWN_MS`: existing deployments are unaffected
until an operator opts in. Prod values come from the next maturity's measured execution cost — the
incident implies roughly 10 bps for cbBTC→USDC at $10k, which is one data point and deliberately not
a default.

## Test plan

Following repo convention — `test/` mirroring `src/`, vitest, additive to the nearest existing file.

- **Sizing** (`bots/midnight-liquidation/test/sizing/plan.test.ts`): `impliedRepaidUnits` and `lif` are
  surfaced and equal what `planSurplus` uses; the round-trip
  `impliedRepaidUnits(maxSeizeForCap(cap)) <= cap` invariant still holds; post-maturity ramp endpoints
  (t+0 → WAD, t ≥ 3600 → `maxLif`).
- **Backoff class** (`bots/midnight-liquidation/test/runner/tick.test.ts`): a plan below `t_cross` does
  NOT call `backoff.record`; a transport-class failure still does; a position at `t_cross + 1 block` is
  retried on the very next block rather than after a doubled wait. This is the assertion that maps
  directly to the lost position, so it should fail loudly if the exemption regresses.
- **Crossover arithmetic** (`bots/midnight-liquidation/test/sizing/lif.test.ts`): `t_cross` for the
  incident tier (`maxLif = 1.043841`) is t+123 s at 15 bps and t+82 s at 10 bps; a tier whose lifetime
  maximum headroom is below the configured cost (0.980 tier at 60.4 bps vs 100 bps) yields no crossover
  at all and must be skipped for the entire post-maturity hour rather than looping.
- **Tick** (`bots/midnight-liquidation/test/runner/tick.test.ts`): a plan below `EXECUTION_COST_BPS` is
  skipped with **no `quoteFor` call** (the point of the gate) and marks the cooldown; a bad-debt
  realization bypasses both floors; both knobs at `0` reproduce current behavior exactly. Because the
  ratio floor is scale-invariant, assert the **group** property — every candidate sharing a
  `(maturity, maxLif, mode)` group is skipped or worked together, and a per-candidate threshold test
  would pass vacuously. Assert separately that a large and a dust candidate in the **same** group
  diverge under `MIN_NET_PROFIT_USD`, since that is the only floor that can separate them. Assert a
  normal-mode candidate is never skipped by the ratio floor (`lifAt` returns full `maxLif`, so headroom
  is 60–438 bps).
- **Venues** (`packages/swaps/test/venues/*.test.ts`): uniswap-v3 floors at
  `minAcceptableAmountOut` when it exceeds the slippage-derived value; the aggregators' derived
  `effectiveSlippageBps` is clamped to `[0, slippageBps]` and computed from the probe estimate;
  omitting `minAcceptableAmountOut` reproduces every existing expectation byte-for-byte.
- **Regression guard**: per CLAUDE.md, break one assertion in each new file, confirm it fails, revert.

Fork coverage in the anvil suite is deliberately not proposed: the gate is pure arithmetic over lens
output, and the existing fork tests already cover the exec path.

## Verification workflow

Per CLAUDE.md, run once the code is settled — `Promise.all`-concurrent where independent:

1. `pnpm --filter @morpho-org/midnight-liquidation run typecheck` and `pnpm --filter @repo/swaps run typecheck`
2. `pnpm lint` (workspace-level, zero warnings)
3. `pnpm format`
4. `pnpm test`

## Decisions needed before implementation

1. **Is the competitive work worth doing at all?** The whole-book pool is ~$3–5k/year (above). This is
   the decision that governs the others: re-scope BOTS-35 to the correctness fixes, and shelve the
   competitive work until book size justifies it. Depth-aware sizing in particular has no live instance
   at the measured curve. The cheapest competitive item, if any is wanted, is **venue coverage** — the
   probes routed via `fly` and `kyberswap` and the bot quotes neither.
1. **Should BOTS-35's premise be challenged?** It treats a 1.2%-of-notional share as the defect. On
   coverage — the metric that bears on protocol safety — the bot behaved correctly as a backstop.
   Recommend rewriting the framing and the third acceptance criterion.
1. **Should items 2 and 3 be merged?** One economic root cause, two separate accounting defects. The
   item-2 premise about an exact-amount approve is factually wrong (`approvePair` is balance-based) and
   should be corrected regardless — it currently reads as an open mystery the encoder already answers.
   Ticket counts are also off: 131 allowance reverts not 120, 157 `tx.submit_failed` not 133.
1. **Do the cheap correctness fixes land, and in what order?** All four are small, all are verified
   against production, and none is justified by revenue: the misleading allowance string (131
   occurrences), the discarded `SubmitOutcome` clearing backoff on failed sends, the backoff hole across
   a computable crossover, and `tx.*` carrying no borrower/id so 157 failures are unattributable — that
   last one breaks the repo's documented id-join convention exactly where the `SubmitOutcome` fix lands.
1. **Thresholds stay at `0`.** No prod behaviour change is proposed at this book size. The
   `plan.skipped` telemetry still earns its place by bounding wasted aggregator quotes (81 per burst)
   and `plan.built` volume (824 per burst), which is rate-limit budget rather than margin.

Settled during exploration, recorded so they are not re-litigated:

- **PR #134** is being closed as superseded, its essentials absorbed into the item 1 PR — so the gate
  folds into `PlanSkipReason` as `insufficient_headroom`, adding no counter and no event.
- **Repay-exact is closed: no.** Seize-exact already accepts an arbitrary `seizedAssets`, so it does
  depth-aware sizing without losing the deterministic sell-side amount fixed-calldata venues need.
- **`SEIZE_CAP_MARGIN_BPS` is fine as-is** — headroom is scale-invariant, so the margin costs 0.3% of
  surplus and moves the break-even instant by zero seconds.
