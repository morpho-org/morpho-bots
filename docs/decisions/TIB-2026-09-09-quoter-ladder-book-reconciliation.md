# TIB-2026-09-09: Quoter-bot ladder reconciliation against the resting book

| Field          | Value                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| **Status**     | Proposed                                                                                                   |
| **Date**       | 2026-09-09                                                                                                 |
| **Author**     | @hayden                                                                                                    |
| **Scope**      | Bot: quoter-bot                                                                                            |
| **Supersedes** | TIB-2026-08-14-quoter-cross-book-clearance _(partially)_, TIB-2026-07-27-midnight-quoter-bot _(partially)_ |

---

## Context

On 2026-09-04 the reference supply APY on USDC/cbBTC (Base) moved about 130 bps. The ladder followed
it, its best ask crossed a third-party bid already resting on the Midnight book,
`assertLadderProspectiveSpread` refused the publication, and the cycle failed. The stopgap was a
−45 bps quote premium: a hand-tuned constant that holds until the book moves again.

Work on the fix has produced one stable half and one that will not stay fixed.

**The clearance** — reprice any rung that would cross the best retained opposing offer to the
nearest tick just clear of it, saturating at the operator's hard rate range — is
[TIB-2026-08-14](./TIB-2026-08-14-quoter-cross-book-clearance.md)'s own-bootstrap rule generalized
from "our own buy" to "any retained offer". It has been unchanged and correct since its first
review.

**The reconciliation** — making the book participate in the `rest` / `resize` / `recenter` decision,
so a ladder the book has since moved into is replaced rather than left resting — has failed three
consecutive independent review rounds, each with a different real defect:

1. The book was carried into the domain as integer basis points. Annualized rate is a **lossy**
   encoding of an exact tick (two ticks a strict clearance apart round onto one basis point, hiding
   a move that leaves the live ladder crossed) and a **time-varying** one (a fixed tick's annualized
   rate grows as maturity approaches, so an untouched book re-annualizes into a fresh quote every
   cycle — roughly 8 bps per 60-second cycle at one hour to maturity).
2. An opaque tick-derived identity replaced it, but neither the serializer nor the canonical reader
   in durable ownership round-tripped it, so the reconstructed active quote could never match the
   fresh one and the ladder would have republished **forever**.
3. The identity was the raw pair of best opposing ticks, so any move of any best offer changed it,
   including one that constrains no rung: with sells near tick 3993, a resting bid stepping from
   tick 100 to 101 leaves the published ticks byte-identical and still forces a full cancel and
   republish.

### The shape of the recurring defect

Each revision compares two quantities, and in each of them **at least one side is derived**:

| Revision                                     | Derived side                  | Failure                         |
| -------------------------------------------- | ----------------------------- | ------------------------------- |
| Book as basis points                         | a rate derived from a tick    | lossy, and drifts with maturity |
| Book as an opaque identity                   | a token derived from the book | over- and under-invalidates     |
| Prepared ticks against resting ticks (below) | a tick derived from a rate    | drifts with maturity            |

Derived quantities move when nothing has happened, or fail to move when something has. That is one
defect wearing three hats, and it has a fixed point: **there is exactly one comparison available in
which both sides are observed** — the ticks of retained offers the maker does not own, against the
ticks of offers the maker does, both read off the same book at the same moment. Integers on both
sides, no conversion, no clock, no storage. That is where this decision goes. "The same moment" is
best-effort: the reader fetches asks and bids as two concurrent responses, so a pair that never
coexisted can be observed once. §5's in-queue recheck and cooldown are what make a one-off false
witness cost nothing.

### The constraint that made all of this necessary

`assertLadderProspectiveSpread` builds its retained set from the whole market book with **no
ownership test**
([`ladder-spread.utils.ts`](../../bots/quoter-bot/src/infrastructure/ladder/ladder-spread.utils.ts)),
so a third party resting inside the maker's envelope on the wrong side does not merely leave the
ladder crossed — it fails every subsequent publication for that market. That is the outage: not a
ladder that quoted badly, but a market the bot could no longer re-quote at all, wedged by an order
it does not control and cannot cancel.

That posture is also inconsistent with the rest of the bot. The readiness gate's `invertedMarketIds`
evaluates the same crossed-book invariant over **maker offers only** — its input is a maker-scoped
API query with an explicit assertion that every returned offer's maker matches
([`viem-setup-state.service.ts`](../../bots/quoter-bot/src/infrastructure/setup-state/viem-setup-state.service.ts)).
The prospective guard is the outlier, and the clearance was being designed to work around it.

## Goals / Non-Goals

**Goals**

- Scope the fail-closed crossing invariant to the maker's own offers, so a third party's order can
  never wedge a market.
- Clear every rung of the best retained opposing offer, in tick space, saturating at the configured
  hard rate range — best-effort pricing, never a gate on publication. A rung saturated at the bound
  may still cross; that is the operator's envelope speaking, not a defect.
- Detect, whenever the book makes it visible, that a resting ladder has been crossed — so the bot
  can stop being lifted at a rate the book has since bettered.
- Derive that signal from the current book alone, so it needs nothing persisted and nothing
  converted.
- Keep detecting the cross separate from deciding what to do about it.
- Stay ratifier-agnostic in a way that leaves the imminent rate ratifier nothing to undo: persist no
  tick, compare no tick across cycles, and carry each offer's `maker` and `ratifier` through the
  book read so a later decision can classify offers by kind without touching this one.
- Leave rate-space quote drift governed by `movementToleranceBps` alone, exactly as today.

**Non-Goals**

- Treat a book move as a reason to replace. A move that crosses no resting offer must rest.
- Add durable state.
- Take a crossing offer rather than clearing it. Taker transactions are out of scope for V0
  ([TIB-2026-07-27](./TIB-2026-07-27-midnight-quoter-bot.md) §5) and belong to
  `midnight-crossed-books`.
- Reprice a rung back toward the center when the offer that pushed it leaves; see **Future
  Considerations**.
- Classify offers by ratifier or project where a rate-native offer will be. Until a second TIB does
  that against the installed ABI (**Future Considerations**), every opposing offer is treated the
  same way: cleared at the tick the book reports now, with the cooldown bounding whatever drifts
  back. This one must only not obstruct that TIB.
- Change reference sources, staleness handling, ladder shape, sizing, exposure caps, or the recenter
  deadband.

## Current Solution

`sameLadderQuoteSet` compares market, center, reference observation id, group mode, and every rung's
index, rate and size. It is a pure function of domain values, so the book cannot reach it. Two
consequences follow: a book that starts crossing a resting ladder never triggers a replacement, and
a rung repriced to clear an offer stays at that tick after the offer leaves.

The answer attempted so far is `bookObservationId`, an opaque token derived from the best opposing
ticks, carried on `LadderMarketState` and `LadderQuoteSet`, persisted with the publication, and
compared by `sameLadderQuoteSet` beside `referenceObservationId`. That is the design the three
rounds above rejected; rounds 1 and 2 are patched, round 3 is not.

## Proposed Solution

### 1. The crossing invariant splits by ownership

- **Own-book crossing stays fail-closed.** A prospective offer that crosses another offer the maker
  owns is a self-trade, and the narrow durably-owned bootstrap-buy / ladder-sell equality remains
  its only exemption. Unchanged.
- **Third-party crossing stops gating publication.** It becomes a pricing concern: cleared
  best-effort by §2, reported by §4, and never a reason to fail a cycle.

This aligns the prospective guard with `invertedMarketIds` and unwedges the market. It is also what
makes everything below safe: a clearance computed from an eventually-consistent book is best-effort
by nature, and a best-effort computation must never be able to halt the strategy when it loses a
race.

**"Own" means maker-owned, not strategy-owned, and the book already says which is which.** Every
offer in the takeable-offers response carries its `maker` (`ApiOfferResponse.maker` in
`@morpho-org/midnight-sdk` 1.3.0); the bot's reader in
[`ladder-book.utils.ts`](../../bots/quoter-bot/src/infrastructure/ladder/ladder-book.utils.ts)
currently discards it. Phase 0 keeps it, validates it as an address, and classifies each book offer
as **own** when `isAddressEqual(offer.maker, maker)` and **third-party** otherwise — one field, read
off the same snapshot as the ticks it is compared with. No second endpoint, no group union, no
consistency window between reads. The readiness gate already keys its crossed-book invariant on the
maker, so after Phase 0 the guard and the gate share one literal definition of "own".

Strategy ownership stays what it is today: a role marker for the one exempted bootstrap-buy /
ladder-sell equality, and the way the ladder identifies its own groups for replacement. It is
**not** an acceptable substitute for maker equality in the self-trade guard, because the two sets
diverge in a routine case — a redeploy onto a fresh filesystem orphans the bot's own live groups,
and `unsafeOffersStatus` deliberately downgrades unknown maker-signed namespaces to a warning so that
case can self-heal. A guard keyed on strategy ownership would reclassify those orphans as
third-party and publish a ladder that self-trades against them. Keyed on the maker, they are simply
own offers the ladder must clear, and the clearance handles them.

The one place ownership is not read from the book is the synthetic entries for pending bootstrap
offers that `completeBookOffers` adds before the indexer has them. Those are constructed locally and
are marked own at construction; nothing infers them.

The economics say the same thing. Crossing a third party's bid costs us the price improvement we
could have taken; it does not put funds at risk, and the offer we would be lifted on is one we chose
to make at a rate inside the operator's configured range. Forgoing an improvement is worth
repricing for. It is not worth refusing to quote for.

### 2. The clearance

Unchanged from the branch, and unchanged in substance from
[TIB-2026-08-14](./TIB-2026-08-14-quoter-cross-book-clearance.md) §2 — only its scope widens from
the own bootstrap buy to every retained opposing offer, whatever its ratifier, at the tick the book
reports for it now. Sells floor at the nearest aligned tick
strictly above the highest retained buy tick, merged with the existing bootstrap floor; buys ceiling
at the nearest aligned tick strictly below the lowest retained sell tick, which had no bound at all
before. Both saturate into the hard rate window, and same-tick rungs merge as they already do.

One correction the generalization must carry: the rate-space and tick-space own-bootstrap guards
currently select opposite offers when several own bootstrap buys are live, because
`highestBootstrapBuyRateBps` takes the maximum rate while `ownBootstrapBuyTickCeiling` takes the
maximum tick, and ticks are inverse to rates. The tick floor is the binding one and is correct, so
this is latent today. The rate-space rule is not being generalized, so the fix is to the bootstrap
helper alone; it ships in Phase 1 ([BOTS-125](https://linear.app/morpho-labs/issue/BOTS-125)).

### 3. The signal: the crossing relation, evaluated fresh

```ts
/** Sides on which a third-party offer currently crosses one of this strategy's resting ladder offers. */
export const bookCrossesRestingLadder = (parameters: {
  marketId: Hex;
  maker: Address;
  book: readonly BookOffer[]; // now carrying `maker`
  activeLadderGroupIds: { lower: ReadonlySet<Hex>; higher: ReadonlySet<Hex> };
}) => {
  lower: boolean;
  higher: boolean;
};
```

It reports per side, not per market. A cross on one side says nothing about the other, and §4's
feasibility gate can hold for one and not the other, so collapsing them into a single boolean would
force a defined-but-arbitrary answer for the mixed case.

The relation is the one `hasInvalidOwnedBootstrapLadderSpread` encodes — highest buy tick at or
above lowest sell tick — but applied to a deliberately narrower pair of sets: third-party offers on
one side against **this strategy's active ladder groups** on the other, per side. A third-party
offer counts only if its executable size, converted to assets at its own tick, is at least the
market's `minimumOfferAssets`. A replacement costs one transaction per active group, and posting an
offer costs its maker one, so without a size floor a dust offer moved once per cooldown buys that
amplification for free; an offer smaller than the smallest one we would quote ourselves is dust by
our own definition. The reader keeps the response's `units` for this and for nothing else. Own offers that are
not ladder groups are on neither side. A third-party sell crossing an own bootstrap buy is
bootstrap's concern and must not replace the ladder; an own orphan crossing the ladder is the
guard's concern, not a reason to reprice. Durable ladder publications already record their groups by
side, so the sets cost nothing new.

It is computed in `positions.readMarket`, which already reads the whole book, and surfaces on
`LadderMarketState`. The application keeps the decision, so monitoring, the verbose plan, and the
read-only dry-run path all continue to report what actually happens.

**Detecting the cross and acting on it are separate decisions.** The relation is a correct signal:
when it flips, a crossing was observed, and that stays true under any mix of offer kinds — the only
false flips are the two-response artefact above, which §5 absorbs. Whether to replace is §5's policy,
and §4 establishes when replacing is feasible at all.

Placement follows the inputs, not the units. Comparing ticks is integer arithmetic and the domain
could do it; what the domain cannot do is read a book or classify ownership, and those are the
signal's only inputs. Tick space is not privileged here either — matching resolves everything to
ticks at the instant it runs, so that is simply where the relation lives.

**This is a state, not an identity, and the distinction is the whole point.** An identity has to be
remembered, survive serialization, and change exactly when the publication should — three
obligations that failed in rounds 2, 2 and 3 respectively. A state is evaluated fresh every cycle
and compared against nothing. `bootstrapBuyRateBps` is already carried this way.

### 4. Feasibility: when replacing could not help anyway

If the book has moved so far that no in-range tick clears it, replacing changes nothing: the
clearance saturates at the same bound and republishes an equally crossed ladder. So a second,
side-specific value reports whether the cross is **clearable** — whether `rateTickWindow` contains a
tick strictly clear of the crossing offer.

This one is not observed-only, and that is fine. It needs the configured bounds, tick spacing and
time to maturity, so it does read the clock — but it answers "could an action help?", not "what is
true on the book?". Keeping it a separate value from §3 is what stops the clock leaking back into
the relation. `positions.readMarket` already holds all of its inputs.

Crossed-and-unclearable is an operator condition, not a bot condition: the book has left the
configured quoting envelope. Unclearability suppresses only the `book-crossed` replacement. The bot
says so (§ Observability), does not churn, and — after §1 — does not halt; a replacement for any
other reason still publishes the saturated best-effort quote, crossed at the bound, exactly as
TIB-2026-08-14 §3 already allows.

### 5. The action: replace, rechecked, with a per-side cooldown

When a side is crossed (§3), clearable (§4), and its cooldown has elapsed, the decision upgrades
from `rest` to a replacement with reason `book-crossed`. Three details make that safe rather than
merely correct:

- **The trigger is re-evaluated inside the mutation queue.** `reconcile` already reads a fresh book
  under the queue lock before preparing a publication. The crossing and feasibility are recomputed
  from that read, and if the cross is gone the reconcile returns a no-op before anything is
  reserved, cancelled or signed. A signal read at decision time is a reason to enter the queue, not a
  license to mutate on stale evidence.
- **The cooldown is per side and advances only on a confirmed replacement.** It is process memory —
  a restart forgets it and at worst replaces once early, which is benign. It is anchored to the
  block timestamp the publication was prepared at, which is the same clock the offers' `start`
  uses, and it advances when the replacement is applied, or logged in read-only mode. A failed
  replacement does not advance it, so the next cycle retries. A cross detected inside the cooldown
  rests and is reported crossed by §4's event, so the throttle is visible rather than silent.
- **The clearance stays one aligned tick beyond the current tick, for every offer kind.** It is a
  lower bound that is exact at the instant it is computed, whatever ratifier signed the opposing
  offer. Projecting where a rate-native offer will be later needs its exact rate, which the observed
  tick does not determine (Alternative 7), so that projection is the second TIB's job. Until then a
  rate-native counterparty that drifts back through the gap is caught by the cooldown, not by a
  guess.

The cooldown is a configured per-market value with a default of several loop intervals, and it is
the only knob this TIB adds.

**The make seam has to carry the evidence back.** Today `reconcile` returns submitted transactions
and cleared-rung counts, and the read-only path returns nothing. Both paths return a structured
result carrying the preparation block timestamp, the rechecked per-side crossing and feasibility,
and whether the cooldown suppressed action — the live path from the real reconcile, the read-only
path from `validateReconcile`. The application owns the cooldown and the events, so it needs exactly
that and nothing else from infrastructure.

### 6. What this deletes

- `bookObservationId` — from `LadderMarketState`, `LadderQuoteSet`, `sameLadderQuoteSet`, the
  persisted publication type, `canonicalQuote`, and `serializePublication`.
- `opposingBookObservationId`, and the identity threaded from `preparePublication` back through
  `reservePublication`.

Durable state shrinks by one field and gains none. Existing on-disk `version: 1` ownership files
tolerate the now-extra property, so no migration is required.

### Implementation Phases

All phases land on [PR #204](https://github.com/morpho-org/morpho-bots/pull/204) over the next few
days. The phases are an ordering of commits for review, not a schedule. The PR keeps the clearance
commit (`776e11f0`) and replaces the three `bookObservationId` commits (`2c2c3808`, `d0b37e6f`,
`ca3a085c`) with Phases 0 and 2.

- **Phase 0 — Narrow the guard.** Carry `maker` (and `ratifier`, unused for now) through
  `readLadderBookOffers`, validated as addresses; classify own by `isAddressEqual` against the
  configured maker; scope the fail-closed set to own offers at both call sites of
  `assertLadderProspectiveSpread` — the make service and the read-only `validateReconcile` path.
  This is what actually unwedges a market, and it is a precondition for anything that replaces on a
  cross, since such a replacement must not be able to fail the cycle it triggers.
- **Phase 1 — Clearance.** Implemented and reviewed (commit `776e11f0`). Adds the BOTS-125 selector
  fix to `highestBootstrapBuyRateBps` with a multiple-live-bootstrap regression test.
- **Phase 2a — Measure.** Add `bookCrossesRestingLadder` and the feasibility value, surface both on
  `LadderMarketState`, emit them from the pre-decision snapshot, and delete `bookObservationId`.
  Drives no transactions on its own, and stays useful after 2b as the record of how often the
  resting ladder is crossed, by how much, and for how long.
- **Phase 2b — Act.** §5: the in-queue recheck, the per-side cooldown, and the `rest` →
  `book-crossed` replacement.

## Considered Alternatives

### Alternative 1: Make the book an input to ladder generation

Clamp rung **rates** in the domain against the opposing book — `opposingBuyRateBps` /
`opposingSellRateBps` derived from the best opposing ticks via `tickToApr` — so the desired quote
set itself becomes a function of the book, and the existing `sameLadderQuoteSet` notices both
symptoms with no new decision anywhere. The application, monitoring, verbose output and the
read-only path are untouched. This is the most structurally attractive alternative and it is what an
independent clean-room study recommended.

**Why rejected — for the current regime only.** It is revision 1, and it fails for revision 1's
reason. `tickToApr` is a function of time to maturity, so a clamp derived from a motionless
third-party offer produces a different integer rate every cycle, and `sameLadderQuoteSet` compares
rung rates exactly — there is no deadband on rungs, only on the center. The design's own loop
argument ("on an unchanged book, re-deriving yields the same set") holds only if the clamp never
binds.

The one setting that would rescue it is a maturity cutoff long enough that the drift rounds away.
A fixed tick's implied rate drifts by roughly `rate × cycle ÷ T` per cycle, which fits the measured
points (500 bps at one hour to maturity, 60-second cycles: 8.3 bps predicted, 8–9 observed). That
stops producing an integer rate change only once `T > rate × cycle` — about **8 hours** at 500 bps
and **17 hours** at 1000 bps. A two-hour cutoff still leaves roughly 4 bps per cycle.

The forthcoming rate ratifier does **not** rescue it. Signing rate-native offers is per-offer signer
discretion, so tick-native offers never leave the book, and every one of them still drifts through
this conversion. See **Future Considerations**.

### Alternative 2: Compare the prepared publication against the resting one, tick for tick

Prepare unconditionally each cycle and rest when the prepared ticks equal the resting ticks.

**Why rejected:** `alignedRateTick` is a function of time to maturity, so the tick encoding a fixed
rate drifts every cycle — measured against the installed SDK, the 450 bps sell boundary moves from
tick 5814 to 5818 over one 60-second cycle at one hour to maturity. Exact equality would republish
the whole ladder on that drift alone. The deadband that deliberately absorbs it is defined in rate
space ([TIB-2026-08-25](./TIB-2026-08-25-quoter-ladder-maturity-premium.md)), so quote identity has
to stay there.

### Alternative 3: Compare the current saturated bound against the resting ticks

Upgrade `rest` when the bound publication would apply moves a tick the maker already has resting —
one bound function, two callers.

**Why rejected:** the bound merges the third-party floor with `ownBootstrapBuyTickCeiling`, so it
fires when the opposing book is empty and only the maker's own bootstrap buy binds — which is not
"the book crossed us", and reporting it as such is wrong. Splitting the bound into book-only and
merged variants to fix that gives up the single-definition property that motivated it. The bound
also needs tick spacing, block time, hard bounds and the bootstrap ceiling, none of which the
reconciler holds, and evaluating it there puts a book read inside the mutation queue ahead of
`hardHalt` and shutdown cleanup on every otherwise-inert cycle. The direct crossing test needs none
of that.

### Alternative 4: Keep the quote premium

Leave reconciliation book-blind and widen `quotePremiumBps` until the ladder clears the book.

**Why rejected:** it is the stopgap. A constant chosen against one book state is wrong for every
other one: too small and publication fails again, too large and the bot quotes uncompetitively for
as long as the constant stands, with nothing reporting that the premium has become the binding
constraint.

### Alternative 5: Phase 0 alone

Narrow the guard, publish through third-party crosses, and fix neither symptom.

**Why rejected — but only just.** It is coherent, adds zero state and zero reads, and it is what
actually ends the outage. It is rejected because Phases 1 and 2 are small on top of it and reuse
machinery that already exists; if the phases have to be cut, this is the line to cut at.

### Alternative 6: Withdraw crossed rungs instead of repricing them

**Why rejected:** it lets any counterparty evict the bot from the top of book for the price of one
make. An earlier draft of the clearance also showed the mechanical failure: `buildLadderTree` threw
`empty-ladder` before `reconcile` reached its cancellation loop, stranding the crossed ladder
on-chain, and a suppressed side made the reconstructed active quote one-sided against a two-sided
desired, cancelling and republishing the healthy side every loop.

### Alternative 7: Size the clearance to a reprice horizon

Clear each rung to the tick the opposing offer _would_ resolve to if it were rate-native and `H`
seconds passed, plus one aligned tick, and allow one book-driven replacement per `H`. One parameter
both sizes the clearance and throttles the churn, and it was this TIB's answer for one revision.

**Why rejected:** the projection cannot be computed from what the book exposes. An observed tick
stands for an interval of rates, and the SDK's conversions round in fixed directions — on the
installed SDK a 500 bps rate-native sell at two hours to maturity rests at tick 5654, reads back as
499 bps, projects to 5657 one cycle later, so a buy cleared to 5656 is already inverted against the
real 5655. Doing it right needs the offer's exact rate from its ratifier data and the ratifier's
resolution rules, neither of which is installed. It also has no defined result when `H` exceeds time
to maturity, and a horizon-based feasibility test diverges from §4's one-tick test. All of that
belongs to the second TIB, written against the real ABI.

## Assumptions & Constraints

- **Evaluate the relation; never compare a proxy for it.** The load-bearing constraint of this TIB;
  the argument is in **The shape of the recurring defect** and §3, and is not repeated here.
- **Midnight matches at tick equality or inversion**, so strict tick ordering is exactly the
  separation the clearance must produce. Matching is pairwise, so there is no transitive self-trade
  path through a genuinely third-party order — the hazard Phase 0 must avoid is a same-maker order
  the bot fails to classify, not a chain through someone else's.
- **Maker-owned and strategy-owned are different sets.** Durable ownership records what this
  strategy published; the maker may hold offers it does not know about, and after a redeploy onto a
  fresh filesystem it holds its own orphans. Anything asserting a self-trade guarantee keys on the
  maker, read from the book response itself.
- **The clearance is best-effort, the own-book invariant is fail-closed.** The book is read from an
  eventually-consistent source and moves between read and publication. A best-effort computation
  must never gate publication; that is §1.
- **A group invisible to both the groups and the book endpoints is invisible to every check the bot
  has.** The trigger cannot see a published rung the API has not indexed, and eventual consistency
  provides no bound on how long that lasts — a degraded-but-successful API can sustain it
  indefinitely. This is a pre-existing property of every book-derived check, not one introduced
  here, but it bounds what this decision can promise.
- **Cancellation tombstones are process memory.** `confirmedCanceledGroups` does not survive a
  restart, so a cancelled group still visible to a stale API is, after Phase 0, correctly classified
  as **own** and fail-closed — the guard can refuse a publication against the bot's own ghost until
  the indexer drops it. That is the safe direction, but the previous bullet says how long it can
  last: indefinitely on a degraded API. A wedge of the bot's own making, recorded, not solved here
  ([BOTS-126](https://linear.app/morpho-labs/issue/BOTS-126)).
- **Same-tick rungs merge, and saturated rungs pile onto the bound.** A book that crosses several
  rungs concentrates their size at one tick. This is the steady state TIB-2026-08-14 §4 already
  chose for hard-bound saturation, and it is chosen again here rather than translating the whole
  side by one offset to preserve `stepBps` — that alternative moves rungs the book never touched,
  changing a shape the operator configured.
- **The hard rate range is the operator's declared quoting envelope**, not an anomaly detector.
- **The rate ratifier is imminent but not installed.** `@morpho-org/midnight-sdk` 1.3.0 exposes only
  the setter and ecrecover ratifiers, so every offer resting today is tick-native. This decision's
  obligation toward the ratifier is negative: persist no tick, compare no tick across cycles, keep
  every bound computed at publication from the book as it resolves then, and carry `ratifier`
  through the book read. §3, §4 and §5 satisfy all four.

## Observability

- `guardrail.book-cleared` (`workflow`, `marketId`, `side`, `clearedRungs`) reports rungs the
  opposing book repriced at publication, attributed to the book only when it moved a rung further
  than the own-bootstrap floor would have.
- **Phase 2a's output is the observability, not a side effect of it.** A new guardrail event carries
  the crossing signal and its feasibility per side (`workflow`, `marketId`, `side`, plus whether the
  cross is clearable and whether the cooldown suppressed action). It is projected from the
  **pre-decision** snapshot, not from the post-check state the monitoring path prefers today — a
  successful clearance erases the cross before that state is read, and the event would otherwise
  never fire on the cycles that matter. The read-only path returns the same cleared-rung metadata as
  the live one so a dry run reports what it would have done.
- Crossed-and-unclearable is distinguishable in that event rather than silent. It means the book has
  left the configured envelope — an operator condition whose correct bot response is to do nothing.
- A `rest` upgraded to a replacement reports `cycle.completed` with `action: 'replace'` and a new
  `reason` value, `book-crossed`. `reason` is an existing allowlisted grouping dimension and a new
  value in it is additive; **no existing field is renamed**, because Better Stack parses these names
  as metric expressions and a rename breaks dashboards silently.
- The alert that matters: a side reported crossed **and** clearable for longer than one cooldown.
  The cooldown makes `reason: 'book-crossed'` at loop frequency impossible by construction, so the
  failure to watch for is the opposite one — the ladder is re-crossed within the cooldown, meaning a
  counterparty is re-quoting through the one-tick clearance or a rate-native offer is drifting
  through it, which is the second TIB's cue.

## Future Considerations

**Releasing an over-cleared rung.** A rung pushed off its generated tick to clear an offer stays
there after that offer leaves, quoting wider than intended until some other change republishes the
ladder. Detecting the release needs the bound that was binding _at publication_, which is not
derivable from the current book and would have to be persisted. Deferred: it is a profitability
improvement with a durable-state cost, and losing that field fails benignly — a rung rests wider
than optimal — where the same slip in revision 2 meant permanent churn.

**Taking the crossing offer.** Strictly better than clearing it, since a crossing offer is price
improvement being offered to us and clearing merely declines it politely. Out of scope for V0 and
already `midnight-crossed-books`' job, but the right long-run answer.

**The second TIB: rate-ratifier semantics.** An imminent ratifier lets an offer be signed to
preserve a single rate across time instead of being pinned to a tick at signing. Which kind an offer
uses is the signer's choice, per offer, permanently — so the book will hold both kinds at once and
always will. There is no end state in which one unit is the durable one. Once its ABI is installed, a
second TIB decides: an allowlisted ratifier decoder that classifies each resting offer by its
`ratifier` address (already carried through the book read after Phase 0); exact per-kind clearance
using the offer's real rate; the near-maturity fail-closed policy for a projection that cannot hold
to expiry; and whether the bot's own ladder quotes rate-native. What follows is the argument for why
that decision is needed at all.

That makes **crossings time-varying with no actor**. A tick-native offer holds its tick while its
rate moves; a rate-native offer holds its rate while its tick moves. Matching resolves both to ticks
at the instant it runs, so two motionless offers can drift into a crossing while nobody signs,
cancels, or moves anything.

The drift is monotone, not oscillating: for a fixed positive rate the resolved tick rises as
maturity approaches, so a rate-native buy drifts into a cross against a fixed tick and stays there,
while a rate-native sell drifts out. A single untouched pair does not cross and uncross repeatedly.
Repetition comes from **our own** replacement restoring a gap that the counterparty then drifts
back through — which locates the churn in the action policy and the clearance width, not in the
book.

This is the fact that settles §3 against Alternative 1 permanently rather than for one regime: §3's
predicate re-evaluates the relation on whatever ticks the book resolves to now, so drift-caused
crossings are **true positives**, while Alternative 1's clamp converts tick-native offers through a
time-varying function and moves when the relation has not, so its drift is **false positives** —
and a permanently mixed book always has some.

**Why the one-tick clearance alone cannot survive that book.** Phase 1's clearance against a
third-party offer is **one aligned tick** (`alignTickUp(tick + 1, spacing)`), not
`CROSS_BOOK_CLEARANCE_BPS` — that constant governs the own-bootstrap rate rule and does not apply
here. Computed with the installed `alignedRateTick` for a hypothetical rate-native 500 bps bid, its
resolved tick moves from 5654 to 5655 over one 60-second cycle with two hours to maturity, and from
5792 to 5795 at one hour. A sell cleared to 5655 is therefore tied or crossed again on the very next
cycle. A fixed wider buffer does not rescue it either — a true 10 bps clearance survives about
2.4 minutes at 500 bps and two hours out — because the drift rate depends on time to maturity. §5's
cooldown bounds the resulting churn to one replacement per cooldown; only the second TIB's exact
projection removes it.

**Quoting the bot's own ladder rate-native** is the follow-on that dissolves most of the remaining
drift: against rate-native counterparties the relative drift goes to zero, and against tick-native
ones only the buy side still drifts into a cross. It is a change to how `buildLadderTree` encodes a
rung, and belongs to the second TIB.

## References

- [TIB-2026-07-27-midnight-quoter-bot](./TIB-2026-07-27-midnight-quoter-bot.md) — §9's failure
  posture, whose "prospective or existing inverted spread → reject make with `NEGATIVE_SPREAD`" row
  Phase 0 narrows to the maker's own offers, and §5's exclusion of taker transactions from V0. Its
  ownership split is **not** superseded: the trigger is an observed market state carried on
  `LadderMarketState`, exactly as `bootstrapBuyRateBps` already is, and quote-set identity stays
  where that TIB put it.
- [TIB-2026-08-14-quoter-cross-book-clearance](./TIB-2026-08-14-quoter-cross-book-clearance.md) —
  the own-bootstrap clearance and hard-bound saturation this generalizes, and the non-goal
  ("their buys remain outside the maker's reconciliation scope") this supersedes.
- [TIB-2026-08-25-quoter-ladder-maturity-premium](./TIB-2026-08-25-quoter-ladder-maturity-premium.md)
  — the rate-space recenter deadband that keeps quote identity out of tick space.
- [TIB-2026-08-23-quoter-bot-monitoring-events](./TIB-2026-08-23-quoter-bot-monitoring-events.md) —
  the event contract the new `reason` value extends.
- [PR #204](https://github.com/morpho-org/morpho-bots/pull/204) — the implementation and the three
  review rounds this TIB responds to.

<!--
TIB conventions:
- Once accepted, do not substantively edit this TIB. If the decision needs to change,
  create a new TIB that supersedes this one and update the Status/Superseded by fields.
- Addenda may be appended to record operational updates that affect
  how the TIB is applied without changing the decision itself.
- TIB identifiers use CalVer (YYYY-MM-DD) based on the date the TIB was first drafted.
-->
