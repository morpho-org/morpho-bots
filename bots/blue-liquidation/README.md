# Blue Liquidation Bot

A non-competitive, ecosystem-backstop liquidator for **Morpho Blue** on Base and Robinhood. It
watches indexed borrowers, reads fresh accrued state, sizes seize-exact liquidations, simulates the
final Executor call, and broadcasts only simulation-ok plans.

Design: [TIB-2026-06-30-blue-liquidation-bot](../../docs/decisions/TIB-2026-06-30-blue-liquidation-bot.md).

## Status

v0. Unit-tested across the core modules. The production read path (lens compile → deployless deploy →
IRM accrual sim → oracle → health → decode) is **validated against 256 live Base positions** via
`probe:lens`, and the lens gas model is **measured** (see `state/lens.sol.ts`). The end-to-end
_liquidate-broadcast_ fork suite is written but **fixture-gated** — it needs a live-unhealthy Base
position (none exist while the market is healthy), `RPC_URL_8453`, and
`BLUE_LIQUIDATION_FORK_FIXTURE` (see [Testing](#testing)). The rindexer `borrow` table columns are
confirmed at boot by the `discovery.schema` startup log.

## Prerequisites

- **bun** `1.3.12`, **Node** `24.14.1` (`.nvmrc`).
- A chain RPC that both reads and _relays_ transactions — **not** `rpc.morpho.dev/realtime`, which
  acknowledges sends but never broadcasts them.
- A **funded EOA** (native gas) — the liquidator and the recipient of both end-of-exec token sweeps.
- The generic **Executor** singleton deployed on each chain the bot runs on
  (`bun run --filter @repo/contracts deploy:executor`). The bot derives its CREATE2 address and
  refuses to start if it holds no code.
- **Postgres** + a **rindexer** instance for borrower discovery (bundled in `docker-compose.yml`).
- Optional: **0x** / **1inch** API keys, only if a collateral routes through them (**LiFi** and
  **LiquidSwap** venues route keyless; a `LIFI_API_KEY` only raises LiFi's rate limits).

## Configuration

Env vars (fail-loud on a missing required var, an unknown chain, or a malformed value):

| Var                                                                 | Required | Default          | Purpose                                                                                                                               |
| ------------------------------------------------------------------- | -------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `CHAIN_ID`                                                          | yes      | —                | Must be in the chain map (`8453`, `4663`)                                                                                             |
| `RPC_URL`                                                           | yes      | —                | Primary RPC (reads, simulation, sends)                                                                                                |
| `RPC_URL_FALLBACK`                                                  | no       | —                | Optional viem-dlc `failover` endpoint                                                                                                 |
| `LIQUIDATOR_PRIVATE_KEY`                                            | yes      | —                | EOA hex key (`0x` + 32-byte hex)                                                                                                      |
| `EXECUTOOOR_ADDRESS`                                                | no       | derived          | Override; default is the derived CREATE2 address                                                                                      |
| `DATABASE_URL`                                                      | yes      | —                | Postgres for the co-located rindexer (discovery)                                                                                      |
| `SWAP_CONFIG_PATH`                                                  | no       | —                | Per-collateral, per-venue swap params JSON                                                                                            |
| `MAX_FEE_GWEI`                                                      | no       | `300`            | Hard ceiling for fee bumps                                                                                                            |
| `ZEROX_API_KEY` / `ONEINCH_API_KEY`                                 | cond.    | —                | Required iff a collateral uses that venue                                                                                             |
| `LIFI_API_KEY`                                                      | no       | —                | Optional; LiFi routes keyless, a key only raises its rate limits                                                                      |
| `MAX_ROUTE_IMPACT_BPS`                                              | no       | `500`            | Reject aggregator routes this far below the oracle ref                                                                                |
| `PENDLE_SLIPPAGE_BPS`                                               | no       | `50`             | Slippage for the Pendle PT → underlying unwrap hop (before the downstream venue sells)                                                |
| `QUOTE_TIMEOUT_MS` / `HTTP_RPS` / `HTTP_BURST` / `HTTP_MAX_RETRIES` | no       | see `config.ts`  | Aggregator HTTP tunables                                                                                                              |
| `BACKOFF_BASE_BLOCKS` / `BACKOFF_MAX_BLOCKS`                        | no       | `2` / `64`       | Per-position failure backoff                                                                                                          |
| `POSITION_LIQUIDATION_COOLDOWN_MS`                                  | no       | `0`              | Opt-in per-position cooldown (ms) after a failed attempt; `0` disables (re-attempt every tick)                                        |
| `BOT_STATE_DIR`                                                     | no       | `~/.morpho-bots` | Dir for the persisted pending-tx queue + terminal-outcome journal (per bot + chain); point at a mounted volume to survive restarts    |
| `BETTERSTACK_SOURCE_TOKEN` / `BETTERSTACK_INGESTING_HOST`           | no       | —                | Opt-in log shipping; when both are set the bot's in-process loglayer transport ships structured logs to BetterStack (inert otherwise) |
| `LOG_LEVEL`                                                         | no       | `info`           | `debug` \| `info` \| `warn` \| `error`                                                                                                |

For Compose/Railway, operator-facing RPC env vars are chain-id suffixed: `RPC_URL_8453`,
`RPC_URL_4663`, and optional `RINDEXER_RPC_URL_<chainId>` overrides. Inside each bot container the
runtime env remains unsuffixed (`RPC_URL`) because each service runs exactly one chain.

### Swap config

A JSON file, keyed by chain id then by EIP-55 collateral address, each entry a discriminated union
on `venue` — `uniswap-v3` (direct, keyless), `0x`, `1inch`, `lifi` (keyless), or `liquidswap`
(keyless, HyperEVM). Collateral that wraps an ERC-4626 vault or a Pendle PT is auto-unwrapped before
the venue swap (see [`configs/example.json`](./configs/example.json)):

```jsonc
{
  "8453": {
    "0x4200000000000000000000000000000000000006": { "venue": "uniswap-v3", "router": "0x2626…e481", "fee": 500, "slippageBps": 100 },
    "0xcbB7C0…33Bf":                               { "venue": "0x", "slippageBps": 100 },
    "0xc1CBa3…e452":                               { "venue": "1inch", "slippageBps": 100 }
  }
}
```

**API keys never live in this file** — they come from `ZEROX_API_KEY` / `ONEINCH_API_KEY` at the
point of use. A collateral with no entry is skipped (`config.no_swap_path`), so coverage is bounded to
collaterals the operator has routed. The bot boots without any swap config (it discovers borrowers and
skips every routed liquidation), so a first deploy can host the volume upload before the file exists.

**Keyed by collateral, not by market/pair.** A liquidation only ever swaps in one direction — the
seized **collateral → the market's loan token** — so the routing question is purely "how do I sell
this collateral?", which is a property of the collateral's liquidity, not of the pair. Aggregator
venues (`0x`/`1inch`) route collateral → _any_ loan token, so one entry per collateral covers every
market that uses it. The one caveat is the direct `uniswap-v3` venue: it swaps through a single
`(collateral, fee)` pool, so it assumes a direct collateral→loan pool at that fee exists for every
market using that collateral — if a collateral is borrowed against different loan tokens and lacks a
direct pool for one, route it through an aggregator instead (pair-keyed routing would be the fix if a
direct-DEX-only deployment ever needed it). `simulate()` rejects mis-keyed routes before broadcast.
`configs/example.json` covers the top live Base collaterals (by active positions): cbBTC
(`0xcbB7C0…33Bf`), WETH (`0x4200…0006`), cbXRP (`0xcb5852…a4af`), SOL (`0x311935…9cf82`), cbETH
(`0x2Ae3F1…Dec22`), cbDOGE (`0xcbD06E…eb510`), cbADA (`0xcbADA7…7b8c`), JitoSOL (`0x97bE14…C34de`),
wstETH (`0xc1CBa3…e452`), AERO (`0x940181…D98631`) — edit to taste (the file is illustrative; verify
pools/fees and set the API keys for any aggregator venue you use).

## Running Locally

```sh
export CHAIN_ID=8453 RPC_URL=https://… LIQUIDATOR_PRIVATE_KEY=0x… \
  DATABASE_URL=postgres://… SWAP_CONFIG_PATH=./configs/example.json
bun run --filter @morpho-org/blue-liquidation start
```

`prestart` builds the workspace packages (soltag-compiles `@repo/contracts` and materializes the ABI).
Discovery needs a running, indexed rindexer against the same `DATABASE_URL` — the easiest path is
Docker Compose below.

## Running With Docker Compose

```sh
cd bots/blue-liquidation
RPC_URL_8453=https://… LIQUIDATOR_PRIVATE_KEY=0x… docker compose up --build
```

Brings up Postgres, one shared rindexer (indexing `Borrow` on Base and Robinhood), and one bot per
chain against the same `DATABASE_URL`. `RPC_URL_4663` is optional locally because Compose defaults
Robinhood to its public RPC. The build context is the repo root so the bun workspace resolves. The
rindexer image bakes in the generated `Morpho.json` ABI, so it is not committed.

## Deploying to Railway

```sh
RAILWAY_PROJECT_ID=… RPC_URL_8453=https://… RPC_URL_4663=https://… LIQUIDATOR_PRIVATE_KEY=0x… \
  bun run --filter @morpho-org/blue-liquidation deploy:railway
# Optional: RINDEXER_RPC_URL_<chainId> (defaults to RPC_URL_<chainId>),
# ZEROX_API_KEY[_<chainId>] / ONEINCH_API_KEY[_<chainId>],
# RAILWAY_ENVIRONMENT (defaults to production).
```

Idempotent: provisions managed Postgres + one shared `rindexer` service + per-chain `bot-<chainId>`
runners, reusing existing services/vars. Secrets are piped via stdin (never argv, never logged).
After `bot-8453` is confirmed healthy, the script attempts to remove the legacy single-chain `bot`
service to avoid running two Base liquidators.

Set `DEPLOY_ONLY=1` (or `true`) to re-ship the **already-provisioned** services from the current
working tree without setting any secrets or variables — the mode the deploy CI uses (it holds no
RPC/keys). A full first-time provision needs `RPC_URL_<chainId>` + `LIQUIDATOR_PRIVATE_KEY`;
`DEPLOY_ONLY` needs neither.

### Swap config (manual step)

Each chain bot has its own `/config` Railway volume. Upload swap config out-of-band once the target
bot is up:

```sh
railway volume files upload ./swap.config.json /config/swap.json --overwrite
```

Select the target bot service/volume when prompted (for example `bot-8453`). Restart that bot
afterward to pick up routes. Until then it runs but skips routed liquidations.

## How It Works

### Startup

Load + validate config, build the signer (wallet client + local nonce cursor) and the deployless read
client, then fail-loud liveness-check **both** the Executor and the Morpho singleton hold code. Wire
the per-collateral swap map, the rate-limited HTTP client, the quoter, the backoff, and the pending
queue, and start the block watcher.

### Trigger

An HTTP block-number poll (`watcher.ts`, no WebSocket) drives one tick per new height, coalescing any
backlog. A coverage bot re-derives its work each block, so a skipped intermediate height is safe.

### Discovery

A co-located rindexer indexes the Morpho `Borrow` event for each configured chain. Base uses the
canonical singleton `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb`; Robinhood uses its own singleton
`0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010`.

`Borrow` yields the `(marketId, onBehalf)` candidate universe (`onBehalf` is the borrower). One
rindexer process writes all networks into one `blue_liquidation_morpho.borrow` table, and each bot
filters by rindexer's `network` column.

`CreateMarket` is deliberately not indexed: no-code rindexer cannot decode the nested `MarketParams`
struct, and the singleton exposes `idToMarketParams(id)`. `discovery/borrowers.ts` reads distinct
`(id, borrower)` pairs for this chain, resolves each id to `MarketParams` on-chain, and returns
`{ marketParams, borrower }[]`. Over-inclusion is harmless (the lens drops repaid/healthy positions);
under-inclusion would miss a liquidation, so v0 does not prune with `Repay`/`WithdrawCollateral` at
the SQL layer. rindexer lag is emitted as `rindexer.lag` for observability only — the lens reads every
candidate fresh.

### State lens

A `soltag`-authored lens (`state/lens.sol.ts`) reads everything the decision depends on for the whole
batch inside one deployless `eth_call` against a single `block.timestamp`. Per element it:

1. re-derives `id = keccak256(abi.encode(params))` and reads `market(id)` / `position(id, borrower)` —
   a forged param set derives an id with no market and is rejected (`valid = false`);
2. **simulates interest accrual** to `block.timestamp` (`IIrm.borrowRateView` + Taylor compounding,
   exactly `MorphoBalancesLib.expectedMarketBalances`);
3. reads `oracle.price()`, then computes `healthy = maxBorrow >= borrowed` with the contract's exact
   rounding (`toAssetsUp` for debt, `mulDivDown`/`wMulDown` for `maxBorrow`, virtual shares/assets).

A per-element try/catch isolates a bad market/oracle to a zeroed `valid = false` row.

### Eligibility and sizing

Off-chain: liquidatable ⟺ `valid && hasDebt && !healthy` (permissionless, time-independent — no gate,
lock, or maturity). Sizing (`sizing/plan.ts`) is **seize-exact**:

```
repaidAssetsFull = borrowShares.toAssetsDown(accruedTotalBorrowAssets, totalBorrowShares)
seizeForFullDebt = mulDivDown(wMulDown(repaidAssetsFull, lif), ORACLE_PRICE_SCALE, collateralPrice)
seizedAssets     = min(collateral, seizeForFullDebt)   // repaidShares = 0; Blue ceil-derives it
```

Pinning the seize keeps an aggregator's fixed sell amount correct. The inbound double-floor guarantees
`repaidShares ≤ borrowShares`, so the on-chain subtraction can't underflow (proved by a brute-force
sweep in `test/sizing/plan.test.ts`). When collateral binds (underwater), seizing 100% drives
`position.collateral` to 0 and Blue socializes the residual as bad debt in the same call. LIF is a pure
function of LLTV (`sizing/lif.ts`), capped at `1.15e18`.

### Quoting

For each liquidatable position, one quote from the operator's configured venue for its single
collateral: `uniswap-v3` (built locally, balance-spliced, no key), or `0x` / `1inch` (one rate-limited
API call, route-bound fixed sell amount). A free oracle-based route-quality check rejects any route
more than `MAX_ROUTE_IMPACT_BPS` below the reference. Quotes are made only for the small liquidatable
set; a per-`(id, borrower)` exponential backoff suppresses repeated failures.

### Simulation

The exact `Executor.exec_606BaXt(...)` bytes are `eth_call`-simulated from the EOA. Only an `ok`
result is broadcast (`simulate.ok` gate). The exec is `liquidate` + an in-callback swap/approval
queue (via `onMorphoLiquidate`) + two trailing `skim` sweeps that drain both tokens to the EOA.

### Broadcast and pending queue

Sim-ok plans are broadcast via the signer and tracked in an in-memory nonce queue: parallel submit at
distinct nonces, EIP-1559 ≥12.5% fee bump on stuck nonces, and a hard `MAX_FEE_GWEI` ceiling that
drops rather than chases a gas spike. State is not persisted — chain truth wins; a restart re-derives
the nonce from `getTransactionCount('pending')`.

## Testing

- `bun test` — unit tests for the math, LIF, seize-exact planner (incl. the underflow-safety sweep),
  the id derivation, discovery SQL, config, eligibility, quoting, venues, the queue, and the exec
  encoder.
- **Live read-path probe** — `bun run --filter @morpho-org/blue-liquidation probe:lens` (needs
  `RPC_URL`, no anvil) runs the deployless lens against a sample of real Base borrowers, prints a
  valid/hasDebt/healthy/liquidatable breakdown + a decoded sample, and — if it finds a live-liquidatable
  position — emits a ready-to-paste `FIXTURE` for the fork suite. Run it any time to confirm the read
  path against production (last run: 256/256 returned, all valid, 0 liquidatable — a healthy market).
- **Fork suite** (`test/fork/`) — end-to-end against a real Base position. It **skips** unless
  `RPC_URL_8453` is set _and_ `BLUE_LIQUIDATION_FORK_FIXTURE` contains a discovered unhealthy position
  - fork block + pool fee (use `probe:lens` to find one). Integer fields should be decimal strings.
    With both, it drives lens → plan → swap → exec, asserts the tx lands, the EOA gains the loan token,
    and the Executor ends holding zero of both tokens.
  * Two fork assertions the TIB enumerates are **deferred to go-live**: (1) an underwater fixture
    asserting the collateral-binds path drives `position.collateral` to 0 and socializes the residual
    (supplier `totalSupplyAssets` drops), and (2) queue bump + replacement against a real node. The
    collateral-binds safety property is meanwhile covered by the `plan.test.ts` underflow sweep and the
    queue bump/replace by `queue/pending-queue.test.ts`; the fork versions add on-chain proof once a
    fixture + RPC are available.

## Important operational notes

- **Broadcast path**: use an RPC that relays. `rpc.morpho.dev/realtime` acks sends but never relays,
  which strands the nonce cursor.
- **Lens gas model** (`state/lens.sol.ts` `BatchGasConfig`) is **measured** — `~150k + 33k·N` plus a
  ~750k deployless-CREATE constant, fit on an anvil fork of Base against real discovered pairs (method
  documented at the config). Re-measure the same way if the lens body changes materially. Any residual
  under-budget is self-correcting (viem-dlc's chunker halve-and-retries an over-cap batch).
- **rindexer schema**: at boot the bot logs `discovery.schema` with the **actual** rindexer column
  names + row count for the `borrow` table, and `discovery.startup` with this network's candidate
  count, synced block, and a parsed `MarketParams` sample (or `discovery.startup_error` with the DB
  message). On Railway, grep those first: if `discovery.schema` shows different column names than the
  `SELECT` in `borrowers.ts`, or `discovery.startup` shows `candidates: 0` while `syncedBlock` is well
  past the deploy block, fix `borrowers.ts` (the one place the schema is encoded) to match the logged
  names. rindexer may not have migrated tables on the first boot (`present: false`); the per-block
  tick retries, so this is informational, not fatal.
- **Coverage grows monotonically** (all markets, no SQL pruning in v0); the lens re-reads healthy rows
  every block. SQL-layer pruning via `Repay`/`WithdrawCollateral` is a scale follow-up.
