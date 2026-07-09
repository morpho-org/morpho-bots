# Midnight Liquidation Bot

Off-chain liquidator for Morpho Midnight markets on Base.

The bot watches candidate borrowers, reads their live Midnight state, builds a liquidation plan,
simulates the exact transaction it would send, and only broadcasts when the full Executor path
succeeds.

## Status

This package is operational code, but it is still intentionally narrow:

- Supported chain: Base (`CHAIN_ID=8453`).
- Discovery is backed by the markets liquidation-candidates HTTP API — an over-inclusive candidate
  feed the bot re-reads on-chain before acting.
- Execution routes the seized collateral through a per-collateral venue: direct single-hop Uniswap V3
  `exactInputSingle`, or the 0x / 1inch swap aggregators (one executable quote per liquidatable
  position). Venue is chosen per collateral in the swap config; a missing `venue` defaults to
  `uniswap-v3`.
- For positions with multiple active collaterals, the current planner evaluates the highest-value
  collateral slot only.

## Prerequisites

- Node.js `24.14.1` (`nvm use` from the repo root).
- Bun `1.3.12`.
- A Base RPC URL.
- A funded liquidator EOA private key.
- A deployed permissionless Executor contract. If `EXECUTOOOR_ADDRESS` is unset, the bot uses the
  deterministic address derived by `@repo/contracts`; startup still requires code to exist there.
- Network access to the markets liquidation-candidates API (public by default; override with
  `LIQUIDATION_CANDIDATES_API_URL`).
- A swap config JSON file for the collateral tokens the bot is allowed to liquidate.

Never commit `.env` files, private keys, RPC credentials, or swap config containing sensitive
operator data.

## Configuration

Environment variables:

| Name                                         | Required | Default    | Description                                                                                                                                                                                                                  |
| -------------------------------------------- | -------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHAIN_ID`                                   | yes      | -          | Must be `8453` for Base.                                                                                                                                                                                                     |
| `RPC_URL`                                    | yes      | -          | Base RPC used for reads, simulation, and (unless `SEND_RPC_URL` is set) sends.                                                                                                                                               |
| `RPC_URL_FALLBACK`                           | no       | -          | Optional fallback RPC for the signer's transport.                                                                                                                                                                            |
| `SEND_RPC_URL`                               | no       | `RPC_URL`  | Dedicated broadcast endpoint for `eth_sendRawTransaction` and the signer's nonce/receipt reads. Set this when `RPC_URL` is a read-only relay that acks sends without relaying them to the sequencer (txs would never mine).  |
| `LIQUIDATOR_PRIVATE_KEY`                     | yes      | -          | `0x`-prefixed 32-byte private key for the sender EOA.                                                                                                                                                                        |
| `EXECUTOOOR_ADDRESS`                         | no       | derived    | Override for the shared Executor address.                                                                                                                                                                                    |
| `LIQUIDATION_CANDIDATES_API_URL`             | no       | public     | Liquidation-candidates endpoint polled for borrower discovery. Defaults to the public Morpho markets API; validated as a URL at startup (fail-loud).                                                                         |
| `HEALTH_FACTOR_LTE`                          | no       | `1.02`     | Health-factor cutoff sent to discovery (`health_factor_lte`); matured positions are always included regardless. Floored at `1.0`. Over-inclusive by design — the on-chain lens is the source of truth.                       |
| `SWAP_CONFIG_PATH`                           | no       | -          | Path to per-chain, per-collateral swap config JSON. If unset or the file is absent, the bot runs with no routes (identifies borrowers, realizes bad debt, skips routed liquidations). A present-but-malformed file is fatal. |
| `MAX_FEE_GWEI`                               | no       | `300`      | Hard max fee cap used by the pending transaction queue.                                                                                                                                                                      |
| `LOG_LEVEL`                                  | no       | `info`     | One of `debug`, `info`, `warn`, `error`.                                                                                                                                                                                     |
| `CACHE_DIR`                                  | no       | `.cache`   | Soltag/deployless cache directory.                                                                                                                                                                                           |
| `ZEROX_API_KEY`                              | cond.    | -          | Required if any collateral uses the `0x` venue. Read at point of use; never stored on config or logged.                                                                                                                      |
| `ONEINCH_API_KEY`                            | cond.    | -          | Required if any collateral uses the `1inch` venue. Read at point of use; never stored on config or logged.                                                                                                                   |
| `QUOTE_TIMEOUT_MS`                           | no       | `2500`     | Per-quote HTTP deadline (the quote runs inside the per-block tick).                                                                                                                                                          |
| `HTTP_RPS` / `HTTP_BURST`                    | no       | `2` / `5`  | Per-venue token-bucket refill rate and burst. The 1inch free tier is 1 RPS — set `HTTP_RPS=1` if you only use 1inch.                                                                                                         |
| `HTTP_MAX_RETRIES`                           | no       | `2`        | Retries on 429/5xx/network (honoring `Retry-After`) before a quote fails.                                                                                                                                                    |
| `MAX_ROUTE_IMPACT_BPS`                       | no       | `500`      | Reject an aggregator route whose quoted output is more than this far below the oracle reference (route-quality guard).                                                                                                       |
| `SEIZE_CAP_MARGIN_BPS`                       | no       | `30`       | Headroom shaved off the on-chain repay cap when sizing a cap-binding seize, so a one-block oracle move can't trip the contract's RCF/debt check. `0` sizes right at the cap.                                                 |
| `BACKOFF_BASE_BLOCKS` / `BACKOFF_MAX_BLOCKS` | no       | `2` / `64` | Exponential per-position cooldown (in blocks) after a failed quote/simulate, bounding API + RPC usage under a backlog.                                                                                                       |

The bot **refuses to start** if a collateral references a venue whose API key env var is unset
(fail-loud). Uniswap-direct needs no key, so a key-free deployment still boots.

Example local `.env` shape:

```sh
CHAIN_ID=8453
RPC_URL=https://base-mainnet.example
RPC_URL_FALLBACK=https://base-mainnet-fallback.example
LIQUIDATOR_PRIVATE_KEY=0x...
SWAP_CONFIG_PATH=./bots/midnight-liquidation/swap.config.json
MAX_FEE_GWEI=300
LOG_LEVEL=info
```

Example `swap.config.json`:

```json
{
  "8453": {
    "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf": {
      "venue": "uniswap-v3",
      "router": "0x2626664c2603336E57B271c5C0b26F421741e481",
      "fee": 100,
      "slippageBps": 50
    },
    "0x4200000000000000000000000000000000000006": { "venue": "0x", "slippageBps": 100 },
    "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452": { "venue": "1inch", "slippageBps": 100 }
  }
}
```

Keys under `8453` are collateral token addresses; each value selects a venue:

- `uniswap-v3` — direct single-hop. `router` must be a `SwapRouter02`-compatible router and `fee` is
  the Uniswap V3 pool fee tier. (Omitting `venue` defaults to `uniswap-v3` for backward compatibility.)
- `0x` / `1inch` — swap aggregators. No `router`/`fee`; the executable route comes from the venue API
  (the API key is supplied via env, never here). Optional `baseUrl` overrides the API host.

`slippageBps` is the maximum oracle-to-DEX output discount the bot tolerates. For aggregators it is
passed to the venue (which bakes the on-chain min-out into its calldata); the bot additionally rejects
any quoted route more than `MAX_ROUTE_IMPACT_BPS` below the oracle reference. Note 1inch caps its
`slippage` at 50% — a `1inch` collateral with `slippageBps > 5000` will have its quotes rejected by
the API (treated as a no-route failure, then backed off). **API keys must never appear in this file**
— they come from `ZEROX_API_KEY` / `ONEINCH_API_KEY`.

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
source bots/midnight-liquidation/.env
set +a
bun run --filter @morpho-org/midnight-liquidation start
```

Useful validation commands while developing:

```sh
bun run --filter @morpho-org/midnight-liquidation typecheck
bun test bots/midnight-liquidation/test
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

Run from `bots/midnight-liquidation`:

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

[docker-compose.yml](./docker-compose.yml) defines a single `bot` service (discovery is the remote
API, so there is no database or indexer). It builds from the repo root so workspace packages resolve
correctly.

From `bots/midnight-liquidation`:

```sh
export RPC_URL=https://base-mainnet.example
export LIQUIDATOR_PRIVATE_KEY=0x...
export SWAP_CONFIG_PATH=/absolute/path/to/swap.config.json
docker compose up --build
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
bun run --filter @morpho-org/midnight-liquidation deploy:railway
```

Secrets are read from the script's environment, piped to Railway via stdin (never argv), and never
logged. The script fails loud if `RPC_URL` or `LIQUIDATOR_PRIVATE_KEY` is missing.

### Swap config (manual step)

There is no host bind mount on Railway, so the bot's swap config lives on a volume mounted at
`/config`, with `SWAP_CONFIG_PATH=/config/swap.json`. The deploy script creates and attaches the
volume but does **not** upload the file. The bot boots without it — with no routes it still identifies
liquidatable borrowers and realizes bad debt, but skips routed liquidations — so there is no
first-deploy crash to work around. Upload `swap.json` (same shape as the example above) to enable
routed liquidations.

A Railway volume mounts only into a **running** container, and `volume files` transfers tunnel through
it, so upload once the bot is up. The command prompts you to pick the volume interactively, or pass
`--volume <name>` (before the subcommand; find the name via `railway volume list`):

```sh
railway volume files upload ./swap.config.json /config/swap.json --overwrite
```

The bot reads the file at startup, so restart/redeploy the bot after uploading to pick up the routes.

## How It Works

### Startup

[src/index.ts](./src/index.ts) loads config, creates two viem clients, and starts the block-poll runner.
The read client wraps the RPC transport with `deployless` support so the bot can execute its Solidity
lens via `eth_call`. The signer client is plain HTTP and owns transaction submission with a local
pending-nonce cursor.

Startup fails loudly if required env vars are missing, the chain is unsupported, the swap config is
malformed, or the configured Executor address has no bytecode.

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

For each liquidatable, non-bad-debt position, [src/quotes/index.ts](./src/quotes/index.ts) resolves
the operator's configured venue for the selected collateral and produces a single venue-agnostic
`Swap` (spender, target, calldata, and how the input amount is bound). It fetches **one** executable
quote per position — quotes are spent only on liquidatable positions, never the full candidate set:

- `uniswap-v3` ([venues/uniswap-v3.ts](./src/quotes/venues/uniswap-v3.ts)) builds `exactInputSingle`
  locally (no API) with the input amount spliced from the Executor's live balance at exec time;
- `0x` / `1inch` ([venues/zerox.ts](./src/quotes/venues/zerox.ts),
  [venues/oneinch.ts](./src/quotes/venues/oneinch.ts)) make one rate-limited API call and return
  route-bound calldata committing a fixed sell amount, with the taker/recipient set to the Executor.

The sell amount is the plan's pinned `seizedAssets`: Midnight transfers exactly that to the Executor
before the callback, so an aggregator's fixed sell amount and a Uniswap balance-splice both act on
exactly the seized balance — no sell-side drift on any venue. The oracle-priced reference output
([src/execution/swap-step.ts](./src/execution/swap-step.ts)) values that same `seizedAssets`. Residual
drift is confined to the on-chain repay-cap check re-derived at the exec-block oracle price; it fails
closed in `simulate()` — a missed liquidation, never a loss — and the `SEIZE_CAP_MARGIN_BPS` headroom
keeps ordinary one-block moves from tripping it.

The bot computes the oracle-priced reference output for free (no extra API call) and rejects any
aggregator route more than `MAX_ROUTE_IMPACT_BPS` below it (`quote.bad_route`). Quote failures (no
route, timeout, rate-limited, API error) log `quote.failed` and back the position off
([src/queue/backoff.ts](./src/queue/backoff.ts)) — an exponential per-position cooldown that bounds
API + RPC usage when many positions fail (the rate-limit defense). A successful submit clears the
backoff.

If no venue is configured for a non-zero liquidation, the tick logs `config.no_swap_path` and skips
the candidate (no backoff). Pure bad-debt realization skips quoting entirely.

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
- Swap routes are allowlisted by config. Missing routes are skipped rather than guessed.
- Aggregator venues (`0x`, `1inch`) add a third-party API dependency on the execution path. If a
  venue is down, rate-limited, or returns no route, that liquidation is skipped (never falls back to
  another venue silently) and the position is backed off; there is no risk of an unsafe broadcast
  because `simulate()` still gates every send. API keys come from env only and are never logged.
- The bot is not a private-orderflow or MEV protection system. It broadcasts ordinary EOA
  transactions.
- The shared Executor cannot safely custody assets between transactions. Every non-zero execution
  path is built to sweep touched tokens at the end of the same transaction.
- Fully bad-debt realization can socialize protocol losses without direct liquidation profit.
