# Midnight Liquidation Bot

Off-chain liquidator for Morpho Midnight markets on Base.

The bot watches candidate borrowers, reads their live Midnight state, builds a liquidation plan,
simulates the exact transaction it would send, and only broadcasts when the full Executor path
succeeds.

## Status

This package is operational code, but it is still intentionally narrow:

- Supported chain: Base (`CHAIN_ID=8453`).
- Discovery is backed by a co-located rindexer/Postgres instance indexing Midnight `Take` events.
- Execution supports single-hop Uniswap V3 `exactInputSingle` routes declared per collateral token.
- For positions with multiple active collaterals, the current planner evaluates the highest-value
  collateral slot only.

## Prerequisites

- Node.js `24.14.1` (`nvm use` from the repo root).
- Bun `1.3.12`.
- A Base RPC URL.
- A funded liquidator EOA private key.
- A deployed permissionless Executor contract. If `EXECUTOOOR_ADDRESS` is unset, the bot uses the
  deterministic address derived by `@repo/contracts`; startup still requires code to exist there.
- A Postgres database populated by rindexer.
- A swap config JSON file for the collateral tokens the bot is allowed to liquidate.

Never commit `.env` files, private keys, RPC credentials, or swap config containing sensitive
operator data.

## Configuration

Environment variables:

| Name                     | Required | Default  | Description                                                                                                                                                                                                                  |
| ------------------------ | -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHAIN_ID`               | yes      | -        | Must be `8453` for Base.                                                                                                                                                                                                     |
| `RPC_URL`                | yes      | -        | Base RPC used for reads, simulation, and sends.                                                                                                                                                                              |
| `RPC_URL_FALLBACK`       | no       | -        | Optional fallback RPC.                                                                                                                                                                                                       |
| `LIQUIDATOR_PRIVATE_KEY` | yes      | -        | `0x`-prefixed 32-byte private key for the sender EOA.                                                                                                                                                                        |
| `EXECUTOOOR_ADDRESS`     | no       | derived  | Override for the shared Executor address.                                                                                                                                                                                    |
| `DATABASE_URL`           | yes      | -        | Postgres URL for rindexer's indexed Midnight event tables.                                                                                                                                                                   |
| `SWAP_CONFIG_PATH`       | no       | -        | Path to per-chain, per-collateral swap config JSON. If unset or the file is absent, the bot runs with no routes (identifies borrowers, realizes bad debt, skips routed liquidations). A present-but-malformed file is fatal. |
| `MAX_FEE_GWEI`           | no       | `300`    | Hard max fee cap used by the pending transaction queue.                                                                                                                                                                      |
| `LOG_LEVEL`              | no       | `info`   | One of `debug`, `info`, `warn`, `error`.                                                                                                                                                                                     |
| `CACHE_DIR`              | no       | `.cache` | Soltag/deployless cache directory.                                                                                                                                                                                           |

Example local `.env` shape:

```sh
CHAIN_ID=8453
RPC_URL=https://base-mainnet.example
RPC_URL_FALLBACK=https://base-mainnet-fallback.example
LIQUIDATOR_PRIVATE_KEY=0x...
DATABASE_URL=postgresql://rindexer:rindexer@localhost:5432/midnight_liquidation
SWAP_CONFIG_PATH=./bots/midnight-liquidation/swap.config.json
MAX_FEE_GWEI=300
LOG_LEVEL=info
```

Example `swap.config.json`:

```json
{
  "8453": {
    "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf": {
      "router": "0x2626664c2603336E57B271c5C0b26F421741e481",
      "fee": 100,
      "slippageBps": 50
    }
  }
}
```

Keys under `8453` are collateral token addresses. `router` must be a `SwapRouter02`-compatible
router, `fee` is the Uniswap V3 pool fee tier, and `slippageBps` is the maximum oracle-to-DEX output
discount admitted by the bot.

## Running Locally

Install dependencies from the repo root:

```sh
nvm use
bun install
```

Start Postgres and rindexer so `DATABASE_URL` points at a database with the
`midnight_liquidation_midnight.take` table populated. The rindexer project config is
[rindexer.yaml](./rindexer.yaml).

Then start the bot:

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

## Running With Docker Compose

[docker-compose.yml](./docker-compose.yml) defines Postgres, rindexer, and the bot. It builds from
the repo root so workspace packages resolve correctly.

From `bots/midnight-liquidation`:

```sh
export RPC_URL=https://base-mainnet.example
export LIQUIDATOR_PRIVATE_KEY=0x...
export SWAP_CONFIG_PATH=/absolute/path/to/swap.config.json
docker compose up --build
```

Optional variables:

```sh
export POSTGRES_PASSWORD=...
export EXECUTOOOR_ADDRESS=0x...
export LOG_LEVEL=debug
```

The compose file currently carries an implementation note that the rindexer service wiring should be
verified end-to-end against a live RPC before relying on it in production.

## Deploying to Railway

The same three components run on the Railway project `bot.liquidation.midnight` (managed Postgres + a
`rindexer` service + the `bot` daemon). [scripts/deploy-railway.ts](./scripts/deploy-railway.ts)
provisions and deploys all three idempotently from the [Railway CLI](https://docs.railway.com/guides/cli),
so it runs the same locally or in CI.

One shared multi-stage [Dockerfile](./Dockerfile) serves both runtimes. Railway always builds the
Dockerfile's final stage and cannot pass `docker build --target`, so a global `ARG BUILD_TARGET` plus a
trailing `FROM ${BUILD_TARGET} AS final` stage lets a per-service `BUILD_TARGET` variable select the
`bot` or `rindexer` stage. `RAILWAY_DOCKERFILE_PATH` points at this Dockerfile and `railway up` runs
from the repo root so the bun workspace resolves.

Authenticate the CLI first — set `RAILWAY_TOKEN` (a project token scoped to the target project /
environment, recommended for CI) or run `railway login`. The script bakes in no project identifier, so
set `RAILWAY_PROJECT_ID` to the project you're deploying to, then provide the secrets via the
environment and run the script:

```sh
export RAILWAY_PROJECT_ID=...   # required: the Railway project to deploy to
export RPC_URL=https://base-mainnet.example
export LIQUIDATOR_PRIVATE_KEY=0x...
# Optional: RINDEXER_RPC_URL (defaults to RPC_URL), RAILWAY_ENVIRONMENT (defaults to production).
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

[src/index.ts](./src/index.ts) loads config, creates two viem clients, and starts the block daemon.
The read client wraps the RPC transport with `deployless` support so the bot can execute its Solidity
lens via `eth_call`. The signer client is plain HTTP and owns nonce-managed transaction submission.

Startup fails loudly if required env vars are missing, the chain is unsupported, the swap config is
malformed, or the configured Executor address has no bytecode.

### Trigger

comment: better name than daemon
[src/daemon/daemon.ts](./src/daemon/daemon.ts) polls the latest block. On each new block it runs one
tick. If blocks arrive while a tick is still running, the watcher coalesces work rather than running
overlapping ticks.

### Discovery

[src/discovery/borrowers.ts](./src/discovery/borrowers.ts) reads candidate `(marketId, borrower)`
pairs from rindexer's Postgres tables. The current query unions the indexed `taker` and `maker`
addresses from Midnight `Take` events. That intentionally over-includes; the on-chain lens filters
out addresses with no debt or non-liquidatable state.

The tick also reads rindexer's indexed head and logs `rindexer.lag`. Lag is observability-only:
rindexer lag can delay candidate coverage, but the bot always reads candidate state fresh on-chain
before planning.

### State Lens

note the caveat for scalability and ideas to fix (TIB)

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

[src/daemon/eligibility.ts](./src/daemon/eligibility.ts) mirrors Midnight's liquidation gate:

```text
valid && gateAllows && hasDebt && !locked && (block.timestamp > maturity || !healthy)
```

[src/sizing/plan.ts](./src/sizing/plan.ts) turns a lens result into a `LiquidationPlan`:

- Pre-maturity unhealthy positions use normal mode with `maxLif` and the Recovery Close Factor cap.
- Post-maturity positions use post-maturity mode, where LIF ramps from `1e18` to `maxLif` over 15
  minutes and the RCF cap is disabled.
- If seizing the whole selected slot would over-repay, the bot passes `repaidUnits` and lets Midnight
  derive `seizedAssets`.
- If the position is fully bad debt, the bot emits a zero/zero plan so Midnight can realize the bad
  debt without moving tokens.

All fixed-point math is integer `bigint` math and mirrors the contract's floor/ceil directions.

### Swap Step

ask for review of executooor

[src/execution/swap-step.ts](./src/execution/swap-step.ts) resolves the operator-declared route for
the selected collateral and computes `amountOutMinimum`.

For `repaidUnits` plans, the bot first mirrors Midnight's rounded on-chain `seizedAssets` derivation
and then values that rounded collateral amount. This avoids asking Uniswap for more loan token than
the contract will actually seize.

If no swap config exists for a non-zero liquidation, the tick logs `config.no_swap_path` and skips
the candidate. Pure bad-debt realization skips swap config entirely.

only Uniswap for now, follow-up with additional liquidity venues

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
signer nonce manager starts from the pending chain nonce.

## Important Operational Notes

- The liquidator gate checks the Executor address, not the EOA, because `liquidate` is called by the
  Executor.
- Swap routes are allowlisted by config. Missing routes are skipped rather than guessed.
- The bot is not a private-orderflow or MEV protection system. It broadcasts ordinary EOA
  transactions.
- The shared Executor cannot safely custody assets between transactions. Every non-zero execution
  path is built to sweep touched tokens at the end of the same transaction.
- Fully bad-debt realization can socialize protocol losses without direct liquidation profit.

observability deferred to v1
