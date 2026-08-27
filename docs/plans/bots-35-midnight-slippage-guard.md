# BOTS-35 (item 3): Midnight liquidation slippage guard

| Field        | Value                                                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Status       | Exploration complete; direction needs a decision (the ticket's framing does not survive the arithmetic)                                   |
| Linear issue | [BOTS-35](https://linear.app/morpho-labs/issue/BOTS-35/fixmidnight-liquidation-order-by-profit-fix-allowance-and-slippage) — third defect |
| Scope        | `bots/midnight-liquidation` sizing + quoting seam, `@repo/swaps` min-out derivation, operator documentation                               |
| Prod config  | Base 8453, venues `['lifi', '0x']`, `SLIPPAGE_BPS` unset → default `100`                                                                  |

## Objective

BOTS-35's acceptance criterion for this item is: _"The slippage guard is retuned (or made adaptive)
so it does not reject economically sound fills during a maturity burst."_

Exploration establishes that during the observed window there **were no economically sound fills to
reject**. The guard was not mis-tuned; it was reporting, in the wrong vocabulary, that a swap-funded
liquidation is unprofitable in the first minutes of the post-maturity LIF ramp. Retuning it — in
either direction — cannot produce a won position. This document records the evidence, then proposes
the change that does satisfy the criterion's _intent_.

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
not a configuration error. The 133 occurrences between 15:02:19 and 15:04:13 are 133 positions whose
quote aged out before gas estimation.

Two adjacent defects sit on the same lines and are worth naming, though neither is this item:

- `submit` returns `boolean`, and `runTick` ignores it: a failed submit still runs `backoff.clear(label)`
  and `counters.submitted += 1`. That both inflates the `submitted` metric and removes the only
  brake on immediate re-attempt — the direct cause of the _thrash_ as distinct from the individual
  failures. PR #134 fixes this properly, returning a `SubmitOutcome` so only `kind: 'sent'` clears
  backoff.
- Note the two error strings in this incident had **different amplifiers**, so they are not one bug:
  the allowance failures were at the _simulate_ stage, where `backoff.record` does fire and does
  suppress (120 occurrences over 390 s across 14 candidates ≈ 8.6 attempts each — backoff working);
  the min-out failures were at the _send_ stage, where `backoff.clear` fires instead and suppresses
  nothing (133 over 114 s). Same underlying marginality, different accounting defects.
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

Computed from the live markets API for the three cbBTC/USDC collateral tiers on Base:

| lltv  | cursor | maxLif   | headroom @ t+60s | @ t+123s | @ t+300s | @ t+600s | @ t+3600s |
| ----- | ------ | -------- | ---------------- | -------- | -------- | -------- | --------- |
| 0.860 | 0.30   | 1.043841 | 7.3 bps          | 15.0 bps | 36.5 bps | 73.1 bps | 438 bps   |
| 0.915 | 0.30   | 1.026167 | 4.4 bps          | 8.9 bps  | 21.8 bps | 43.6 bps | 262 bps   |
| 0.980 | 0.30   | 1.006036 | 1.0 bps          | 2.1 bps  | 5.0 bps  | 10.1 bps | 60 bps    |

The $10,004 fill was lost at **t+123 s**. At that point a swap-funded liquidator had between **2 and
15 bps** of headroom, depending on tier. A cbBTC→USDC swap on Base cannot execute inside that: the
cheapest Uniswap v3 tier alone is 5 bps, before spread, price impact on a $10k clip, and the
oracle-versus-market basis.

Consequences that follow directly:

- **Widening `SLIPPAGE_BPS` is futile.** It moves the failure from the router's min-out revert to the
  protocol's repay shortfall. Same skipped position, one block later, more gas burned on estimates.
- **Tightening it is also irrelevant.** The binding constraint was never the guard.
- **We cannot lose principal to a loose guard.** If the swap under-delivers, the repay fails and the
  transaction reverts; the Executor's structural sweeps mean a successful exec ends at zero balance.
  The only exposure to a loose guard is sandwich extraction of the surplus, which is real but is a
  late-ramp concern, not an early-ramp one.
- **The ticket's own context corroborates this.** "99% of value cleared within 4 minutes of maturity"
  means the entire auction resolves inside the window where a self-funding swap route is
  structurally unprofitable. The liquidators who cleared it were almost certainly **inventory-funded**:
  repay from held loan token, keep the collateral, sell later off the critical path. That strategy has
  no slippage guard to tune because it performs no swap.

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

**Placement depends on whether PR #134 is revived.**

- **#134 alive** — the ratio floor folds into its `PlanSkipReason` union as `insufficient_headroom`,
  riding the existing `plan.skipped` event and `LEVEL_BY_REASON` map. No new counter, no new event,
  and #134's documented sum identities stay intact: the skip is absorbed by
  `liquidatable === inflightSkipped + planSkipped + planned`, because the candidate never enters the
  worked set. This is the preferred shape — the gate is pure arithmetic over `PlanInput`, which is
  exactly what `planWithReason()` already is.
- **#134 dead** — the gate needs its own loop exit, a `headroomSkipped` counter, and a
  `plan.headroom_insufficient` event carrying `headroomBps`, `lif`, and seconds-since-maturity, so the
  next maturity produces the ramp curve as telemetry rather than as 133 identical warnings.

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

### 4. Configuration surface

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

1. **Does this reframing stand?** The ticket asks for a retuned guard; this proposes a profitability
   gate plus an economic floor, and argues the retune is a no-op. If the reframing is accepted,
   BOTS-35's third acceptance criterion should be rewritten and the inventory-funded strategy split
   into its own issue.
2. **Is PR #134 alive?** It decides this change's shape, not just the merge order. Alive → the ratio
   floor folds into `PlanSkipReason`, adds no counter and no event, and #134 already fixes the
   submit-accounting bug below. Dead → the gate carries its own exit, counter, and event, and that bug
   needs picking up separately.
3. **Threshold values for prod.** Both knobs default to `0`. Setting them needs one maturity's measured
   cbBTC→USDC execution cost, which the `plan.headroom_insufficient` telemetry is designed to produce.
4. **Should the adjacent submit-accounting bug ride along?** `runTick` ignores `submit`'s return
   boolean, so `backoff.clear()` and `counters.submitted += 1` run even on a failed send — no
   suppression at all, which is what let 133 `tx.submit_failed` pile up in 114 seconds. PR #134 fixes
   this properly by returning a `SubmitOutcome` so only `kind: 'sent'` clears backoff. Subsumed if
   #134 lands.
