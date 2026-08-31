# TIB-2026-07-09: Midnight liquidation — API market whitelist and best-of-venues selection

| Field      | Value                                                                           |
| ---------- | ------------------------------------------------------------------------------- |
| **Status** | Accepted — implemented; live in prod                                            |
| **Date**   | 2026-07-09                                                                      |
| **Author** | @hayden                                                                         |
| **Scope**  | Package: `@repo/midnight-liquidation` (+ additive `@repo/swaps` venue selector) |

---

> **Note.** This is the one 2026-07-09 decision **not** folded into
> [TIB-2026-07-13-bot-architecture](./TIB-2026-07-13-bot-architecture.md): it is a per-bot
> _liquidation-strategy_ change, from the midnight-liquidation lineage (see
> [TIB-2026-05-28](./TIB-2026-05-28-midnight-liquidation-bot.md),
> [TIB-2026-06-29](./TIB-2026-06-29-midnight-multi-venue-swaps.md)), not repo architecture. It was
> drafted against the then-current monolithic tick and has since been carried, unchanged in
> substance, into the source/transform ops of the pipeline architecture: the market whitelist gates
> the `unhealthy-positions` source, and venue selection runs inside the `liquidate` transform's
> quoting adapter.

## Context

Midnight's swap routing came from a hand-maintained per-collateral JSON (`SWAP_CONFIG_PATH`) that
did two jobs at once: it **enumerated the collateral set** the bot would act on, and it **pinned one
liquidity venue** to each token. Two prior decisions set up the tension. The multi-venue TIB
([TIB-2026-06-29](./TIB-2026-06-29-midnight-multi-venue-swaps.md)) made venue an operator-declared,
per-collateral choice with **no cross-venue fallback**, and deferred a best-execution selector to
future work. Separately, borrower discovery moved onto the Midnight markets API
(`GET https://api.morpho.org/v0/midnight/markets`), making that endpoint the coverage source of
truth.

Two forces broke the hand-maintained file: it is **toil that drifts** — every listed or delisted
market needs a config edit, while the markets API already knows the authoritative listed set — and
one venue per collateral is the **thin-liquidity coverage gap** the multi-venue TIB fought. This
decision narrowly **reverses** two non-goals of TIB-2026-06-29 (operator-declared venue with no
best-execution selection; no silent cross-venue fallback) and **delivers** its deferred selector.
The rest of that TIB — the `Swap` currency, the venue-agnostic encoder, seize-exact sizing, the
aggregator adapters — is untouched.

## Goals / Non-Goals

**Goals**

- Replace the hand-maintained routing file with two API/probe-sourced inputs: a **market whitelist**
  from the markets API, and **automatic best-of-venues selection** — so nothing needs editing as
  markets are listed or delisted.
- **Best-of-all-venues quoting**: per `(collateral, loan)` pair, rank venues from a cached
  indicative probe, firm-quote the best venue for the position's size **once**, and fall through to
  the runner-up on failure (coverage-first).
- Keep the deployless lens as the **correctness boundary** — the whitelist gates only _which_
  markets are acted on. A delisted-but-underwater position falls out of scope by design.
- Honor "only necessary calls" + "~1 req/sec venue rate limit": probe **only** pairs with a
  liquidatable position, cache the ranking, and run probes on a **separate** rate-limited client so a
  probe burst never queues ahead of a time-sensitive firm quote.
- Enable venues by **API-key presence** (`ZEROX_API_KEY` → `0x`, `ONEINCH_API_KEY` → `1inch`) with a
  global `SLIPPAGE_BPS`; **hard-fail at boot** if no key is present, unless
  `ALLOW_BAD_DEBT_ONLY=true`.
- Keep all `@repo/swaps` changes **additive** — blue-liquidation's single-venue path is untouched.

**Non-Goals**

- **Net-of-gas / profitability ranking.** The probe stores gross output only; ranking is best
  _gross_ output. A `minProfit` gate is a deliberate follow-up (the cache is shaped for it).
- **MEV-aware or competitive execution.** The bot stays a coverage-first backstop liquidator.
- **Uniswap V3 as a rankable venue.** Dropped here (see below).
- **Changing the correctness boundary.** The firm-quote → oracle route-quality guard → on-chain
  `simulate()` chain is unchanged.

## Proposed Solution

Four pieces replace the file. `@repo/swaps` gains an **additive** venue-selector + multi-venue
quoting surface; the midnight core gains a markets-API whitelist and key-presence config.

### 1. Market whitelist via the Midnight markets API

`createListedMarketFilter` (`packages/midnight-liquidation/src/markets.ts`) treats
`GET /v0/midnight/markets?listed=true` as a **hard whitelist**. Borrower candidates are filtered to
the listed set **before** the on-chain lens read — a non-listed market is never discovered, probed,
or liquidated. The filter is **fail-closed**: it refreshes on a timer, serves **last-known-good** on
a transient API failure, and yields an empty set only on a never-successful first fetch. Because the
lens still re-reads every surviving pair fresh on-chain, the whitelist is a coverage/scope gate,
**never** a correctness one.

### 2. Best-of-all-venues quoting via a cached, rate-limited, log-scaled probe

`createVenueSelector` (`packages/swaps/src/venue-selector.ts`) caches, per
`(chainId, collateral, loan)` pair, a **best-first venue ranking** built from **indicative** quotes
(`priceByVenue`: 0x `/price`, 1inch `/quote`) sampled at **log-scaled ladder** sizes (`PROBE_LADDER`,
default `0.01/0.1/1/10/100` whole collateral tokens). `composeMultiVenueQuoting`
(`packages/swaps/src/quoting.ts`) picks the best venue for the position's size bucket (nearest ladder
point in log space), firm-quotes it **once**, applies the oracle route-quality guard, and —
coverage-first — **falls through to the next-ranked venue** on a quote or route-quality failure. A
firm quote is spent only on the chosen venue.

Three guards keep this inside the "only necessary calls" + "~1 rps" budget:

- **Probing is gated to pairs with a liquidatable position** — driven from the transform's quoting
  adapter (`packages/midnight-liquidation/src/quotes.ts`), never for quiet markets. Probe volume is
  O(liquidatable pairs), not O(candidates).
- **`staleMs`-cached** (`PROBE_STALE_MS`): a repeat refresh for the same pair inside the window makes
  zero venue calls. The ladder cache is the op's disposable cache, rebuilt if lost.
- **A separate rate-limited HTTP client** for probes (`PROBE_HTTP_RPS`, its own per-venue token
  buckets, distinct from the firm-quote client) — so a background probe burst can never queue
  **ahead of** a live liquidation's firm quote on the same venue's bucket.

### 3. Venues enabled by API-key presence; hard-fail otherwise

There is **no per-collateral routing**. `0x` is enabled iff `ZEROX_API_KEY` is present, `1inch` iff
`ONEINCH_API_KEY`; a global `SLIPPAGE_BPS` replaces the old per-entry slippage. With **no** venue key
present, config loading **throws at boot** — a rotated or forgotten key must not silently disable
liquidations — **unless** `ALLOW_BAD_DEBT_ONLY=true`, which boots the degraded posture (discover +
realize pure bad debt, which needs no swap) with a loud, repeated health log. Keys stay env-only and
are read at point of use, never stored on config. `EXCLUDE_COLLATERALS` still short-circuits excluded
collateral before any venue call.

### 4. Uniswap V3 dropped as a Midnight venue

The `@repo/swaps` Uniswap-V3 adapter only **echoes the lens oracle price**
(`expectedAmountOut = referenceAmountOut`) — it has no real off-chain quote, so it cannot be ranked
on output against aggregators (it would always look oracle-perfect and win spuriously). DEX
aggregators already route through Uniswap pools, so dropping the _direct_ venue does not lose the
underlying liquidity — only the keyless path to it. Consequence: **at least one aggregator API key is
now required** to swap-liquidate. A follow-up would bring Uniswap back as a **rankable** venue via a
tiny quote-shim service that mimics an aggregator's quote API over Uniswap data.

### 5. Profitability-gating readiness

The probe cache stores a **per-venue output curve** and the selector returns `{ venue, expectedOut }[]`.
This lets a future `minProfit` gate **pre-screen** a position — skip the firm quote if no venue's
estimate clears the threshold — then gate on the firm quote's output. Net-of-gas ranking stays a
decision-time concern (gas is not in the probe).

## Considered Alternatives

### Alternative 1: Keep the hand-maintained per-collateral routing file

**Why rejected:** toil that drifts against the markets API (which already knows the listed set), and
one venue per collateral is the exact thin-liquidity coverage gap the multi-venue TIB fought.

### Alternative 2: Fan out firm quotes across all venues per position, pick the best

**Why rejected:** burns the venue rate budget — O(venues) firm quotes per liquidatable position on
the time-sensitive path — for a ranking the cached indicative probe already gives for ~free.

### Alternative 3: Keep Uniswap V3 rankable via its oracle-echo

**Why rejected:** the oracle echo is not a real output estimate — it would tie or beat every
aggregator route by construction and win spuriously, sending swaps to a single pool that may lack
depth. A genuinely rankable Uniswap venue needs a real quote source (the deferred shim service).

## Assumptions & Constraints

- The markets API `listed=true` set is authoritative for _which_ markets to act on. Because the lens
  stays the correctness boundary, an over- or under-inclusive whitelist can only cost coverage, never
  cause a bad fill — the filter fails closed and serves last-known-good.
- At least one aggregator API key is present, or `ALLOW_BAD_DEBT_ONLY=true` (bad-debt-only, no swap).
- Indicative probes are a good-enough proxy for firm-quote ranking. A mis-ranked venue costs at most
  a fall-through to the runner-up, never a bad fill — the firm quote, the oracle route-quality guard,
  and `simulate()` still gate execution.
- Venue rate limits (~1 rps) hold; the isolated probe budget + probe cache + liquidatable-only gating
  keep firm quotes ahead of probe bursts.
- Aggregators route through Uniswap pools, so dropping the direct Uniswap venue removes only the
  keyless path to that liquidity, not the liquidity.

## Security

- **API keys stay env-only** and are read at point of use; nothing lands on a logged config object.
- **The whitelist is a fail-closed scope gate.** A compromised or empty markets response can only
  _shrink_ the acted-on set, never authorize a market the lens would reject. It is, however, a
  **liveness dependency for coverage** — last-known-good + fail-closed bound the blast radius to
  missed coverage.
- **The untrusted-calldata + `simulate()` trust boundary is unchanged.** Indicative probe outputs are
  never executed; the firm quote's embedded min-out, the oracle route-quality guard, and the on-chain
  `simulate()` ok-only gate remain the trust chain, so a stale or wrong venue pick fails closed as a
  missed block, never a bad fill.

## Future Considerations

- **`minProfit` / net-of-gas gate** using the probe's per-venue output curve — the cache is already
  shaped for it.
- **Uniswap as a rankable venue** via a quote-shim service that mimics an aggregator's quote API over
  Uniswap data — would also lift the "aggregator key required" constraint.
- **Per-collateral `PROBE_LADDER` calibration** for very-high- or very-low-decimal collaterals, if
  more markets are listed. Not blocking — sizes clamp to the nearest log-space bucket.

## References

- [TIB-2026-06-29: Midnight liquidation bot — multi-venue swap support](./TIB-2026-06-29-midnight-multi-venue-swaps.md)
  — this TIB reverses its "operator-declared venue / no best-execution / no fallback" non-goals and
  delivers its deferred selector; the `Swap` currency, encoder, and seize-exact sizing are untouched.
- [TIB-2026-07-13: Off-chain bot architecture](./TIB-2026-07-13-bot-architecture.md) — the pipeline
  the whitelist filter and venue selector now run inside (the `unhealthy-positions` source and
  `liquidate` transform), and the home of `@repo/swaps` as the venue-agnostic quoting library.
- 0x Swap API v2 (`/price` indicative): `https://0x.org/docs/api`
- 1inch Classic Swap v6 (`/quote` indicative):
  `https://portal.1inch.dev/documentation/apis/swap/classic-swap/introduction`

### 2026-08-31 — probe ladder, gross ranking, and the probe-proxy assumption superseded

[TIB-2026-08-31 (venue cost-curve selection)](./TIB-2026-08-31-venue-cost-curve-selection.md)
supersedes three of this TIB's decisions, on evidence from the 2026-08-28 15:00 UTC maturity (see
[TIB-2026-08-28](./TIB-2026-08-28-midnight-send-shortfall-classification.md)). The log-scaled
`PROBE_LADDER` in whole collateral tokens becomes fixed decades in USD ($0.01 → $100k, 8 rungs)
converted per pair — the whole-token ladder spanned $800–$8M for cbBTC while 832 of 926 (90%) real
seizes fell below its bottom rung. The **"Net-of-gas / profitability ranking"** non-goal is reversed
for its route-cost half: the probe now stores a per-rung venue **rate** (no oracle, so the cache
stays keyed by pair and shared across every market on it) and ranking is net of interpolated route
cost, applied above the candidate cap; gas stays out of the curve. And the assumption that
"indicative probes are a good-enough proxy for firm-quote ranking" is replaced by an explicit
fail-open rule — a cold, incomplete, or clamped curve reverts to gross-surplus ordering with full
venue fall-through, which is what preserves this TIB's "costs at most a fall-through" guarantee.
The markets-API whitelist, key-presence venue enablement, isolated probe client, and
liquidatable-only probe gating are unchanged.
