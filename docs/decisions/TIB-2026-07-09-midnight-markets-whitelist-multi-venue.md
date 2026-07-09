# TIB-2026-07-09: Midnight liquidation bot — API market whitelist and best-of-venues selection

| Field      | Value                                                                      |
| ---------- | -------------------------------------------------------------------------- |
| **Status** | Proposed — implemented; awaiting review                                    |
| **Date**   | 2026-07-09                                                                 |
| **Author** | @hayden                                                                    |
| **Scope**  | App: `bots/midnight-liquidation` (+ additive `@repo/swaps` venue selector) |

---

## Context

The midnight-liquidation bot got its swap routing from a hand-maintained per-collateral JSON
(`configs/example.json`, loaded via `SWAP_CONFIG_PATH`) that did two jobs at once: it **enumerated
the collateral set** the bot would act on, and it **pinned exactly one liquidity venue** to each
token. Two prior decisions set up the tension this TIB resolves. The multi-venue TIB
([TIB-2026-06-29](./TIB-2026-06-29-midnight-multi-venue-swaps.md)) made venue an operator-declared,
per-collateral choice with **no cross-venue fallback**, and explicitly deferred a "best-execution
venue selector" to Future Considerations. The discovery-markets-API TIB
([TIB-2026-07-09](./TIB-2026-07-09-midnight-discovery-markets-api.md)) moved borrower discovery onto
the Midnight markets API, making that endpoint the coverage source of truth.

Two forces now push past the hand-maintained file. First, it is toil that drifts: every listed or
delisted market needs a config edit, and the markets API already knows the authoritative listed set.
Second, one venue per collateral is a coverage gap — the same thin-liquidity problem the multi-venue
TIB fought — that best-of-venues selection closes. This TIB **narrowly reverses** two Non-Goals of
TIB-2026-06-29 (operator-declared venue with no best-execution selection; no silent cross-venue
fallback) and **delivers its deferred best-execution selector**. The rest of that TIB — the `Swap`
currency, the venue-agnostic encoder, seize-exact sizing, the aggregator adapters — stands unchanged.

## Goals / Non-Goals

**Goals**

- Replace the hand-maintained per-collateral routing file with two API-sourced inputs: a **market
  whitelist** from the Midnight markets API, and **automatic venue selection** — so nothing needs
  editing as markets are listed or delisted.
- **Best-of-all-venues quoting**: per `(collateral, loan)` pair, rank venues from a cached indicative
  probe, firm-quote the best venue for the position's size **once**, and fall through to the runner-up
  on failure (coverage-first).
- Keep the deployless lens as the **correctness boundary** — the whitelist only gates _which_ markets
  are acted on. A delisted-but-underwater position falls out of scope by design.
- Honor the "only necessary calls" + "~1 req/sec venue rate limit" constraints: probe **only** pairs
  with a liquidatable position, staleMs-cache the ranking, and run probes on a **separate**
  rate-limited HTTP client so probe bursts never queue ahead of a time-sensitive firm quote.
- Enable venues by **API-key presence** (`ZEROX_API_KEY` → `0x`, `ONEINCH_API_KEY` → `1inch`) with a
  global `SLIPPAGE_BPS`; **hard-fail at boot** if no key is present, unless `ALLOW_BAD_DEBT_ONLY=true`.
- Keep all `@repo/swaps` changes **additive** — blue-liquidation's single-venue `composeQuoting` /
  `parseSwapConfig` / Uniswap path is untouched (see [[bot-kit-swaps-extraction]]).
- Shape the probe cache so a future `minProfit` gate can pre-screen a position without new plumbing.

**Non-Goals**

- **Net-of-gas / profitability ranking.** The probe stores gross output only (gas is not in it).
  Venue ranking is best _gross_ output; a `minProfit` gate is a deliberate follow-up.
- **MEV-aware or competitive execution.** The bot stays a coverage-first "must-work fallback
  liquidator" (per TIB-2026-06-29); best gross output is the ranking/tiebreak, not a race.
- **Uniswap V3 as a rankable midnight venue.** Dropped here (see Proposed Solution); its
  reintroduction as a rankable venue is a separate follow-up.
- **Changing the correctness boundary or any v0 safety invariant.** The firm-quote → oracle
  route-quality guard → on-chain `simulate()` chain is unchanged.
- **Migrating blue-liquidation.** It stays on the per-collateral single-venue config path.
- **Extracting discovery into a shared package.** Discovery stays per-bot (per the extract TIB); the
  venue-agnostic selector correctly lives in `@repo/swaps`, discovery does not.

## Current Solution

`config.ts` read `SWAP_CONFIG_PATH` into a per-collateral map of `{ venue, slippageBps, ... }`
(`parseSwapConfig`), and `composeQuoting` looked each liquidatable collateral up in that map,
firm-quoted the one configured venue, applied the oracle route-quality check, and returned
`no_config` for any collateral not in the file. The collateral universe was whatever the file
listed; a configured venue's failure was fail-loud-and-skip with no fallback. That routing file is
**deleted** — `config.ts` no longer reads any swap-config path. (Stale `SWAP_CONFIG_PATH` /
`configs/example.json` references remain only in the deferred deploy-infra scripts and a seed-script
example; see Future Considerations.)

## Proposed Solution

Four API/probe-driven pieces replace the file. `@repo/swaps` gains an **additive** venue-selector +
multi-venue quoting surface; the bot gains a markets-API **whitelist** and rewired config.

### 1. Market whitelist via the Midnight markets API

`GET https://api.morpho.org/v0/midnight/markets?listed=true` is a **hard whitelist**
(`bots/midnight-liquidation/src/discovery/markets.ts`, `createListedMarketFilter`). Borrower
candidates from the liquidation-candidates endpoint (the discovery-markets-API TIB) are filtered to
this listed set **before** the on-chain lens read — a non-listed market is never discovered, probed,
or liquidated. The filter is **fail-closed**: it refreshes on a timer (`MARKETS_REFRESH_MS`, default
60s), serves **last-known-good** on a transient API failure, and yields an empty set only on a
never-successful first fetch. The lens still re-reads every surviving pair fresh on-chain, so the
whitelist is a coverage/scope gate, **never** a correctness one — a delisted-but-underwater position
simply falls out of scope.

### 2. Best-of-all-venues quoting via a cached, rate-limited, log-scaled probe

New `@repo/swaps` `createVenueSelector` (`packages/swaps/src/venue-selector.ts`) caches, per
`(chainId, collateral, loan)` pair, a **best-first venue ranking** built from **indicative** quotes
(`priceZerox` = 0x `/price`, `priceOneInch` = 1inch `/quote`) sampled at **log-scaled ladder** sizes
(`PROBE_LADDER`, default `0.01/0.1/1/10/100` whole collateral tokens, converted per-collateral to
base units). New `composeMultiVenueQuoting` picks the best venue for the position's **size bucket**
(nearest ladder point in log space), firm-quotes it **once**, applies the existing oracle
route-quality guard, and — coverage-first — **falls through to the next-ranked venue** on a quote or
route-quality failure. A firm quote is requested only _after_ the venue order is decided from the
cache, and only for the chosen venue — never fanned out across venues.

```ts
// The unit the selector ranks and returns, per size bucket:
type VenueQuoteEstimate = { venue: Venue; expectedOut: bigint }
select(pair: { collateral; loan }, amountIn: bigint): VenueQuoteEstimate[] // best-first; [] if cold
```

The Midnight-shaped adapter (`bots/midnight-liquidation/src/quotes.ts`) keeps the tick's
`(plan, out)` signature: it projects the lens output into the package's plain `QuoteRequest`,
`refresh`es the probe for the position's pair, then calls the package's `quoteFor`.

```
per liquidatable position:
  collateral slot present? excluded collateral?  -> no_config (no API call)
  selector.refresh({collateral, loan})           // gated to THIS pair; staleMs-cached; probeClient
  select(pair, seizedAssets) -> best-first order  // [] cold -> deterministic default venue order
  for venue in order:
    firm quote (httpClient) -> route-quality guard -> ok? return swap : continue (fall-through)
  -> failed(lastReason)                            // tick backs the position off
```

Three guards keep this inside the "only necessary calls" + "~1 rps" budget:

- **Probing is gated to pairs with a liquidatable position** — `refresh` is driven from the tick's
  quoting adapter, never for quiet markets. Probe volume is O(liquidatable pairs), not O(candidates).
- **`staleMs`-cached** (`PROBE_STALE_MS`, default 10 min): a repeat `refresh` for the same pair
  inside the window makes zero venue calls.
- **A separate rate-limited HTTP client** for probes (`PROBE_HTTP_RPS`, default 1) with its own
  per-venue token buckets, distinct from the firm-quote client — so a background probe burst can
  never queue **ahead of** a live liquidation's firm quote on the same venue's bucket.

### 3. Venues enabled by API-key presence; hard-fail otherwise

There is **no per-collateral routing** anymore. `0x` is enabled iff `ZEROX_API_KEY` is present,
`1inch` iff `ONEINCH_API_KEY`; a global `SLIPPAGE_BPS` (default 100) replaces the old per-entry
slippage. With **no** venue key present, `loadConfig` **throws at boot** — a rotated or forgotten key
must not silently disable liquidations — **unless** `ALLOW_BAD_DEBT_ONLY=true`, which boots the
degraded posture (discover + realize pure bad debt, which needs no swap) with a loud, repeated health
log. Keys stay env-only, read at point of use, never stored on `Config` (unchanged from
TIB-2026-06-29).

### 4. Uniswap V3 dropped as a midnight venue

The `@repo/swaps` Uniswap-V3 adapter only **echoes the lens oracle price**
(`expectedAmountOut = referenceAmountOut`) — it has no real off-chain quote, so it cannot be ranked
on output against aggregators (it would always look oracle-perfect and win spuriously). DEX
aggregators already route through Uniswap pools, so dropping the _direct_ venue does not lose the
underlying liquidity — only the ability to reach it without an API key. Consequence: **at least one
aggregator API key is now required** to swap-liquidate. A follow-up (a Linear CRTR ticket is being
filed) will bring Uniswap back as a **rankable** venue by standing up a tiny service that mimics an
aggregator's quote API but sources Uniswap data.

### 5. Profitability-gating readiness

The probe cache stores a **per-venue output curve** (each enabled venue's indicative output at each
ladder point), and `select` returns `{ venue, expectedOut }[]`. This lets a future `minProfit` gate
**pre-screen** a position — skip the firm quote entirely if no venue's estimate can clear the
threshold — and then gate on the firm quote's output. Net-of-gas ranking stays a decision-time
concern (gas is not in the probe).

### Implementation Phases

- **Phase 1 — `@repo/swaps` selector + multi-venue quoting.** `createVenueSelector`, `priceByVenue`
  (0x `/price`, 1inch `/quote`), `PriceParameters`/`PriceQuote` types, and `composeMultiVenueQuoting`
  with coverage-first fall-through. Additive — the single-venue path is untouched.
- **Phase 2 — Market whitelist.** `createListedMarketFilter` over the markets API; fail-closed,
  last-known-good, timer-refreshed.
- **Phase 3 — Config rewrite + wiring.** Drop `SWAP_CONFIG_PATH`; derive enabled venues from key
  presence; add `markets`/`probe`/global-slippage config; wire the two HTTP clients, the selector,
  the whitelist filter, and the Midnight-shaped `quotes.ts` adapter; filter candidates to the
  whitelist before the lens read.

## Considered Alternatives

### Alternative 1: Keep the hand-maintained per-collateral routing file

Continue enumerating collaterals and pinning a venue each in `swap.json`.

**Why rejected:** It is toil that drifts against the markets API (which already knows the listed set),
and one venue per collateral is the exact thin-liquidity coverage gap the multi-venue TIB fought.
Sourcing the market set from the API and the venue from a probe removes both.

### Alternative 2: Fan out firm quotes across all venues per position, pick the best

Firm-quote every enabled venue for each liquidatable position and take the best output.

**Why rejected:** Burns the venue rate budget — O(venues) firm quotes per liquidatable position on
the time-sensitive path — for a ranking the cached indicative probe already gives for ~free. The
firm quote is spent only on the chosen venue (plus a fall-through on failure).

### Alternative 3: Keep Uniswap V3 rankable via its oracle-echo

Treat the Uniswap adapter's oracle-echo output as its "quote" and rank it alongside aggregators.

**Why rejected:** The oracle echo is not a real output estimate — it would tie or beat every
aggregator route by construction and win spuriously, sending swaps to a single pool that may lack
depth. Aggregators already route through Uniswap pools; a genuinely rankable Uniswap venue needs a
real quote source (the deferred quote-shim service).

## Assumptions & Constraints

- The markets API `listed=true` set is authoritative for _which_ markets to act on. Because the lens
  stays the correctness boundary, an over- or under-inclusive whitelist can only cost coverage, never
  cause a bad fill — the filter fails closed and serves last-known-good.
- At least one aggregator API key is present, or `ALLOW_BAD_DEBT_ONLY=true`. With the flag and no key,
  the bot can only realize pure bad debt (no swap).
- Indicative probes (0x `/price`, 1inch `/quote`) are a good-enough proxy for firm-quote ranking. A
  mis-ranked venue costs at most a fall-through to the runner-up, never a bad fill — the firm quote,
  the oracle route-quality guard, and `simulate()` still gate the actual execution.
- Venue rate limits (~1 rps) hold. The isolated `PROBE_HTTP_RPS` budget + `PROBE_STALE_MS` cache +
  liquidatable-only gating keep firm quotes ahead of probe bursts; a large simultaneous wave paces
  against the buckets, acceptable for a fallback bot.
- Aggregators route through Uniswap pools, so dropping the direct Uniswap venue does not remove access
  to that liquidity — only the keyless path to it.
- The `PROBE_LADDER` range (0.01–100 whole tokens) spans the sell sizes real listed collaterals
  produce; `nearestBucket` picks the closest log-space point, so out-of-range sizes clamp to the
  nearest end.

## Dependencies

- The **Midnight markets API** (`GET /v0/midnight/markets`) — Morpho's own endpoint (not a
  rate-limited venue), already adopted for borrower candidates in
  [TIB-2026-07-09](./TIB-2026-07-09-midnight-discovery-markets-api.md), now also the whitelist source.
- **`@repo/swaps`** new additive surface: `createVenueSelector`, `composeMultiVenueQuoting`,
  `priceByVenue`, and the `PriceParameters`/`PriceQuote` types. The package was established as the
  venue-agnostic home in [TIB-2026-07-09](./TIB-2026-07-09-extract-bot-kit-and-swaps.md).
- **0x `/price` and 1inch `/quote`** indicative endpoints, in addition to the firm-quote endpoints
  from TIB-2026-06-29. Both require the same env API keys.

## Observability

Additive JSON log events (structural `QuoteLogger` / bot `Logger`):

```
markets.listed              { chainId, markets }                         // whitelist refreshed
discover.filtered           { total, listed }                            // candidates dropped by whitelist
probe.refreshed             { collateral, loan, points, venues }         // a pair's probe cache filled
probe.venue_error           { venue, collateral, loan, amountIn, detail }// one probe call failed (non-fatal)
probe.error                 { collateral, loan, detail }                 // refresh() rejected (non-fatal)
select.ok                   { venue, collateral, expected, oracle, order }// chosen venue firm-quoted ok
select.cold_default         { collateral, loan, order }                  // no cache yet → default order
quote.route_quality_failed  { venue, collateral, expected, oracle }      // fell through on bad route
quote.excluded_collateral   { collateral }                              // EXCLUDE_COLLATERALS skip
```

`venueSelector.snapshot()` exposes per-pair cache age + current winner per size bucket, and
`listedMarkets.snapshot()` exposes whitelist size + `updatedAt`, for periodic/shutdown logging.

## Security

- **API keys stay env-only** and are read at point of use — the new probe client shares the same key
  handling; nothing lands on the logged `Config` (unchanged from TIB-2026-06-29).
- **The whitelist is a fail-closed scope gate.** A compromised or empty markets response can only
  _shrink_ the acted-on set, never authorize a market the lens would reject. It is, however, now a
  **liveness dependency for coverage** — a silently-narrowed whitelist quietly reduces what the bot
  liquidates; last-known-good + fail-closed bound the blast radius to missed coverage.
- **Untrusted aggregator calldata + `simulate()` trust boundary unchanged.** Indicative probe outputs
  are never executed; the firm quote's embedded min-out, the oracle route-quality guard, and the
  on-chain `simulate()` ok-only gate remain the trust chain, so a stale or wrong venue pick fails
  closed as a missed block, never a bad fill.

## Future Considerations

- **`minProfit` / net-of-gas gate** using the probe's per-venue output curve — the cache is already
  shaped for it (`select` returns `{ venue, expectedOut }[]`).
- **Uniswap as a rankable venue** via a quote-shim service that mimics an aggregator's quote API over
  Uniswap data (CRTR follow-up being filed) — would also lift the "aggregator key required" constraint.
- **Deploy-infra cleanup.** `docker-compose.yml`, `scripts/deploy-railway.ts`, and the seed-script
  example still reference `SWAP_CONFIG_PATH` / `configs/example.json`, now dead at the source. Folds
  into the deferred deploy-infra extraction (Phase 4 of the extract TIB); the live Railway service
  also needs its `SWAP_CONFIG_PATH` var and volume removed (see [[railway-midnight-liquidation-deploy]]).
- **Midnight multichain** (from the extract TIB) — the selector is already chain-keyed.

## Open Questions

- Whether the default `PROBE_LADDER` (0.01–100 whole tokens) needs per-collateral calibration for
  very-high- or very-low-decimal collaterals once more markets are listed. Not blocking — sizes clamp
  to the nearest log-space bucket and the firm quote is still per-position.

## References

- [TIB-2026-06-29: Midnight liquidation bot — multi-venue swap support](./TIB-2026-06-29-midnight-multi-venue-swaps.md)
  — this TIB **narrowly reverses** its "operator-declared venue / no best-execution selection" and
  "no silent cross-venue fallback" Non-Goals and **delivers** its deferred best-execution selector.
  The `Swap` currency, the venue-agnostic encoder, and seize-exact sizing are untouched.
- [TIB-2026-07-09: Extract `@repo/swaps` and `@repo/bot-kit`](./TIB-2026-07-09-extract-bot-kit-and-swaps.md)
  — established `@repo/swaps` as the venue-agnostic home; the new selector lives there, discovery
  stays per-bot, and blue-liquidation keeps the single-venue path.
- [TIB-2026-07-09: Midnight discovery via the markets API](./TIB-2026-07-09-midnight-discovery-markets-api.md)
  — the markets API this TIB reuses as the market whitelist.
- 0x Swap API v2 (`/price` indicative): `https://0x.org/docs/api`
- 1inch Classic Swap v6 (`/quote` indicative): `https://portal.1inch.dev/documentation/apis/swap/classic-swap/introduction`
- CRTR — Uniswap quote-shim service (rankable Uniswap venue), follow-up being filed.

<!--
TIB conventions:
- Once accepted, do not substantively edit this TIB. If the decision needs to change,
  create a new TIB that supersedes this one and update the Status/Superseded by fields.
- Addenda may be appended to record operational updates that affect
  how the TIB is applied without changing the decision itself.
- TIB identifiers use CalVer (YYYY-MM-DD) based on the date the TIB was first drafted.
-->
