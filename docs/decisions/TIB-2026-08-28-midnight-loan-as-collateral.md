# TIB-2026-08-28: Midnight loan-as-collateral — off-chain slot choice and the swap-free path

| Field          | Value                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------- |
| **Status**     | Proposed                                                                                     |
| **Date**       | 2026-08-28                                                                                   |
| **Author**     | @hayden                                                                                      |
| **Scope**      | App: `bots/midnight-liquidation` · Package: `@repo/swaps` (shared with `blue-liquidation`)   |
| **Supersedes** | [TIB-2026-05-28](./TIB-2026-05-28-midnight-liquidation-bot.md) — its `LensOut` slot contract |

---

## Context

Midnight now lists markets whose **loan token is itself an accepted collateral**, priced by the
protocol team's official identity oracle (`MorphoChainlinkOracleV2-default`, price `1e36`). The
purpose is to let market makers take borrow-side fixed-rate exposure without holding an unwanted
token ([Tarik, #fixed-rate-markets, 2026-07-17](https://morpholabs.slack.com/archives/C08UY4ZS5PH/p1784299112903789)).
Verified on 2026-08-28: 4 of the 8 `listed=true` markets already carry it (USDC loan + USDC collateral
at 98% LLTV alongside cbBTC at 86%), so they are already inside the bot's whitelist. The earliest
maturity is 2026-10-30 15:00 UTC.

One deployed parameter drives most of what follows. The 98% LLTV is set _"to be able to reimburse
liquidators' gas"_ ([Mathis, 2026-08-25](https://morpholabs.slack.com/archives/C08UY4ZS5PH/p1787619662574969)).
So `maxLif = 1/(1 − 0.30·0.02) = 1.006036` — a **60 bps** incentive at full ramp, roughly a seventieth
of the cbBTC slot's, and the entire economics of the slot. `rcfThreshold` stays set from the real
collateral (same thread), so the bot's RCF math is unaffected.

Three properties of the existing bot collide with this:

1. `@repo/swaps` only took its swap-free path when an unwrap chain had run, so a collateral token that
   already IS the loan token fell through to venue quoting as `USDC → USDC`. Every aggregator rejects
   that (verified: LiFi `HTTP 400 {"code":1011,"message":"The same token cannot be used as both the
source and destination token."}`), which classifies as non-retryable `no_route` — so the position
   was never liquidated, quietly.
2. `plan.ts`'s headroom gate (landed 2026-08-27) skips any plan whose `(lif − 1)/lif` is below
   `HEADROOM_FLOOR_BPS`, default 3. Against a 60 bps ceiling that is a pure time gate suppressing the
   first ~179 s past maturity.
3. These are the **first multi-collateral markets** the bot has seen. Every previously listed market
   had exactly one collateral, so the lens picking the single greatest-_value_ slot on-chain was
   trivially correct.

## Goals / Non-Goals

**Goals**

- Liquidate loan-as-collateral positions reliably, and from the first second past maturity.
- Evaluate every activated collateral slot, with fall-through so one slot's transient failure does not
  forfeit another slot's certain liquidation.
- Keep the change to `@repo/swaps` a correct generalization for `blue-liquidation` too.

**Non-Goals**

- An absolute (dust) profitability floor — that is BOTS-81, and is orthogonal: it should apply to
  swap-free plans like any other.
- Liquidating more than one slot of a position in a single tick. One `liquidate` seizes from one slot;
  the candidates are alternatives, not a batch.
- Changing RCF sizing. `rcf.ts` already mirrors the contract per slot, and `rcfThreshold` is unchanged
  upstream. (BOTS-66's three "stricter rules" are router _admission_ rules, not liquidation rules.)

## Current Solution

The lens computed `bestCollateralIdx` as the argmax over activated slots by USD value and returned
five flat `bestCollateral*` fields; `planWithReason` sized that one slot; the tick worked one candidate
per position. `TIB-2026-05-28` records this contract explicitly.

## Proposed Solution

**1. The lens returns slots; the planner chooses.** `LensOut.collaterals` is now a
`CollateralSlot[]` (market index, amount, price, `maxLif`, `lltv`) in bitmap order, unranked.
`planCandidates` sizes each slot under the existing mode policy and returns candidates ranked by
`planSurplus`, with an explicit comparator (surplus descending, then post-maturity first on a tie).

Slot choice moved off-chain because **the chain cannot make it**: which slot is worth liquidating
depends on whether it needs a swap, and the lens has no notion of venues. Value-max was also never
profit-max — the two live slots differ ~7× in incentive.

**2. A swap-free slot is a first-class shape, not an edge case.** `CollateralSlot.swapFree` is
computed in `planInputFromLens` (the only layer holding both token addresses and sizing types) and
rides onto `LiquidationPlan`. It has two consequences:

- `@repo/swaps` short-circuits to `swapFreePlan` whenever the sell path already ends in the loan
  token, producing a **zero-step `SwapPlan`** — and that short-circuit is evaluated _before_ the
  no-venues gate, so a keyless / `ALLOW_BAD_DEBT_ONLY` deployment can still clear these positions.
- `gateOnHeadroom` does not apply. The floor bounds a route cost this path does not pay; charging it
  would forfeit the contested early seconds of every loan-as-collateral maturity, which is where an
  ascending-price auction is won (see `rankByUsdSurplus`). Break-even still binds via
  `minAcceptableAmountOut` and `assessProfitability`.

**3. Suppression is deferred to the end of the tick.** `backoff.record(label, block)` sets
`until = block + baseBlocks` while `shouldSkip(label, block)` tests `block < until`, so recording a
candidate's failure inline would suppress that position's own remaining candidates in the same tick —
silently reducing fall-through to a single attempt. Phase B accumulates per-label outcomes and applies
`backoff.record` / `cooldown.mark` once after the loop, which also keeps the USD ranking global rather
than grouping candidates by position to make the bookkeeping work.

**4. `sweepCalls` dedupes the market tokens.** With `collateralToken === loanToken`, two sweeps meant a
second `transfer` of zero, which some ERC-20s revert on. One home in
`@repo/swaps/execution/executor-calls`, consumed by both bots' encoders.

## Considered Alternatives

- **Keep slot choice on-chain, ranked by incentive instead of value.** Rejected: still blind to
  whether a slot needs a swap, and it would need a second lens revision the moment fall-through
  arrived.
- **Return one plan and let the next tick try the other slot.** Rejected: a tick is ~2 s on Base but a
  maturity auction is decided in the first block, and `backoff` would delay the retry exponentially.
- **Lower `HEADROOM_FLOOR_BPS` globally so 60 bps clears it.** Rejected: it would weaken the gate for
  every swapping slot, which is exactly what the floor is for. The distinction is per-plan, so the
  carve-out belongs per-plan.
- **Prefer the swap-free slot outright.** Rejected: it leaves the larger incentive on the table
  whenever both slots are liquidatable. Ranking chases the larger prize; fall-through provides the
  safety. The one concession is that truncation to `MAX_PLAN_CANDIDATES_PER_POSITION` never drops the
  best swap-free candidate.

## Assumptions & Constraints

- The identity oracle stays 1:1. If it does not, the route-quality check fails the plan closed rather
  than seizing at a wrong price — the zero-step path is still oracle-checked.
- `market.collateralParams` is never empty, so index 0 always exists. This is what lets a write-off
  against a position with no remaining collateral name a slot at all; the index is inert there because
  `liquidate` skips its whole sizing block for a `(0, 0)` call (`midnight-contracts.txt:1847`).
- The lens is at the EVM stack-depth limit (see `vitest.config.ts`), so `_collectSlots` must not carry
  a second loop's locals — hence the separate `_countActivated`.

## Dependencies

- `@repo/swaps` is shared with `blue-liquidation`; the `swapFreePlan` generalization and `sweepCalls`
  land in both. `blue-liquidation`'s `expectedLoanOut` deliberately keeps its two-argument signature —
  it has one collateral per market, so it has no slot to disambiguate.

## Observability

- `quote.ok` / `quote.floor_unmet` / `unwrap.bad_route` carry `venue: 'no-swap'` for the zero-step
  path, distinct from `'unwrap-only'`, so a loan-as-collateral liquidation is separable from a PT-USDC
  unwrap in existing dashboard queries (both event names are unchanged).
- `tick.end` gains `candidates` and `siblingSkipped`. The counter identities now split: everything up
  to sizing is **per position**, everything phase B works is **per candidate**. Event names are
  unchanged, but `noSwapPath` / `quoteFailed` / `quoteUnprofitable` / `reverted` become per-attempt on
  multi-collateral positions.
- `simulate.ok` / `simulate.revert` / `config.no_swap_path` / `quote.unprofitable` gained
  `collateralIndex` and `postMaturityMode`: several candidates per position share a
  `(marketId, borrower)`, so without them the log join cannot separate two attempts.
- `plan.skipped` is now per slot, and carries `collateralIndex`.

## Security

No new trust surface. The swap-free path moves fewer tokens than the swapping path (no external
router is called at all), and the Executor's full-drain invariant is preserved by `sweepCalls` — the
dedupe strictly reduces the number of transfers, never the set of tokens drained.

## Future Considerations

- BOTS-81's absolute floor should treat swap-free plans like any other: their surplus is real but
  small, and a dust position's 60 bps will not cover gas.
- If a position ever activates enough slots to hit `MAX_PLAN_CANDIDATES_PER_POSITION` in practice, the
  cap becomes a real policy rather than a backstop and deserves revisiting.

## Open Questions

- Should the loan-as-collateral slot be _preferred_ over a larger swapping slot once we have measured
  realized fill rates on the swapping path? Ranking is currently gross-surplus-only.

## References

- [TIB-2026-05-28](./TIB-2026-05-28-midnight-liquidation-bot.md) — the `LensOut` contract this revises.
- [BOTS-2](https://linear.app/morpho-labs/issue/BOTS-2), [BOTS-66](https://linear.app/morpho-labs/issue/BOTS-66)
- [Router changelog, 2026-08-25](https://morpholabs.slack.com/archives/C08UY4ZS5PH/p1787674233882079) —
  the admission rules (98% lltv, loan not sole collateral, loan excluded from the greatest-lltv pick).
- [Deployed config, 2026-08-26](https://morpholabs.slack.com/archives/C08UY4ZS5PH/p1787729338707179)
