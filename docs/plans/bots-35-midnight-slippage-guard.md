# BOTS-35: Midnight liquidation — slippage guard, and what the 31 Jul maturity actually showed

| Field        | Value                                                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Status       | Investigation complete, economics verified against production logs. Awaiting decisions below; no code written.                            |
| Linear issue | [BOTS-35](https://linear.app/morpho-labs/issue/BOTS-35/fixmidnight-liquidation-order-by-profit-fix-allowance-and-slippage) — third defect |
| Depends on   | PR #181 (`fix/bots-35-tick-telemetry-and-submit-outcome`) — green, MERGEABLE, base with `gh stack`                                        |
| Also touches | BOTS-81 (dust), BOTS-87 (`BlockSampler`, blue port)                                                                                       |
| Prod config  | Base 8453, venues `['lifi', '0x']`, `SLIPPAGE_BPS` unset → default `100`                                                                  |

## Recommendation

**Re-scope BOTS-35 to correctness, and treat the competitive framing as answered rather than open.**

The ticket asks for the slippage guard to be "retuned (or made adaptive) so it does not reject
economically sound fills." The guard was not mis-tuned. It is _simultaneously_ too loose to protect the
repay and too tight to gate on, and neither direction of retuning could have won the position. What
actually limits us is that a swap-funded liquidation has only `lif − 1` of headroom, which ramps from
zero over an hour after maturity — and the total prize across the entire Midnight book is **~$3–5k per
year**, shared with every other liquidator.

That does not mean do nothing. It means the work is worth doing for **legibility and correctness**, not
for revenue, and the ordering changes accordingly: measure first, then fix the two real defects, then add
the gate behind a default-off flag.

## Current state

### The economics (verified)

Post-maturity LIF ramps linearly from `WAD` to `maxLif` over `TIME_TO_MAX_LIF` = 3600 s
(`sizing/lif.ts`, mirroring the contract). `maxLif = WAD²/(WAD − cursor·(WAD − lltv))`
(`midnight-contracts.txt:874`). A seize-exact plan pins `seizedAssets` and the contract derives the repay
as `ceil(ceil(seized·price/SCALE)·WAD/LIF)`, so the swap must return at least `oracleValue / LIF` or the
repay fails and the whole transaction reverts atomically.

**Headroom is therefore `(lif − 1)/lif`** — not `lif − 1`. The two are interchangeable early in the ramp
but diverge ~4% at full ramp, and the clamped value is the ceiling that matters:

| lltv  | cursor | maxLif   | @ t+60s | @ t+123s | @ t+300s | @ t+600s | ceiling (t ≥ 3600 s) |
| ----- | ------ | -------- | ------- | -------- | -------- | -------- | -------------------- |
| 0.860 | 0.30   | 1.043841 | 7.3 bps | 15.0 bps | 36.4 bps | 72.6 bps | **420.0 bps**        |
| 0.915 | 0.30   | 1.026167 | 4.4 bps | 8.9 bps  | 21.8 bps | 43.4 bps | **255.1 bps**        |
| 0.980 | 0.30   | 1.006036 | 1.0 bps | 2.1 bps  | 5.0 bps  | 10.1 bps | **60.0 bps**         |

The incident market is determined, not inferred: the ticket names `0x168e3125…a47937`, and the markets
API gives `maturity 1785510000 = 2026-07-31T15:00:00Z` (matching the ticket) with a **single** collateral
slot — cbBTC at `lltv 0.860 / cursor 0.30`. So the 420.0 bps ceiling applies.

Because `lif` is clamped, a position whose swap cost exceeds the ceiling is **permanently** unliquidatable
by swap — not "unprofitable for a while", never, at any `t`. Since repayment is what makes lender funds
withdrawable (`_marketState.withdrawable += repaidUnits`), the harm would be stranded lender capital
rather than bad debt. A purely underwater position is unaffected: bad-debt realization is the `(0,0)` plan
and needs no swap.

### Two properties that drive the whole design

**Headroom is scale-invariant.** Substituting the contract's derivations for a cap-bound plan
(`capBoundPlan`, `plan.ts:88`):

```text
capEff       = cap · (BPS − marginBps) / BPS
seizedAssets = maxSeizeForCap(capEff, price, lif)  ≈ capEff · lif / price
seizedValue  = seizedAssets · price / SCALE        ≈ capEff · lif
repaidUnits  = impliedRepaidUnits(seized, …)       ≈ capEff
headroom     = (seizedValue − repaidUnits) / seizedValue = (lif − 1) / lif
```

`capEff` cancels. Verified numerically against the real `mulDivUp`/`mulDivDown` paths (0.915 tier,
t+123 s): **8.9325 bps at `SEIZE_CAP_MARGIN_BPS` of both 0 and 30**, identical to four decimals.
Consequences:

- **`SEIZE_CAP_MARGIN_BPS` is fine as-is.** It shrinks the position and the absolute surplus by 0.3% —
  three cents on an $8.94 surplus — and moves the break-even instant by zero seconds. It is doing the
  one-block-drift job its docstring claims. Leave it alone.
- **The ratio floor is a group property, not a per-candidate one.** It depends only on the market's
  maturity, the slot's `maxLif`, the mode and chain time — never on borrower, size, or price. One value
  per `(maturity, maxLif, mode)` group per block: a few divisions, hoistable out of the candidate loop. It
  rejects all-or-nothing within a group, which matches the incident (all 14 candidates failed identically
  at t+13 s on one shared `lif`). **Tests must assert the group property or pass vacuously.**
- In normal mode `lifAt` returns full `maxLif` immediately, so headroom is 60–420 bps and the ratio floor
  is a no-op. It bites post-maturity plans essentially only.

**A gate must key on headroom, never on cost.** Headroom is known exactly from chain time. Cost is not:
it moved 25 bps → 8 bps in under sixty seconds during the incident, at constant venue and collateral. That
asymmetry is what makes "gate on a threshold" and "re-quote often because cost is volatile" consistent
rather than contradictory, and it is the one design conclusion resting on the contract rather than on this
maturity.

### What the prize is worth

The liquidator's entire margin is the LIF bonus, so the gross prize is `notional × headroom`:

```text
t+123s (winner strikes)   headroom 14.98 bps  →  gross $14.94
t+143s (our first ok)     headroom 17.41 bps  →  gross $17.37
our net at our best observed cost (16.37 bps) →  $1.04
```

The whole maturity — $11,424 repaid at 15–25 bps clearing headroom — was worth **$17–29 gross**, split
across every participant. The reported $138.74 was notional, worth cents of margin.

Sizing the book from the markets API (186 distinct markets, deduped): **~$1.98M outstanding** (USDC
$1,805,977 + WETH $175,737), 81 of 186 markets carrying debt, maturities spanning 2026-07-17 to
2027-07-17. Every market's whole debt becomes liquidatable at its maturity and the span is ~one year, so
roughly one turnover per year: a total pool of **$2,973–$4,954/year**, shared. Pool ≈ 0.2% of notional per
turnover, so it scales — $10M book → ~$20k/yr, $100M → ~$200k/yr.

**This changes the objective, not just the budget.** The bot's purpose is protocol safety; the prize pool
justifies (or doesn't) _competing for contested positions_, which is a different thing. The logs separate
them: the $10k position was cleared promptly by someone 123 s after maturity — a healthy protocol outcome,
and a ~$1.40 margin loss for us. The eleven positions we won were $0.05–$80, the ones nobody else had
reason to touch. That is the bot working as a backstop.

### The two real defects

1. **The allowance revert is a balance shortfall wearing a misleading string, 131 times.** `approvePair`
   (`packages/swaps/src/execution/executor-calls.ts:50`) emits `approve(spender, 0)` then
   `approve(spender, <live balanceOf>)`, spliced at exec by `balanceOfPlaceholder` — **balance-based
   over-approval, not an exact amount** (stated at `encode-call.ts:104-106`, because `repaidUnits` is
   recomputed on-chain and is not staticcall-readable). So `allowance == balance`, exactly, and
   `ERC20: transfer amount exceeds allowance ⟺ loan balance after swap < derived repay`. There is no
   allowance-provisioning bug. **BOTS-35's item-2 premise about a "just-in-time exact-amount approve" is
   factually wrong**, and the unexplained 15:02:18 recovery needs no internal-state theory — the swap
   simply began clearing the repay as `lif` ramped.
2. **Both bots discard `submit`'s broadcast signal.** `PendingQueue.submit` already returns
   `Promise<boolean>` with a documented contract (`pending-queue.ts:82`: "a caller counting real
   broadcasts must not count those"), but both bots' `index.ts` closures type the dep as `Promise<void>`
   and discard it — so a failed submit still runs `backoff.clear(label)` and `counters.submitted += 1`. No
   new type is needed; `@repo/bot-kit` is correct. **PR #181 fixes this in both bots.**

Items 2 and 3 of the ticket are therefore **one economic root cause at two points inside one
transaction** — `Error(return too low)` is the router refusing mid-swap, `exceeds allowance` is the repay
failing post-swap. They differ only in amplifier: the simulate-stage failures were backoff-suppressed
(`backoff.record` fires), the send-stage ones were not (`backoff.clear` fires instead).

### The blind spot

Production time series (cbBTC, venue 0x, positions > $1 — all 17 candidates were cbBTC, so collateral is
not a confound, and the venue was constant):

| t bucket  | quotes | median cost | best cost | headroom    |
| --------- | ------ | ----------- | --------- | ----------- |
| 0–20 s    | 12     | 18.33       | 10.45     | 1.22        |
| 20–40 s   | 24     | 17.56       | 15.89     | 3.65        |
| 40–60 s   | 12     | 19.87       | 17.85     | 6.09        |
| 60–80 s   | 11     | 25.45       | 24.19     | 8.52        |
| 80–120 s  | **0**  | —           | —         | 10.96–14.61 |
| 120–140 s | 2      | 8.02        | 7.85      | 15.83       |
| 140–160 s | 37     | 10.04       | 4.64      | 18.27       |
| 200–220 s | 20     | 5.17        | 3.09      | 25.57       |

**A 58-second total blind spot, t+80 → t+138, across every position over a dollar** — and the winner
struck at t+123 inside it. Cost collapsed ~16 bps across the gap at constant venue and collateral, which
confirms the residual was oracle-versus-DEX basis and that it mean-reverted within ~2 minutes.

The counterfactual is **unresolvable, and deliberately so**: interpolating cost linearly across the gap
puts the viability crossover at t+114.9 to t+117.3 — 6 to 8 seconds ahead of the winner, well inside the
interpolation's own uncertainty. Mild convexity pushes it past t+123. The measurements needed to decide it
are precisely the ones the bug prevented from existing. So **the backoff fix must be justified as "it wins
positions in this regime in general, and it produces the evidence to tell" — never as "it would have won
this one."**

### Cost was basis, not price impact

Measured against the marginal (smallest-probe) rate via LiFi, cbBTC→USDC on Base:

| notional   | impact vs marginal | routed via |
| ---------- | ------------------ | ---------- |
| $80        | 0.00 bps           | fly        |
| $8,448     | −1.74 bps          | fly        |
| $84,483    | 1.26 bps           | kyberswap  |
| $422,417   | 2.88 bps           | kyberswap  |
| $844,834   | 10.63 bps          | fly        |
| $1,689,667 | 18.84 bps          | fly        |

Size-related impact at ~$10k is **approximately zero**, so almost none of the observed 16–25 bps was price
impact. Readings under ~2 bps are routing noise. Caveat: this is today's calm liquidity, not 31 Jul during
the burst — though a pool absorbing $1.7M at 19 bps does not move on the burst's total $11,424.

Two consequences. **Partial sizing has no live instance**: the largest single position is real and large
($1,005,266, borrower `0xC6877a6534…`, market `0x549cd072daf9…`), but at ~11 bps it clears comfortably
inside the ramp, and on a concave curve the 420 bps breakpoint sits orders of magnitude above the entire
$1.98M book. **And slicing recovers nothing** on a trade whose impact is already zero. The 420 bps cap
stays a documented limit, not a work item.

### Drift bounds: basis versus outright vol

Two exposures, easily conflated:

- **Will the repay clear?** Price-independent to first order — `requiredRepay` and actual output both
  scale with price, so only basis drift matters.
- **Will the router min-out clear?** Full outright vol exposure, because `amountOutMinimum` is a frozen
  integer compared against a price-scaling actual output.

A gate whose two sides are computed from the _same_ lens read at the _same_ instant is price-level
invariant and therefore basis-only. The frozen-integer exposure applies to calldata already minted, and it
grows with **quote age**: basis over ~2 blocks, outright vol over minutes. So quote freshness, not price
level, is the variable to control.

## What to build, in recommended order

### 1. Per-maturity basis readout — do this first

Cheapest item proposed by anyone, and every open parameter is downstream of it. `select.ok` already logs
`{ venue, id, collateral, expected, oracle, amountOutMinimum, order }`, so realized cost per quote is
`(oracle − expected)/oracle` and viability is `expected ≥ oracle/lif`. **Zero new instrumentation** — a
query and a readout. It sets the gate's floor, the item-2 gate's buffer, and decides inventory funding.

### 2. Exempt economic skips from backoff

Clearest link to the lost position. Today an economic failure records exponential backoff, so the bot
sampled t+73 s then t+137 s across a crossover computable in advance:

```text
t_cross = 3600 · cost_bps / (maxLif − 1)_bps        // per (market, collateral tier)
cost  5 bps → t+41s     cost 15 bps → t+123s
cost 10 bps → t+82s     cost 30 bps → t+246s
```

- A plan below `t_cross` is skipped **without** `backoff.record` — it is not a failure, and the wait is
  known exactly.
- From `t_cross` onward the position is attempted **every block** with no economic backoff. Only
  transport-class failures keep today's backoff.
- Cost is itself fast-moving and mean-reverting, so an economic failure carries almost no information
  about the next ten seconds. That is a second, independent reason not to back off on one.
- `QuoteFailureReason` already separates `no_route`/`bad_route` from `timeout`/`rate_limited`/`api_error`,
  so the seam exists. The sim-revert path is the one that currently conflates them.

### 3. Correct the misleading allowance string

Floor the min-out at the derived repay so a shortfall reverts at the router (`return too low`) rather than
at the repay (`exceeds allowance`). Both paths revert; one names the cause. Falls out of change 5.

### 4. The gate: `insufficient_headroom`, default off

**Prerequisite:** surface the derived repay from sizing. `impliedRepaidUnits` is module-private
(`sizing/plan.ts:61`) and `LiquidationPlan` carries `repaidUnits: 0n` for every seize-exact plan:

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

`planSurplus` already computes both internally; the change surfaces rather than recomputes them.
**Open verification item:** `repaidUnits` are _units_, not assets. Both sampled markets have
`current_settlement_fee_wad: 0` and `continuous_fee_rate: 0` so they coincide today, but confirm the
conversion against `midnight-contracts.txt:1819` before trusting the floor as a loan-token amount.

**Two floors, because the ratio floor is scale-invariant and cannot reject dust:**

```ts
// Ratio floor — group-level, hoisted out of the candidate loop.
const headroomBps = ((referenceAmountOut - plan.impliedRepaidUnits) * BPS) / referenceAmountOut
// Absolute floor — per-candidate, the only one that can reject dust.
const surplusUsd = usdValueOf(loanToken, referenceAmountOut - plan.impliedRepaidUnits)
```

At t+123 s a $10k plan and a $1 plan both read 8.93 bps, but their surpluses are $8.94 and $0.00089. Gas
is fixed, so only the absolute floor separates them — which is also the ticket's dust aside (eight fills
moving $0.00), adjacent to BOTS-81. The absolute floor needs a loan→USD step; consume the `usdValueOf`
snapshot BOTS-35 item 1 is building from `GET /markets/midnight/tokens` rather than adding a second price
path. Bad-debt realizations bypass both floors, matching the existing `isBadDebtRealization` branch.

**Placement, all honored in PR #181.** The floor folds into `planWithReason()` as a `PlanSkipReason`
variant: no new counter, no new event. The sum identities stay intact, with the skip absorbed by
`liquidatable === inflightSkipped + planSkipped + planned`. Everything needed is on `PlanInput`
(`blockTimestamp`, `maturity`, `bestCollateralMaxLif`), so no widening; the threshold arrives via the
existing `PlanOptions`. PR 2's phase-A seam is on hold, so the loop is still single-pass — the gate drops
in right after `planWithReason()`.

- **Plan-skip records neither backoff nor cooldown.** Load-bearing (see change 2), documented on
  `PlanOutcome` — _"A skip is NOT a failure signal… Several reasons clear on their own as chain time
  advances"_ — and enforced by a test in #181. Any future per-reason suppression policy must default to
  "no suppression".
- **`LEVEL_BY_REASON` maps it to `debug`.** It fires identically for every candidate in a group; one line
  per position per block is how the post-mortem produced hundreds of identical warnings. #181's map is
  typed to admit `'debug'` and its docstring already carries this rule. Ramp telemetry comes from one
  group-level line at `info`, cadence-gated by `createBlockSampler` (tracked in BOTS-87 — coordinate
  there, don't duplicate).
- **Payload:** `headroomBps`, `lif`, `maxLif`, `secondsSinceMaturity`, `tCrossSeconds`. The last makes the
  line actionable rather than diagnostic. No `details` bag — a plain widening of `plan.skipped`'s existing
  `{ marketId, borrower, reason }`; `knip` rejects speculative unused fields.

Naming is agreed with the item 2 fork, split by pipeline stage to match `plan.*` / `quote.*` /
`simulate.*`: this is `insufficient_headroom` on `plan.skipped`; their post-quote check is
`quote.unprofitable` / `quoteUnprofitable`. Filter-then-verify, not duplicates.

### 5. Economic min-out floor in `@repo/swaps`

`QuoteParameters` gains an optional absolute floor:

```ts
/** Absolute break-even output; the min-out floor must not sit below this. Omitted → legacy behavior. */
minAcceptableAmountOut?: bigint
```

- **uniswap-v3** encodes `amountOutMinimum` locally (`venues/uniswap-v3.ts:50`) → set it to
  `max(minAcceptableAmountOut, referenceAmountOut·(1 − slippageBps))`.
- **lifi / 0x / 1inch / liquidswap** have their floor baked by the API from a `slippage` parameter, so
  derive the _percentage_ that keeps it above break-even:
  `clamp(((estimate − minAcceptableAmountOut) · BPS) / estimate, 0, slippageBps)`.

**The probe cache is not a valid denominator.** `PROBE_STALE_MS` defaults to `600_000` — ten minutes, most
of the ramp — and the guarantee decays with quote age. Use the firm quote actually being broadcast, and
never reuse one across the ramp.

The strongest justification is not diagnostic. It is that the floor makes **`SLIPPAGE_BPS` monotone and
safe to widen**: today raising it loosens the router's protection and pushes shortfalls onto the repay, a
perverse range. With the floor, widening can never take min-out below break-even.

## Configuration surface

| Env                  | Default | Meaning                                                                                                                                                                                   |
| -------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HEADROOM_FLOOR_BPS` | `0`     | **Lower bound** on execution cost — the cheapest route you would ever expect. Suppresses only the provably-hopeless opening seconds. **Not** a typical-cost estimate; see the note below. |
| `MIN_NET_PROFIT_USD` | `0`     | The absolute floor. Rejects dust, which the ratio floor structurally cannot.                                                                                                              |
| `SLIPPAGE_BPS`       | `100`   | Unchanged in name and default; becomes a **ceiling** on the derived min-out floor rather than the floor itself.                                                                           |

**Why `HEADROOM_FLOOR_BPS` and not `EXECUTION_COST_BPS`.** The gate suppresses until
`headroom(t) ≥ threshold`, so it is a pure time gate:

```text
1 bps → no quotes until t+8.2s      10 bps → no quotes until t+82.1s
5 bps → no quotes until t+41.1s     16 bps → no quotes until t+131.4s
```

The errors are asymmetric — a wasted quote costs one aggregator call, a blinded window costs the position:

| threshold | futile quotes suppressed | viable window blinded if true cost is 0.56 / 3.09 / 5.0 bps |
| --------- | ------------------------ | ----------------------------------------------------------- |
| 3 bps     | 12 of 59 (20%)           | 20.0s / — / —                                               |
| 5 bps     | 36 of 59 (61%)           | 36.5s / 15.7s / —                                           |
| 10 bps    | 59 of 59 (100%)          | 77.5s / 56.7s / 41.1s                                       |

0.56 bps was observed at t+240 in this same incident, so the low-basis case is not hypothetical. A 10 bps
threshold would blind the first 57–78 seconds of a low-basis maturity — the most contested part of the
auction. A name asking for "cost" invites a reader to enter their _typical_ cost and produce exactly that;
a name asking for a floor does not. **Default `0`.** For provenance: this maturity implies
`(8.52, 15.83]`, deliberately **not** adopted, because it fits one observed basis regime.

## Test plan

Repo convention — `test/` mirroring `src/`, vitest, additive to the nearest existing file.

- **Sizing** (`test/sizing/plan.test.ts`): `impliedRepaidUnits` and `lif` are surfaced and equal what
  `planSurplus` uses; `impliedRepaidUnits(maxSeizeForCap(cap)) <= cap` still holds; ramp endpoints
  (t+0 → WAD, t ≥ 3600 → `maxLif`).
- **Backoff class** (`test/runner/tick.test.ts`): a plan below `t_cross` does **not** call
  `backoff.record`; a transport-class failure still does; a position at `t_cross + 1 block` is retried on
  the very next block, not after a doubled wait. This is the assertion that maps to the lost position.
- **Crossover arithmetic** (`test/sizing/lif.test.ts`): `t_cross` on the incident tier
  (`maxLif = 1.043841`) is t+123 s at 15 bps and t+82 s at 10 bps; a tier whose ceiling is below the
  configured floor (0.980 at 60.0 bps) yields no crossover and must be skipped for the whole post-maturity
  hour rather than looping.
- **Gate** (`test/runner/tick.test.ts`): a plan below `HEADROOM_FLOOR_BPS` is skipped with **no `quoteFor`
  call**; a bad-debt realization bypasses both floors; both knobs at `0` reproduce current behavior
  exactly. Assert the **group** property — every candidate sharing a `(maturity, maxLif, mode)` group is
  skipped or worked together — because a per-candidate threshold test passes vacuously. Assert separately
  that a large and a dust candidate in the **same** group diverge under `MIN_NET_PROFIT_USD`. Assert a
  normal-mode candidate is never skipped by the ratio floor.
- **Venues** (`packages/swaps/test/venues/*.test.ts`): uniswap-v3 floors at `minAcceptableAmountOut` when
  it exceeds the slippage-derived value; the aggregators' derived slippage is clamped to
  `[0, slippageBps]`; omitting `minAcceptableAmountOut` reproduces every existing expectation.
- **Regression guard**: per CLAUDE.md, break one assertion in each new file, confirm it fails, revert.

Anvil fork coverage is deliberately not proposed: the gate is pure arithmetic over lens output and the
existing fork tests cover the exec path.

## Verification workflow

Per CLAUDE.md, once the code is settled — concurrent where independent:

1. `pnpm --filter @morpho-org/midnight-liquidation run typecheck` and `pnpm --filter @repo/swaps run typecheck`
2. `pnpm lint` (workspace-level, zero warnings)
3. `pnpm format`
4. `pnpm test`

## Decisions needed

1. **Re-scope BOTS-35 to correctness?** The pool is ~$3–5k/year and the ticket's "1.2% of the value"
   premise measures share-against-third-parties rather than coverage. Recommend rewriting the framing and
   the third acceptance criterion.
2. **Merge items 2 and 3, and correct the ticket?** One economic root cause, two accounting defects. The
   item-2 premise about an exact-amount approve is factually wrong regardless. Counts are also off: 131
   allowance reverts not 120, 157 `tx.submit_failed` not 133.
3. **Does the gate ship default-off?** Recommend yes — no prod behaviour change at this book size. It
   still earns its place by bounding 824 `plan.built` and 81 wasted aggregator quotes per burst, which is
   rate-limit budget rather than margin.
4. **Inventory funding as its own deferred issue?** It is the only thing that removes basis exposure
   entirely, but the basis self-corrected in ~2 minutes and we have one observation. Recommend deferring
   to the readout (change 1) rather than deciding now.

Settled during investigation — recorded so they are not re-litigated:

- **Repay-exact: no.** Seize-exact already accepts an arbitrary `seizedAssets`, so it does depth-aware
  sizing without losing the deterministic sell-side amount fixed-calldata venues need.
- **`SEIZE_CAP_MARGIN_BPS`: leave alone.** Headroom is scale-invariant.
- **Partial sizing: shelved.** Structurally valid, no live instance at the measured curve.
- **More venues: dropped.** The cost was basis, which every venue faces.
- **`tx.*` correlation: not a defect.** Every `tx.*` line carries `label` (`${id}:${borrower}`).
- **PR #134: closed as superseded** by #181; leftovers tracked in BOTS-87.

## Derivation

How this got here, because the conclusion moved four times and a reader deserves to know which parts are
load-bearing.

**The path.** I started from the ticket's framing — a mis-tuned `~1%` guard — and found `SLIPPAGE_BPS`
defaults to 100 with no Railway override, so the guard was config, not code. Reading the contract's LIF
ramp showed the real constraint: headroom starts at zero and takes an hour to reach a ceiling of a few
hundred bps, so early attempts are unprofitable by construction and no retune could win. I then argued
successively that the loss was caused by **the cap margin** (wrong — headroom is scale-invariant), by
**inventory-funded competitors** (unsupported — the cost ranges overlap), by **the backoff schedule
sampling across the crossover** (real, observed, but not decisive), and by **price impact on a $10k clip**
(wrong — measured impact at $10k is ~zero). Each fell when someone queried the underlying log field or
contract line instead of arguing from a summary. Three sessions worked BOTS-35's three defects in
parallel; the production log analysis came from the item 2 session, the tier pin and the impact
measurement from here.

**Nine retracted claims**, kept because several are still readable as live in other people's notes:

| Claim                                                   | Why it fell                                                |
| ------------------------------------------------------- | ---------------------------------------------------------- |
| `SEIZE_CAP_MARGIN_BPS` eats the headroom                | Compared a margin on _size_ against a margin on _rate_     |
| Winners were "almost certainly inventory-funded"        | Cost intervals overlap; a swap-funded competitor fits too  |
| The backoff schedule lost the position                  | Best-ever quote (16.37) exceeded headroom at the strike    |
| Route quality on a $10k clip                            | Measured impact at $10k is ~0 bps                          |
| A gate's fixed LHS carries outright vol                 | Both sides come from one lens read; basis-only             |
| `EXECUTION_COST_BPS = 10` as an evidence-backed default | Fits one basis regime; blinds 57–78 s on a low-basis day   |
| "No remote branch carries `planWithReason`"             | A refused command reported as run; 5 hits on #134's branch |
| PR #134 introduces a `SubmitOutcome` type               | `submit` already returned `Promise<boolean>`               |
| `tx.*` events carry no correlation field                | Every one carries `label`                                  |

**The pattern matters more than the count.** Claims traced to `Midnight.sol` or the repository source
held; claims inferred from the incident narrative did not — including BOTS-35's own JIT-approve premise,
which survived a contested week because a derivation was written up as an observation. The last three rows
are a distinct and worse category: one asserted a check the tool had **refused to run**, and two
contradicted source **already read into this session's context**, adopted from a peer's summary without
reopening the file. So the failure mode is not "didn't check the source" but "checked the source, then let
a summary overwrite it."

The two conclusions that survived contact are the LIF-ramp economics and the headroom-versus-cost
asymmetry. Both were derived from the contract. Weight the rest accordingly.

**Evidence provenance.** Economics verified against production logs (Better Stack source 2607569, s3
archive, 2026-07-31 14:59–15:10). The viability predicate `cost_bps ≤ (maxLif − 1)·t/3600` predicts
**13 of 13** simulate outcomes at t+138–144 including two dust rejections, and the log fit brackets
`maxLif − 1 ≥ 432 bps`, independently confirming the tier lookup. Cost curve measured live via LiFi. Book
sizing from the markets API. Still **not** verified: the winner's t+123 s strike is ticket-derived — no
on-chain `Liquidate` event was checked.

## Operational note

PR #181 is pushed and green (`fix/bots-35-tick-telemetry-and-submit-outcome`, 443/144 across 7 files, 5/5
checks passing, MERGEABLE, draft). Base on it with `gh stack` — never merge main into a child.

PR 2 (phase split + USD ranking) is **on hold**: ordering only matters once something clears a viability
threshold, and no threshold is approved. So the phase-A seam does not exist yet.

One stale `lint-staged automatic backup` stash entry containing `sizing/plan.ts` may still be in the
shared stash stack — worth inspecting before it is mistaken for live work.
