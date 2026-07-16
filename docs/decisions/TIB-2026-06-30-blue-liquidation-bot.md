# TIB-2026-06-30: Blue liquidation bot — v0

| Field      | Value                        |
| ---------- | ---------------------------- |
| **Status** | Implemented                  |
| **Date**   | 2026-06-30                   |
| **Author** | @hayden                      |
| **Scope**  | App: `bots/blue-liquidation` |

---

## Context

Morpho Blue is a single-collateral, permissionless, immutable lending primitive. A position
`(marketId, borrower)` is liquidatable when `borrowShares > 0` **and** it is unhealthy —
`_isHealthy` returns false, i.e. `maxBorrow < borrowed`. There is no maturity, no per-market
liquidator gate, and at most one collateral asset per market. The decision surface is:

- **Single collateral.** No 128-slot bitmap, no per-slot argmax, no per-collateral oracle/LIF. One
  collateral, one oracle, one LLTV per market.
- **No maturity, no RCF cap, no liquidator gate.** The liquidation incentive factor (LIF) is a pure
  function of LLTV; there is no time ramp and no recovery-close-factor cap. Any address may liquidate
  any unhealthy position.
- **Continuous accrual.** Blue debt accrues every block via the
  market's interest rate model (IRM). A borrower's stored `borrowShares` converts to _more_ loan
  assets over time even with a flat oracle price, so the health check must run against **accrued**
  market state, not the last-written storage. The lens must replicate accrual
  (`IIrm.borrowRateView` + Taylor compounding) exactly, matching `MorphoBalancesLib`.
- **`MarketParams` are off-chain.** The Morpho singleton exposes only the mutable `Market` struct via
  `market(Id)`; it does **not** return `MarketParams` (`loanToken, collateralToken, oracle, irm,
lltv`). Those are emitted once by `CreateMarket` and must be indexed. Since `Id ==
keccak256(abi.encode(marketParams))` is a cryptographic commitment, the lens re-derives the id from
  the supplied params and rejects any mismatch.

We build for two readers:

1. **Integrators** copying it as a reference implementation — the accrual, health, LIF, and sizing
   logic must read as documentation.
2. **Ourselves** running it as a safety-net liquidator that values reliability over latency — it must
   _work_ correctly and predictably, not win races.

Three architectural choices anchor the design:

- **Discovery via a co-located rindexer instance.** rindexer indexes Morpho's `CreateMarket` (→ the
  `Id → MarketParams` registry) and `Borrow` (→ the `(marketId, borrower)` candidate universe;
  `onBehalf` is the borrower) into Postgres; the bot reads them each tick over `DATABASE_URL`. Scope
  is **all markets on the target chain** — the true backstop posture — with execution bounded to
  collaterals the operator has configured a swap route for. We deliberately do **not** depend on a
  hosted indexer/API on the liquidation path (see Considered Alternatives).
- **Decisions via a `soltag`-authored lens** read through `@morpho-org/viem-dlc`'s `deployless`
  transport. Everything the decision depends on — accrued `Market` state, `Position`, the simulated
  IRM rate, and the oracle price — is read fresh inside one `eth_call` against a single
  `block.timestamp`. Discovery says who _might_ be liquidatable; the lens says whether it still _is_.
- **Execution via the vendored, fully generic
  [`Rubilmax/executooor`](https://github.com/Rubilmax/executooor)** singleton already in
  `@repo/contracts` (owner gate stripped, no protocol-specific Solidity). The executooor was built
  _for Morpho Blue_, so `onMorphoLiquidate` is its native callback and `executooor-viem` provides the
  `morphoBlueLiquidate` encoder; the swap and repay approval ride inside the callback as the
  Executor's generic call queue. **No Solidity change is needed** to serve Blue.

## Goals / Non-Goals

**Goals**

- Long-running runner, single chain per process, that reliably liquidates **every** position that
  becomes liquidatable while it is running.
- **Accrual-correct** health: the lens simulates IRM accrual to `block.timestamp` and applies the
  contract's exact rounding (`toAssetsUp` for debt, `mulDivDown`/`wMulDown` for `maxBorrow`, virtual
  shares/assets in all conversions).
- Correct sizing: LIF from LLTV, and a single seize-exact rule
  (`seizedAssets = min(collateral, seizeForFullDebt)`) that fully closes a solvent-collateral
  position or seizes 100% of collateral and lets Blue socialize the remainder as bad debt.
- **Multi-venue** callback-swap execution from day one: `uniswap-v3` (direct, no key), `0x`, `1inch`,
  operator-selected per collateral, behind a venue-agnostic encoder. Single-hop / one quote per
  liquidatable position; the bot does not search paths.
- Simple in-memory nonce queue: parallel submit at distinct nonces, EIP-1559 fee bump on stuck
  nonces, hard ceiling that drops rather than chases gas spikes.
- Broad coverage: index **all** Blue markets on the chain; the lens filters to unhealthy debtors and
  execution is bounded to collaterals with a configured route.
- Reusable as a reference implementation — the accrual/health/LIF/sizing math reads cleanly as
  documentation.

**Non-Goals**

- Profitability gating, MEV-aware bidding, private mempools. We submit every sim-ok plan.
- Multi-hop swap routing. One pool / one aggregator quote per collateral; volatile assets get
  conservative slippage or are omitted.
- Multi-chain in a single process. One process per chain; horizontal scale via deployments.
- Flashloan-funded liquidations. The Executor is funded by the seized collateral alone via the
  in-line swap; no external borrow.
- **Protocol-specific Solidity in the Executor.** We reuse the vendored generic singleton unchanged;
  the swap and approvals ride inside the native `onMorphoLiquidate` callback as the Executor's generic
  call queue. No Blue-specific handler.
- Persisting queue state across runner restarts. Chain truth wins; we re-derive on startup.
- Replacing `@repo/utils` or `@repo/contracts` patterns. Reuse them as-is; add only a Morpho ABI +
  vendored interface to `@repo/contracts`.

## Current Solution

Before this change, the repo had no Morpho Blue liquidator. Morpho Blue ABIs/interface were also not
vendored; `@repo/contracts` shipped the generic `Executor.sol` plus the interfaces needed by existing
bots.

## Proposed Solution

### Module shape

Solidity/ABIs live in `@repo/contracts`, soltag-compiled at build time. This bot adds a vendored
Morpho Blue interface; the Executor is reused unchanged.

```
packages/contracts/
  solidity/
    Executor.sol                 // REUSED unchanged: Rubilmax executooor, owner gate stripped
    interfaces/IMorpho.sol       // NEW: vendored from morpho-org/morpho-blue (interface + event set:
                                 //      CreateMarket, Borrow, Repay, SupplyCollateral,
                                 //      WithdrawCollateral, Liquidate)
  scripts/{codegen,build,deploy-executor}.ts  // REUSED: existing generate/build/deploy pipeline
  src/{abis,contracts}.ts        // generated ABIs + Executor (.with() factory)
  abis/Morpho.json               // NEW: materialized for rindexer (built, not committed)
  foundry.toml                   // `forge fmt` only — soltag/bun do the compilation
```

Adding `MorphoAbi` via a vendored `interfaces/IMorpho.sol` uses the existing `@repo/contracts`
codegen/build/deploy pipeline.

The bot lives under `bots/blue-liquidation/`:

```
src/
  config.ts          // env + swap-config JSON + per-chain Morpho map; fail loud
  index.ts           // boot: loadConfig → wire deps → runner.start(); SIGTERM/SIGINT
  constants.ts       // named constants cited to Blue's src/libraries/ConstantsLib.sol + MathLib:
                     //   WAD=1e18, ORACLE_PRICE_SCALE=1e36, LIQUIDATION_CURSOR=0.3e18,
                     //   MAX_LIQUIDATION_INCENTIVE_FACTOR=1.15e18, VIRTUAL_SHARES=1e6, VIRTUAL_ASSETS=1;
                     //   bot-local: STUCK_BLOCKS=4, MAX_BUMP_ATTEMPTS=3, 1inch spender, 0x AllowanceHolder
  client.ts          // deployless (+ optional failover) read client; getCode liveness gate
  signer.ts          // wallet client + createNonceManager; send / getReceipt / getBaseFee
  logger.ts          // JSON-line structured logger (bigints stringified)

  runner/
    runner.ts        // start/stop; wires modules; owns lifecycle
    tick.ts          // pure orchestrator: injected deps, one tick
    watcher.ts       // setInterval getBlockNumber poll → coalesced new-block queue (HTTP only)
    eligibility.ts   // off-chain liquidatability (borrowShares>0 && !healthy) + lens → plan-input

  discovery/
    borrowers.ts     // reads (marketId, borrower) candidates joined to MarketParams; + rindexer head

  state/
    lens.sol.ts      // soltag lens: accrual sim + health for a batch; codecs; fetcher
                     //   deployless batch helper lives in @repo/utils

  sizing/
    lif.ts           // pure: lifFromLltv(lltv) → bigint  (no maturity ramp)
    plan.ts          // pure: PlanInput → LiquidationPlan (seize-exact: min(collateral, seizeForFullDebt))
    math.ts          // pure: mulDivUp / mulDivDown / wMulDown / wDivDown / wDivUp / wTaylorCompounded /
                     //   toAssetsUp / toAssetsDown / toSharesUp / toSharesDown (virtual offsets)

  quotes/            // multi-venue quoting and swap calldata
    types.ts         // Swap (the one currency), Venue, QuoteParameters, VenueAdapter
    http-client.ts   // per-venue token-bucket rate-limited fetch + retries + key injection
    venues/{uniswap-v3,zerox,oneinch}.ts
    index.ts         // composeQuoting(): { quoteFor } consumed by the tick

  execution/
    encode-call.ts   // pure: plan + Swap → Executor.exec_606BaXt(bytes[]) via morphoBlueLiquidate
    swap-step.ts     // pure: oracle-priced reference output (expectedLoanOut) for the route-quality guard
    simulate.ts      // eth_call the real exec from the EOA; ok | revert

  queue/
    pending-queue.ts // in-memory Map<nonce, Pending>; submit / bump / drop / onBlock; inflightLabels
    fee-policy.ts    // pure: EIP-1559 bump ≥12.5%; ceiling → drop
    backoff.ts       // exponential per-(id,borrower) failure suppression (quote/route/simulate)

bunfig.toml          // preload soltag.preload.ts for `bun test` + runtime
soltag.preload.ts    // Bun.plugin driving soltag's transform (compiles the lens on load)
rindexer.yaml        // rindexer project: index Morpho CreateMarket + Borrow on Base
docker-compose.yml   // Postgres + rindexer + bot
Dockerfile           // multi-stage: bot; abi (materializes Morpho.json); rindexer
```

Pure modules are unit-tested; everything touching RPC / Postgres / `process` is covered by the anvil
fork suite (`test/fork/`).

### Implementation Phases

- **Phase 1 — Contracts + discovery + dry-run.** Vendor `IMorpho.sol`, generate `MorphoAbi`, and
  materialize `abis/Morpho.json`. Land `discovery/` (rindexer indexing `CreateMarket` + `Borrow`, the
  registry join), `config.ts`, and an `index.ts` dry-run that prints "would attempt" against the
  candidate set only. Discovery SQL and fail-loud config are unit-testable.
- **Phase 2 — Lens + sizing (read-only).** Author the soltag lens with **accrual simulation** and the
  id-commitment check, wire the deployless transport, and land `sizing/` (LIF from LLTV, the
  seize-exact planner). Plans are now correct and fresh; `simulate` is the sink.
- **Phase 3 — Runner + nonce queue + signed sends.** Add `runner/`, `queue/`, signer wiring. Exercise
  the queue and bumping with a deterministic dummy broadcast before swaps exist.
- **Phase 4 — Multi-venue swaps + Executor encoder.** Land `quotes/` (the `Swap` currency, the three
  venue adapters, the rate-limited HTTP client, the backoff), the `morphoBlueLiquidate`-based
  encoder, the per-collateral swap config, the `simulate` ok-only gate, and the anvil fork suite.

### Discovery design (rindexer)

A co-located **rindexer** instance (bundled in the bot's `docker-compose.yml`) runs Postgres,
rindexer, and the bot against one `DATABASE_URL`. On Base it indexes two Morpho events on the
canonical singleton `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb`:

- **`CreateMarket(Id indexed id, MarketParams marketParams)`** → the `Id → MarketParams` registry.
  This is **required**, not optional: `MarketParams` are unavailable from the singleton, and the lens
  needs `(loanToken, collateralToken, oracle, irm, lltv)` to read state and size.
- **`Borrow(Id indexed id, address caller, address indexed onBehalf, address indexed receiver, ...)`**
  → the `(marketId, borrower)` candidate universe. `onBehalf` (indexed) is the position owner and the
  only borrower-creating field, so its `onBehalf` set is the complete borrower universe.

`discovery/borrowers.ts` returns `{ marketParams, borrower }[]` by selecting distinct
`(id, onBehalf)` from the indexed `Borrow` table and joining each `id` to the `CreateMarket`
registry. Over-inclusion is harmless (repaid/closed positions are dropped fresh by the lens);
under-inclusion would miss a liquidation, so we do not prune with `Repay`/`WithdrawCollateral` at the
SQL layer in v0 (a future optimization). We do **not** trust any indexed position/collateral amount —
the lens reads it fresh.

**rindexer-lag signal.** `borrowers.ts` exposes `rindexerSyncedBlock`; each tick compares it to the
chain head and emits `rindexer.lag`. Observability-only, fails open — the lens reads every candidate
fresh, so lag is coverage latency, never a correctness issue.

### Lens design (soltag)

One elementwise function (viem-dlc's array-in/array-out contract):

```solidity
function lens(Input[] calldata input) external view returns (LensOut[] memory output)
```

**Input element** (per pair): `struct Input { MarketParams params; address borrower; }`. The lens
first re-derives `id = keccak256(abi.encode(params))` and reads state at that id; a caller cannot
smuggle in mismatched params because everything downstream keys off the committed id. A per-element
try/catch isolates any revert (unknown market, reverting oracle) to a zeroed `valid: false` row — one
bad element never breaks the batch.

Per element, the lens:

1. Reads the borrow-side `Market` fields (`totalBorrowAssets, totalBorrowShares, lastUpdate`) and the
   `Position` (`borrowShares, collateral`). It does **not** read `fee`: the fee accrues to
   `totalSupplyShares`, never to `totalBorrowAssets`/`totalBorrowShares`, so it does not affect the
   `borrowShares → assets` conversion the health check and seize depend on. (This is where the lens
   deliberately diverges from a full `expectedMarketBalances` replication — it computes only the
   borrow side.)
2. **Simulates accrual to `block.timestamp`**: `elapsed = block.timestamp - lastUpdate`; if
   `elapsed > 0 && irm != address(0)`, `rate = IIrm(irm).borrowRateView(params, market)`, then
   `interest = totalBorrowAssets.wMulDown(rate.wTaylorCompounded(elapsed))` and add it to
   `totalBorrowAssets`. This is `MorphoBalancesLib.expectedMarketBalances` inline — identical to
   what `liquidate` computes after its own `_accrueInterest`. `irm == address(0)` markets skip this
   (rate 0).
3. Reads `collateralPrice = IOracle(oracle).price()`.
4. Computes, with the contract's exact rounding:
   `borrowed = borrowShares.toAssetsUp(accruedTotalBorrowAssets, totalBorrowShares)` (virtual
   offsets `+1` / `+1e6`); `maxBorrow = collateral.mulDivDown(collateralPrice, 1e36).wMulDown(lltv)`;
   `healthy = maxBorrow >= borrowed`.

**Output element** returns the flat sizing inputs and the accrued state:

```solidity
struct LensOut {
  bool    valid;                  // id derived + market exists
  bool    hasDebt;                // borrowShares > 0
  bool    healthy;                // maxBorrow >= borrowed  (== the contract's _isHealthy return)
  uint64  blockTimestamp;         // avoid host-clock drift
  uint128 borrowShares;
  uint128 collateral;
  uint256 accruedTotalBorrowAssets;
  uint256 totalBorrowShares;
  uint256 collateralPrice;        // raw oracle price (ORACLE_PRICE_SCALE units)
  uint256 lltv;
}

// Off-chain (runner/eligibility.ts):
//   liquidatable = valid && hasDebt && !healthy
//   — no gate, no lock, no maturity: Blue liquidation is permissionless and time-independent.
```

The lens returns accrued totals (not a pre-computed seize) so the pure planner can derive both sizing
sides against a single, consistent chain time. The single file contains the soltag source tagged
template, input/output codecs, inline `BatchGasConfig`, and exported
`readBlueLiquidationLens(client, morpho, pairs)`. The fetcher delegates to the shared array-in /
array-out deployless batch helper in `@repo/utils`. soltag is a build-time transform preloaded via
`bunfig.toml`; `soltag` + `solc` are runtime deps.

### Sizing math

All pure integer `bigint` math mirroring the contract's floor/ceil directions and virtual offsets.
`now = LensOut.blockTimestamp`.

**LIF from LLTV** (`sizing/lif.ts`) — no maturity ramp:

```ts
// LIF = min(MAX_LIF, WAD / (WAD - LIQUIDATION_CURSOR·(WAD - lltv)))
function lifFromLltv(lltv: bigint): bigint {
  const lif = wDivDown(WAD, WAD - wMulDown(LIQUIDATION_CURSOR, WAD - lltv))
  return lif < MAX_LIF ? lif : MAX_LIF   // MAX_LIF = 1.15e18, LIQUIDATION_CURSOR = 0.3e18
}
```

**Seize-exact everywhere** (`sizing/plan.ts`). We pin `seizedAssets` and let Blue derive
`repaidShares`, so an aggregator's fixed sell amount is correct on every branch (the Executor holds
exactly the seize when the callback runs). The single rule:

```
repaidAssetsFull = borrowShares.toAssetsDown(accruedTotalBorrowAssets, totalBorrowShares)
seizeForFullDebt = mulDivDown(wMulDown(repaidAssetsFull, lif) , ORACLE_PRICE_SCALE, collateralPrice)
seizedAssets     = min(collateral, seizeForFullDebt)     // repaidShares = 0; Blue ceil-derives it
```

**Rounding-direction note (intentional, mirrors the contract).** The lens rounds debt **up**
(`toAssetsUp`) for the _health test_ — conservative, matching `_isHealthy`. The planner rounds debt
**down** (`toAssetsDown`) when deriving `seizeForFullDebt`, matching the contract's own repay→seize
derivation (`repaidShares.toAssetsDown(...)`). The two rounding directions are deliberately different
because they answer different questions; this is not an inconsistency.

- **Debt binds** (`seizeForFullDebt < collateral`, i.e. collateral is worth more than the discounted
  debt): pin `seizedAssets = seizeForFullDebt`. Blue then ceil-derives `repaidShares` from the pinned
  seize via its `liquidate` `seizedAssets → repaidShares` path
  (`seizedAssets.mulDivUp(price, SCALE).wDivUp(lif).toSharesUp(...)`). The intended property is
  `repaidShares ≤ borrowShares` — the inbound double-floor in `seizeForFullDebt` should dominate the
  contract's ceil-derivation so `position.borrowShares -= repaidShares` cannot underflow. This is the
  **load-bearing correctness claim** of the sizing rule; it must be _proved_ against the contract
  derivation and brute-force-swept before go-live (Open Questions / Verification). A full close may
  leave a few wei of residual debt, which is acceptable for a backstop liquidator.
- **Collateral binds** (`seizeForFullDebt ≥ collateral`, underwater): pin
  `seizedAssets = collateral`. Blue seizes 100% and derives `repaidShares`. `liquidate`'s bad-debt
  block then fires precisely when `position[id][borrower].collateral == 0 && borrowShares > 0` after
  the seize — writing the residual off against `totalSupplyAssets`/`totalSupplyShares` (loss
  socialized across suppliers). Pinning `seizedAssets = collateral` is exactly what drives
  `position.collateral` to 0, so it is the full-collateral seize that _triggers_ socialization. The
  `collateral == 0 && borrowShares > 0` trigger is asserted in the fork suite.
- **Degenerate** (`borrowShares > 0` but `collateral == 0`): nothing to seize; skip. Clearing pure
  residual bad debt would require an uncompensated loan-token repay, which a backstop bot does not do.

An over-large derived repay reverts in `simulate()`, so it is not broadcast.

### Multi-venue swaps

One currency — **`Swap`** (`src/quotes/types.ts`,
`{ spender, target, value, callData, amountIn: {source:'balance',offset} | {source:'fixed',value},
expectedAmountOut, amountOutMinimum }`) — flows from a venue adapter into a venue-agnostic encoder
that branches only on `amountIn.source`:

- **`uniswap-v3`** — builds `exactInputSingle` locally (no key); `amountIn` is balance-spliced from
  the Executor's live collateral.
- **`0x`** (AllowanceHolder) / **`1inch`** (Classic v6) — one rate-limited API call returning
  route-bound calldata with a **fixed** sell amount = the pinned `seizedAssets`; taker/recipient = the
  Executor. Both spend via a plain `approve` the Executor can satisfy.

**The loan-token reference is free.** Blue's `oracle.price()` yields collateral→loan value directly,
so `expectedLoanOut = mulDivDown(seizedAssets, collateralPrice, ORACLE_PRICE_SCALE)`
(`execution/swap-step.ts`) is computed with no extra API call — it feeds both the uniswap
`amountOutMinimum` (`expectedLoanOut·(10000 - slippageBps)/10000`) and the route-quality guard.

**Rate-limiting.** Quotes are restricted to the small _liquidatable_ set (one quote per liquidatable
position, O(liquidatable) not O(candidates)); a free oracle route-quality pre-check rejects any quote
more than `MAX_ROUTE_IMPACT_BPS` below the oracle reference; a per-`(id, borrower)` exponential
`backoff` suppresses repeated quote/route/simulate failures; and a shared per-venue token-bucket HTTP
client bounds API usage. Config is a Zod
discriminated union on `venue` (missing `venue` defaults to `uniswap-v3`); API keys come from
`ZEROX_API_KEY` / `ONEINCH_API_KEY` at point of use, never stored on `Config` or logged.

### Executor integration

We reuse the vendored generic `Rubilmax/executooor` singleton in `@repo/contracts` **unchanged** (its
only diff from upstream is the stripped owner gate + a pragma relaxation). No Blue-specific Solidity
is added. `onMorphoLiquidate` is the Executor's native callback and `executooor-viem`'s
`ExecutorEncoder` ships a `morphoBlueLiquidate` builder. Morpho ignores the callback's return and
pulls the repayment afterward.

`execution/encode-call.ts` builds `Executor.exec_606BaXt(bytes[])`:

1. `Morpho.liquidate(marketParams, borrower, seizedAssets, /*repaidShares*/ 0, data)` from the
   Executor (`msg.sender`). Blue transfers `seizedAssets` of collateral to `msg.sender` **before**
   the callback, then calls `msg.sender.onMorphoLiquidate(repaidAssets, data)`, then pulls
   `repaidAssets` of the loan token via `safeTransferFrom` **after**.
2. `data` carries the Executor's callback call queue, run inside `onMorphoLiquidate`:
   - `approve(collateral, swap.spender, 0)` then `approve(collateral, swap.spender, balanceOf(exec))`
     — the USDT-safe zero-then-set pair, reused for every venue's spender.
   - the swap call (`buildCall(swap.target, swap.value, swap.callData)`), balance-spliced iff
     `amountIn.source === 'balance'`, else route-bound fixed amount.
   - `approve(loan, morpho, 0)` then `approve(loan, morpho, balanceOf(exec))` — balance-based
     (over-approve by the LIF margin), zero-then-set.
3. Two trailing `skim` sweeps (loan token then collateral) to the EOA, running **after** `liquidate`
   returns so Blue's end-of-call repay pull is not stripped early.

The shared singleton must end every tx holding zero of either token; the dual sweep plus simulation
coverage enforce this. Blue liquidation is permissionless, so there is no gate to check against the
Executor and no per-market authorization to arrange.

### Config

Env vars (fail-loud on missing required):

| Var                                 | Required | Default | Purpose                                            |
| ----------------------------------- | -------- | ------- | -------------------------------------------------- |
| `CHAIN_ID`                          | yes      | —       | Must be in chain map (v0: Base `8453`)             |
| `RPC_URL`                           | yes      | —       | Primary RPC (reads, simulation, sends)             |
| `RPC_URL_FALLBACK`                  | no       | —       | Optional viem-dlc `failover` endpoint              |
| `LIQUIDATOR_PRIVATE_KEY`            | yes      | —       | EOA hex key (`0x` + 32-byte hex)                   |
| `EXECUTOOOR_ADDRESS`                | no       | derived | Override; default is the derived CREATE2 address   |
| `DATABASE_URL`                      | yes      | —       | Postgres for the co-located rindexer (discovery)   |
| `SWAP_CONFIG_PATH`                  | no       | —       | Per-collateral, per-venue swap params JSON         |
| `MAX_FEE_GWEI`                      | no       | `300`   | Hard ceiling for fee bumps                         |
| `ZEROX_API_KEY` / `ONEINCH_API_KEY` | cond.    | —       | Required iff a collateral uses that venue          |
| `MAX_ROUTE_IMPACT_BPS`              | no       | `500`   | Reject aggregator routes this far below oracle ref |
| `LOG_LEVEL` / `CACHE_DIR`           | no       | —       | Logging and local cache controls                   |

Chain map in `config.ts`: `{ [chainId]: { chain, morpho: Address } }`, fail loud when `CHAIN_ID` is
absent. v0 wires Base (8453), Morpho = `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` (the canonical
singleton, identical on every chain). The deployless lens needs no per-chain deployer (soltag bakes
the CREATE2 factory); `Executor.with()` gives the derived `EXECUTOOOR_ADDRESS`. Startup validation:
parse the key, zod-validate the swap config, resolve `EXECUTOOOR_ADDRESS`, then `assertContractDeployed`
for **both** the Executor and the Morpho singleton, and validate venue-key presence.

### Hosting

The bot, its co-located rindexer, and Postgres deploy to **Railway** in one project. A shared
multi-stage `Dockerfile` (a `BUILD_TARGET` build-arg selects the `bot` or
`rindexer` stage; the `abi` stage materializes `Morpho.json`) builds for both Railway and
`docker-compose`. An idempotent `scripts/deploy-railway.ts` drives the Railway CLI, piping secrets via
stdin (never argv, never logged). The swap config rides on a `/config` Railway volume the operator
uploads out-of-band; the bot boots without it (discovers + skips routed liquidations). Deploy
mechanics live in the script, `Dockerfile`, and README.

## Considered Alternatives

### Alternative 1: Sourcing `MarketParams` from the singleton instead of indexing `CreateMarket`

Read the market definition on-chain from its id.

**Why rejected:** impossible on Blue — the singleton stores only the mutable `Market` and never the
immutable `MarketParams`, and the id is a keccak hash (not invertible). `CreateMarket` is the only
source of the params, so it must be indexed. The lens re-derives `id == keccak256(abi.encode(params))`
to keep the same "never trust an off-chain market" guarantee.

### Alternative 2: Reading raw `borrowShares → assets` without simulating accrual

Convert debt against the last-written `totalBorrowAssets`/`Shares` from `market(Id)`.

**Why rejected:** Blue debt accrues every block; the stored totals are stale as of `lastUpdate`. A
position can cross into liquidatable purely from accrual, so a non-accruing lens produces false
negatives at the boundary. The lens replicates `MorphoBalancesLib.expectedMarketBalances`
(`borrowRateView` + `wTaylorCompounded`) to match `liquidate`'s internal view exactly.

### Alternative 3: Discovery via a hosted Morpho API/subgraph instead of a co-located rindexer

Refresh borrower positions from Morpho's hosted API/subgraph each tick.

**Why rejected:** adds an availability dependency on the liquidation hot path, and indexer lag should
not determine whether we send. A co-located rindexer gives the full universe from chain logs with no
external dependency; the lens reads every decision fresh, so lag is coverage latency only. Blue's
hosted infra is good, but the hot-path independence is the point.

### Alternative 4: Trust indexer state for the liquidation decision (skip the lens)

Size and decide straight off indexed `borrowShares`/`collateral`/health.

**Why rejected:** Blue accrues continuously, so a position's health changes _every block_ independent
of any transaction. Discovery says _who_ might be liquidatable; the lens, read fresh in one `eth_call`
against a single `block.timestamp` (accrual + oracle + position), says _whether it still is_.

### Alternative 5: Multicall instead of a deployless lens

Two/three multicalls (position, accrued balances, oracle) and skip soltag.

**Why rejected:** the accrual simulation needs `market`, `position`, the IRM rate, and the oracle
evaluated against one consistent `block.timestamp`; splitting them across multicalls invites
inconsistency and forces accrual math onto the host clock. The lens does it all in one `eth_call` and
returns exactly the struct the planner wants.

### Alternative 6: Repay-exact sizing (pin `repaidShares`) instead of seize-exact

Pin `repaidShares = borrowShares` and let Blue derive the seize.

**Why rejected:** the seize would then be contract-derived and unknown at encode time, which breaks
the fixed-amount aggregator branch (0x/1inch commit a sell amount off-chain). Seize-exact
(`min(collateral, seizeForFullDebt)`) keeps the Executor holding exactly what every venue sells, at
the cost of a few wei of residual debt on a full close — an accepted backstop trade-off.

### Alternative 7: Cron / one-shot topology; Alternative 8: Persistent queue state; Alternative 9: Multi-hop routing

Rejected because per-block reactivity is cheap, chain-truth-wins on restart makes persistence
fragile and unnecessary, and single-hop routing is an explicit v0 scope bound.

## Assumptions & Constraints

- The co-located rindexer keeps reasonable pace with Base; its lag is observability-only.
- `Borrow`'s indexed `onBehalf` covers every borrower, and `CreateMarket` captures every market's
  `MarketParams`. The lens re-derives the id from the params, so a forged/stale param set is rejected.
- The market's IRM implements `borrowRateView(marketParams, market)` and its output matches the
  state-changing `borrowRate` used by `_accrueInterest` (true for Blue's standard AdaptiveCurveIRM);
  `irm == address(0)` markets never accrue and are handled.
- The Morpho singleton is at `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` on Base, and the generic
  Executor is deployed at the derived CREATE2 address (fail-loud liveness check at startup).
- `oracle.price()` bakes both tokens' decimals into the `ORACLE_PRICE_SCALE`-relative price; sizing
  and P&L still use each token's real decimals. An oracle revert is "skip and retry," not "safe."
- The deployless transport's `exfil: 'revert'` path is preserved by the operator's RPC provider.
- Single-hop Uniswap-V3-compatible pools or aggregator routes exist for each collateral the operator
  opts into; unconfigured collaterals are skipped (`config.no_swap_path`).
- Base is Cancun-capable (the Executor uses transient storage / `mcopy`). One process per chain; the
  operator funds the EOA with native gas.

## Dependencies

- `@morpho-org/viem-dlc` (catalog): `deployless`, `failover`, `policy()`, `resolveArrayFunction`,
  codecs.
- `soltag` + `solc` (catalog, **runtime**): the preload compiles the lens on load.
- `executooor-viem` (catalog): `ExecutorEncoder` with the native `morphoBlueLiquidate` builder +
  `buildCall`/`balanceOf` placeholders.
- `viem` (catalog): clients, `createNonceManager` + `jsonRpc`, `call` (simulation), `keccak256` /
  `encodeAbiParameters` (id derivation), send/receipt/block helpers.
- `zod` (catalog): swap-config discriminated union.
- `@repo/contracts` (workspace): **new** `MorphoAbi` + vendored `IMorpho.sol`; the reused generic
  `Executor` (`.with()` factory); materialized `abis/Morpho.json` for rindexer.
- `@repo/utils` (workspace): `tryCatch`, `addressSchema`, `allFulfilled`, `delay`,
  `parseJsonResponse`, plus the shared deployless batch-lens helper used by the lens fetcher.
- Out-of-repo: the co-located rindexer Postgres + `rindexer` image (indexing `CreateMarket` +
  `Borrow`); the deployed Executor singleton; the Morpho singleton; the 0x + 1inch APIs.

## Observability

JSON-line via `logger.ts`: `startup`, `runner.start/shutdown`, `block.new`, `rindexer.lag`,
`lens.read`, `plan.built`, `simulate.ok/revert`, `tx.sent/bumped/confirmed/dropped/reverted`,
`tick.end`, `tick.error`, `watcher.error`, `shutdown`, plus quoting keys (`quoting.startup`,
`quote.failed`, `quote.bad_route`, `backoff.skip`, `config.no_swap_path`). `tick.end` counters:
`pairs, liquidatable, planned, noSwapPath, quoteFailed, badRoute, backoffSkipped, ok, reverted,
submitted`. Logs go to stdout/stderr (Railway captures both); BetterStack forwarding + Slack
alerting are deferred to v1, and the keys are designed to ship as-is.

_Update (2026-07-14): the BetterStack log-forwarding half is now implemented additively — see
[TIB-2026-07-14-betterstack-log-forwarding](./TIB-2026-07-14-betterstack-log-forwarding.md)._

## Security

- **Private key** read from env once at startup; never logged or written to disk.
- **No liquidator gate** — Blue is permissionless, so there is no `canLiquidate` check whose subject
  could drift between layers.
- **Committed `MarketParams`.** The lens re-derives `id == keccak256(abi.encode(params))`, so a forged
  or stale market definition can't slip into a `liquidate` call.
- **Swap slippage.** `amountOutMinimum` from the fresh oracle value via per-collateral `slippageBps`,
  plus the free `MAX_ROUTE_IMPACT_BPS` route-quality guard; a bad swap reverts atomically inside
  `liquidate` and the whole tx reverts — no loss.
- **Full drain of the shared singleton.** Dual-token sweep + `simulate()` residual check enforce a
  zero ending balance; a missing-sweep regression fails closed in sim.
- **Permissionless singleton — caller-side defenses.** Zero-then-set approve pairs (no standing
  allowance; no DoS on approve-from-nonzero tokens), balance-based repay approval, and the
  `simulate()` ok-only gate as the trust boundary for opaque aggregator calldata.
- **API-key hygiene.** Keys are env-only, read at point of use, never on `Config` (which is logged)
  and never in `swap.json`; the HTTP client strips query/headers from error logs.
- **Broadcast path.** Send through a normal RPC that relays — **not** `rpc.morpho.dev/realtime`,
  which acknowledges sends but never relays them.

## Future Considerations

- A profitability gate; MEV-aware venue selection; multi-hop / path-depth routing; additional venues
  (Odos, Universal Router).
- **SQL-layer candidate pruning.** v0 indexes only `CreateMarket` + `Borrow` and never prunes;
  indexing `Repay`/`WithdrawCollateral`/`Liquidate` to expire closed positions is a scale follow-up.
  The candidate set grows monotonically, the lens re-reads `hasDebt=false` rows every block, and
  immutable `MarketParams` can be cached per `Id` and the market read deduped per `Id`.
- Richer observability (BetterStack traces + Slack alerts) — deferred to v1.
- Throughput under a large liquidation wave (single-EOA nonce serialization; sequential
  simulate/receipt loops) and RPC-usage scaling. Partially addressed (CRTR-2807): the `liquidate`
  transform now backs off a position whose attempt fails to produce a submittable tx
  (`no_config`/`quote_failed`/`sim_reverted`), skipping re-quoting for
  `POSITION_LIQUIDATION_COOLDOWN_MS` (opt-in, default 0 = off) — so a persistently-failing position
  stops re-hitting the rate-limited venue APIs every tick.
- Multi-chain: the chain map is deliberately multi-chain-ready; Ethereum mainnet (largest Blue TVL)
  and other Blue chains are a config + deploy follow-on, one process per chain.
- Pre-liquidation support (Morpho's `PreLiquidation` contracts) as a distinct future mechanism.

## Open Questions

- **Seize-exact underflow safety — must prove before go-live.** The debt-binds rule pins
  `seizedAssets = seizeForFullDebt` and relies on Blue's ceil-derivation yielding
  `repaidShares ≤ borrowShares` (no `position.borrowShares` underflow). Prove this against the exact
  `Morpho.sol` `seizedAssets → repaidShares` derivation and brute-force-sweep it. If it does not hold
  universally, fall back to repay-exact (`repaidShares = borrowShares`) on the debt-binds branch and
  accept aggregator seize drift there.
- **Lens gas calibration — open.** The inline `BatchGasConfig` coefficients are placeholders;
  calibrate on a Base fork, including a market on the standard AdaptiveCurveIRM (the accrual sim is
  the dominant per-element cost), before go-live.
- **IRM coverage — likely resolved.** The lens calls `borrowRateView` generically, so any conformant
  IRM works; verify the standard AdaptiveCurveIRM on a fork and confirm behavior for `irm ==
address(0)` markets.
- **Executor deployment — likely resolved.** Reuse `@repo/contracts`' deterministic CREATE2 deploy
  script.

## Verification

- `bun install` (catalog `soltag`/`solc`/`executooor-viem`/viem-dlc); `bun run --filter
@morpho-org/blue-liquidation typecheck` (0 errors, soltag first); `bun lint` (0 warnings);
  `bun test` (all pass).
- Unit tests: `lifFromLltv` across LLTV range (incl. the `MAX_LIQUIDATION_INCENTIVE_FACTOR` cap); the
  accrual replication matches `expectedBorrowAssets` on captured fixtures (incl. `irm==0`); the health
  boundary with virtual shares/assets and exact rounding; the seize-exact planner across debt-binds /
  collateral-binds / degenerate branches; **the `repaidShares ≤ borrowShares` underflow-safety
  property** on the debt-binds branch (a brute-force sweep against the contract derivation, per Open
  Questions); the id-commitment check rejecting mismatched params; nonce queue (parallel assignment,
  ≥12.5% bump, `inflightLabels` backpressure); venue adapters against fixture JSON; discovery SQL (the
  `Borrow × CreateMarket` join + lag query).
- Anvil fork suite (`test/fork/`): fork Base, use a real unhealthy (or accrual-crossed) Blue position,
  deploy the Executor via the CREATE2 factory, drive lens → plan → quote → `encodeLiquidationExec` →
  `simulate` → signed broadcast; assert receipt success, the EOA gains the loan token, and the
  Executor ends holding **zero** of both tokens. A separate underwater fixture asserts the
  collateral-binds path drives `position.collateral` to 0 and socializes the residual (supplier
  `totalSupplyAssets` drops). Separately: queue bump + replacement against a real node.
- Per-test vacuity check (flip one assertion, confirm failure, revert). Smoke run on Base ≥1 h;
  observe `tick.end` cadence and no orphaned `pending` on SIGTERM.

## References

- [TIB-2026-05-28: Midnight liquidation bot — v0](./TIB-2026-05-28-midnight-liquidation-bot.md) —
  related liquidation-runner decision.
- [TIB-2026-06-29: Midnight liquidation bot — multi-venue swap support](./TIB-2026-06-29-midnight-multi-venue-swaps.md)
  — related multi-venue swap decision.
- Morpho Blue: `https://github.com/morpho-org/morpho-blue` — `src/Morpho.sol` (555 lines),
  `src/libraries/ConstantsLib.sol` (LIF constants), `src/libraries/periphery/MorphoBalancesLib.sol`
  (accrual simulation).
- Morpho addresses (canonical singleton `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb`):
  `https://docs.morpho.org/get-started/resources/addresses/`.
- `executooor-viem` (native `morphoBlueLiquidate` encoder): `https://www.npmjs.com/package/executooor-viem`.

### 2026-07-10 — persistent runner superseded by the pipeline architecture

[TIB-2026-07-13 (bot architecture)](./TIB-2026-07-13-bot-architecture.md) replaces this bot's
persistent runner with one-shot pipeline ops driven by unix loops; the market-params cache persists
between runs as a chain-truth-reconciled hint, and the transaction queue/nonce state now lives in
the per-chain `morpho-queued` daemon. Discovery (rindexer/Postgres) is unchanged; the indexer now
lives at `deploy/blue-rindexer`.

### 2026-07-16 — pipeline reverted; persistent runner restored

The pipeline architecture above was reverted (see
[TIB-2026-07-16-revert-to-bots-as-programs](./TIB-2026-07-16-revert-to-bots-as-programs.md)). This
bot is again a standalone long-running program with an in-process block-watcher + runner loop and an
in-process pending-tx queue. The transaction queue/nonce state now persists under `BOT_STATE_DIR`
(default `~/.morpho-bots`, reconciled against chain truth on boot) via `@repo/bot-kit` rather than a
`morpho-queued` daemon; the rindexer + its `rindexer.yaml` live back under `bots/blue-liquidation/`
(no `deploy/blue-rindexer`). The market-params chain-truth reconciliation is preserved.

<!--
TIB conventions:
- Once accepted, do not substantively edit this TIB. If the decision needs to change,
  create a new TIB that supersedes this one and update the Status/Superseded by fields.
- Addenda may be appended to record operational updates that affect
  how the TIB is applied without changing the decision itself.
- TIB identifiers use CalVer (YYYY-MM-DD) based on the date the TIB was first drafted.
-->
