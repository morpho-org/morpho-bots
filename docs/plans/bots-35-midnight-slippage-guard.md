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
  brake on immediate re-attempt — the direct cause of the _thrash_ (120 attempts) as distinct from the
  individual failures. PR #134 covers the counter half.
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
3. **Keep the arithmetic in loan-token units.** Unlike the Blue gate
   (`docs/plans/crtr-2806-blue-profitability-gate.md`, which explicitly non-goals Midnight), no USD
   price provider is needed: the Midnight oracle converts collateral → loan natively, and both the
   surplus and the floor are loan-denominated. Gas is the only native-denominated term, and it is
   second-order next to a 2 bps headroom; it is deferred, not modelled.
4. **Do not paper over the stale-quote window.** Re-quoting immediately before `submit` would close it
   but costs an API round trip in a latency race we are already losing. The profitability gate makes
   the window matter far less, because attempts only happen when headroom exceeds execution cost by a
   margin. Revisit only if evidence shows late-ramp attempts still aging out.
5. **`SLIPPAGE_BPS` remains, as a ceiling.** The derived floor is clamped so it never permits _more_
   slippage than the operator's configured maximum. Operators keep one comprehensible safety knob.

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

In `runTick`, between `plan()` and the `quoteFor` call, and only for non-bad-debt plans:

```ts
const headroomBps = ((referenceAmountOut - plan.impliedRepaidUnits) * BPS) / referenceAmountOut
if (headroomBps < minHeadroomBps) { counters.unprofitable += 1; /* log + cooldown; continue */ }
```

- Bad-debt realizations bypass the gate (they perform no swap), matching the existing
  `isBadDebtRealization` branch.
- Emits a new `plan.unprofitable` event carrying `headroomBps`, `lif`, and seconds-since-maturity, so
  the next maturity produces the ramp curve as telemetry rather than as 133 identical warnings.
- Marks the cooldown, so a position below threshold is not re-evaluated every block for an hour.

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

| Env                | Default | Meaning                                                                                      |
| ------------------ | ------- | -------------------------------------------------------------------------------------------- |
| `MIN_HEADROOM_BPS` | `0`     | Skip a plan whose oracle headroom (`LIF − 1`) is below this. `0` preserves today's behavior. |
| `SLIPPAGE_BPS`     | `100`   | Unchanged in name and default; now a **ceiling** on the derived floor rather than the floor. |

Default-off for `MIN_HEADROOM_BPS` keeps the open-source posture the repo already takes with
`ALLOW_BAD_DEBT_ONLY` and `POSITION_LIQUIDATION_COOLDOWN_MS`: existing deployments are unaffected
until an operator opts in. Prod would be set from the next maturity's measured execution cost.

## Test plan

Following repo convention — `test/` mirroring `src/`, vitest, additive to the nearest existing file.

- **Sizing** (`bots/midnight-liquidation/test/sizing/plan.test.ts`): `impliedRepaidUnits` and `lif` are
  surfaced and equal what `planSurplus` uses; the round-trip
  `impliedRepaidUnits(maxSeizeForCap(cap)) <= cap` invariant still holds; post-maturity ramp endpoints
  (t+0 → WAD, t ≥ 3600 → `maxLif`).
- **Tick** (`bots/midnight-liquidation/test/runner/tick.test.ts`): a plan below `MIN_HEADROOM_BPS` is
  skipped with **no `quoteFor` call** (the point of the gate), increments the new counter, marks the
  cooldown; a bad-debt realization bypasses the gate; `MIN_HEADROOM_BPS=0` reproduces current behavior
  exactly.
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
2. **`MIN_HEADROOM_BPS` for prod.** Needs one maturity's measured cbBTC→USDC execution cost. The
   `plan.unprofitable` telemetry above is designed to produce it; until then the default stays `0`.
3. **Should the adjacent submit-accounting bug ride along?** `runTick` ignoring `submit`'s boolean is
   two lines and is the actual cause of the 120-attempt thrash, but it overlaps PR #134.
