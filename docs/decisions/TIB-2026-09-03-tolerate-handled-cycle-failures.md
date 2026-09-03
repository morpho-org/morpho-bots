# TIB-2026-09-03: Tolerating handled cycle failures instead of halting the maker

| Field      | Value                                                          |
| ---------- | -------------------------------------------------------------- |
| **Status** | Proposed                                                       |
| **Date**   | 2026-09-03                                                     |
| **Author** | @hayden                                                        |
| **Scope**  | Bot: quoter-bot · Package: `@repo/monitoring` (halt predicate) |

---

## Context

On 2026-09-03 the production Midnight maker `0x67Af916DB5a580a9f7E93828436dB3A3753acA95` (Base 8453) stopped quoting and stayed dark until a human restarted it. The onchain trace of that
account is unambiguous about how it went dark:

| nonce     | time (UTC)  | call                                                                           |
| --------- | ----------- | ------------------------------------------------------------------------------ |
| 3778–3788 | 21:01:17–39 | ordinary reconciliation — `setConsumed` cancels interleaved with two publishes |
| 3789      | 21:01:43    | `multicall(bytes[])` — **9** × `setConsumed(groupId, MAX_OFFER_CAP, maker)`    |
| 3790      | 21:01:43    | `multicall(bytes[])` — **1** × `setConsumed(groupId, MAX_OFFER_CAP, maker)`    |
| —         | —           | nothing since                                                                  |

Two separate batched multicalls, four seconds after fresh publishes, is the signature of
`LadderMakeService.cleanup()` followed by `BootstrapMakeService.cleanup()`: both are the only
paths that reach `invalidateBatch` — one native multicall per writer — and they run only on
shutdown. This was the bot cancelling its own book on the way out, not an operator invalidating
it. Maker funds (42,008 USDC), gas (0.0248 ETH) and USDC allowance (unbounded since a 14:34 UTC
approval that day) were all healthy throughout, so nothing in the strategy's own economics
explains the stop.

The cause is a predicate. Both writer monitors and the combined lifecycle branched on
`cycleHasFailure`, which returns true for `failed` **or** `halted`. A single per-market
`status: 'failed'` — one Morpho API read timing out on one market is enough — therefore stopped the
fail-together lifecycle described in
[TIB-2026-08-23](./TIB-2026-08-23-quoter-bot-monitoring-events.md), and stopping runs shutdown
cleanup, which cancels every live offer the bot owns across every market. One transient provider
blip cost the whole book and required a human to restart quoting.

That behaviour also contradicts the failure posture the bot was specified with:
[TIB-2026-07-27](./TIB-2026-07-27-midnight-quoter-bot.md) §9 already says "One market read fails →
Invalidate/halt that market; other allowlisted markets may continue". The code never implemented
the second half.

## Goals / Non-Goals

**Goals**

- Stop the bot only when it can no longer account for its own live offers — not when one market's
  cycle failed and was handled.
- State the invariant that makes a `failed` result retryable, in terms the code can actually
  honour, and bound the retry accordingly.
- Preserve the existing ordering guarantee that writers are aborted before the halting report's
  event delivery is awaited.
- Record the resulting operator-visible change: a dark market no longer implies a dead process.

**Non-Goals**

- Escalating to a per-market cancel when a market is persistently broken. Recorded as a follow-up
  below; not taken under incident pressure.
- Changing what makes an individual cycle fail, or any quoting, sizing, or cross-book decision.
- Changing the fail-together lifecycle itself. It stays fail-together; only the definition of what
  qualifies as a failure worth failing together over moves.
- Alerting rules. The bot emits the signals; Better Stack owns the rules
  ([TIB-2026-08-23](./TIB-2026-08-23-quoter-bot-monitoring-events.md)).
- Deploying the fix. Production runs `quoter-bot-2026.08.27-2`; several merged halt-path fixes are
  already undeployed.

## Current Solution

`@repo/monitoring` exports one cycle predicate:

```ts
export const cycleHasFailure = (results: readonly { status: string }[]) =>
  results.some(result => result.status === 'failed' || result.status === 'halted')
```

`LadderQuoterService.runContinuously`, `PositionBootstrapService.runContinuously`, and
`QuoterBotService.runContinuously` all branch on it, and all three treat it as "stop". The setup
monitor has its own version of the same conflation: it retries an explicitly transient
provider-only failure up to three times **within** one cycle, then emits `ready: false` and halts —
so a provider outage lasting longer than three back-to-back reads also cancels the book. The
lifecycle's setup branch halted eagerly on `if (!report.ready) stopFromWorkflow()`, before awaiting
event delivery.

## Proposed Solution

### 1. Separate "what happened" from "what to do about it"

`@repo/monitoring` gains `cycleRequiresHalt`, which selects `halted` only:

```ts
export const cycleRequiresHalt = (results: readonly { status: string }[]) =>
  results.some(result => result.status === 'halted')
```

The two writer monitors and the combined lifecycle branch on it. `cycleHasFailure` keeps its
meaning and its remaining job — the one-shot CLI commands' exit code — and its TSDoc now says it
reports what happened rather than what to do.

### 2. The invariant that makes `failed` retryable — and what it does not promise

`halted` means an invalidation or cleanup write itself failed, leaving live offers the bot can no
longer account for. It is never retryable.

`failed` is **handled**: the cycle classified it, recorded it, and left the market in a state the
next cycle re-derives from live truth. Both writers re-read live book and market truth at the top
of every cycle (`readMarket` per configured market, fresh group listing per publication), so a
failed market carries no state forward that the next cycle would trust.

It is worth being precise about what this invariant is _not_, because an earlier draft of this
change asserted the stronger and **false** claim that a `failed` result means the market was
reconciled flat first. The live code refutes it in both writers:

- `LadderMakeService.reconcile` calls `preparePublication` and then
  `assertLadderProspectiveSpread` **before** the invalidation loop
  ([`ladder-make.service.ts`](../../bots/quoter-bot/src/infrastructure/ladder/ladder-make.service.ts)),
  so a negative-spread rejection throws with the previously published quote set still live and
  `invalidated: false`.
- [`bootstrap-make.service.ts`](../../bots/quoter-bot/src/infrastructure/bootstrap/bootstrap-make.service.ts)
  throws `negative-spread` before any invalidation, and its `retainedGroup` branch throws _after_
  deliberately keeping the existing group live.

So the true invariant is the weaker one: **a failed market is handled, not flat.** Its previous
offers may still be resting, at a center that keeps drifting while the market keeps failing.

### 3. Bounded retry: `MARKET_FAILURE_BUDGET_CYCLES = 5`

Because the invariant does not promise flatness, the retry must be bounded.
[`market-failure-budget.utils.ts`](../../bots/quoter-bot/src/application/market-failure-budget.utils.ts)
tracks consecutive `failed` cycles per `marketId` inside one monitor loop; any other status clears
that market's count, and a market absent from a cycle keeps its running count. Five consecutive
failing cycles for the _same_ market halt monitoring, which cancels through shutdown cleanup.

The budget is not a retry policy for its own sake — it bounds how long stale quotes may stay live
at a drifting center before the bot pulls them. Five cycles is roughly five minutes at the
sixty-second loop, against the old zero minutes and a dead process.

### 4. Readiness gets the same treatment across cycles

`SetupCheckService.runContinuously` keeps its three in-cycle attempts for explicitly transient
provider-only failures, and now also emits the unready report and retries on the next interval for
up to `SETUP_CHECK_TRANSIENT_CYCLES = 10` consecutive cycles (~10 min) before halting. Invariant
and mixed failures still halt on the first cycle. Same reasoning as the market budget: halting
cancels every live offer, so a provider outage must not cost the book — but it must not be
tolerated forever either.

### 5. The halt decision moves ahead of report emission

The setup monitor computes `halting` **before** calling `onCycle`, and carries it on a new
`SetupCycleContext` passed alongside the report:

```ts
onCycle?: (report: SetupCheckReport, context: SetupCycleContext) => void | Promise<void>
```

The lifecycle branches on `context.halting` instead of `!report.ready`. This is deliberate and
load-bearing: the previous eager `if (!report.ready) stopFromWorkflow()` fired before `await
parameters.onEvent?.(…)`, so writers were aborted without waiting for event delivery. Deriving the
halt from the report _after_ emission would have silently moved the abort behind an await on the
observability path. Carrying the decision on the context preserves the ordering while keeping the
tolerance policy in one place.

### Known limitation: bootstrap starvation

A bootstrap make-stage failure `return`s the cycle. Markets configured after a persistently failing
one are therefore skipped until that market's budget runs out — up to five cycles of no bootstrap
activity for its healthy peers. This is documented in
[`docs/reference.md`](../../bots/quoter-bot/docs/reference.md) and is worth fixing separately; it
is strictly better than the current behaviour, where the first failure took every market down
permanently.

## Considered Alternatives

### Alternative 1: Keep halt-and-cancel on any failure

The status quo — treat every `failed` entry as a reason to stop the lifecycle.

**Why rejected:** This is the bug. One transient provider blip on one market costs the entire book
across every market and needs a human to restart quoting, which is what happened at 21:01:43 UTC on
2026-09-03. The specified posture in TIB-2026-07-27 §9 was already that other allowlisted markets
may continue.

### Alternative 2: Unbounded retry with no budget

Branch on `cycleRequiresHalt` and simply never halt on `failed`.

**Why rejected:** A `failed` result does not promise the market is flat (§2), so an unbounded retry
leaves stale, mispriced quotes resting indefinitely while the reference center drifts away from
them. That is precisely how a maker gets adversely selected. Tolerance without a bound trades a
loud availability failure for a quiet economic one.

### Alternative 3: Escalate to cancelling only the failing market, and keep looping

On budget exhaustion, invalidate that market's groups and continue quoting the healthy ones instead
of halting the process.

**Why rejected:** Strictly better availability, and the right eventual destination. But it needs a
new escalation path threaded through both writer services, whose failure modes differ — the ladder
publishes a whole quote set per market, bootstrap retains groups and can fail before any
invalidation — and a per-market cancel that itself fails needs its own `halted` semantics. That is
a design worth doing carefully, not under incident pressure. Recorded as a follow-up.

## Assumptions & Constraints

- Every writer cycle re-derives from live onchain and provider truth. If either writer ever caches
  market or book state across cycles, `failed` stops being safely retryable and this decision must
  be revisited.
- `failed` is only ever produced by a classified, recorded failure path. A future code path that
  reports `failed` after a partial _write_ would violate the invariant in §2 — such a path must
  report `halted`.
- Five cycles is a judgement call about how long stale quotes may rest at a drifting center, not a
  measured threshold. It is a constant, not operator configuration, and one loop interval is 60 s.
- The budget is per monitor-loop process memory. A restart resets every market's count, which is
  consistent with the bot's rebuild-from-chain design.
- The lifecycle remains fail-together: a `halted` result in any workflow still aborts its peers and
  exits.

## Observability

No new log events, but the **meaning of the existing ones changes** and alerting must follow:

- A handled per-market failure now ships `cycle.completed` with `status: "failed"` and the process
  keeps running. Alerting must key on those records, not on liveness.
- The process-level heartbeat of
  [TIB-2026-08-23](./TIB-2026-08-23-quoter-bot-monitoring-events.md) is unchanged and still
  fail-together-correct, but its practical coverage narrows: previously a market going dark
  reliably killed the process, so the heartbeat was a near-complete detector. Now **the heartbeat
  can be green while a market is not quoting**. The "dark market ⇒ dead process" inference no
  longer holds.
- A budget-exhausted or invariant halt still ends in shutdown cleanup and a non-zero exit, so the
  existing crash/halt signals still fire for the persistent cases.

`bots/quoter-bot/README.md` and `bots/quoter-bot/docs/reference.md` are updated in the same change
to state both the new retry semantics and the heartbeat caveat.

## Future Considerations

- **Per-market escalation** (Alternative 3) — cancel only the failing market on budget exhaustion
  and keep healthy markets quoting through a permanently broken one.
- **Bootstrap starvation** — a make-stage failure ending the whole cycle should become a per-market
  skip.
- **Alerting on failed cycles** — now that a failed market is survivable and therefore quieter, it
  needs an explicit rule rather than falling out of a crash alert.

## References

- [TIB-2026-07-27-midnight-quoter-bot](./TIB-2026-07-27-midnight-quoter-bot.md) — §9 failure
  posture, including the "One market read fails … other allowlisted markets may continue" row this
  change finally implements.
- [TIB-2026-08-23-quoter-bot-monitoring-events](./TIB-2026-08-23-quoter-bot-monitoring-events.md) —
  the fail-together lifecycle and process-level heartbeat whose operational reading this change
  qualifies.
- [`monitor.utils.ts`](../../packages/monitoring/src/monitor.utils.ts) — `cycleHasFailure` and
  `cycleRequiresHalt`.
- [`market-failure-budget.utils.ts`](../../bots/quoter-bot/src/application/market-failure-budget.utils.ts),
  [`setup-check.service.ts`](../../bots/quoter-bot/src/application/setup/setup-check.service.ts),
  [`quoter-bot.service.ts`](../../bots/quoter-bot/src/application/quoter-bot/quoter-bot.service.ts)
  — the implementation.

<!--
TIB conventions:
- Once accepted, do not substantively edit this TIB. If the decision needs to change,
  create a new TIB that supersedes this one and update the Status/Superseded by fields.
- Addenda may be appended to record operational updates that affect
  how the TIB is applied without changing the decision itself.
- TIB identifiers use CalVer (YYYY-MM-DD) based on the date the TIB was first drafted.
-->
