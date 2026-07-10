# Midnight Liquidation Bot

Off-chain liquidator for Morpho Midnight markets on Base.

The bot watches candidate borrowers, reads their live Midnight state, builds a liquidation plan,
simulates the exact transaction it would send, and only broadcasts when the full Executor path
succeeds.

## Status

This package is operational code, but it is still intentionally narrow:

- Supported chain: Base (`CHAIN_ID=8453`).
- The markets the bot may touch come from the Midnight markets API (`listed=true`) as a **whitelist**:
  only listed markets are discovered, probed, and liquidated (fail-closed). There is no hand-maintained
  collateral list.
- Discovery is backed by the markets liquidation-candidates HTTP API — an over-inclusive candidate
  feed the bot filters to the whitelist and re-reads on-chain before acting.
- Execution tries **all enabled venues and uses the best** (0x / 1inch swap aggregators). Venues are
  enabled by the presence of their API key — there is no per-collateral routing file. The best venue
  per collateral→loan pair and size is picked from a cached, rate-limited, log-scaled indicative probe;
  the position itself is then firm-quoted once against the chosen venue, falling through to the
  runner-up venue on failure (coverage-first). Uniswap-direct is not a candidate here — aggregators
  route through Uniswap pools anyway, and a direct Uniswap route can't be ranked on real output.
- For positions with multiple active collaterals, the current planner evaluates the highest-value
  collateral slot only.

## Prerequisites

- Node.js `24.14.1` (`nvm use` from the repo root).
- Bun `1.3.12`.
- A Base RPC URL.
- A funded liquidator EOA private key.
- A deployed permissionless Executor contract. If `EXECUTOOOR_ADDRESS` is unset, the bot uses the
  deterministic address derived by `@repo/contracts`; startup still requires code to exist there.
- Network access to the markets liquidation-candidates API and the Midnight markets API (both public
  by default; override with `LIQUIDATION_CANDIDATES_API_URL` / `MARKETS_API_URL`).
- At least one venue API key (`ZEROX_API_KEY` and/or `ONEINCH_API_KEY`) to actually swap-liquidate.
  With no key set the bot can only discover positions and realize bad debt, and refuses to start
  unless `ALLOW_BAD_DEBT_ONLY=true` is set.

Never commit `.env` files, private keys, or RPC credentials.

## Configuration

Environment variables:

| Name                                         | Required | Default             | Description                                                                                                                                                                                                                 |
| -------------------------------------------- | -------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHAIN_ID`                                   | yes      | -                   | Must be `8453` for Base.                                                                                                                                                                                                    |
| `RPC_URL`                                    | yes      | -                   | Base RPC used for reads, simulation, and (unless `SEND_RPC_URL` is set) sends.                                                                                                                                              |
| `RPC_URL_FALLBACK`                           | no       | -                   | Optional fallback RPC for the signer's transport.                                                                                                                                                                           |
| `SEND_RPC_URL`                               | no       | `RPC_URL`           | Dedicated broadcast endpoint for `eth_sendRawTransaction` and the signer's nonce/receipt reads. Set this when `RPC_URL` is a read-only relay that acks sends without relaying them to the sequencer (txs would never mine). |
| `LIQUIDATOR_PRIVATE_KEY`                     | yes      | -                   | `0x`-prefixed 32-byte private key for the sender EOA.                                                                                                                                                                       |
| `EXECUTOOOR_ADDRESS`                         | no       | derived             | Override for the shared Executor address.                                                                                                                                                                                   |
| `LIQUIDATION_CANDIDATES_API_URL`             | no       | public              | Liquidation-candidates endpoint polled for borrower discovery. Defaults to the public Morpho markets API; validated as a URL at startup (fail-loud).                                                                        |
| `HEALTH_FACTOR_LTE`                          | no       | `1.02`              | Health-factor cutoff sent to discovery (`health_factor_lte`); matured positions are always included regardless. Floored at `1.0`. Over-inclusive by design — the on-chain lens is the source of truth.                      |
| `MARKETS_API_URL`                            | no       | public              | Midnight markets endpoint used as the market whitelist (`listed=true`). Defaults to the public Morpho markets API; validated as a URL at startup.                                                                           |
| `MARKETS_REFRESH_MS`                         | no       | `60000`             | How often the whitelist is refreshed. The endpoint is Morpho's own (not rate-limited); last-known-good is served on a transient failure.                                                                                    |
| `ZEROX_API_KEY`                              | cond.    | -                   | Enables the `0x` venue when set. Read at point of use; never stored on config or logged.                                                                                                                                    |
| `ONEINCH_API_KEY`                            | cond.    | -                   | Enables the `1inch` venue when set. Read at point of use; never stored on config or logged.                                                                                                                                 |
| `ALLOW_BAD_DEBT_ONLY`                        | no       | `false`             | When no venue API key is set, the bot refuses to start unless this is `true` (then it runs bad-debt-only: discovers positions, realizes bad debt, never swap-liquidates).                                                   |
| `SLIPPAGE_BPS`                               | no       | `100`               | Global max oracle-to-DEX output discount passed to every venue (bakes the on-chain min-out into calldata). Replaces the old per-collateral `slippageBps`.                                                                   |
| `ZEROX_BASE_URL` / `ONEINCH_BASE_URL`        | no       | public              | Optional venue API host overrides.                                                                                                                                                                                          |
| `EXCLUDE_COLLATERALS`                        | no       | -                   | Comma-separated collateral addresses the bot must never seize/hold — skipped (no quote) even in a listed market.                                                                                                            |
| `MAX_FEE_GWEI`                               | no       | `300`               | Hard max fee cap used by the pending transaction queue.                                                                                                                                                                     |
| `LOG_LEVEL`                                  | no       | `info`              | One of `debug`, `info`, `warn`, `error`.                                                                                                                                                                                    |
| `CACHE_DIR`                                  | no       | `.cache`            | Soltag/deployless cache directory.                                                                                                                                                                                          |
| `QUOTE_TIMEOUT_MS`                           | no       | `2500`              | Per-quote HTTP deadline (the firm quote runs inside the per-block tick).                                                                                                                                                    |
| `HTTP_RPS` / `HTTP_BURST`                    | no       | `2` / `5`           | Per-venue token-bucket refill rate and burst for FIRM quotes. The 1inch free tier is 1 RPS — set `HTTP_RPS=1` if you only use 1inch.                                                                                        |
| `PROBE_HTTP_RPS`                             | no       | `1`                 | Per-venue token-bucket rate for BACKGROUND probes, on a separate client so probe bursts never queue ahead of a live firm quote.                                                                                             |
| `PROBE_STALE_MS`                             | no       | `600000`            | Probe-cache TTL per pair. A pair is re-probed only when a liquidatable position touches it after the cache goes stale — no probe traffic on quiet markets.                                                                  |
| `PROBE_LADDER`                               | no       | `0.01,0.1,1,10,100` | Comma-separated log-scaled probe sizes in whole collateral tokens; converted per-collateral to base units. Venue rankings are cached per size bucket.                                                                       |
| `HTTP_MAX_RETRIES`                           | no       | `2`                 | Retries on 429/5xx/network (honoring `Retry-After`) before a quote fails.                                                                                                                                                   |
| `MAX_ROUTE_IMPACT_BPS`                       | no       | `500`               | Reject a venue's quoted output more than this far below the oracle reference (route-quality guard).                                                                                                                         |
| `SEIZE_CAP_MARGIN_BPS`                       | no       | `30`                | Headroom shaved off the on-chain repay cap when sizing a cap-binding seize, so a one-block oracle move can't trip the contract's RCF/debt check. `0` sizes right at the cap.                                                |
| `BACKOFF_BASE_BLOCKS` / `BACKOFF_MAX_BLOCKS` | no       | `2` / `64`          | Exponential per-position cooldown (in blocks) after a failed quote/simulate, bounding API + RPC usage under a backlog.                                                                                                      |

The bot **refuses to start** if no venue API key is present, unless `ALLOW_BAD_DEBT_ONLY=true` — a
rotated or forgotten key must not silently disable liquidations.

Example local `.env` shape:

```sh
CHAIN_ID=8453
RPC_URL=https://base-mainnet.example
RPC_URL_FALLBACK=https://base-mainnet-fallback.example
LIQUIDATOR_PRIVATE_KEY=0x...
ZEROX_API_KEY=...
ONEINCH_API_KEY=...
MAX_FEE_GWEI=300
LOG_LEVEL=info
```

### Markets, venues, and probing

There is no swap config file. Instead:

- **Which markets** the bot touches comes from the Midnight markets API (`MARKETS_API_URL`) with
  `listed=true`: it is a hard **whitelist** — a market not in the listed set is never discovered,
  probed, or liquidated (fail-closed). This shapes only what the bot acts on; the on-chain lens remains
  the correctness boundary, and a delisted-but-underwater position simply falls out of scope.
- **Which venue** clears a given liquidation is chosen automatically. Both aggregators are enabled by
  the mere presence of their API key. For each collateral→loan pair, a background job requests
  indicative quotes from every enabled venue at the `PROBE_LADDER` sizes and caches a best-first
  ranking per size bucket. This probe is **gated** to pairs that have a liquidatable position and
  cached for `PROBE_STALE_MS`, and runs on its own `PROBE_HTTP_RPS` budget — so venues' tight rate
  limits (~1 req/sec) are respected and quiet markets cost nothing.
- **When a position is liquidatable**, the bot firm-quotes once against the pre-chosen best venue,
  applies the `MAX_ROUTE_IMPACT_BPS` oracle route-quality guard, and falls through to the runner-up
  venue only on failure — never fanning out firm quotes across venues at once. A pair not yet probed
  (e.g. newly listed) falls back to a deterministic default venue for that one quote.

`SLIPPAGE_BPS` is the global max oracle-to-DEX output discount passed to every venue (which bakes the
on-chain min-out into its calldata); the bot additionally rejects any quoted route more than
`MAX_ROUTE_IMPACT_BPS` below the oracle reference. API keys come from `ZEROX_API_KEY` /
`ONEINCH_API_KEY` and are never logged.

## Running Locally

Install dependencies from the repo root:

```sh
nvm use
bun install
```

Discovery hits the public liquidation-candidates API by default, so no local indexer or database is
needed. Start the bot:

```sh
set -a
source packages/midnight-liquidation/.env
set +a
bun run --filter @repo/cli start midnight tick    # one tick; loop/cron for persistence
```

(Or put config under `~/.morpho-bots` — `morpho-bots init` scaffolds it — instead of env vars.)

Useful validation commands while developing:

```sh
bun run --filter @repo/midnight-liquidation typecheck
bun test packages/midnight-liquidation/test
```

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

Run from `packages/midnight-liquidation`:

```sh
RPC_URL=https://base-mainnet.example \
PRIVATE_KEY_LENDER=0x... \
PRIVATE_KEY_BORROWER=0x... \
bun run seed:positions \
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

| Option               | Default     | Description                                                               |
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

[docker-compose.midnight.yml](../../docker-compose.midnight.yml) defines a single `bot` service
(discovery is the remote API, so there is no database or indexer). It builds the `uis/cli` image,
whose entrypoint loops `morpho-bots midnight tick`.

From the repo root:

```sh
export RPC_URL=https://base-mainnet.example
export LIQUIDATOR_PRIVATE_KEY=0x...
export ZEROX_API_KEY=...   # and/or ONEINCH_API_KEY
docker compose -f docker-compose.midnight.yml up --build
```

Optional variables:

```sh
export EXECUTOOOR_ADDRESS=0x...
export LOG_LEVEL=debug
```

## Deploying to Railway

The bot runs as a single service on the Railway project `bot.liquidation.midnight` (discovery is the
remote API — no Postgres or indexer service). [scripts/deploy-railway.ts](./scripts/deploy-railway.ts)
provisions and deploys it idempotently from the [Railway CLI](https://docs.railway.com/guides/cli), so
it runs the same locally or in CI.

The [Dockerfile](./Dockerfile) is a single-stage bun image; `RAILWAY_DOCKERFILE_PATH` points Railway at
it and `railway up` runs from the repo root so the bun workspace resolves.

Authenticate the CLI first — set `RAILWAY_TOKEN` (a project token scoped to the target project /
environment, recommended for CI) or run `railway login`. The script bakes in no project identifier, so
set `RAILWAY_PROJECT_ID` to the project you're deploying to, then provide the secrets via the
environment and run the script:

```sh
export RAILWAY_PROJECT_ID=...   # required: the Railway project to deploy to
export RPC_URL=https://base-mainnet.example
export LIQUIDATOR_PRIVATE_KEY=0x...
# Optional: RAILWAY_ENVIRONMENT (defaults to production).
bun run --filter @repo/cli deploy:railway:midnight
```

Secrets are read from the script's environment, piped to Railway via stdin (never argv), and never
logged. The script fails loud if `RPC_URL` or `LIQUIDATOR_PRIVATE_KEY` is missing.

### Venue API keys (manual step)

There is no swap config file to upload anymore — venues are enabled purely by the presence of their
API key. Set `ZEROX_API_KEY` and/or `ONEINCH_API_KEY` in the Railway service environment (the deploy
script pushes `RPC_URL` + `LIQUIDATOR_PRIVATE_KEY` only, so add the venue keys yourself). With no key
set, the service will refuse to start unless `ALLOW_BAD_DEBT_ONLY=true`.

## How It Works

### Startup

[src/index.ts](./src/index.ts)'s `tickOnce` loads config, creates two viem clients, and runs one tick
(the `morpho-bots` CLI drives it in a loop).
The read client wraps the RPC transport with `deployless` support so the bot can execute its Solidity
lens via `eth_call`. The signer client is plain HTTP and owns transaction submission with a local
pending-nonce cursor.

Startup fails loudly if required env vars are missing, the chain is unsupported, no venue API key is
set without `ALLOW_BAD_DEBT_ONLY=true`, or the configured Executor address has no bytecode.

### Trigger

[src/runner/runner.ts](./src/runner/runner.ts) polls the latest block. On each new block it runs one
tick. If blocks arrive while a tick is still running, the watcher coalesces work rather than running
overlapping ticks.

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

### State Lens

[src/state/lens.sol.ts](./src/state/lens.sol.ts) defines a deployless Solidity lens. For each
candidate, it:

- loads the canonical `Market` from Midnight with `toMarket(id)`;
- reads debt, collateral bitmap, liquidation lock status, and liquidator gate status;
- computes `maxDebt`, `badDebt`, and health with the same oracle and rounding directions used by
  Midnight's `liquidate`;
- selects the highest-value activated collateral slot;
- returns the full market and flat sizing inputs to TypeScript.

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
  the lens computes it on-chain and returns it as `bestCollateralMaxLif`.
- Post-maturity positions use post-maturity mode, where LIF ramps from `1e18` to `maxLif` over 60
  minutes and the RCF cap is disabled.
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
output into a quote request and hands it to `@repo/swaps`' multi-venue quoting. Venue selection is
driven by a cached, rate-limited probe rather than a per-collateral config file:

- A background probe (the `@repo/swaps` venue selector) requests **indicative** quotes from every
  enabled venue (`0x`, `1inch`) at the `PROBE_LADDER` sizes for each collateral→loan pair, and caches a
  best-first ranking per size bucket. It is gated to pairs that have a liquidatable position, cached
  for `PROBE_STALE_MS`, and runs on a separate `PROBE_HTTP_RPS` client so it can never delay a live
  firm quote — respecting venues' ~1 req/sec limits and spending nothing on quiet markets.
- When a position is liquidatable, the bot firm-quotes **once** against the top-ranked venue for that
  pair+size (a single rate-limited API call returning route-bound calldata, taker/recipient = the
  Executor), applies the oracle route-quality guard, and falls through to the runner-up venue only on
  failure (`select.ok` / `quote.route_quality_failed`). A not-yet-probed pair uses a deterministic
  default venue for that one quote (`select.cold_default`). Firm quotes are spent only on liquidatable
  positions, never the full candidate set.

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
positions fail (the rate-limit defense). A successful submit clears the backoff.

If no venue is enabled (bad-debt-only mode) or the collateral is on `EXCLUDE_COLLATERALS`, the tick
logs `config.no_swap_path` and skips the candidate (no API call, no backoff). Pure bad-debt
realization skips quoting entirely.

### Simulation

[src/execution/encode-call.ts](./src/execution/encode-call.ts) builds the exact calldata sent to the
Executor:

- normal liquidations call `Midnight.liquidate` with `receiver = callback = Executor`;
- the Executor fallback runs a callback queue that approves the collateral, swaps all seized
  collateral to the loan token, approves Midnight to pull repayment, and returns Midnight's callback
  success magic value;
- after `liquidate` returns, trailing sweeps send any loan or collateral token balance from the
  Executor to the liquidator EOA;
- zero/zero bad-debt realization uses no callback and no sweeps.

[src/execution/simulate.ts](./src/execution/simulate.ts) runs `eth_call` from the liquidator EOA
against the real Executor calldata. Any revert means the bot does not broadcast.

### Broadcast And Pending Queue

On simulation success, [src/queue/pending-queue.ts](./src/queue/pending-queue.ts) sends the
transaction through the signer client and tracks it by nonce and `(marketId, borrower)` label.

While a label is pending, later ticks skip that position. On each block the queue checks receipts,
logs confirmed or reverted transactions, and fee-bumps stuck transactions until either they confirm,
hit the fee ceiling, or exhaust bump attempts.

Queue state is in-memory. On restart, chain truth wins: the bot rediscovers live candidates and the
signer nonce cursor starts from the pending chain nonce. If the initial raw broadcast fails after a
nonce is claimed but before a hash is returned, the signer rolls the cursor back and the queue aborts
that tick instead of counting a hashless transaction as submitted.

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
