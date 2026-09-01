# Midnight Liquidation Bot

Off-chain liquidator for Morpho Midnight markets, running on Base and Ethereum mainnet.

The bot watches candidate borrowers, reads their live Midnight state, builds a liquidation plan,
simulates the exact transaction it would send, and only broadcasts when the full Executor path
succeeds.

## Status

This package is operational code, but it is still intentionally narrow:

- Supported chains: Base (`CHAIN_ID=8453`) and Ethereum mainnet (`CHAIN_ID=1`). **One process per
  chain** — the bot is single-chain by design; horizontal scale is one deployment per chain.
- Each chain carries its own calibration (`TuningConfig` in `src/config.ts`): block-denominated
  values are derived from a shared wall-clock intent through the chain's block time, and the fee /
  economics values are set per chain. Every one of them is still overridable by its env var.
- The markets the bot may touch come from the Midnight markets API (`listed=true`) as a **whitelist**:
  only listed markets are discovered, probed, and liquidated (fail-closed). There is no hand-maintained
  collateral list.
- Discovery is backed by the markets liquidation-candidates HTTP API — an over-inclusive candidate
  feed the bot filters to the whitelist and re-reads on-chain before acting.
- Execution tries **all enabled venues and uses the best** (LiFi / 0x / 1inch swap aggregators).
  Venues are enabled by the presence of their API key (LiFi also via `ENABLE_LIFI`, since it works
  keyless) — there is no per-collateral routing file. The best venue
  per collateral→loan pair and size is picked from a cached, rate-limited, log-scaled indicative probe;
  the position itself is then firm-quoted once against the chosen venue, falling through to the
  runner-up venue on failure (coverage-first). Uniswap-direct is not a candidate here — aggregators
  route through Uniswap pools anyway, and a direct Uniswap route can't be ranked on real output.
- For positions with multiple active collaterals, the planner sizes **every** activated slot — in both
  liquidation modes when the position is matured and unhealthy, since the contract opens both gates —
  and ranks the resulting candidates by expected surplus. The tick works down that ranking and submits
  at most one liquidation per position, so a transient venue failure or a closed gate on one candidate
  falls through to the next in the same tick.
- ⚠️ **The bot does not yet support the protocol's full collateral range.** Midnight allows 16
  activated collaterals per borrower, which at two open modes is 32 candidates; the planner keeps only
  the top `MAX_PLAN_CANDIDATES_PER_POSITION` (4) after ranking, so it bounds the quotes and
  simulations one position can spend. Today's listed markets carry at most two collaterals — exactly
  4 candidates — so nothing is dropped in practice, but **a third listed collateral would start
  silently truncating.** Raise the cap (and re-check the venue rate budget) before such a market
  ships. The best swap-free candidate is never truncated away, so the certain-execution path survives
  the cap regardless.
- **Loan-as-collateral** markets list the loan token as one of their own collaterals (priced by an
  identity oracle). Seizing that slot needs no swap at all: no venue is called, so such a position is
  liquidatable even with no venue key set, and it is exempt from `HEADROOM_FLOOR_BPS` — that floor
  bounds a route cost this path does not pay.

## Prerequisites

- Node.js `24.14.1` (`nvm use` from the repo root).
- pnpm `11.1.1` (via corepack), Node `24.14.1`.
- A Base RPC URL.
- A funded liquidator EOA private key.
- A deployed permissionless Executor contract. If `EXECUTOOOR_ADDRESS` is unset, the bot uses the
  deterministic address derived by `@repo/contracts`; startup still requires code to exist there.
- Network access to the markets liquidation-candidates API and the Midnight markets API (both public
  by default; override with `LIQUIDATION_CANDIDATES_API_URL` / `MARKETS_API_URL`, the latter accepting
  a comma-separated list of endpoints whose whitelists are unioned).
- At least one enabled venue to swap-liquidate a collateral that is not the loan token:
  `ENABLE_LIFI=true` (or a `LIFI_API_KEY`), `ZEROX_API_KEY`, and/or `ONEINCH_API_KEY`. With none
  enabled the bot refuses to start unless `ALLOW_BAD_DEBT_ONLY=true` is set — and even then it is not
  limited to bad debt: it still discovers positions, realizes bad debt, **and liquidates
  loan-as-collateral slots**, which need no venue at all.

Never commit `.env` files, private keys, or RPC credentials.

## Configuration

Environment variables:

| Var                                                       | Required | Default                               | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------- | -------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CHAIN_ID`                                                | yes      | —                                     | Must be in the chain map: `8453` (Base) or `1` (Ethereum mainnet). Selects the deployment address and the chain tuning row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `RPC_URL`                                                 | yes      | —                                     | RPC for the configured chain, used for reads, simulation, and sends. Must be a full RPC that relays `eth_sendRawTransaction` — a read-only relay that acks sends without forwarding them to the sequencer would leave every tx unmined.                                                                                                                                                                                                                                                                                                                                                                                        |
| `RPC_URL_FALLBACK`                                        | no       | —                                     | Optional fallback RPC for the signer's transport.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `LIQUIDATOR_PRIVATE_KEY`                                  | yes      | —                                     | `0x`-prefixed 32-byte private key for the sender EOA.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `EXECUTOOOR_ADDRESS`                                      | no       | derived                               | Override for the shared Executor address.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `LIQUIDATION_CANDIDATES_API_URL`                          | no       | public                                | Liquidation-candidates endpoint polled for borrower discovery. Defaults to the public Morpho markets API; validated as a URL at startup (fail-loud).                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `HEALTH_FACTOR_LTE`                                       | no       | `1.02`                                | Health-factor cutoff sent to discovery (`health_factor_lte`); matured positions are always included regardless. Floored at `1.0`. Over-inclusive by design — the on-chain lens is the source of truth.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `MARKETS_API_URL`                                         | no       | public                                | Midnight markets endpoint(s) used as the market whitelist (`listed=true`). Accepts a comma-separated list, whose whitelists are unioned per-source (see below). Defaults to the public Morpho markets API; every entry is validated as a URL at startup (fail-loud). ⚠️ Set a list only after an image that supports it is live, and clear it back to one URL before rolling back — older images reject a list.                                                                                                                                                                                                                |
| `MARKETS_REFRESH_MS`                                      | no       | `60000`                               | How often the whitelist is refreshed. The endpoint is Morpho's own (not rate-limited); last-known-good is served on a transient failure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ZEROX_API_KEY`                                           | cond.    | —                                     | Enables the `0x` venue when set. Read at point of use; never stored on config or logged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ONEINCH_API_KEY`                                         | cond.    | —                                     | Enables the `1inch` venue when set. Read at point of use; never stored on config or logged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ENABLE_LIFI`                                             | no       | `false`                               | Enables the keyless `lifi` venue. Also implicitly enabled when `LIFI_API_KEY` is set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `LIFI_API_KEY`                                            | no       | —                                     | Optional; LiFi routes keyless, a key only raises its rate limits (and enables the venue). Read at point of use; never logged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ALLOW_BAD_DEBT_ONLY`                                     | no       | `false`                               | When no venue is enabled, the bot refuses to start unless this is `true` (it then discovers positions, realizes bad debt, and liquidates loan-as-collateral slots, which need no route; it never swap-liquidates, and an unwrap chain counts as a swap here).                                                                                                                                                                                                                                                                                                                                                                  |
| `ZEROX_BASE_URL` / `ONEINCH_BASE_URL` / `LIFI_BASE_URL`   | no       | public                                | Optional venue API host overrides.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `EXCLUDE_COLLATERALS`                                     | no       | —                                     | Comma-separated collateral addresses the bot must never seize/hold — skipped (no quote) even in a listed market.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `MAX_FEE_GWEI`                                            | no       | `300`                                 | Hard max fee cap used by the pending transaction queue.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `PRIORITY_FEE_GWEI`                                       | no       | `0.1`                                 | First-send tip. The bump path adds at most 1.42x (3 attempts × 12.5%) over ~15 blocks, so this value, not the ceiling, sets what the bot actually pays for inclusion. Must leave room for one bump under `MAX_FEE_GWEI`.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `LOG_LEVEL`                                               | no       | `info`                                | One of `debug`, `info`, `warn`, `error`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `CACHE_DIR`                                               | no       | `.cache`                              | Soltag/deployless cache directory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `QUOTE_TIMEOUT_MS`                                        | no       | `2500`                                | Per-quote HTTP deadline (the firm quote runs inside the per-block tick).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `HTTP_RPS` / `HTTP_BURST`                                 | no       | `2` / `5`                             | Per-venue token-bucket refill rate and burst for FIRM quotes. The 1inch free tier is 1 RPS — set `HTTP_RPS=1` if you only use 1inch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `PROBE_HTTP_RPS`                                          | no       | `1`                                   | Per-venue token-bucket rate for BACKGROUND probes, on a separate client so probe bursts never queue ahead of a live firm quote.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `PROBE_STALE_MS`                                          | no       | `45000`                               | Probe-cache TTL per pair. A pair is re-probed only when a liquidatable position touches it after the cache goes stale — no probe traffic on quiet markets. Kept short because the cached curve is a price level and the route cost derived from it is the same order (~20bps) as the post-maturity liquidation incentive it is weighed against; venue _ordering_ is unaffected by cache age.                                                                                                                                                                                                                                   |
| `PROBE_LADDER`                                            | no       | `0.01,0.1,1,10,100,1000,10000,100000` | Comma-separated log-scaled probe sizes in **USD**, converted per-collateral to base units against the token price (whole collateral tokens for a collateral the price source cannot price). Fixed and deliberately wide — decades from \$0.01 to \$100k bracket every real seize size on any collateral, so `select` interpolates rather than clamping.                                                                                                                                                                                                                                                                        |
| `HTTP_MAX_RETRIES`                                        | no       | `2`                                   | Retries on 429/5xx/network (honoring `Retry-After`) before a quote fails.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `MAX_ROUTE_IMPACT_BPS`                                    | no       | `500`                                 | Reject a venue's quoted output more than this far below the oracle reference (route-quality guard).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `SEIZE_CAP_MARGIN_BPS`                                    | no       | `30`                                  | Headroom shaved off the on-chain repay cap when sizing a cap-binding seize, so a one-block oracle move can't trip the contract's RCF/debt check. `0` sizes right at the cap.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `HEADROOM_FLOOR_BPS`                                      | no       | `3`                                   | **Lower bound** on swap execution cost — the cheapest route you would ever expect, NOT a typical cost. A seize-exact plan's whole margin is the incentive `(lif - 1)/lif`, so a plan below this floor cannot fund its own repay by any route and is skipped as `plan.skipped` / `insufficient_headroom` before it costs a quote, a simulation or a gas estimate. Post-maturity the incentive ramps from zero over an hour, so this acts as a pure time gate: `3` suppresses roughly the first 25s on a 4.4%-maxLif tier. Set it too high and it blinds the earliest, most contested part of a maturity. `0` disables the gate. |
| `MIN_SURPLUS_BPS`                                         | no       | `0`                                   | Surplus over break-even a quoted route's **expected** output must clear before the bot spends a simulation on it, in bps of the plan's contract-derived repay. `0` is pure break-even: both sides then come from the contract's own formula with no tuned value, so the gate can only reject plans that would have reverted anyway. It gates the expected output only — the min-out actually encoded in the swap calldata stays at break-even — so raising it buys margin against a route that underperforms its quote, not against oracle drift between simulation and inclusion.                                             |
| `PENDLE_SLIPPAGE_BPS`                                     | no       | `50`                                  | Slippage for the Pendle PT → underlying unwrap hop (before the downstream venue sells).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `BACKOFF_BASE_BLOCKS` / `BACKOFF_MAX_BLOCKS`              | no       | `2` / `64`                            | Exponential per-position cooldown (in blocks) after a failed quote/simulate, bounding API + RPC usage under a backlog. An economic refusal (`floor_unmet`, an unprofitable quote) never arms it, and neither does a send the chain itself declined — see [Broadcast And Pending Queue](#broadcast-and-pending-queue).                                                                                                                                                                                                                                                                                                          |
| `POSITION_LIQUIDATION_COOLDOWN_MS`                        | no       | `0`                                   | Opt-in per-position cooldown (ms) after a failed liquidation attempt; `0` disables it (re-attempt every tick).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `BETTERSTACK_SOURCE_TOKEN` / `BETTERSTACK_INGESTING_HOST` | no       | —                                     | Opt-in log shipping; when both are set the bot's in-process loglayer transport ships structured logs to BetterStack (inert otherwise).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `BETTERSTACK_HEARTBEAT_URL`                               | no       | —                                     | Optional Better Stack Uptime heartbeat URL, pinged every minute; failures only log a warning and never interrupt liquidations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

The bot **refuses to start** if no venue is enabled, unless `ALLOW_BAD_DEBT_ONLY=true` — a rotated or
forgotten key (or a missing `ENABLE_LIFI`) must not silently disable liquidations.

Example local `.env` shape:

```sh
CHAIN_ID=8453
RPC_URL=https://base-mainnet.example
RPC_URL_FALLBACK=https://base-mainnet-fallback.example
LIQUIDATOR_PRIVATE_KEY=0x...
ZEROX_API_KEY=...
ONEINCH_API_KEY=...
# Fee and economics knobs default from the chain's tuning row; set them only to override.
MAX_FEE_GWEI=300
PRIORITY_FEE_GWEI=0.1
LOG_LEVEL=info
```

### Per-chain defaults

Several defaults are **chain-dependent**, resolved from the `CHAIN_ID` row before any env override is
applied. Block counts come from one shared wall-clock intent divided by the chain's block time, so the
same behaviour keeps the same timing on a ~2s and a ~12s chain.

| Default                                 | Base (8453) | Mainnet (1) | Why it differs                                                             |
| --------------------------------------- | ----------- | ----------- | -------------------------------------------------------------------------- |
| settle cooldown / stuck / backoff, etc. | 20n/4n/2n   | 3n/1n/1n    | Same wall-clock intent, ~6x the block time.                                |
| `MAX_FEE_GWEI`                          | `300`       | `50`        | Never binds on Base; on mainnet it is the only hard bound on spend per tx. |
| `PRIORITY_FEE_GWEI`                     | `0.1`       | `2`         | Base tips are nominal; mainnet's are a real market.                        |
| `MIN_SURPLUS_BPS`                       | `0`         | `25`        | Break-even is a loss after mainnet gas — see the caveat below.             |
| `SEIZE_CAP_MARGIN_BPS`                  | `30`        | `60`        | One block of oracle drift is ~6x longer on mainnet.                        |

> **Mainnet caveat.** Gas is not part of the profitability comparison (`src/runner/profitability.ts`
> weighs the quoted route against the contract-derived repay only). `MIN_SURPLUS_BPS` is a stopgap
> proxy: because it is bps of the repay, it under-covers small positions and over-charges large ones.
> Calibrate it against observed gas per liquidation and typical position size.

### Markets, venues, and probing

There is no swap config file. Instead:

- **Which markets** the bot touches comes from the Midnight markets API (`MARKETS_API_URL`) with
  `listed=true`: it is a hard **whitelist** — a market not in the listed set is never discovered,
  probed, or liquidated (fail-closed). This shapes only what the bot acts on; the on-chain lens remains
  the correctness boundary, and a delisted-but-underwater position simply falls out of scope.

  `MARKETS_API_URL` accepts **more than one endpoint**, comma-separated, and the whitelist is the union
  across them. This lets a deployment read an additional list (e.g. one carrying extra shorter-maturity
  markets for testing) without that list becoming the single source of truth for the whole whitelist.
  The combined size is logged once per refresh as `markets.whitelist`; the per-source `markets.listed`
  lines report each endpoint separately and must not be summed (sources overlap). Because the union is
  additive, **delisting a market takes effect only once every configured source has dropped it** — a
  market delisted from one endpoint stays in scope while another still lists it.

  The max-age staleness rule (`LISTED_MARKETS_MAX_AGE_MS` — a build-time constant of 10 minutes, not an
  environment variable) is applied **per source**, so one endpoint going down or going stale narrows the
  whitelist to its still-fresh peers (`markets.source_expired`) rather than emptying it and halting all
  liquidations. Only when _every_ source is stale is the whitelist empty, reported every tick as
  `markets.whitelist_expired` — fail-closed. Each source's own set survives its own transient failures
  (last-known-good, `markets.refresh_failed`); a source that returns a successful but empty list is
  authoritative, and because a healthy peer would otherwise mask it, that transition is called out as
  `markets.listed_empty`. A cold start with no successful fetch lists nothing.

  **Environments deliberately differ here.** Staging reads both the public endpoint and the test-market
  endpoint, so its whitelist is a strict superset of production's and it exercises the same API
  production depends on. Production reads the public endpoint only. Adding a source **widens what the
  bot will spend real capital on**, and the whitelist is only as trustworthy as the endpoints serving
  it — anyone who can list a market on any configured endpoint can direct that deployment's key at it.
  Note that `EXCLUDE_COLLATERALS` is a poor veto for this: it is collateral-scoped, and every currently
  listed market shares one collateral, so excluding it would disable the real markets too. There is no
  per-market denylist — the endpoint list _is_ the gate.

  ⚠️ **Rolling back past the release that added multi-source support will crash-loop the service** if
  `MARKETS_API_URL` still holds a comma-separated value: the older image validates the variable as a
  single URL and `loadConfig` rejects it at startup. Clear the variable to a single endpoint before
  rolling back. This is also why the list must only be set _after_ the new image is live.

- **Which venue** clears a given liquidation is chosen automatically. Aggregators are enabled by the
  mere presence of their API key (LiFi also via `ENABLE_LIFI`, since it works keyless). For each
  collateral→loan pair, a background job requests
  indicative quotes from every enabled venue at the `PROBE_LADDER` sizes and caches each venue's rate
  curve, which is then interpolated at the actual seize size. This probe is **gated** to pairs that
  have a liquidatable position that is neither cooled-down nor backed off, is cached for
  `PROBE_STALE_MS`, and runs on its own `PROBE_HTTP_RPS`
  budget — so venues' tight rate limits (~1 req/sec) are respected and quiet markets cost nothing. It
  is started, never awaited: a pair is warmed for the next tick rather than delaying this one.
- **When a position is liquidatable**, the bot firm-quotes once against the pre-chosen best venue and
  applies the `MAX_ROUTE_IMPACT_BPS` oracle route-quality guard — never fanning out firm quotes across
  venues at once. Whether it then tries the runner-up depends on what the curve knew: see
  [Quoting](#quoting). A pair not yet probed (e.g. newly listed) falls back to a
  deterministic default venue for that one quote.

The min-out floor is **derived, not configured**: each venue's slippage allowance is computed from the
liquidation's break-even output — the repay `liquidate` will pull — so the floor is economic rather
than a percentage someone picked. A fixed allowance is wrong in both directions and crosses over as
the incentive ramps: below break-even it lets a shortfall through to fail at the repay instead, above
it the router rejects fills that would have settled. There is no `SLIPPAGE_BPS`. A route is still
rejected when its quote is more than `MAX_ROUTE_IMPACT_BPS` below the oracle reference, and every venue
missing the floor is reported as `quote.floor_unmet` — an economic verdict, so the position is retried
on the next block rather than backed off. API keys come from `ZEROX_API_KEY` / `ONEINCH_API_KEY` and
are never logged.

## Running Locally

Install dependencies from the repo root:

```sh
nvm use
pnpm install
```

Discovery hits the public liquidation-candidates API by default, so no local indexer or database is
needed. Start the bot:

```sh
set -a
source bots/midnight-liquidation/.env
set +a
pnpm --filter @morpho-org/midnight-liquidation run start
```

Useful validation commands while developing:

```sh
pnpm --filter @morpho-org/midnight-liquidation run typecheck
pnpm --filter @morpho-org/midnight-liquidation exec vitest run
```

## Testing

- `pnpm --filter @morpho-org/midnight-liquidation exec vitest run` — unit tests for the sizing planner, the deployless lens,
  discovery (the candidate + markets APIs and their shared retry loop), quoting / venue selection, the
  pending queue, eligibility, and the exec encoder.
- **Fork suite** (`test/fork/`) — end-to-end against a real Base fork. Unlike a fixture-gated suite it
  **seeds its own liquidatable position** ([test/fork/seed.ts](./test/fork/seed.ts)): Midnight has no
  `borrow()`, so it clones a curator-trusted market, funds both EOAs via cheatcodes, signs an offer,
  and drives the `supplyCollateral` + `take` order-book path, then warps past maturity to make the
  position liquidatable. `liquidation.test.ts` then drives lens → plan → swap → exec, asserts the tx
  lands, and asserts the Executor ends holding zero of both tokens; `queue.test.ts` bumps a stuck tx
  and asserts the replacement lands at the same nonce. Both **require `RPC_URL_8453`** (an archive
  endpoint that serves the fork block) and fail loud — not skip — when it is unset.

## Seeding Liquidatable Positions

The package includes an operator-only helper for creating real, edge-of-liquidation Midnight
positions on Base. It is not part of the runner; it imports bot math/lens code to create positions
that the production bot can discover and liquidate.

The script starts from two funded ETH-only EOAs:

- Wallet A (`PRIVATE_KEY_LENDER`) becomes the maker/lender.
- Wallet B (`PRIVATE_KEY_BORROWER`) becomes the taker/borrower.

It discovers a real trusted Midnight market for the requested pair, clones its collateral/oracle
shape, creates one market per position, signs EcrecoverRatifier offers, and sends `take` transactions
that leave each position healthy at creation but near the liquidation edge. `--dry-run` performs
discovery, cryptographic self-checks, and capital planning without sending transactions.

Run from `bots/midnight-liquidation`:

```sh
RPC_URL=https://base-mainnet.example \
PRIVATE_KEY_LENDER=0x... \
PRIVATE_KEY_BORROWER=0x... \
pnpm run seed:positions \
  --config ./swap.config.json \
  --pair WETH/USDC \
  --count 10 \
  --drawdown-bps 0 \
  --dry-run
```

For a live run, remove `--dry-run` and either answer the confirmation prompt or pass `--yes`.
Before sending any transaction, the script checks:

- the local `toId` and tick math against the deployed Midnight contract;
- the requested swap route exists in the same config shape the bot uses;
- the estimated total spend is below `--max-spend-eth` (default `0.05`);
- Wallet A and Wallet B each have enough ETH for their own WETH deposits plus gas headroom.

Useful options:

| Option               | Default     | Purpose                                                                   |
| -------------------- | ----------- | ------------------------------------------------------------------------- |
| `--config`           | required    | Swap config JSON path. Must include the route the prod bot will use.      |
| `--pair`             | `WETH/USDC` | Token pair to seed. Supported symbols are defined in the script.          |
| `--count`            | `100`       | Number of positions/markets to create.                                    |
| `--drawdown-bps`     | `0`         | Price drop needed before the positions become liquidatable.               |
| `--notional-usdc`    | `1`         | Target debt size per position.                                            |
| `--reference-market` | unset       | Optional market id to clone instead of auto-discovery.                    |
| `--ratifier`         | unset       | Optional EcrecoverRatifier address to use with `--reference-market`.      |
| `--ladder`           | `false`     | Spread drawdown thresholds from `0` to `--drawdown-bps` across the batch. |
| `--max-spend-eth`    | `0.05`      | Abort if estimated Wallet A + Wallet B ETH spend exceeds this cap.        |
| `--dry-run`          | `false`     | Print the plan and send no transactions.                                  |
| `--yes`              | `false`     | Skip the live-run confirmation prompt.                                    |

## Running With Docker Compose

[docker-compose.yml](./docker-compose.yml) defines one service per chain — `bot-8453` and `bot-1`
(discovery is the remote API, so there is no database or indexer). Both build from the repo root so
workspace packages resolve correctly.

Operator-facing RPC and venue vars are **chainId-suffixed**; inside each container the runtime env is
unsuffixed, because each service runs exactly one chain.

From `bots/midnight-liquidation`:

```sh
export RPC_URL_8453=https://base-mainnet.example
export RPC_URL_1=https://eth-mainnet.example
export LIQUIDATOR_PRIVATE_KEY=0x...
export ZEROX_API_KEY_8453=...   # and/or ONEINCH_API_KEY_8453 / LIFI_API_KEY_8453
docker compose up --build
```

Run a single chain with `docker compose up --build bot-8453`.

Optional variables:

```sh
export EXECUTOOOR_ADDRESS=0x...
export LOG_LEVEL=debug
export RPC_URL_FALLBACK_8453=https://base-mainnet-fallback.example
export ALLOW_BAD_DEBT_ONLY_1=true   # run a chain unarmed, with no venue key
```

## Deploying to Railway

The bot runs as one service per chain on the Railway project `bot.liquidation.midnight` (discovery is
the remote API — no Postgres or indexer service).
[scripts/deploy-railway.ts](./scripts/deploy-railway.ts) provisions and deploys them idempotently from
the [Railway CLI](https://docs.railway.com/guides/cli), so it runs the same locally or in CI.

Railway service names are project-wide: production uses `bot-<chainId>` (`bot-8453`, `bot-1`), while
non-production environments use an environment prefix (for example, `staging-bot-8453`). After
`bot-8453` is confirmed healthy, the script retires the legacy single-chain `bot` service — leaving it
up would run a second, stale Base liquidator against the same funded key.

The [Dockerfile](./Dockerfile) is a single-stage Node image (pnpm installs, esbuild bundles, node runs);
`RAILWAY_DOCKERFILE_PATH` points Railway at it and `railway up` runs from the repo root so the pnpm
workspace resolves.

Authenticate the CLI first — set `RAILWAY_TOKEN` (a project token scoped to the target project /
environment, recommended for CI) or run `railway login`. The script bakes in no project identifier, so
set `RAILWAY_PROJECT_ID` to the project you're deploying to, then provide the secrets via the
environment and run the script:

```sh
export RAILWAY_PROJECT_ID=...   # required: the Railway project to deploy to
export RPC_URL_8453=https://base-mainnet.example
export RPC_URL_1=https://eth-mainnet.example
export LIQUIDATOR_PRIVATE_KEY=0x...          # or per-chain LIQUIDATOR_PRIVATE_KEY_<chainId>
export ZEROX_API_KEY=...                     # venue inputs; per-chain via ZEROX_API_KEY_<chainId> etc.
# Optional: RAILWAY_ENVIRONMENT (defaults to production), RPC_URL_FALLBACK_<chainId>,
# MAX_FEE_GWEI/PRIORITY_FEE_GWEI/MIN_SURPLUS_BPS[_<chainId>], ALLOW_BAD_DEBT_ONLY[_<chainId>].
pnpm --filter @morpho-org/midnight-liquidation run deploy:railway
```

Secrets are read from the script's environment, piped to Railway via stdin (never argv), and never
logged. The script fails loud — before mutating any Railway state — if a chain's `RPC_URL_<chainId>`
or private key is missing, or if a chain has no venue enabled and no `ALLOW_BAD_DEBT_ONLY` opt-in.

The venue posture is **synchronized** on every full run: `ENABLE_LIFI` / `ALLOW_BAD_DEBT_ONLY` are set
explicitly, and each venue key and fee override is either set from this run's inputs or **deleted**
when absent — so neither a stale opt-in nor a dropped key can linger from a previous run. A `CRASHED`
deployment counts as a failed deploy, because the bot fails loud on a bad config.

Set `DEPLOY_ONLY=1` (or `true`) to re-ship every **already-provisioned** `bot-<chainId>` service from
the current working tree without setting any secrets or variables — the mode the deploy CI uses (it
holds no RPC/keys). In this mode the RPC and key requirements do not apply.

Mainnet needs the Executor deployed once before its service can boot (startup asserts it holds code):

```sh
RPC_URL=<mainnet> DEPLOYER_PRIVATE_KEY=0x... pnpm --filter @repo/contracts run deploy:executor
```

Provisioning mainnet ahead of any listed market is safe: the whitelist is fail-closed, so the bot
idles at `markets.listed { markets: 0 }` rather than erroring, and starts working when markets list.

### Venue API keys

There is no swap config file to upload anymore — venues are enabled by the presence of their API key
(or `ENABLE_LIFI=true` for keyless LiFi). The deploy script uploads `LIFI_API_KEY`, `ZEROX_API_KEY`,
and `ONEINCH_API_KEY` when they are present in its environment. Set `ENABLE_LIFI=true` manually in the
Railway service only when you want keyless LiFi. With no venue enabled, the service will refuse to
start unless `ALLOW_BAD_DEBT_ONLY=true`.

## How It Works

### Startup

[src/index.ts](./src/index.ts) loads config, creates two viem clients, and starts the block-poll runner.
The read client wraps the RPC transport with `deployless` support so the bot can execute its Solidity
lens via `eth_call`. The signer client is plain HTTP and owns transaction submission with a local
pending-nonce cursor.

Startup fails loudly if required env vars are missing, the chain is unsupported, no venue API key is
set without `ALLOW_BAD_DEBT_ONLY=true`, or the configured Executor address has no bytecode.

### Trigger

`@repo/bot-kit`'s shared runner
([packages/bot-kit/src/runner/runner.ts](../../packages/bot-kit/src/runner/runner.ts)) polls the
latest block and runs the bot's per-block tick ([src/runner/tick.ts](./src/runner/tick.ts)) once per
new block. If blocks arrive while a tick is still running, the watcher coalesces work rather than
running overlapping ticks.

### Discovery

[src/discovery/borrowers.ts](./src/discovery/borrowers.ts) polls the markets liquidation-candidates
endpoint for candidate `(marketId, borrower)` pairs, following the cursor across every page
(`include_matured=true`, `health_factor_lte` from `HEALTH_FACTOR_LTE`). The feed is over-inclusive by
design — it does not evaluate the liquidation lock or liquidator gate — so the on-chain lens re-reads
every pair and filters out non-liquidatable state before planning.

Candidates are then filtered to the **market whitelist**
([src/discovery/markets.ts](./src/discovery/markets.ts)): the Midnight markets API (`listed=true`),
refreshed every `MARKETS_REFRESH_MS` and served last-known-good on a transient failure. A candidate
whose market is not listed is dropped before the lens read (fail-closed) — the whitelist is the only
gate on _which_ markets the bot acts on; the lens remains the correctness gate on _whether_ a position
is liquidatable.

Discovery failure is tolerated: a transient API error logs `discover.error` and the tick proceeds with
zero new candidates so the pending queue (confirmations / fee bumps) is still driven that block. A
runaway paginated response is capped at `MAX_DISCOVERY_PAGES` and logs `discover.max_pages` rather than
silently truncating (which would be under-inclusion — a liquidation missed).

Separately, [src/discovery/token-prices.ts](./src/discovery/token-prices.ts) keeps a snapshot of token
USD prices from the markets tokens endpoint, refreshed on its own timer (independent of
`MARKETS_REFRESH_MS`, so a slow tokens fetch cannot stall the fail-closed whitelist refresh) and served
last-known-good. It has **two consumers**:

- the tick's **ranking**, which values each candidate's gross surplus and its interpolated route cost
  in the same USD scale so the two are subtractable;
- the **probe ladder's denomination** ([src/index.ts](./src/index.ts)), which converts the USD
  `PROBE_LADDER` rungs into the collateral's base units.

It still fails **open**, but the behaviour is worth stating exactly, because "unpriced" now degrades
two things and gates one bound. An unpriced **loan** token leaves that position's route cost unknown,
so its candidates keep their gross-surplus score, sort last, and — because the
`MAX_PRESELECTED_CANDIDATES_PER_POSITION` fall-through bound is applied only to a position whose route
costs are all known — get the **full** unbounded fall-through rather than a cutoff over an untrusted
ordering. An unpriced **collateral** token falls that pair's ladder back to whole collateral tokens for
one TTL. A total outage is therefore the pre-curve behaviour throughout: discovery-order ranking, no
cutoff, whole-token ladders. It never decides that a liquidation is not attempted.

Watch `prices.tokens` for the snapshot size and the `unpriced` counter on `tick.end` — a persistently
high `unpriced` means the snapshot is not covering the loan tokens actually being liquidated. Note the
endpoint prices plain assets but not Midnight's synthetic collateral wrappers, so an exotic collateral
is expected to read as unpriced.

### State Lens

[src/state/lens.sol.ts](./src/state/lens.sol.ts) defines a deployless Solidity lens. For each
candidate, it:

- loads the canonical `Market` from Midnight with `toMarket(id)`;
- reads debt, collateral bitmap, liquidation lock status, and liquidator gate status;
- computes `maxDebt`, `badDebt`, and health with the same oracle and rounding directions used by
  Midnight's `liquidate`;
- returns every activated collateral slot (amount, oracle price, `maxLif`, `lltv`), unranked;
- returns the full market and flat sizing inputs to TypeScript.

Slot _choice_ is deliberately off-chain: which slot is worth liquidating depends on whether it needs a
swap, which the chain cannot know.

Per-candidate lens failures are isolated: one reverting oracle or malformed market leaves that row
invalid without failing the whole batch.

### Eligibility And Math

[src/runner/eligibility.ts](./src/runner/eligibility.ts) mirrors Midnight's liquidation gate:

```text
valid && gateAllows && hasDebt && !locked && (block.timestamp > maturity || !healthy)
```

[src/sizing/plan.ts](./src/sizing/plan.ts) turns a lens result into a `LiquidationPlan`:

- Pre-maturity unhealthy positions use normal mode with `maxLif` and the Recovery Close Factor cap.
  `maxLif` is derived from the collateral's `liquidationCursor` and `lltv` (`ConstantsLib.maxLif`);
  the lens computes it on-chain per slot and returns it on each `collaterals[]` entry.
- Post-maturity healthy positions use post-maturity mode, where LIF ramps from `1e18` to `maxLif` over
  60 minutes and the RCF cap is disabled.
- Post-maturity **unhealthy** positions open both on-chain gates, so the bot builds both candidate
  plans and **retains both**, ranked best-first and attempted in order — a mode that fails falls
  through to the other in the same tick rather than forfeiting the position. Normal mode pays the full `maxLif`
  immediately while the post-maturity LIF is still ramping, so `plan.built { postMaturityMode: false }`
  on a matured position shortly after maturity is expected behavior, not a mode-selection bug; once the
  ramp completes, ties resolve to post-maturity (its gate cannot close if the price recovers).
- Every non-bad-debt plan is **seize-exact**: it pins `seizedAssets` (with `repaidUnits = 0`) and lets
  Midnight ceil-derive `repaidUnits`. Midnight transfers exactly `seizedAssets` to the Executor before
  the swap callback, so every venue sells exactly the held balance — no sell-side drift.
- If seizing the whole selected slot would over-repay, the bot seizes the largest amount whose
  contract-derived repaid stays within the cap (`maxSeizeForCap`), shaved by `SEIZE_CAP_MARGIN_BPS` for
  one-block oracle-drift headroom.
- If the position is fully bad debt, the bot emits a zero/zero plan so Midnight can realize the bad
  debt without moving tokens.

All fixed-point math is integer `bigint` math and mirrors the contract's floor/ceil directions.

### Quoting

For each liquidatable, non-bad-debt position, [src/quotes.ts](./src/quotes.ts) projects the lens
output into a quote request and hands it to `@repo/swaps`' multi-venue quoting. The package first runs
the **pre-swap unwrap chain**: if the seized collateral wraps an ERC-4626 vault or a Pendle PT, it
auto-detects that and prepends the redeem step(s) that convert it to a tradable underlying (threading
each hop's worst-case output forward so a downstream fixed-amount step can never revert on a
shortfall); if the chain already ends in the loan token there is nothing left to sell, so the plan is
the unwrap steps alone. A collateral on `EXCLUDE_COLLATERALS` short-circuits before any of this. Venue
selection then applies to the **post-unwrap** pair, driven by a cached, rate-limited probe rather than
a per-collateral config file:

- A background probe (the `@repo/swaps` venue selector) requests **indicative** quotes from every
  enabled venue (`lifi`, `0x`, `1inch`) at the `PROBE_LADDER` sizes for each collateral→loan pair, and
  caches each venue's _rate_ (`expectedOut / amountIn`) per rung. `select` log-linearly interpolates
  that curve at the real seize size, clamping (and flagging `clamped`) rather than extrapolating past
  the ladder ends. Nothing oracle-derived is cached, so the per-pair cache is shared by every market
  on that pair and each market derives its own route cost from its own oracle reference. It is gated
  to pairs that have a liquidatable position, cached for `PROBE_STALE_MS`, and runs on a separate
  `PROBE_HTTP_RPS` client so it can never delay a live firm quote — respecting venues' ~1 req/sec
  limits and spending nothing on quiet markets.
- When a position is liquidatable, the bot firm-quotes **once** against the top-ranked venue for that
  pair+size (a single rate-limited API call returning route-bound calldata, taker/recipient = the
  Executor) and applies the oracle route-quality guard. A not-yet-probed pair uses a deterministic
  default venue for that one quote (`select.cold_default`). Firm quotes are spent only on liquidatable
  positions, never the full candidate set.
- **Whether the walk continues to the runner-up depends on what the curve knew.** A _trusted_ curve —
  one that ranked **every** enabled venue, none of them on a clamped rung — already names the winner on
  the very axis the two economic refusals measure, so `quote.route_quality_failed` and
  `quote.floor_unmet` stop the walk there and the candidate costs one venue's worth of calls. Every
  other curve state (cold, incomplete, or clamped) fails **open** to the full pre-curve fall-through
  across the whole enabled set.

  A **transport** failure never stops the walk, whatever the curve knew: the curve ranked output, not
  reachability. That covers a timeout or rate-limit on the first quote and on the min-out
  re-derivation alike — both surface as `quote.failed`, and the next venue is tried. This is what keeps
  the guarantee that a mis-ranked or stale curve costs at most a fall-through, never a lost position.

- The firm quote's **min-out denominator** also comes from the curve when it is trustworthy _and_
  fresher than the package's prediction-age ceiling, which saves the second call the two-pass
  derivation would otherwise spend. It is bounded on both sides: too high a prediction is refused by
  the break-even postcondition, and too large an overshoot above break-even is re-derived against the
  venue's own quote rather than encoded. `select.ok` carries `curveCostBps`, `curveAgeMs` and
  `firmQuoteCostBps` so probe fidelity is measurable from the log alone.

The sell amount is the plan's pinned `seizedAssets`: Midnight transfers exactly that to the Executor
before the callback, so the venue's fixed sell amount acts on exactly the seized balance — no
sell-side drift. The oracle-priced reference output
([src/execution/swap-step.ts](./src/execution/swap-step.ts)) values that same `seizedAssets`. Residual
drift is confined to the on-chain repay-cap check re-derived at the exec-block oracle price; it fails
closed in `simulate()` — a missed liquidation, never a loss — and the `SEIZE_CAP_MARGIN_BPS` headroom
keeps ordinary one-block moves from tripping it.

The bot computes the oracle-priced reference output for free (no extra API call) and rejects any venue
route more than `MAX_ROUTE_IMPACT_BPS` below it (`quote.route_quality_failed`). Quote failures (no
route, timeout, rate-limited, API error) log `quote.failed`; once every ranked venue is exhausted the
position is backed off — an exponential per-position cooldown that bounds API + RPC usage when many
positions fail (the rate-limit defense). A successful submit clears the backoff; nothing else does.

If no venue is enabled (bad-debt-only mode) or the collateral is on `EXCLUDE_COLLATERALS`, the tick
logs `config.no_swap_path` and skips the candidate (no API call, no backoff). Pure bad-debt
realization skips quoting entirely. A **loan-as-collateral** candidate is the exception to the
no-venue case: its sell path is already over, so it resolves to a zero-step plan before the
enabled-venue check is reached and is liquidated normally.

### Simulation

[src/execution/encode-call.ts](./src/execution/encode-call.ts) builds the exact calldata sent to the
Executor:

- normal liquidations call `Midnight.liquidate` with `receiver = callback = Executor`;
- the Executor fallback runs a callback queue that runs the plan's steps — a plain collateral is one
  venue swap; exotic collateral is unwrap step(s) then usually a venue swap — approves Midnight to
  pull repayment, and returns Midnight's callback success magic value;
- after `liquidate` returns, trailing sweeps send both market tokens plus every intermediate token
  the unwrap chain introduced from the Executor to the liquidator EOA (the full-drain invariant);
- zero/zero bad-debt realization uses no callback and no sweeps.

`@repo/bot-kit`'s shared simulator ([packages/bot-kit/src/simulate.ts](../../packages/bot-kit/src/simulate.ts))
runs `eth_call` from the liquidator EOA against the real Executor calldata. Any revert means the bot
does not broadcast.

### Broadcast And Pending Queue

On simulation success, `@repo/bot-kit`'s shared pending queue
([packages/bot-kit/src/queue/pending-queue.ts](../../packages/bot-kit/src/queue/pending-queue.ts))
sends the transaction through the signer client and tracks it by nonce and by the position's
`(marketId, borrower)` key.

While that position is in flight, later ticks skip it. On each block the queue checks receipts,
logs confirmed or reverted transactions, and fee-bumps stuck transactions until either they confirm,
hit the fee ceiling, or exhaust bump attempts.

A queue answer that broadcast nothing is classified three ways, counted on `tick.end` as
`sendRefused` / `sendReverted` / `sendRejected` (which sum to `notSent`):

- **refused** — the queue declined before reaching the send (aborted-send latch, failed nonce sync,
  nonce hole). Queue-wide, so it is held against no position.
- **execution-reverted** — the node rejected this position's own transaction with an on-chain
  execution revert (`tx.submit_failed`, `executionRevert: true`, plus the 4-byte `selector` when the
  payload carried one). **This does not extend the position's suppression window**, and it also
  exempts the position from an entry a sibling candidate armed, whichever order the two ran in — an
  execution revert, unlike a broadcast, does not stop the next-ranked sibling from being tried.
  Post-maturity the LIF ramps over an hour, so a min-out shortfall says nothing about the next
  attempt; backing off sampled that ramp
  exponentially, which is what turned a maturity into 4–9 minutes per position on 2026-08-28. The
  position is instead retried as fast as the tick can drain, with skipped heights coalesced. An
  opted-in `POSITION_LIQUIDATION_COOLDOWN_MS` window is deliberately left armed: it is a flat
  operator throttle, not a ramp sampler, so lifting it is an operator's call.
- **rejected** — the send machinery failed (nonce, funds, RPC). Nothing was learned about the plan,
  so the position backs off exactly as before.

Because the execution-reverted case carries no throttle at all, an unbroken streak of
execution-reverted sends on one position is tracked and reported as `send.revert_streak` (warn) on the
one send that first takes it past 15 minutes, carrying the revert count, the streak duration, the last
selector, and whether that selector stayed constant across the streak. Only that crossing is logged:
with no throttle on the path, warning on every later revert would ship a line per tick — two, when
both of a position's siblings revert — for as long as it stays stuck. A constant selector over a long
streak points at a structural fault — an expired route deadline, malformed aggregator calldata,
an estimator/provider discrepancy, a gate that keeps closing — rather than an incentive that has yet
to catch up. The threshold is a duration and not an attempt count on purpose: the incentive ramps on
wall clock, so attempts-to-clear is `clearing_time / sweep_period` and shrinks every time the bot
gets faster, which a count threshold would have to be recalibrated against. The streak only reports;
it never suppresses.

`bots/blue-liquidation` deliberately diverges here and keeps backoff on every rejected send,
execution reverts included: its liquidation incentive is static rather than ramping, so a declined
send there really is evidence about the next block.

Queue state is in-memory. On restart, chain truth wins: the bot rediscovers live candidates and the
signer nonce cursor starts from the pending chain nonce. If the initial raw broadcast fails after a
nonce is claimed but before a hash is returned, the signer rolls the cursor back and the queue aborts
that tick instead of counting a hashless transaction as submitted.

### Log Correlation

Every **position-scoped** event carries the position in one field, **`id`**, whose value is
`lensKey(marketId, borrower)`: the two halves joined by `:` with both lowercased. So a maturity's
events group into one row per position with **no normalization in the query** (`GROUP BY id`). `tx.*`
used to name the same string `label`; it does not any more. The full set:

`plan.skipped`, `plan.built`, `preselect.skipped`, `route.unresolved`, `cooldown.skip`,
`config.no_swap_path`, `quote.excluded_collateral`, `quote.unprofitable`, `unwrap.failed`,
`unwrap.resolved`, `unwrap.bad_route`, `unwrap.preview_reverted`, `unwrap.preview_zero`,
`quote.floor_unmet`, `quote.ok`, `quote.failed`, `quote.route_quality_failed`, `probe.error`,
`select.cold_default`, `select.ok`, `simulate.ok`, `simulate.revert`, `send.revert_streak`,
`tx.send_aborted`, `tx.submit_failed`, `tx.sent`, `tx.bumped`, `tx.confirmed`, `tx.reverted`,
`tx.dropped`, `tx.replace_failed`, `tx.onblock_error`, `nonce.sync_failed`, `queue.nonce_hole`.

`plan.built` also keeps `marketId` and `borrower` as human-readable extras. They are for an operator
reading a single line — grouping keys on `id`.

`id` identifies a **position**, and one position yields several candidates (one per activated
collateral slot, and a matured-and-unhealthy slot in both open modes). The per-**candidate** key is
therefore `(id, collateralIndex, postMaturityMode)`, and both discriminators ride on every
per-candidate event, the `@repo/swaps` quote events included. `send.revert_streak` deliberately
carries none: the streak is keyed by position and spans whichever siblings reverted, so attributing it
to one `(slot, mode)` would misreport it.

Everything else is scoped to something other than a position and carries **no** `id`, by design —
don't group it by one:

- **per tick** — `discover.*`, `lens.read`, `probe.warmed`, `tick.end`, `tick.error`, `block.new`
- **per venue pair** — `probe.warm_failed`, `probe.venue_error`, `probe.refreshed` (several positions
  in one market share a probe)
- **queue-wide** — `queue.nonce_hole_cleared`, `queue.maintenance_failed`, `reconcile.failed` (a
  condition that would have refused any position)
- **process / config** — `startup`, `shutdown`, `quoting.*`, `markets.*`, `prices.*`, `discovery.*`,
  `signer.*`, `heartbeat.*`, `runner.*`, `watcher.error`, `pendle.*`

## Important Operational Notes

- The liquidator gate checks the Executor address, not the EOA, because `liquidate` is called by the
  Executor.
- Markets are allowlisted by the `listed=true` whitelist. A non-listed market is skipped rather than
  guessed; a collateral on `EXCLUDE_COLLATERALS` is never seized.
- Aggregator venues (`0x`, `1inch`) add a third-party API dependency on the execution path. Dropping
  Uniswap-direct means at least one venue API key is required to swap-liquidate at all. If a venue is
  down, rate-limited, or returns no route, the bot falls through to the runner-up enabled venue; only
  when every enabled venue fails is the position backed off. `simulate()` still gates every send, so a
  stale probe or wrong venue pick is a missed liquidation, never an unsafe broadcast. API keys come
  from env only and are never logged.
- The bot is not a private-orderflow or MEV protection system. It broadcasts ordinary EOA
  transactions.
- The shared Executor cannot safely custody assets between transactions. Every non-zero execution
  path is built to sweep touched tokens at the end of the same transaction.
- Fully bad-debt realization can socialize protocol losses without direct liquidation profit.
