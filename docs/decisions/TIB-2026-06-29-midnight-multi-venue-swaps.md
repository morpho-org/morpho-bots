# TIB-2026-06-29: Midnight liquidation bot — multi-venue swap support

| Field      | Value                                                                           |
| ---------- | ------------------------------------------------------------------------------- |
| **Status** | Proposed — implemented; awaiting review; amended CRTR-2673 (seize-exact sizing) |
| **Date**   | 2026-06-29                                                                      |
| **Author** | @hayden                                                                         |
| **Scope**  | App: `bots/midnight-liquidation`                                                |

---

## Context

The midnight-liquidation bot ([TIB-2026-05-28](./TIB-2026-05-28-midnight-liquidation-bot.md))
executes every liquidation swap through a single hard-coded path: a Uniswap V3 `exactInputSingle`
call, with a per-collateral `swap.json` of `{ router, fee, slippageBps }`. The on-chain
`amountOutMinimum` is derived purely from the lens oracle price — there is **no off-chain
quoting**. The v0 TIB already flagged additional liquidity venues as a fast-follow.

This bot is a _fallback liquidator that must work_, not be competitive. On thin-liquidity
collaterals a single Uniswap V3 pool can lack the depth to clear a seized position at an acceptable
slippage, so a position that is liquidatable on paper produces a swap that reverts in `simulate()`
and is never broadcast — a coverage gap. Routing such collaterals through a DEX aggregator that
splits across pools widens the set of positions the bot can actually clear.

The Executor singleton already forwards arbitrary `(target, value, callData)` calls and services
magic-value callbacks via its bare `fallback` (the generic-executor decision in the v0 TIB; see
[[executor-singleton-generic]] / Amendment 11). So adding venues is **entirely an off-chain
encoder + config + quoting change — no Solidity or contract change**.

## Goals / Non-Goals

**Goals**

- Route a given collateral's liquidation swap through an operator-selected **venue**:
  `uniswap-v3` (direct, no API key), `0x` (Swap API v2 / AllowanceHolder), or `1inch`
  (Classic Swap v6) — widening collateral coverage where Uniswap V3 liquidity is thin.
- Keep the encoder **venue-agnostic**: one executable-swap currency between any venue adapter and
  the encoder, so adding a fourth venue is a new adapter, not an encoder rewrite.
- Preserve every v0 safety invariant unchanged: the `simulate()` ok-only gate, the full-drain
  sweeps, and the zero-then-set approval pairs.
- Bound API usage so the bot stays inside aggregator free-tier rate limits without a quoting cache
  or curve.
- Keep existing single-venue deploys working byte-identically (a missing `venue` defaults to
  `uniswap-v3`).

**Non-Goals**

- **Multi-hop / path-depth routing on a single venue.** That is a distinct deferred work item from
  the v0 TIB; this TIB is about the _choice of venue_, not path depth.
- **Odos and the Uniswap Universal Router.** Deferred (see Considered Alternatives) — their
  approval models don't fit the Executor's plain-`approve`-only capability, or they are routers
  rather than aggregators.
- **A binned price-impact / liquidity curve.** Considered and rejected (Considered Alternatives):
  aggregator quotes are only needed for the small liquidatable set, so a curve is unnecessary.
- **A profitability gate or MEV-aware venue selection.** The bot still submits every sim-ok plan;
  venue is operator-declared per collateral, not chosen by best execution at runtime.
- **Silent cross-venue fallback.** A configured venue's quote failing is fail-loud-and-skip, not a
  retry on a different venue.
- **Storing API keys on the `Config` object.** Keys are env-only and read at point of use.

## Current Solution

`execution/swap-step.ts` builds a `SwapStep` (`{ router, fee, amountOutMinimum }`) from the
per-collateral `swap.json` entry and the lens's fresh oracle value.
`execution/encode-call.ts` hard-codes the `EXACT_INPUT_SINGLE_ABI`, builds the `exactInputSingle`
calldata inline, and splices the Executor's live collateral balance into the `amountIn` word via a
`balanceOf` placeholder. The tick resolves the swap step synchronously (`swapStepFor`, no
network). There is exactly one route kind, and the encoder is the only place Uniswap V3 semantics
live.

## Proposed Solution

The whole design turns on one type — **`Swap`** (`src/quotes/types.ts`): a venue-agnostic,
executable swap, the single currency flowing from a venue adapter into the encoder. Every venue
(Uniswap-direct, 0x, 1inch, and any future one) collapses to the same `Swap`; the adapter that
produced it is the _only_ code that ever knew which DEX/aggregator it was. The encoder becomes
purely mechanical and loses all Uniswap-specific knowledge.

```
src/quotes/
  types.ts            # Swap (the one currency), Venue, QuoteParameters, VenueAdapter
  http-client.ts      # per-venue token-bucket rate-limited fetch + retries + key injection
  venues/
    uniswap-v3.ts     # builds exactInputSingle calldata locally → Swap (balance-bound amountIn)
    zerox.ts          # GET /swap/allowance-holder/quote → Swap (fixed amountIn)
    oneinch.ts        # GET /swap/v6.1/{chainId}/swap     → Swap (fixed amountIn)
  index.ts            # composeQuoting(): builds { quoteFor } consumed by the tick
src/queue/
  backoff.ts          # createBackoff(): exponential per-(id,borrower) failure suppression
```

### The `Swap` type — the one currency

```ts
export type Venue = 'uniswap-v3' | '0x' | '1inch'

export type Swap = {
  spender: Address           // ERC20 `approve` target for tokenIn
  target: Address            // swap call target (often === spender)
  value: bigint              // native value to forward (0 for ERC20→ERC20)
  callData: Hex              // pre-built swap calldata; the min-out floor is already inside it
  amountIn:                  // the ONLY thing that varies between venues:
    | { source: 'balance'; offset: bigint }   //   splice the Executor's live tokenIn balance
    | { source: 'fixed'; value: bigint }       //   calldata commits to `value`; do NOT splice
  expectedAmountOut: bigint  // venue's quoted output — route-quality check + logging
  amountOutMinimum: bigint   // the floor encoded in callData — observability only
}

export type VenueAdapter = { venue: Venue; quote(params: QuoteParameters): Promise<Swap> }
```

The insight is that _a liquidation swap is a call to a target, approving a spender, whose input
amount is either the Executor's live balance or a fixed number._ The min-out floor is already
encoded inside `callData`, so the encoder never inspects the venue. `amountIn` is the entire venue
surface that reaches the encoder:

- **Uniswap-direct** → `{ source: 'balance', offset }`. This is exactly today's behavior — splice
  the live balance — now expressed as data rather than a code path.
- **0x / 1inch** → `{ source: 'fixed', value }`. Route-bound aggregator calldata can't be
  re-spliced after the fact.

### The encoder becomes venue-agnostic

`encodeLiquidationExec`'s old `swapStep: SwapStep | null` becomes `swap: Swap | null` (type-only
import). The callback-queue builder no longer knows about Uniswap, `exactInputSingle`, fee tiers,
or routers — it assembles the same shape for **every** venue and branches only on
`swap.amountIn.source`:

1. `approve(collateral, swap.spender, 0)` then `approve(collateral, swap.spender,
balanceOf(executor))` — the existing zero-then-set, USDT-safe pair, reused for every venue's
   spender. (ERC20 `approve` calldata is amount-independent, so the balance splice is always safe.)
2. The swap call `buildCall(swap.target, swap.value, swap.callData)`, and **iff**
   `swap.amountIn.source === 'balance'`, attach a `balanceOf` placeholder at `swap.amountIn.offset`.
   For `'fixed'`, attach **no** placeholder — the amount is route-bound.
3. `approve(loan, midnight, 0)` then `approve(loan, midnight, balanceOf(executor))` — unchanged.
4. Trailing `skim` sweeps for the loan token then the collateral token to the EOA — unchanged, so
   aggregator residual dust still returns to the EOA and the singleton ends at zero.

That single `if (swap.amountIn.source === 'balance')` is the entire venue surface left in the
encoder. The `EXACT_INPUT_SINGLE_ABI` and the exactInputSingle calldata construction **move out** of
`encode-call.ts` and into `quotes/venues/uniswap-v3.ts`, where venue knowledge belongs.

### The load-bearing correctness tension: route-bound calldata vs. the balance placeholder

The v0 design relies on a `balanceOf` placeholder: the Executor staticcalls
`token.balanceOf(executor)` at exec time and splices the live balance over the `amountIn` word, so
the encoder commits to no off-chain amount. Aggregator calldata is **route-bound to a fixed sell
amount committed off-chain** — re-splicing a different `amountIn` would invalidate the route and the
signed-in min-out. These two models are in direct conflict.

Resolution: for aggregator venues we quote against the **predicted seized collateral**
(`predictSeizedAssets` in `execution/swap-step.ts`, extracted from the existing `expectedLoanOut`
body — the same mirror of the on-chain seize derivation), and let the swap consume exactly that
fixed amount. This is the user's _"sell everything we predict we'll receive"_ decision, and it needs
**no Uniswap fallback** for the cap-binding branch. Here is why it is safe:

- **The full-slot branch (`plan.seizedAssets > 0`) has zero sell-side drift.** Midnight transfers
  exactly `seizedAssets` to the Executor — precisely what we quoted. Prediction equals reality.
- **Drift exists only on the cap-binding branch (`seizedAssets = 0`)**, where the contract derives
  the seize at execution time from `repaidUnits`, the oracle `price`, and (post-maturity) the
  ramping LIF. Any of those can move between our read-block and the execution-block, or diverge by
  a rounding step (competing state, oracle movement, the post-maturity LIF ramp).
- **All drift outcomes are fail-closed via the existing `simulate()` gate.** If actual < quoted, the
  swap's `transferFrom` reverts. If actual > quoted but the proceeds no longer cover `repaidUnits`,
  the repay `transferFrom` reverts. Either way `simulate()` catches it and the position backs off.
  A drift is a **missed liquidation, never a loss**.
- The drift window is a single block — we re-predict every tick.

So `simulate()` — already the v0 hard backstop — is the entire safety mechanism for the fixed-amount
path. The loan-token repay approval stays balance-based, so Midnight pulls `repaidUnits` from
whatever the swap actually produced; the LIF discount and slippage buffer give headroom.

### Rate-limiting strategy: liquidatable-only quoting + free pre-check + backoff

Aggregator quotes are HTTP calls inside the tick, so the design must stay inside free-tier limits
(1inch's free tier is 1 RPS). Three guards, no quoting cache or curve:

1. **Quotes are restricted to liquidatable positions only — one executable quote per liquidatable
   position.** Quote volume is O(liquidatable), not O(candidates). The full candidate universe is
   still read fresh by the lens each tick (unchanged), but only the small set that survives the
   liquidatability check ever reaches an adapter. This is why a binned price-impact curve is
   unnecessary (Considered Alternatives).
2. **A free, oracle-based route-quality pre-check.** The lens already returns the fresh oracle
   value (`expectedLoanOut`, the v0 reference), at no extra API call. A quoted route more than
   `MAX_ROUTE_IMPACT_BPS` below the oracle reference is rejected as a bad route and the position
   backs off — catching a degenerate aggregator route before it reaches `simulate()`. Uniform across
   venues: every adapter populates `expectedAmountOut`, so the tick special-cases no venue.
3. **An exponential per-position failure backoff** (`src/queue/backoff.ts`,
   `createBackoff({ baseBlocks, maxBlocks })`): a position that repeatedly fails to quote, fails the
   route check, or reverts in `simulate()` is suppressed for `min(maxBlocks, base·2^attempts)`
   blocks. This stops persistent failures (illiquid pairs, no-route collaterals) from re-quoting
   every block. It mirrors the `pending-queue` posture — in-memory, chain-truth-wins-on-restart, no
   persistence — and is cleared on a successful submit.

A shared **per-venue token-bucket rate-limited HTTP client** (`src/quotes/http-client.ts`,
`tokens = min(burst, tokens + elapsed·rps)`, injected `now` for tests) with bounded retry honoring
`Retry-After` is the third guard, sitting underneath the adapters. It is written as a self-contained
pure function so it is trivially hoistable to `@repo/utils` if a second bot needs it.

### Tick flow (per liquidatable, not-in-flight position)

```
plan()
  -> bad-debt realization (seized=0 & repaid=0): bare liquidate, NO quote, NO API   (unchanged)
  -> else:
     - backoff.shouldSkip(id, borrower, block)?  -> skip
     - swap = await quoteFor(plan, out)        // uniswap-v3 local; aggregator = one API call
         null (no-route/timeout/api-error) -> backoff.record(...); skip            (FAIL + SKIP)
     - route-quality: expectedAmountOut < expectedLoanOut·(10000 - MAX_ROUTE_IMPACT_BPS)/10000
         -> reject + backoff.record(...)                                            (bad route)
  -> simulate()  (unchanged hard backstop)
         revert -> backoff.record(...); skip
  -> submit()    (unchanged) ; backoff.clear(id, borrower) on success
```

### Why these two venues — the approval model

The Executor can only do a plain ERC20 `approve` (no EIP-712 / Permit2 signing). **0x's
AllowanceHolder flow** and **1inch Classic v6** both spend via a plain `approve` to a spender
address, so they fit the Executor's capability directly — the existing zero-then-set approve pair
serves them unchanged. The 1inch AggregationRouterV6 spender
(`0x111111125421cA6dc452d289314280a0f8842A65`) is a per-chain checksummed `Address` constant in
`src/constants.ts`, which also lets the adapter skip the `/approve/spender` API call. All adapters
quote with `taker / from / recipient = Executor`, so output lands in the Executor for the repay and
the two trailing sweeps then drain to the EOA.

### Config + secret hygiene

Per-collateral config becomes a Zod **discriminated union on `venue`** (`src/config.ts`), wrapped in
a `preprocess` that defaults a missing `venue` to `'uniswap-v3'` — so existing `swap.json` files
keep working byte-identically. `swapConfigSchema` / `SwapConfig` / `parseSwapConfig` signatures are
unchanged.

API keys come from env by a fixed convention (`ZEROX_API_KEY`, `ONEINCH_API_KEY`). Their **presence**
is validated fail-loud inside `loadConfig` (using the injected `env` so tests can drive the
missing-key-fatal case): for each venue referenced on the configured chain, a missing key is a fatal
boot error. But the key **values are never stored on the `Config` object** — `Config` is logged at
`startup`/`shutdown` and `logger.ts` does not redact, so storing a secret there would leak it. The
values are read from `env` at point of use in `main()` and handed to the HTTP client, where they
live only in that closure. `Config` gains only the non-secret `quoting` block (timeouts, RPS/burst,
retries, `MAX_ROUTE_IMPACT_BPS`, backoff bounds), parsed with safe defaults so existing deploys are
unaffected.

### Implementation Phases

- **Phase 1 — `Swap` + venue-agnostic encoder.** Introduce `quotes/types.ts`, move
  `EXACT_INPUT_SINGLE_ABI` and the exactInputSingle construction out of `encode-call.ts` into the
  uniswap-v3 adapter, and rework the encoder to branch on `swap.amountIn.source`. Uniswap behavior
  is byte-identical; no new venue is reachable yet.
- **Phase 2 — Aggregator adapters + HTTP client.** Land `http-client.ts` (token bucket, key
  injection, retries) and the 0x + 1inch adapters returning fixed-amount `Swap`s. Unit-tested
  against fixture JSON, no live network.
- **Phase 3 — Config + wiring.** Discriminated-union venue schema with the legacy default, env key
  presence validation, the `quoting` block, and `composeQuoting()` in `main()`.
- **Phase 4 — Tick integration + backoff.** Async `quoteFor`, the free route-quality pre-check, the
  failure-backoff tracker, and the new `tick.end` counters / observability keys. Extend the fork
  e2e with an aggregator arm using captured live calldata.

**Status:** Implemented; all unit tests and the anvil fork suite pass. Awaiting review. Go-live
needs real `ZEROX_API_KEY` / `ONEINCH_API_KEY` provisioned and a `swap.json` declaring per-collateral
venues.

## Considered Alternatives

### Alternative 1: A binned price-impact / liquidity curve per collateral

Sample each venue's price impact across a log-scale set of sell sizes once, interpolate, and reuse
the curve to size quotes — giving constant API usage independent of liquidatable count.

**Why rejected:** Aggregator quotes are only ever needed for the _small liquidatable set_ (one quote
per liquidatable position, O(liquidatable) not O(candidates)). The curve solves an API-volume problem
that the liquidatable-only restriction already solves, at the cost of stale-curve risk and real
complexity. The cheaper guards — the free oracle route-quality pre-check and the failure backoff —
cover the actual need.

### Alternative 2: Odos

A leading aggregator with strong routing.

**Why rejected:** Deferred. Odos is a two-step `quote → assemble` flow (an extra round-trip in the
tick), carries a 3bps protocol fee, and is mid-migration to V3. None of that is disqualifying, but it
adds latency and a fee for marginal coverage gain over 0x + 1inch; revisit if those two leave a gap.

### Alternative 3: Uniswap Universal Router

Route through Uniswap's Universal Router for deeper Uniswap-ecosystem liquidity.

**Why rejected:** Deferred, and a category error for this work item. The Universal Router is a
_router_, not an aggregator — it has a gated API, takes two round-trips, and uses a Permit2 / proxy
approval path the Executor can't satisfy (plain `approve` only). Path depth on Uniswap belongs to
the separate multi-hop work item, not the choice-of-venue change.

### Alternative 4: Silent cross-venue fallback on quote failure

If the configured venue fails to quote, transparently retry on another venue before skipping.

**Why rejected:** Hides a misconfiguration or a genuinely illiquid pair behind a quieter failure
mode, and complicates the per-collateral "operator declares the venue" contract. Fail-loud-and-skip
with a backoff surfaces the problem in logs and lets the operator fix the config; a missed block is
cheap for a fallback bot.

## Assumptions & Constraints

- The Executor's plain-`approve`-only capability is sufficient for every shipped venue — true for
  0x AllowanceHolder and 1inch Classic v6, which is _why_ they were chosen.
- The predicted seized collateral (`predictSeizedAssets`) is the right sell amount for fixed-amount
  venues; all prediction-vs-reality drift is confined to the cap-binding branch and fails closed in
  `simulate()`. If `simulate()`'s ok-only gate were ever weakened, the fixed-amount path would lose
  its only backstop.
- Aggregator APIs return calldata whose embedded min-out the bot can trust, and expose a spender the
  Executor can approve. The 1inch AggregationRouterV6 spender is stable per chain (hard-coded
  constant).
- Free-tier rate limits hold (1inch ≈ 1 RPS). The token bucket + liquidatable-only quoting +
  backoff keep usage under that; a large simultaneous liquidation wave could still pace against the
  bucket, which is acceptable for a fallback bot.
- API keys are provided via env and present at boot for every venue the chain's config references;
  a missing key is a fatal boot error.
- Existing single-venue `swap.json` files (no `venue` field) continue to parse as `uniswap-v3`.

## Dependencies

- The generic Executor singleton from [TIB-2026-05-28](./TIB-2026-05-28-midnight-liquidation-bot.md)
  — unchanged; this TIB adds no Solidity. The `value`-forwarding `buildCall` and `balanceOf`
  placeholder come from `executooor-viem`.
- 0x Swap API v2 (AllowanceHolder endpoint) and 1inch Classic Swap v6 — external HTTP services,
  each requiring an API key.
- `@repo/utils` `delay` and `parseJsonResponse` (the latter chosen over `fetchJsonResponse` because
  the client needs the raw `Response` to inspect `status` for 429-vs-5xx and read `Retry-After`).
- `zod` (catalog): the discriminated-union venue schema.

## Observability

Additive, stable JSON keys (per the v0 logger). Per liquidation, log the chosen `venue`, the quote's
`expectedAmountOut` vs the oracle `expectedLoanOut` delta (the operator's execution-quality signal),
and the resolved `amountOutMinimum`. New events:

```
quoting.startup     { venuesByCollateral }                         // configured venues per collateral
quote.failed        { venue, reason: 'timeout'|'rate_limited'|'no_route'|'api_error' }
quote.bad_route     { venue, expected, oracle }                    // failed the oracle pre-check
backoff.skip        { id, borrower, until }                        // suppressed by failure backoff
```

The `tick.end` counters gain `quoteFailed`, `badRoute`, and `backoffSkipped` — a shape change, so
`test/runner/tick.test.ts` assertions and the README observability table are updated. The HTTP
client never logs keys (query/headers stripped). No new metrics backend; logs go to
stdout/stderr as in v0.

## Security

- **API keys are env-only and never stored on `Config`.** `Config` is logged at `startup`/`shutdown`
  and `logger.ts` does not redact, so keys are read at point of use in `main()` and live only in the
  HTTP client closure. Presence is validated at boot (fail-loud); values never touch `swap.json` or
  the logged config object. The HTTP client strips query/headers from any logged error so a key
  can't leak through a failed-request log line.
- **Aggregator calldata is opaque and untrusted at encode time** — it is third-party-built bytes the
  bot does not parse. The `simulate()` ok-only gate is the trust boundary: stale or garbage calldata
  reverts in the dry-run and is never broadcast. The free route-quality pre-check rejects degenerate
  routes earlier, but `simulate()` remains the hard backstop.
- **Full-drain invariant preserved.** The trailing collateral + loan sweeps stay, so aggregator
  residual dust is swept and the shared singleton ends at zero. A residual would be claimable by the
  next caller; the `simulate()` residual check still rejects any plan that would leave one.
- **Zero-then-set approvals preserved** for every venue's spender — no standing allowance on the
  shared singleton, and no DoS on approve-from-nonzero (USDT-style) tokens.
- The Executor and its gate-target semantics are unchanged from v0; this TIB introduces no new
  on-chain trust assumptions.

## Future Considerations

- **Odos and the Uniswap Universal Router** as additional venues once 0x + 1inch leave a coverage
  gap and the approval/round-trip costs are worth paying.
- **Hoist the rate-limited HTTP client to `@repo/utils`** when a second bot needs to rate-limit an
  API — it is already written as a self-contained pure function for this reason.
- **Multi-hop / path-depth routing** remains the separate deferred item from the v0 TIB; venue
  choice (this TIB) and path depth are orthogonal.
- **A best-execution venue selector** (quote multiple venues, pick the best output) if coverage ever
  turns into a competitiveness goal — explicitly out of scope while the bot is a fallback.

## Amendment — seize-exact sizing (CRTR-2673)

**Problem.** The original design sized the cap-binding branch as _repaid-binding_: `plan()` emitted
`{ seizedAssets: 0, repaidUnits: cap }` and the contract derived the seize on-chain. But aggregator
venues (0x / 1inch) commit a **fixed sell amount off-chain** — quoted against `predictSeizedAssets`,
a read-time mirror of the contract's floor-floor seize derivation. When the on-chain seize drifts
from that prediction (oracle price moving between the read- and exec-block, the post-maturity LIF
ramp, or a rounding step), the Executor's actual collateral balance ≠ the aggregator's committed
sell amount and the swap's `transferFrom` reverts — a missed liquidation (fail-closed in
`simulate()`). Uniswap-direct was immune: its `balance`-splice sells the actual held balance, so a
fixed off-chain commitment never existed there.

**Decision.** Standardize **every** non-bad-debt plan to be **seize-exact**: pin `seizedAssets = S`
with `repaidUnits = 0`, across all venues and all scenarios (full-slot and cap-binding, normal and
post-maturity). The Midnight `liquidate` contract transfers `seizedAssets` to the receiver (the
Executor) at midnight-contracts.txt:2415 — **before** the `onLiquidate` callback at :2417 — so
pinning the seize means the Executor holds exactly `S` when the swap runs, and every venue
(aggregator fixed-amount or Uniswap balance-splice) sells exactly that. The sell-side drift
disappears for all venues, not just the cap-binding aggregator case.

**Why standardize, not special-case aggregators** (the issue's literal scope). Making the binding
venue-conditional would force the quoting layer to rewrite the plan downstream per-venue, coupling
the quote to the encoded `liquidate` args. Standardizing keeps the plan the single source of truth:
the encoder (`encode-call.ts`) and the venue adapters (`quotes/venues/*`) are **unchanged** — the
`'balance'` vs `'fixed'` split is about per-venue splice-ability and is orthogonal to the binding —
and the off-chain seize-prediction mirror (`predictSeizedAssets`) is **deleted**, its floor-floor
math relocated into the planner as `maxSeizeForCap`. Net: less code, not more.

**`maxSeizeForCap`.** The cap-binding branch now seizes the largest `S` whose contract-derived
repaid stays within the cap — the closed form
`S = floorDiv(floorDiv(cap·lif, WAD)·SCALE, price)`, identical to the contract's own repaid→seize
derivation at :2371. It is provably exact, with no search or correction step: `impliedRepaidUnits(S)
≤ cap` always holds, and `S` is the largest such seize (verified by formal proof plus a 7.4M-case
brute-force sweep with zero violations).

**Safety margin.** Pinning `seizedAssets` makes the on-chain RCF check (normal mode, :2381) and the
debt-underflow guard (post-maturity, :2395) re-derive `repaidUnits` at the **exec-block** oracle
price. An oracle price increase between read and exec can lift the derived repaid over the cap and
revert (fail-closed). LIF drift is safe-direction (the post-maturity LIF only ramps up → derived
repaid only falls). To avoid avoidable `simulate()` failures in volatile markets, the cap-binding
seize is sized against `cap·(1 - seizeCapMarginBps)`. New config tunable `SEIZE_CAP_MARGIN_BPS`
(default 30 bps / 0.30%, env-overridable, calibratable). The path cannot be drift-free: the
aggregator route and its min-out are committed off-chain at the read block, so eliminating drift
would require an on-chain helper — which (a) reverses the generic-Executor decision
([TIB-2026-05-28](./TIB-2026-05-28-midnight-liquidation-bot.md) Amendment 11; see
[[executor-singleton-generic]]) and (b) still cannot re-price an aggregator route on-chain.

**Dust trade-off (accepted).** Seize-exact hits an arbitrary repaid target only to integer-seize
granularity, so in full-close scenarios (post-maturity, or normal-mode rcf-exempt) it may leave a
few wei of residual debt that the old repaid-binding zeroed exactly. A new `S == 0 → null` guard in
`plan()` turns such a residual into a permanent cheap skip — never a `{0, 0}` plan, which would be
mis-routed as a bad-debt write-off. Normal-mode RCF-capped positions are unaffected: they
intentionally liquidate over multiple txs anyway.

**Validation.** `maxSeizeForCap` property + fixed-vector tests; `plan()` cap-binding tests updated
to seize-exact + margin + the `S == 0` guard; the anvil fork e2e exercises the seize-exact
cap-binding post-maturity path end-to-end (lands on the real contract, full-drain holds) — the
successful exec is the on-chain proof that the derived repaid stayed within the cap.

## References

- [TIB-2026-05-28: Midnight liquidation bot — v0](./TIB-2026-05-28-midnight-liquidation-bot.md) —
  the generic Executor, the `simulate()` ok-only gate, the full-drain invariant, and the
  fast-follow note this TIB delivers.
- 0x Swap API v2 (AllowanceHolder): `https://0x.org/docs/api`
- 1inch Classic Swap v6: `https://portal.1inch.dev/documentation/apis/swap/classic-swap/introduction`
- `executooor-viem` (the generic Executor encoder): `https://www.npmjs.com/package/executooor-viem`
