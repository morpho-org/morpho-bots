# TIB-2026-08-28: Midnight send shortfall — classifying a rejected broadcast

| Field      | Value                                                                               |
| ---------- | ----------------------------------------------------------------------------------- |
| **Status** | Proposed                                                                            |
| **Date**   | 2026-08-28                                                                          |
| **Author** | @hayden                                                                             |
| **Scope**  | App: `bots/midnight-liquidation` · Package: `@repo/bot-kit` (submit classification) |

---

## Context

The 2026-08-28 15:00 UTC Midnight maturity was the first run with PRs #181 and #182 in production
(deployment `ab395786-7283-4c4c-9d2e-1dae2f50a346`). All 13 positions cleared, so this is not an
incident. It is a **latency** finding: clearing took 4–9 minutes per position, against a
competitor's 123 seconds on the 31 Jul maturity. Three tickets were opened off the first read of the
logs — [BOTS-88](https://linear.app/morpho-labs/issue/BOTS-88),
[BOTS-89](https://linear.app/morpho-labs/issue/BOTS-89),
[BOTS-90](https://linear.app/morpho-labs/issue/BOTS-90).

This TIB records what the window actually measured and the decisions taken from it. It exists
because **BOTS-89 asserted a structural explanation that the data does not support**, and the
correction is only useful if it does not substitute a second overclaim for the first. Every finding
below therefore carries its epistemic status explicitly: what is measured, what is inferred, and
what remains unobserved. A future reader who needs one thing from this document should take that
distinction, not the numbers.

Source data throughout: BetterStack source `2607569` (`t384553.bot_liquidation_midnight`), window
2026-08-28 15:00:00–15:10:00 UTC, joined to Base receipts. Log joins key on `label` — the `tx.*`
events carry the position identity in `label`, not `id`.

## Goals / Non-Goals

**Goals**

- Record the measured classification of the window's send rejections, and attach an epistemic status
  to each finding so the unproven parts stay legible as unproven.
- Decide what a rejected broadcast means for per-position suppression, and record the **deliberate
  divergence** between `midnight-liquidation` and `blue-liquidation` that follows — the rationale
  a code comment at either site cannot carry.
- Fix the two claims in the tickets that the window refutes: the quoted-versus-realized hypothesis,
  and the "15 bps above oracle" figure.
- Name the real economic lever so the follow-up work is aimed at it.

**Non-Goals**

- Fixing the latency itself. The lever is route cost, and that is
  [TIB-2026-08-31](./TIB-2026-08-31-venue-cost-curve-selection.md); this TIB only establishes that
  it _is_ the lever.
- Explaining the 47 unclassified reverts. That needs the selector capture decided below, and the
  next maturity to spend it on.
- MEV-aware or private-orderflow execution. The bot remains a coverage-first backstop liquidator.
- Re-introducing an operator slippage percentage. See finding 4 — there is no such knob on this path
  any more, and this TIB does not bring one back.

## Current Solution

`PendingQueue.submit` returns `{ sent: false, reason: 'refused' | 'send_failed' }`
(`packages/bot-kit/src/queue/pending-queue.ts`). `refused` is a queue-wide condition and records
nothing against the position; `send_failed` is the node rejecting this position's own transaction,
and **both** liquidators arm per-position backoff on it. That rule predates any measurement of what
a `send_failed` actually contains.

Retry cadence, stated correctly: the runner polls block height every `BLOCK_POLL_MS` and, when a
drain is already in flight, later polls only raise the target height — intermediate heights coalesce
away (`packages/bot-kit/src/runner/watcher.ts`). A tick over a maturity-sized candidate set cannot
finish inside a 2 s Base block. So the honest description of an un-suppressed position is **"retried
as fast as the tick can drain, with skipped heights coalesced"** — not "retried every block". Any
reasoning downstream that assumes per-block retry is wrong by construction.

## Measurements

### 1. Tick accounting held — and backoff, not economics, was the volume

**Measured.** Over the window, `planned 926 = backoffSkipped 637 + quoteUnprofitable 81 + ok 167 +
reverted 41`. The identity closes, so no candidate class is unaccounted for.

PR #182's economic-refusal exemption — a `floor_unmet` quote failure counts `quoteUnprofitable` and
arms neither backoff nor cooldown — worked exactly as designed: 81 candidates, zero backoff, zero
cooldown. But it was **12% of the volume**. Backoff suppressed **637 of 926 (69%)** planned
candidates, and it was armed by the send path, not the quote path.

### 2. Send rejections were overwhelmingly on-chain min-out reverts

**Measured.** 153 of the 167 `simulate.ok` candidates came back `sent: false`; only 14 broadcast.
Decoded `tx.submit_failed` reasons, with the emitting contract identified by searching deployed Base
bytecode for the revert string:

| `tx.submit_failed` reason                   | n   | Emitting contract                                                                                                                |
| ------------------------------------------- | --- | -------------------------------------------------------------------------------------------------------------------------------- |
| `Error(return too low)`                     | 103 | `0x71c2ed90cc288229be59f26b8b3eef3c07d7ab99` — the AMM pool 0x routed through (Metric/Kipseli family); its own min-out `require` |
| `Execution reverted for an unknown reason.` | 47  | viem's `shortMessage` fallback — revert data whose selector our decoder does not know, or no data at all. **Unclassified.**      |
| `Error(Return amount is not enough)`        | 3   | KyberSwap `MetaAggregationRouterV2` `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5`, reached inside a LiFi route                    |

**Inferred, and load-bearing.** The revert string is a property of **whichever pool the aggregator
routed through**, not of the venue. The same 0x quote lands on a different long-tail pool an hour
later and reverts with a different string, or with none. An allowlist of decoded reasons is
therefore **open-ended by construction** — it can only ever be a list of pools we have already been
surprised by.

### 3. Quoted versus realized — BOTS-89 item 1, and it refutes BOTS-89's premise

**Measured, on-chain.** Receipts were pulled for all 14 confirmed fills. Realized output is the
loan-token `Transfer` into the Executor `0x6d9dea0ae96156862a534e5016173d3e001cb7d0`, compared
against the `select.ok` `expected` that preceded each `tx.sent`:

```text
quoted - realized, bps:  min -10.0   p50 0.0   mean 6.35   max 56.5
0x fills only:           -0.5 ... +2.2 bps   (n=9)
lifi fills:              -10.0 ... +56.5 bps (n=5)
```

0x's `buyAmount` is already net of its 15 bps `zeroExFee`, verified against a receipt: pool output
20,237,668, fee 30,356 to `0xad01c20d5886137e056775af56915de824c8fce5`, 20,207,312 to the Executor,
against a quoted 20,211,664. The quote is not silently gross.

**What this proves.** For 0x AMM routes that landed, there is **no uniform realized-output bias** —
the quote is good to ~2 bps. So "discount venue quotes by a measured factor" has nothing to
discount, and that lever is closed.

**What this does not prove.** The 153 rejected attempts are **unobserved**: this measurement can
only see fills that landed, and the failures are exactly the population a bias would hide in. The 47
unclassified reverts could still carry a route-specific or estimator-specific cause. BOTS-89's
structural explanation — that the quoted route includes RFQ/PMM liquidity a contract caller cannot
reach — is therefore **ruled out for the successful 0x AMM subset only**, and remains **unproven for
the failed subset** pending the selector capture decided below. Do not read finding 3 as "quotes are
fine."

### 4. The floor is already break-even-derived — there is no percentage left to tune

**Measured, in code.** There is no operator `SLIPPAGE_BPS` on this path any more; PR #182 replaced
it. `firmQuoteVenue` computes `slippageBps: slippageForFloor(askableFloor, denominator)`
(`packages/swaps/src/quoting.ts`) so the **venue's own** `minBuyAmount` lands at the protocol's
break-even repay, and `clearsFloor` refuses any quote whose _encoded_ min-out sits under it —
a reconstructed (`'derived'`) min-out never qualifies.

This is also what explains the 6–47 bps spread in observed margins that a fixed percentage could not
account for: **the spread is the LIF ramp**, not slippage tolerance. A future reader must not
"restore SLIPPAGE_BPS" or write "SLIPPAGE_BPS unchanged" into a follow-up — the knob does not exist
here, and the floor is right at every point on the ramp by construction rather than by tuning.

**Decision:** the floor stays as-is.

### 5. Route cost, not quote bias, is the economic lever

**Measured.** Median route cost for 0x cbBTC→USDC over the window was **17.6 bps against the
oracle**, while a loan-as-collateral slot pays **zero**
([TIB-2026-08-28](./TIB-2026-08-28-midnight-loan-as-collateral.md)). Against post-maturity
incentives of ~20 bps, that 17.6 bps is the deciding term in whether a candidate is fundable at all.

**Correction to BOTS-89.** `expected` sat 17.6 bps **below** the oracle across the full window.
BOTS-89's "15 bps above oracle" was a first-minute artifact of the ramp and is wrong for the window;
it should not be carried forward.

**Measured, and cutting the other way.** 0x routes cbBTC→USDC on Base through long-tail AMMs
(Metric_V2, Kipseli, Hanji, Hydrex) — the same pools behind finding 2's reverts. Those pools **did
fill at quote when they landed** (finding 3). They are a variance source, not a pricing lie.

## Proposed Solution

**1. An execution-revert send rejection no longer arms per-position backoff; a transport-class
rejection still does.** The discriminator is the execution-revert **class** —
`isExecutionRevert` (`packages/bot-kit/src/revert.utils.ts`), which walks the viem error chain for
`ExecutionRevertedError` and falls back to the canonical `execution reverted` short message. It is
deliberately **not** a list of decoded reason strings, for the reason in finding 2: the string names
the pool, so a list is open-ended by construction and silently mis-classifies the first pool it has
not met. The class is a property of the node's response and does not enumerate.

Note the coverage this buys: the 47 unclassified rejections are execution reverts by class even
though their selector is unknown, so they are exempted correctly today, before anyone decodes them.
That is the whole argument for classifying on class rather than on content.

**2. The queue logs the 4-byte selector on `tx.submit_failed`.** The decoder already reaches for
revert data and falls through to viem's short message when the selector is unknown
(`revertReason`); the selector itself is thrown away at that point. Keeping it turns "unclassified"
from a dead end into a lookup, and is the only way finding 3's unproven half gets resolved on the
next maturity.

**3. The two liquidators diverge, deliberately.** `midnight-liquidation` exempts the economic
revert from backoff; `blue-liquidation` does **not**. This is not drift and must not be "fixed" by
aligning them.

The reason is the shape of the incentive. Midnight's post-maturity LIF **ramps**, so a shortfall now
carries no information about the next attempt — the same position with the same route becomes
fundable purely by the passage of time, and backing off samples that ramp exponentially, skipping
the contested block where it first clears. Morpho Blue's liquidation incentive is **static**, so a
shortfall there does carry information: nothing about the position improves on its own, and
suppressing it is correct. This mirrors exactly the split PR #182 already made for the `floor_unmet`
quote refusal, and it is the same argument one layer later in the tick.

**4. No retry throttle on an economic revert — neither backoff nor cooldown — and this is safe only
because of a dependency.** Removing suppression from 69% of candidates removes the only thing
bounding re-quote and re-simulate volume for them. That is acceptable **only once the venue
cost-curve work lands**, because pre-screening against the interpolated curve cuts the number of
firm quotes spent per position per tick. The dependency is stated in full below; it is a sequencing
constraint, not a preference.

The backstop is telemetry, not a limit: the tick tracks **consecutive execution reverts per
position** and escalates when a position exceeds a threshold, which is the signal that a shortfall
is structural (a broken route) rather than a ramp that has not yet cleared. The escalation is an
operator signal — it does not re-arm suppression, because doing so would reintroduce exactly the
exponential ramp-sampling this decision removes.

Two implementation properties are load-bearing and are recorded here rather than left to the diff.

**The exemption is a latch, not a removal.** Suppression is keyed by POSITION and applied once in the
tick's `finally`, after every candidate has had its turn; an execution revert does not enter
`submittedLabels`, so the position's next-ranked alternative still runs and can arm the entry _after_
the reverted send. Deleting from the pending set would therefore have held only when the reverted send
happened to be that position's last event of the tick. A latch consulted at application time is
order-independent, which is the property actually wanted. `pendingCooldown` is deliberately left armed:
it is a flat, default-off window an operator opts into to throttle a class of position, so lifting it is
an operator's call, not an inference from one sibling's outcome.

**The escalation fires once on the crossing, not per tick.** A stuck position is swept every tick, so a
per-tick warn would be unbounded in volume (doubled when two of its siblings revert) for exactly the
condition an operator has already been told about. The streak reports `below` / `crossed` / `ongoing`
and only `crossed` is logged.

**5. `excludedSources` on 0x is deferred, explicitly.** Excluding the long-tail pools would cut
finding 2's revert variance directly. It is not taken now because finding 3 measures those same
routes filling **at quote** when they land: excluding them trades a measured, real price for an
unmeasured reduction in variance, and the reduction is only worth it if the cost curve does not
already price the difference. Revisit once the curve is live and route cost is observable per pool.

**6. Retry cadence is described honestly wherever it appears.** "Every block" is wrong (see Current
Solution). Follow-up work and dashboards use "as fast as the tick can drain, with skipped heights
coalesced."

## Considered Alternatives

### Alternative 1: Allowlist the decoded revert reasons

Exempt `Error(return too low)` and `Error(Return amount is not enough)` from backoff by string.

**Why rejected:** the string identifies the pool the aggregator happened to route through, not the
venue or the failure mode, so the list is open-ended by construction — it would have covered 106 of
the window's 153 rejections and silently mis-classified the other 47, plus every pool not yet met.
It also makes an attacker- and third-party-controlled string a control input (see Security).

### Alternative 2: Discount venue quotes by a measured factor

Apply an empirical haircut to `expected` before the economic gate, on BOTS-89's premise that quoted
output systematically overstates realized output.

**Why rejected:** finding 3 measures the bias at p50 0.0 bps, and −0.5…+2.2 bps across nine 0x
fills. There is nothing to discount. A haircut would suppress fundable candidates on a ramp where
the whole margin is ~20 bps.

### Alternative 3: Keep backoff on execution reverts, but shorten it

**Why rejected:** any positive backoff on a monotonically improving incentive samples the ramp
geometrically and skips the block where the position first becomes fundable. Shortening it changes
how much is lost, not whether. The distinction that matters is whether the failure carries
information about the next attempt, and an economic revert on a ramp does not.

### Alternative 4: Align the two liquidators on one backoff rule

**Why rejected:** the rule's correctness depends on whether the incentive is time-varying, and the
two protocols differ on exactly that. Aligning them would be right for one bot and wrong for the
other. Recording the asymmetry is the cheaper correctness mechanism than a shared rule with a
protocol switch buried in it.

## Assumptions & Constraints

- **The venue cost-curve work lands before this runs without a throttle.**
  ([TIB-2026-08-31](./TIB-2026-08-31-venue-cost-curve-selection.md).) Removing suppression from 69%
  of candidates is bounded only by the curve's pre-screen cutting firm quotes per position per tick.
  If that work slips, this decision must not ship alone.
- **Midnight's post-maturity LIF ramps monotonically with time.** This is the entire basis for
  "a shortfall now says nothing about the next block", and therefore for both the `floor_unmet`
  exemption and this one. If the protocol ever makes the post-maturity incentive static or
  non-monotonic, the divergence in decision 3 inverts and both liquidators should back off again.
- **The quoted-versus-realized measurement covers fills only (n=14).** It is a statement about the
  routes that landed. It is not a statement about the 153 that did not, and must not be cited as
  one.
- **0x `buyAmount` is net of `zeroExFee`** (verified on-chain, finding 3). If 0x changes fee
  accounting, the comparison in finding 3 silently shifts by 15 bps.
- **`isExecutionRevert` correctly separates on-chain reverts from transport failures across our
  transports.** It already backs the queue's drop-versus-bump decision, so this reuses a
  classification the queue trusts rather than adding a second one.
- **Accepted risk: the streak is report-only.** There is no throttle, no circuit breaker, and no
  suppression anywhere on the escalate path — a position that reverts structurally keeps being quoted
  and simulated at full tick cadence for as long as it stays liquidatable, and the only thing that
  changes at the threshold is that a human is told. This is a deliberate decision by the repository
  owner, taken with decision 4: any throttle on this path samples a monotonically improving incentive
  geometrically and skips the block where the position first becomes fundable, which is the loss this
  whole TIB is about. What mitigates it is that the cost is bounded and the signal is loud — one warn
  per streak carrying `count`, `durationMs`, `selector` and `selectorConstant`, which is enough to tell
  a broken route from an early ramp without a second measurement — and that quote volume per position
  per tick is bounded independently by
  [TIB-2026-08-31](./TIB-2026-08-31-venue-cost-curve-selection.md)'s pre-screen, which is why that
  sequencing dependency is hard. **Do not add a throttle here.**

## Dependencies

- [TIB-2026-08-31 — venue cost-curve selection](./TIB-2026-08-31-venue-cost-curve-selection.md). A
  hard sequencing dependency, per Assumptions.
- `@repo/bot-kit`'s `SubmitOutcome` is consumed by both liquidators **and** both reallocation bots.
  Refining the `send_failed` reason must stay additive at that boundary — the reallocation bots have
  no ramp and must keep today's behavior.

## Observability

- `tx.submit_failed` gains the **4-byte revert selector** when the payload carries one, and the
  execution-revert **class** as a field, so the exemption is auditable from the log rather than
  inferred from an absence of `backoff.skip`. The decoded `reason` string stays as-is.
- A **consecutive-execution-revert streak per position**, carrying its count, its duration, the
  selector, and a `selectorConstant` flag, with an escalation event when the streak has run **unbroken
  for more than 15 minutes**. This is the backstop for running without a throttle.

  **Keyed per position, not per `(position, selector)`** as this TIB first specified. Keying on the
  selector too would restart the clock every time the route landed in a different pool, so a position
  stuck for an hour across four pools would never reach the threshold — the failure mode the backstop
  exists to catch. Keying on the position alone and reporting `selectorConstant` keeps the clock
  monotonic while preserving the distinction the compound key was after: a constant selector is much
  stronger evidence of a structural fault (a closed gate, malformed calldata, an estimator discrepancy)
  than a mixed streak, which reads as ordinary min-out shortfalls against whichever pool the route hit.
  The flag is strictly more informative than a reset would have been.

  The threshold is deliberately expressed in **time, not attempts**. Post-maturity LIF ramps on
  wall-clock, so a position becomes fundable at a moment, not after N tries: attempts-to-clear is
  `clearing_time / sweep_period`, and the sweep period is precisely what this decision and the curve
  work change. A count threshold would therefore need recalibrating on every latency improvement,
  and would fire on healthy positions as sweeps got faster. 15 minutes sits well past the 4–9 minutes
  positions actually took to clear on 2026-08-28 (and far past the 123-second competitive benchmark
  from 31 Jul) while staying well inside the 60-minute ramp, so a position that is merely early on
  its ramp does not trip it. The count is emitted alongside so a count-based rule can be calibrated
  from real data later if one turns out to be wanted.

- Dashboards joining sends to outcomes must key on `label`; `tx.*` events do not carry `id` **at the
  time of this decision**. BOTS-90 normalizes that to a single `id` field across `plan.*`, `quote.*`,
  `select.*`, `simulate.*` and `tx.*` in both liquidators — expect this line to be superseded.
- `tick.end` counter identities **do change**, in two places, and a dashboard summing them must be
  updated with the release rather than after it:
  - `notSent === sendRefused + sendReverted + sendRejected` is new. `sendReverted` is the exempt class
    this decision creates, so it is not merely a relabelling of an existing bucket.
  - the per-candidate identity gains `preselectSkipped`
    ([TIB-2026-08-31](./TIB-2026-08-31-venue-cost-curve-selection.md)), which lands in the same release
    train.

  Expect `backoffSkipped` to fall sharply on the next maturity and `notSent` to rise correspondingly —
  that is the decision working, not a regression, and the two should be read together.

## Security

Classifying on the execution-revert **class** rather than on the decoded string also keeps a
third-party-controlled string out of the control path. A revert string is chosen by whichever
contract the aggregator's route ends in; treating it as an input to our suppression logic would let
an arbitrary pool decide whether the bot keeps retrying a position. The class comes from the node's
response shape, not from contract-authored content. The `simulate()` ok-only broadcast gate is
unchanged, so nothing here widens what can be sent.

## Future Considerations

- **`excludedSources` on 0x** as a variance lever, once route cost is observable per pool (decision
  5).
- **Decode the 47.** With the selector logged, the next maturity should resolve them into either a
  known custom error or a genuinely dataless revert — which is what settles the unproven half of
  finding 3.
- If the selector capture shows the failed subset _does_ carry a route-specific bias, BOTS-89's
  structural hypothesis comes back and the response is a route filter, not a quote haircut.

## Open Questions

- Are the 47 unclassified reverts the same failure mode as the 103, or a distinct one? Unknown until
  the selectors land.
- Is a 123-second clear achievable at all on a public mempool, or does the competitor's figure imply
  private orderflow? Nothing in this window answers it, and no decision here depends on it.

## References

- [BOTS-88](https://linear.app/morpho-labs/issue/BOTS-88),
  [BOTS-89](https://linear.app/morpho-labs/issue/BOTS-89),
  [BOTS-90](https://linear.app/morpho-labs/issue/BOTS-90)
- [TIB-2026-08-31: Venue cost-curve selection](./TIB-2026-08-31-venue-cost-curve-selection.md) — the
  route-cost lever this TIB identifies, and the sequencing dependency for running without a throttle.
- [TIB-2026-08-28: Midnight loan-as-collateral](./TIB-2026-08-28-midnight-loan-as-collateral.md) —
  the zero-route-cost slot that finding 5 compares against.
- [TIB-2026-07-09: Midnight market whitelist and venue selection](./TIB-2026-07-09-midnight-market-and-venue-selection.md)
  — the probe/selector this window exercised.
- PRs #181 and #182 (merged `298aa1bc`) — the candidate ranking, break-even floor, and `floor_unmet`
  exemption whose first production maturity this was.
- BetterStack source `2607569` (`t384553.bot_liquidation_midnight`), 2026-08-28 15:00:00–15:10:00
  UTC, deployment `ab395786-7283-4c4c-9d2e-1dae2f50a346`.
