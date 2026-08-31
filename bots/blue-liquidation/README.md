# Blue Liquidation Bot

A non-competitive, ecosystem-backstop liquidator for **Morpho Blue** on Base and Robinhood. It
discovers at-risk borrowers via the Morpho GraphQL API, reads fresh accrued state, sizes seize-exact
liquidations, simulates the final Executor call, and broadcasts only simulation-ok plans.

Design: [TIB-2026-06-30-blue-liquidation-bot](../../docs/decisions/TIB-2026-06-30-blue-liquidation-bot.md)
(its discovery + swap-routing sections are superseded by the GraphQL discovery and key-inferred
multi-venue quoting described below).

## Status

v0. Unit-tested across the core modules. The production read path (lens compile → deployless deploy →
IRM accrual sim → oracle → health → decode) is **validated against 256 live Base positions** via
`probe:lens`, and the lens gas model is **measured** (see `state/lens.sol.ts`). The end-to-end
_liquidate-broadcast_ fork suite is written but **fixture-gated** — it needs a live-unhealthy Base
position (none exist while the market is healthy), `RPC_URL_8453`, and
`BLUE_LIQUIDATION_FORK_FIXTURE` (see [Testing](#testing)).

## Prerequisites

- **pnpm** `11.1.1` (via corepack) and **Node** `24.14.1` (`.nvmrc`).
- A chain RPC that both reads and _relays_ transactions — **not** `rpc.morpho.dev/realtime`, which
  acknowledges sends but never broadcasts them.
- A **funded EOA** (native gas) — the liquidator and the recipient of the end-of-exec token sweeps.
- The generic **Executor** singleton deployed on each chain the bot runs on
  (`pnpm --filter @repo/contracts run deploy:executor`). The bot derives its CREATE2 address and
  refuses to start if it holds no code.
- At least one enabled **swap venue** — a `ZEROX_API_KEY` / `ONEINCH_API_KEY` / `LIFI_API_KEY`, or
  `ENABLE_LIFI=true` (LiFi routes keyless; its key only raises rate limits). A venue-less deployment
  must opt into detection-only mode explicitly (`ALLOW_DETECTION_ONLY=true`).

## Configuration

Env vars (fail-loud on a missing required var, an unknown chain, or a malformed value):

| Var                                                                 | Required | Default                          | Purpose                                                                                                                               |
| ------------------------------------------------------------------- | -------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `CHAIN_ID`                                                          | yes      | —                                | Must be in the chain map (`8453`, `4663`)                                                                                             |
| `RPC_URL`                                                           | yes      | —                                | Primary RPC (reads, simulation, sends)                                                                                                |
| `RPC_URL_FALLBACK`                                                  | no       | —                                | Optional viem-dlc `failover` endpoint                                                                                                 |
| `LIQUIDATOR_PRIVATE_KEY`                                            | yes      | —                                | EOA hex key (`0x` + 32-byte hex)                                                                                                      |
| `EXECUTOOOR_ADDRESS`                                                | no       | derived                          | Override; default is the derived CREATE2 address                                                                                      |
| `MORPHO_API_URL`                                                    | no       | `https://api.morpho.org/graphql` | GraphQL endpoint for borrower discovery                                                                                               |
| `HEALTH_FACTOR_LTE`                                                 | no       | `1.02`                           | Discovery health-factor cutoff (min `1.0` — throws below)                                                                             |
| `ZEROX_API_KEY` / `ONEINCH_API_KEY` / `LIFI_API_KEY`                | no       | —                                | Each key **enables** its venue; LiFi also via `ENABLE_LIFI` (keyless)                                                                 |
| `ENABLE_LIFI`                                                       | no       | `false`                          | Enable LiFi without a key                                                                                                             |
| `ALLOW_DETECTION_ONLY`                                              | no       | `false`                          | Opt-in: boot with zero venues (discover + log only, skip every liquidation). Without it, zero venues is a startup error               |
| `EXCLUDE_COLLATERALS`                                               | no       | —                                | Comma-separated collateral deny-list (skipped with `config.no_swap_path`)                                                             |
| `ZEROX_BASE_URL` / `ONEINCH_BASE_URL` / `LIFI_BASE_URL`             | no       | —                                | Optional per-venue API host overrides                                                                                                 |
| `PROBE_STALE_MS` / `PROBE_HTTP_RPS` / `PROBE_LADDER`                | no       | see `config.ts`                  | Venue-probe cache staleness, isolated probe rate, and ladder sizes (whole collateral tokens — this bot wires no USD price source)     |
| `MAX_FEE_GWEI`                                                      | no       | `300`                            | Hard ceiling for fee bumps                                                                                                            |
| `MAX_ROUTE_IMPACT_BPS`                                              | no       | `500`                            | Reject aggregator routes this far below the oracle ref                                                                                |
| `PENDLE_SLIPPAGE_BPS`                                               | no       | `50`                             | Slippage for the Pendle PT → underlying unwrap hop (before the downstream venue sells)                                                |
| `QUOTE_TIMEOUT_MS` / `HTTP_RPS` / `HTTP_BURST` / `HTTP_MAX_RETRIES` | no       | see `config.ts`                  | Aggregator HTTP tunables                                                                                                              |
| `BACKOFF_BASE_BLOCKS` / `BACKOFF_MAX_BLOCKS`                        | no       | `2` / `64`                       | Per-position failure backoff                                                                                                          |
| `POSITION_LIQUIDATION_COOLDOWN_MS`                                  | no       | `0`                              | Opt-in per-position cooldown (ms) after a failed attempt; `0` disables (re-attempt every tick)                                        |
| `BETTERSTACK_SOURCE_TOKEN` / `BETTERSTACK_INGESTING_HOST`           | no       | —                                | Opt-in log shipping; when both are set the bot's in-process loglayer transport ships structured logs to BetterStack (inert otherwise) |
| `BETTERSTACK_HEARTBEAT_URL`                                         | no       | —                                | Optional Better Stack Uptime heartbeat URL, pinged every minute; failures only log a warning and never interrupt liquidations         |
| `LOG_LEVEL`                                                         | no       | `info`                           | `debug` \| `info` \| `warn` \| `error`                                                                                                |

For Compose/Railway, operator-facing RPC env vars are chain-id suffixed: `RPC_URL_8453`,
`RPC_URL_4663`, and optional distinct `BETTERSTACK_HEARTBEAT_URL_<chainId>` values. Inside each bot
container the runtime env remains unsuffixed because each service runs exactly one chain.

### Venues

There is no per-collateral routing file. Venues are **enabled by key presence** (`ZEROX_API_KEY`,
`ONEINCH_API_KEY`, `LIFI_API_KEY` — or `ENABLE_LIFI=true` for keyless LiFi), and for each
liquidatable position a background probe cache ranks the enabled venues best-first for the
`(collateral, loan)` pair (log-scaled indicative quotes on an isolated rate budget, interpolated at
the seize size — see `PROBE_LADDER`/`PROBE_STALE_MS`/`PROBE_HTTP_RPS`; ladder sizes are whole
collateral tokens here, since this bot wires no USD price source). The firm quote goes to the top
venue and falls through to the next on failure, so a transient venue outage costs coverage, never
correctness. The curve also predicts that venue's own output to set the quote's min-out denominator,
but only while it is fresher than the package's prediction-age ceiling — well under this bot's
ten-minute `PROBE_STALE_MS`, so an older curve simply pays the two-pass derivation's extra call.
Collateral that wraps an ERC-4626 vault or a Pendle PT is auto-unwrapped before the venue swap.
`EXCLUDE_COLLATERALS` is the operator's deny-list for collaterals the bot must never seize/hold.

With **zero venues** the bot refuses to start unless `ALLOW_DETECTION_ONLY=true`, in which case it
discovers and logs liquidatable positions but skips every liquidation (`config.no_swap_path`) — a
rotated/forgotten key must not quietly disable liquidations.

## Running Locally

```sh
export CHAIN_ID=8453
export RPC_URL=https://…
export LIQUIDATOR_PRIVATE_KEY=0x…
export ZEROX_API_KEY=…            # or ENABLE_LIFI=true, or ALLOW_DETECTION_ONLY=true
pnpm --filter @morpho-org/blue-liquidation run start
```

`prestart` builds this bot and its workspace dependencies (soltag-compiles `@repo/contracts` and
materializes the ABI, then esbuild-bundles `dist/`), so `start` runs a plain `node` against a
freshly built bundle. Discovery hits the public Morpho GraphQL API — no indexer or database to run.

## Running With Docker Compose

```sh
cd bots/blue-liquidation
export RPC_URL_8453=https://…
export LIQUIDATOR_PRIVATE_KEY=0x…
export ZEROX_API_KEY=…
docker compose up --build
```

Brings up one bot per chain (`bot-base`, `bot-robinhood`) — nothing else. `RPC_URL_4663` is optional
locally because Compose defaults Robinhood to its public RPC. Robinhood defaults to detection-only
(`ALLOW_DETECTION_ONLY_4663` defaults true) and takes chainId-suffixed venue inputs
(`ZEROX_API_KEY_4663` etc.) so arming Base never silently arms it. The build context is the repo
root so the pnpm workspace resolves.

## Deploying to Railway

Authenticate the CLI first — set `RAILWAY_TOKEN` (a project token scoped to the target project /
environment, recommended for CI) or run `railway login`. Then provide the secrets via the environment
and run the script:

```sh
export RAILWAY_PROJECT_ID=…
export RPC_URL_8453=https://…
export RPC_URL_4663=https://…
export LIQUIDATOR_PRIVATE_KEY=0x…
export ZEROX_API_KEY=…                 # venue inputs; per-chain via ZEROX_API_KEY_<chainId> etc.
export ALLOW_DETECTION_ONLY_4663=true  # required while Robinhood has no venue
pnpm --filter @morpho-org/blue-liquidation run deploy:railway
# Optional: ENABLE_LIFI[_<chainId>], ONEINCH_API_KEY[_<chainId>] / LIFI_API_KEY[_<chainId>],
# RAILWAY_ENVIRONMENT (defaults to production).
```

Idempotent: provisions one per-chain `bot-<chainId>` runner each, reusing existing services/vars.
Secrets are piped via stdin (never argv, never logged). The whole venue posture is **synchronized**
on every full run: `ENABLE_LIFI`/`ALLOW_DETECTION_ONLY` are set explicitly, and each venue key is
either set from this run's inputs or **deleted** when absent — so neither a stale detection-only
opt-in nor a dropped venue key can linger from a previous run. A chain with no venue input and no
opt-in fails loud before any Railway mutation. A `CRASHED` deployment is a failed deploy (the bot
fails loud on a bad config). After `bot-8453` is confirmed healthy, the script attempts to remove
the legacy single-chain `bot` service to avoid running two Base liquidators.

Railway service names are project-wide. Production retains `bot-<chainId>`; every other environment
is prefixed (for example, `staging-bot-8453`).

Set `DEPLOY_ONLY=1` (or `true`) to re-ship the **already-provisioned** services from the current
working tree without setting any secrets or variables — the mode the deploy CI uses (it holds no
RPC/keys). A full first-time provision needs `RPC_URL_<chainId>` + `LIQUIDATOR_PRIVATE_KEY`;
`DEPLOY_ONLY` needs neither.

**One-time migration teardown**: earlier deployments provisioned a managed `Postgres` and a
`rindexer` service (plus `staging-` prefixed variants) for discovery. The bot no longer reads them —
once the new bots are confirmed healthy in an environment, delete those services and their volumes
from the Railway dashboard. The deploy script never deletes a database itself.

## How It Works

### Startup

Load + validate config (including the venue inference and the zero-venue gate), build the signer
(wallet client + local nonce cursor) and the deployless read client, then fail-loud liveness-check
**both** the Executor and the Morpho singleton hold code. Wire the venue selector + the two
rate-limited HTTP clients (firm quotes vs background probes), the quoter, the backoff, and the
pending queue, run one discovery self-check, and start the block watcher.

### Trigger

An HTTP block-number poll (`watcher.ts`, no WebSocket) drives one tick per new height, coalescing any
backlog. A coverage bot re-derives its work each block, so a skipped intermediate height is safe.

### Discovery

Each tick, `discovery/borrowers.ts` POSTs one `marketPositions` GraphQL query to
`api.morpho.org/graphql` per page, filtered server-side to **this chain** (`chainId_in`), **listed
markets only** (`marketListed: true`), and positions at or below `HEALTH_FACTOR_LTE` — ordered by
ascending health factor so the worst positions are always on page 1. Only `market.marketId` +
`user.address` are consumed; skip-pagination walks the full set (page size 1000, with a loud
`discover.max_pages` backstop against silent truncation, and de-dupe across pages).

Each distinct id resolves to `MarketParams` on-chain via `idToMarketParams(id)` (memoized forever —
params are immutable per id), and the lens re-reads every pair fresh, so the API is a coverage
source, never a correctness dependency: over-inclusion is harmless, API indexing lag is coverage
latency only, and an id that doesn't resolve against this chain's singleton is dropped (with a
`discover.dropped` warn — the backstop against an API/deployment mismatch). Base uses the canonical
singleton `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb`; Robinhood uses its own singleton
`0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010`.

Because `marketListed: true` is enforced server-side, discovery covers **every listed market** from
the first tick — including markets that never had a borrow while the bot was running (the old
indexer only knew markets with an indexed `Borrow` event). The flip side: a delisted market's
positions leave discovery even if still liquidatable.

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

For each liquidatable position, `quotes.ts` projects the lens output into a `@repo/swaps`
`QuoteRequest` and hands it to the package's `composeMultiVenueQuoting`. The package first runs the
**pre-swap unwrap chain**: if the seized collateral wraps an ERC-4626 vault or a Pendle PT, it
auto-detects that (memoized `eth_call` for ERC-4626; the Pendle SDK for PT) and prepends the redeem
step(s) that convert it to a tradable underlying — threading each hop's worst-case output forward so a
downstream fixed-amount step can never revert on a shortfall. When the unwrap chain already ends in
the loan token there is nothing left to sell, so the plan is the unwrap steps alone.

Otherwise it refreshes the probe cache for the POST-unwrap `(collateral, loan)` pair (staleness-gated
— quiet markets cost no venue calls; a stale-cache refresh runs synchronously before the firm quote,
worst case roughly venues × ladder points at `PROBE_HTTP_RPS`), takes the best-first venue order
(enabled-but-unranked venues appended so a probe hiccup can't hide a venue), and fetches **one**
executable quote from the top venue — `0x` / `1inch` / `lifi` (one rate-limited API call,
route-bound fixed sell amount; LiFi routes keyless) — falling through to the next venue on failure.
A free oracle-based route-quality check (against the full-path oracle reference) rejects any route
more than `MAX_ROUTE_IMPACT_BPS` below it. Quotes are made only for the small liquidatable set; a
per-`(id, borrower)` exponential backoff suppresses repeated failures — including a send the chain
declined with an execution revert, which is a deliberate divergence from `bots/midnight-liquidation`
(blue's liquidation incentive is static, so a shortfall on this block does predict the next one; see
[TIB-2026-08-28](../../docs/decisions/TIB-2026-08-28-midnight-send-shortfall-classification.md)).

### Simulation

The exact `Executor.exec_606BaXt(...)` bytes are `eth_call`-simulated from the EOA. Only an `ok`
result is broadcast (`simulate.ok` gate). The exec is `liquidate` + an in-callback queue (via
`onMorphoLiquidate`) that runs the plan's steps — a plain collateral is one venue swap; exotic
collateral is unwrap step(s) then usually a venue swap — followed by the repay-token approval. After
`liquidate` returns, trailing `skim` sweeps drain both market tokens **plus every intermediate token
the unwrap chain introduced** to the EOA (the full-drain invariant: a fixed-amount step leaves the
worst-case-vs-actual surplus behind).

### Broadcast and pending queue

Sim-ok plans are broadcast via the signer and tracked in an in-memory nonce queue: parallel submit at
distinct nonces, EIP-1559 ≥12.5% fee bump on stuck nonces, and a hard `MAX_FEE_GWEI` ceiling that
drops rather than chases a gas spike. State is not persisted — chain truth wins; a restart re-derives
the nonce from `getTransactionCount('pending')`.

### Log correlation

Every position-scoped event — `plan.*`, `cooldown.*`, `config.*`, `quote.*`, `unwrap.*`, `select.*`,
`simulate.*`, `tx.*`, `queue.*`, `nonce.*` — carries the position in one field, **`id`**, whose value
is `lensKey(marketId, borrower)`: the two halves joined by `:` with both lowercased. So a window's
events group into one row per position with **no normalization in the query** (`GROUP BY id`). `tx.*`
used to name the same string `label`; it does not any more. `plan.built` also keeps `marketId` and
`borrower` as human-readable extras — for reading a single line, not for grouping.

A Blue market has exactly one collateral, so one position is one candidate: unlike
`bots/midnight-liquidation`, `id` alone identifies a row and no candidate discriminator is emitted.

## Testing

- `pnpm test` — unit tests for the math, LIF, seize-exact planner (incl. the underflow-safety sweep),
  the id derivation, GraphQL discovery (parsing, pagination, retry semantics), config (incl. venue
  inference and the zero-venue gate), eligibility, quoting, venues, the queue, and the exec encoder.
- **Live read-path probe** — `pnpm --filter @morpho-org/blue-liquidation run probe:lens` (needs
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
- **Discovery health**: at boot the bot logs `discovery.startup` with this chain's candidate count
  and a parsed `MarketParams` sample (or `discovery.startup_error` with the API message). On Railway,
  grep those first, then per tick: `discover.error` (transient API failure — the tick proceeds with
  zero candidates and the pending queue is still maintained), `discover.dropped` (malformed rows or
  ids that don't resolve on this chain's singleton — API schema drift or a wrong-deployment mismatch),
  and `discover.max_pages` (pagination backstop hit — under-inclusion, investigate immediately).
  There is no indexer-lag signal anymore: API indexing latency is a coverage concern only, since the
  lens re-reads every candidate fresh on-chain each block.
- **Coverage** spans every listed market server-side; the lens re-reads all discovered candidates
  each block, bounded by the `HEALTH_FACTOR_LTE` cutoff rather than a borrow-event history.
