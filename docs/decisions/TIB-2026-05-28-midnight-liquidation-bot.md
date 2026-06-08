# TIB-2026-05-28: Midnight liquidation bot — v0

| Field      | Value                            |
| ---------- | -------------------------------- |
| **Status** | Proposed                         |
| **Date**   | 2026-05-28                       |
| **Author** | @hayden                          |
| **Scope**  | App: `bots/midnight-liquidation` |

---

## Context

Morpho Midnight is a multi-collateral, maturity-aware credit primitive. A position is
liquidatable when `debt > 0` AND `!locked` AND (it is unhealthy OR past maturity). Two things
make sizing meaningfully harder than on Morpho Blue:

- **Multi-collateral.** A `Market` carries up to 128 `CollateralParams` slots — each with its
  own `lltv`, `maxLif`, and oracle — and a borrower may activate up to 16 of them. Health and
  seize-amount are sums / argmaxes across the activated set.
- **Maturity-aware incentive.** In post-maturity mode the liquidation incentive factor (LIF)
  ramps linearly from 1× to the slot's `maxLif` over the 15 minutes following maturity, so the
  same position is worth different amounts at different blocks.

(For the one-paragraph elevator pitch and the rationale behind each pillar below, see the
companion `docs/midnight-liquidation-bot-exec-summary.md`.)

We build for two readers:

1. **Integrators** copying it as a reference implementation — the health, liquidatability, and
   LIF + RCF sizing logic must read as documentation.
2. **Ourselves** running it as a fallback that catches positions the competitive ecosystem
   misses. It must _work_, not be _competitive_.

Three architectural choices anchor the design:

- **Discovery via the Morpho Midnight API** (`https://api.morpho.dev/v1/midnight/*`): paginated
  borrow positions, each carrying its `Market` config inline. The position set implies the
  market set, so we never fetch `/markets` and never touch `eth_getLogs`.
- **Decisions via a `soltag`-authored lens** read through `@morpho-org/viem-dlc`'s `deployless`
  transport. Anything the liquidation decision depends on is read fresh from `eth_call`; the API
  drives discovery and config only.
- **Execution via a modified [`Rubilmax/executooor`](https://github.com/Rubilmax/executooor)**
  (vendored under `contracts/executooor/`): the owner gate is stripped to make it a permissionless
  shared singleton, plus one `onLiquidate` handler that runs the single-hop swap. The two
  modifications, and the reason the handler is mandatory, live in §Executooor integration.

## Goals / Non-Goals

**Goals**

- Long-running daemon, single chain per process, that reliably liquidates **every** position
  that becomes liquidatable while it is running.
- Correct sizing: maturity-aware LIF curve and pre-maturity RCF cap (with the
  `rcfThreshold` exemption). Collateral picked by USD value, freshly read in the same eth_call
  as the liquidatable check.
- Callback-swap execution from day one. Single-hop only (one Uniswap-V3-style pool); routing
  config is operator-supplied per collateral, the bot does not search paths.
- Simple in-memory nonce queue: parallel submit at distinct nonces, EIP-1559 fee bump on
  stuck nonces, hard ceiling that drops rather than chases gas spikes.
- Reusable as a reference implementation — the health/liquidatability/sizing math reads
  cleanly as documentation.

**Non-Goals**

- Profitability gating, MEV-aware bidding, private mempools. We submit every sim-ok plan.
- Multi-hop swap routing. Operator picks one pool per collateral; volatile assets get
  conservative slippage or are simply omitted from the config.
- Multi-chain in a single process. One process per chain; horizontal scale via deployments.
- Flashloan-funded liquidations. The Executor is funded by the seized collateral alone via
  the in-line swap; no external borrow.
- Custom callback Solidity beyond the two modifications in §Executooor integration (strip the
  owner gate; add one mandatory `onLiquidate` handler). No support for the other Midnight
  callbacks (`onBuy` / `onSell` / `onRepay` / `onFlashLoan`). Solidity lives at
  `contracts/executooor/`.
- Persisting queue state across daemon restarts. Chain truth wins; we re-derive on startup.
- Replacing `@repo/utils` or `@repo/abis` patterns. Reuse them as-is.

## Proposed Solution

### Module shape

Solidity lives at the repo root:

```
contracts/executooor/
  Executor.sol         // vendored from Rubilmax/executooor: owner gate stripped +
                       // minimal onLiquidate(...) handler returning CALLBACK_SUCCESS
  interfaces/          // upstream + ILiquidateCallback / ILiquidatorGate from Midnight
```

The bot lives under `bots/midnight-liquidation/src/`:

```
config.ts            // env + JSON file + per-chain Midnight/deployer map; fail loud
index.ts             // boot: loadConfig → daemon.start(); SIGTERM handler
constants.ts         // TIME_TO_MAX_LIF=900, WAD=1e18, ORACLE_PRICE_SCALE=1e36,
                     // MAX_COLLATERALS_PER_BORROWER=16, CALLBACK_SUCCESS, etc.

daemon/
  daemon.ts          // start/stop; wires modules; owns lifecycle
  tick.ts            // pure orchestrator: takes injected deps, runs one tick
  watcher.ts         // setInterval-driven getBlockNumber poll → coalesced new-block queue
                     // (HTTP only; no WebSocket transport, no eth_subscribe)

api/
  openapi.json       // vendored OpenAPI spec (regenerated via a bun script)
  generated.ts       // openapi-typescript output (gitignored or checked in; pick one)
  client.ts          // openapi-fetch client + tryCatch boundary; per-request error normalization
  pagination.ts      // pure: async-generator over { data, cursor }
  positions.ts       // listBorrowPositions({ debt_gte }); each row carries its Market config,
                     // so the distinct markets fall out of the position set (no /markets call)
  chains.ts          // getIndexerStatus() for staleness gate

lens/
  lens.sol.ts        // single file: soltag template, input/output codecs, inline
                     // gas constants, and the exported readMidnightLiquidationLens fetcher
  read-deployless-batch-lens.ts  // vendored from prime-monorepo
                                 // packages/resolvers/src/rpc/; helper that wraps
                                 // viem-dlc's policy() + single-array-in/out pattern

sizing/
  lif.ts             // pure: lifAt(now, maturity, maxLif, postMaturityMode) → bigint
  rcf.ts             // pure: maxRepaidPreMaturity + exemption check (normal mode only)
  plan.ts            // pure: LensOut → LiquidationPlan (picks postMaturityMode)
  bitmap.ts          // activeBits (shared with lens decoder)

execution/
  encode-call.ts     // pure: LiquidationPlan + SwapStep + recipient → Executor.exec(bytes[]) calldata
                     // (single liquidate(callback=executor,receiver=executor) + trailing sweeps)
  simulate.ts        // tryCatch around simulateContract; returns gas + status
  build-tx.ts        // pure: plan + swap → signed Transaction request

queue/
  pending-queue.ts   // in-memory Map<nonce, Pending>; submit / bump / drop / onBlock
                     // (nonce assignment delegated to viem's createNonceManager)
  fee-policy.ts      // pure: EIP-1559 bump ≥12.5%; ceiling enforcement
```

Pure modules are unit-tested; everything that touches `PublicClient` / `fetch` / `process` is
covered by integration tests on anvil.

### Implementation Phases

- **Phase 1 — API discovery (no chain work).** Land `api/`, `config.ts` v2 envs, and an
  `index.ts` dry-run that prints "would attempt" liquidations against API filters only. No
  lens, no signer. Pagination, indexer-lag gate, fail-loud config — all unit-testable. Ships
  as a stronger v1.

- **Phase 2 — Lens + sizing (still read-only).** Author the soltag lens, wire the deployless
  transport, replace v1 eligibility + sizing with the lens path. Plans are now correct and
  fresh; `simulateLiquidate` is the sink. End-to-end smoke on a chain with Midnight deployed.

- **Phase 3 — Daemon + nonce queue + signed sends.** Add `daemon/`, `queue/`, signer wiring.
  Encode a _dummy_ callback target that reverts deterministically (so we exercise the queue
  and bumping without swapping). Verify replacement via deliberately-underpriced first send.

- **Phase 4 — Callback wiring + swap config.** Plug in the real `EXECUTOOOR_ADDRESS` and the
  per-collateral swap config. Run on a testnet against a real Uniswap V3 pool. Go-live gate.

### API client design

Types are generated from the OpenAPI spec — no hand-rolled DTOs. We use
[`openapi-typescript`](https://openapi-ts.dev/) (dev-only) to emit a single `generated.ts`
file from the spec, and [`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/) (~5 KB
runtime) as the typed `fetch` wrapper. Both are zero-runtime-magic — `openapi-fetch` is just
typed `fetch` keyed by path + method, and the generator never produces classes or factories.

**Spec sync.** Port `scripts/pull-schemas.ts` from `apps/markets-v2-app` in `prime-monorepo`.
It's an interactive CLI (`prompts`-driven). The Morpho API and the Router live under the same
domain (`api.morpho.dev`), and the Midnight API serves a first-class OpenAPI document, so we
use the `json` parser mode: fetch the OpenAPI spec straight from the endpoint, same as any
other upstream. Both `openapi.json` and `generated.ts` are committed.

Run manually only — never wire into CI or `prebuild`. The build must stay offline so a flaky
upstream can't break it, and schema updates land as reviewable diffs. Drop-in port: same
shape, swap `pnpm`-isms for `bun`, point at our `src/api/openapi.json` output path.

**Client.** `api/client.ts` exports a single `createApiClient(baseUrl)` that wires
`openapi-fetch` against the generated `paths` type (with a `User-Agent` header), plus a thin
`apiCall<P, M>(client, path, method, params)` helper that `tryCatch`-wraps requests, normalizes
4xx/5xx into a discriminated error (per the API's `MidnightErrorResponseDto`), and rejects
non-JSON responses (e.g. HTML 502 pages). No second cache layer — the API's
`Cache-Control: public, max-age=2, stale-while-revalidate=1` is exactly the freshness we want
per tick.

**Pagination.** A single pure async generator, `paginate(fetchPage)`, wraps the cursor protocol
shared by `/positions` and `/activities` (both return `{ cursor, data }`), with a hard cap of
100 pages as a circuit breaker. `positions.ts` and `chains.ts` are thin wrappers that bind the
typed client into `paginate(…)` and return arrays / single objects. The generated types do all
the parameter checking; we don't add Zod.

**Discovery cadence.** Positions are refreshed every tick via
`/v1/midnight/positions?type=borrow&debt_gte=1&limit=200`. Each row carries its
`Market` config inline, so the distinct markets fall out of the position set for free
— no separate `/markets` fetch and no `MarketIndex` TTL to manage. (A market with zero open
borrow positions has nothing to liquidate, so it never needs to appear.)

Before trusting a tick's positions, we call `/v1/midnight/chains` and compare
`latest_indexed_block` against our block-poll cursor:

- lag ≤ 5 → proceed silently
- lag ≤ 30 → log `warn api.lag`, still proceed
- lag > 30 → log `error api.lag`, skip the tick

### Lens design (soltag)

A single elementwise function — required by viem-dlc's `resolveArrayFunction` (one dynamic
array in, one dynamic array out):

```solidity
function lens(bytes[] calldata input) external view returns (bytes[] memory output)
```

**Input element** (per pair): `abi.encode(Market market, bytes32 id, address borrower, address caller)`.

- The lens validates the `(market, id)` pairing by calling `Midnight.toId(market)`
  (public view, `midnight-contracts.txt:2590`) and comparing against `id` — any mismatch sets
  `valid: false` (do not revert; would break the whole batch). **Do not re-implement the hash
  off-chain**: the id is a CREATE2-style double hash
  (`keccak256(abi.encodePacked(0xff, midnight, chainId, keccak256(abi.encodePacked(SSTORE2_PREFIX, abi.encode(market)))))`,
  `IdLib.toId`, `:339`) salted by the contract's **`INITIAL_CHAIN_ID`** (captured at
  construction, _not_ live `block.chainid`), so delegating to `Midnight.toId` is both simpler
  and immune to a chain-id mismatch.
- `caller` is the address whose `canLiquidate` we want checked. **This is the
  `EXECUTOOOR_ADDRESS`, not the EOA** — `Midnight.liquidate` checks
  `market.liquidatorGate == address(0) || ILiquidatorGate(market.liquidatorGate).canLiquidate(msg.sender)`
  (`midnight-contracts.txt:2317`), and `msg.sender` will be the executooor singleton (it is the
  contract that calls `liquidate`). Getting this wrong is the most likely subtle bug if we forget.

**Output element** (per pair):

There is **no `Midnight.isLiquidatable`** — the lens composes liquidatability from
`isHealthy(market, id, borrower)` (`:2663`), `liquidationLocked(id, borrower)` (`:2656`), the
position debt, and `market.maturity`:

```solidity
struct LensOut {
  bool    valid;                  // id == Midnight.toId(market)
  bool    hasDebt;                // position.debt > 0
  bool    healthy;               // Midnight.isHealthy(market, id, borrower) → maxDebt >= debt
  bool    locked;                // Midnight.liquidationLocked(id, borrower)
  bool    gateAllows;             // liquidatorGate==0 ? true : canLiquidate(caller) try/catch→false
  uint64  blockTimestamp;         // for LIF eval + the now>maturity test; avoid host clock drift
  uint128 debt;
  uint128 maxDebt;                // Σ collateral_i · price_i · lltv_i (over activated slots)
  uint128 badDebt;                // debt.zeroFloorSub(Σ collateral_i · price_i · WAD / maxLif_i);
                                  //   liquidate() writes this off before sizing — see rcf.ts
  uint128 activatedBitmap;        // position.collateralBitmap (≤16 bits set)
  uint8   bestCollateralIdx;      // argmax over activated slots by USD value
  uint128 bestCollateralAmt;      // position.collateral[bestCollateralIdx]
  uint256 bestCollateralUsd;      // USD18 value
  uint256 bestCollateralPrice;    // raw oracle price (ORACLE_PRICE_SCALE units)
  uint256 bestCollateralMaxLif;   // market.collateralParams[bestCollateralIdx].maxLif
  uint256 bestCollateralLltv;     // market.collateralParams[bestCollateralIdx].lltv
}

// Off-chain, liquidatable = hasDebt && !locked && (now > maturity || !healthy).
//   `!healthy` is exactly the contract's pre-maturity test `debt > maxDebt` (isHealthy returns
//   maxDebt >= debt); post-maturity needs only now > maturity. Mirrors the requires in
//   liquidate(...) at midnight-contracts.txt:2315 (debt > 0) + 2339-2342.
//
// RCF exemption (normal mode only) is computed off-chain from the fields above:
//   exempt = (bestCollateralAmt × bestCollateralPrice / ORACLE_PRICE_SCALE × WAD / lif)
//              .zeroFloorSub(maxRepaid) < market.rcfThreshold
// — i.e. it tests the *liquidated* slot's pre-seizure value (expressed in repaid-units after
// dividing by LIF, then subtracting maxRepaid), per midnight-contracts.txt:2381-2385. It does
// not depend on any other slot, so the lens does not return a separate field for it.
```

This gives us everything to (a) confirm liquidatable fresh, (b) pick the slot, (c) compute
`seizedAssets` / `repaidUnits` respecting LIF + RCF, (d) pass the `Market` struct straight into
the `liquidate` call (already have it from the API; the `valid` flag confirms `toId(market) == id`).

**Colocated single file.** `lens/lens.sol.ts` contains the entire lens module in one place:

1. The Solidity source as a `soltag` tagged template (compiled at build time to a `factory`
   - `factoryData` pair).
2. Input + output codecs (`encodeAbiParameters` for the `(Market, id, borrower, caller)` input
   tuple; struct decoder for `LensOut`).
3. Inline `BatchGasConfig` — calibrated `{ constant ≈ 50_000, linear ≈ 150_000, quadratic ≈ 0
}` empirically on a fork, with per-chain overrides; document the calibration method in a
   comment in the same file.
4. An exported `readMidnightLiquidationLens(client, pairs): Promise<Map<key, LensOut>>`.

The fetcher delegates to the vendored `readDeploylessBatchLens` helper (copied from
`packages/resolvers/src/rpc/read-deployless-batch-lens.ts` in `prime-monorepo`). That helper:

- Type-checks the lens function shape (single dynamic array in, single dynamic array out — matches our `lens(bytes[]) → bytes[]`).
- Wraps `viem-dlc`'s `policy(...)` sentinel and `readContract` so the deployless transport
  recognizes and chunks the call.
- Returns a `Map<K, V>` keyed by a user-supplied `key(input)` fn and valued by a user-supplied
  `value(input, output)` fn.
- Threads per-chain gas overrides via `BatchGasConfig`.

We vendor it (one file copy) rather than depend on a new shared package; if a second bot
needs it later we promote to `@repo/utils` or upstream into `@morpho-org/viem-dlc`.

### Sizing math

All pure, mirror the contract verbatim. `now = LensOut.blockTimestamp` (chain time, not host).
`maxLif` and `lltv` are **per-collateral** — read from `market.collateralParams[collateralIndex]`,
not from the market. The liquidator chooses `postMaturityMode` (see `plan.ts` below); the LIF
ramp applies only in that mode (`midnight-contracts.txt:2362-2366`).

**Debt fidelity.** `liquidate` reads raw `_position.debt` (`:2323`) with no pre-accrual step, and
`isHealthy` (`:2663`) uses the same field; continuous fees accrue into `credit` / `pendingFee` /
`continuousFeeCredit` (`updatePositionView`, `:2516-2538`), **never** into `debt`. So the lens
reading raw `position.debt` is exactly faithful to what `liquidate` computes — no fee field is
needed in `LensOut`.

```ts
// sizing/lif.ts — mirrors midnight-contracts.txt:2364-2366
function lifAt(now: bigint, maturity: bigint, maxLif: bigint, postMaturityMode: boolean): bigint {
  if (!postMaturityMode) return maxLif                           // normal mode: full incentive
  // post-maturity mode: linear ramp WAD → maxLif over TIME_TO_MAX_LIF
  const lif = WAD + ((maxLif - WAD) * (now - maturity)) / TIME_TO_MAX_LIF
  return lif < maxLif ? lif : maxLif                             // min(maxLif, …)
}

// sizing/rcf.ts — normal mode only (no cap in post-maturity mode).
// Mirrors midnight-contracts.txt:2378-2380, with one subtlety: when the position carries bad
// debt, liquidate() writes it off (`_position.debt -= badDebt`, :2344-2346) BEFORE computing
// maxRepaid, so the cap is taken against the *post-writeoff* debt. We pass the lens's `badDebt`
// (= debt.zeroFloorSub(Σ collateral·price·WAD/maxLif), :2326-2334) and subtract it here so our
// cap matches the contract's exactly:
//   maxRepaid = ((debt - badDebt) - maxDebt).mulDivUp(WAD*WAD, WAD*WAD - lif*lltv)
function maxRepaidPreMaturity(
  debt: bigint, badDebt: bigint, maxDebt: bigint, lif: bigint, lltv: bigint
): bigint {
  if (lltv >= WAD) return MAX_UINT
  const effectiveDebt = debt - badDebt          // = min(debt, Σ collateral·price·WAD/maxLif)
  // mulDivUp(x, y, d) = ceilDiv(x * y, d). effectiveDebt >= maxDebt (and the denominator stays
  // positive) because maxLif is derived from lltv as WAD²/(WAD - cursor·(WAD-lltv)), which makes
  // maxLif·lltv <= WAD² for every allowed lltv < WAD (:997, :2487).
  return mulDivUp(effectiveDebt - maxDebt, WAD * WAD, WAD * WAD - lif * lltv)
}

// RCF cap is waived for the SAME slot being liquidated when the slot's pre-seizure value
// (converted to repaid-units by dividing through LIF, then subtracting maxRepaid with a
// zero floor) is below rcfThreshold. Mirrors midnight-contracts.txt:2381-2385 exactly.
function isRcfExempt(
  bestCollateralAmt: bigint,
  bestCollateralPrice: bigint,   // ORACLE_PRICE_SCALE units
  lif: bigint,
  maxRepaid: bigint,
  rcfThreshold: bigint
): boolean {
  const slotInLoanUnits =
    floorDiv(bestCollateralAmt * bestCollateralPrice, ORACLE_PRICE_SCALE)
  const slotInRepaidUnits = floorDiv(slotInLoanUnits * WAD, lif)
  const residual = zeroFloorSub(slotInRepaidUnits, maxRepaid)
  return residual < rcfThreshold
}
```

`sizing/plan.ts` first picks the mode, then the amounts. **Mode policy:** if
`now > market.maturity` → `postMaturityMode = true` (works regardless of health; gets the
ramped LIF, no RCF cap); else require unhealthy (`debt > maxDebt`) and use
`postMaturityMode = false` (full `maxLif`, RCF cap applies). It then chooses between
`{ seizedAssets, repaidUnits=0 }` and `{ seizedAssets=0, repaidUnits }`:

- `postMaturityMode` (past maturity) → `seizedAssets = bestCollateralAmt` (100% of slot); no cap.
- normal mode, no cap binding (or RCF-exempt) → `seizedAssets = bestCollateralAmt` (100% of slot).
- normal mode with cap binding (and not exempt) → `repaidUnits = maxRepaid`.
- otherwise (not liquidatable: no debt, locked, or healthy-and-pre-maturity) → skip.

The `badDebt` correction in `maxRepaidPreMaturity` only matters for the third branch (normal mode,
cap binding). The post-maturity path takes 100% of the slot with no cap, sidestepping `maxRepaid`
entirely; and even if the correction were wrong, an over-large `repaidUnits` fails closed in
`simulate()` rather than on-chain — a missed liquidation, never a loss.

### Tx queue

**Nonce assignment is delegated to viem's `createNonceManager`** (`viem/nonce`, with a `jsonRpc()`
source, attached to the `privateKeyToAccount`) — no hand-rolled counter. Parallel
`walletClient.sendTransaction(...)` calls then claim sequential nonces automatically; the manager
syncs from `getTransactionCount('pending')` on first use and re-syncs whenever an error indicates
drift. That gives us concurrent-safe assignment, restart safety (pulls from `'pending'`), and
out-of-band gap detection for free. Our queue does **not** own a `nextNonce` cursor.

`queue/pending-queue.ts` owns what viem's manager does not — tracking, confirmation, and
bump/replace — via an in-memory `Map<nonce, Pending>`. Each `Pending` carries its `nonce`,
`txHash`, the source `plan`, `submittedAtBlock`, the current `maxFeePerGas` /
`maxPriorityFeePerGas`, an `attempt` counter, and a `state` of `sent | confirmed | replaced |
dropped`.

**Submit.** `walletClient.sendTransaction({ ... })` — viem claims the next nonce via the
manager. We read the assigned nonce from the request (viem exposes it on the returned
transaction object via `prepareTransactionRequest`) and record the entry. No awaiting needed
between submits.

**Fee bump.** Pure `bumpFees({ maxFeePerGas, maxPriorityFeePerGas, baseFee })`:

- new priority = max(prev × 1125/1000, prev + 1) // ≥12.5% EIP-1559 floor
- new max = max(prev × 1125/1000, baseFee × 2 + new priority)
- both capped at `MAX_FEE_GWEI`; beyond cap → `drop()` rather than chase

**Replacement.** When we bump, we **explicitly pass `nonce: pending.nonce`** to
`sendTransaction` — bypassing the nonce manager (which only acts when `nonce` is unset). This
is the one case where we hand-pick the nonce.

**Stuck detection.** Each polled block, scan `pending` for `currentBlock - submittedAtBlock

> STUCK_BLOCKS (4)`and not yet confirmed. Fetch receipt; null → bump + replace at same
nonce,`attempt++`. After `MAX_BUMP_ATTEMPTS (3)`, log `tx.dropped` and remove from our map.

**Drift / gap awareness.** Viem's nonce manager re-syncs from chain on send errors. If a
confirmation from a higher nonce arrives while a lower nonce is still pending, we walk
lower-nonce pending entries, query their receipts, and mark each
confirmed-elsewhere/replaced/dropped accordingly. No `nextNonce` math on our side.

**Reorg awareness.** Deliberately none beyond receipt re-confirmation. Acceptable for a
coverage bot — a re-orged-out tx re-appears as a liquidatable position on the next tick.

**Shutdown (SIGTERM/SIGINT).** Stop the watcher, stop accepting new plans, log a final dump
of `pending` (hashes + nonces), exit after a 5 s drain window. Pending txs continue on-wire;
chain truth wins on restart.

### Tick loop

`daemon/watcher.ts` runs a `setInterval(getBlockNumber, BLOCK_POLL_MS)` loop (default 2 s)
against the HTTP RPC; WebSocket transports and `eth_subscribe` are explicitly avoided. On
each new block height it enqueues an event; if a tick is mid-flight, only the latest height
is processed next (backlog coalesces).

`daemon/tick.ts` per new block:

1. Indexer staleness gate (`/v1/midnight/chains`); skip tick if `lag > 30`.
2. Fetch borrow positions from the API (markets fall out of the position set inline).
3. Drop `(marketId, borrower)` pairs already non-terminal in the queue (backpressure — keep a
   small `inflight: Set<\`${marketId}:${borrower}\`>` owned by the daemon).
4. Call `readLens(pairs)`.
5. For each `valid && gateAllows && liquidatable` (liquidatable composed off-chain from
   `hasDebt && !locked && (now > maturity || !healthy)`): `plan()` → `simulate()` →
   `pendingQueue.submit()`.
6. `pendingQueue.onBlock(blockNumber)` — confirmations, stuck-detection, bumps.
7. Emit `tick.end` with counters.

### Executooor integration

We vendor [`Rubilmax/executooor`](https://github.com/Rubilmax/executooor) Solidity into
`contracts/executooor/Executor.sol` and apply **two modifications**:

1. Remove the `require(msg.sender == OWNER)` from `exec_606BaXt` — the contract becomes a
   permissionless shared singleton (any EOA can call `exec(Call[])`), and the `OWNER` immutable
   - constructor argument are dropped.
2. Add a minimal `onLiquidate(...)` handler. `Midnight.liquidate` takes an explicit `callback`
   address and **requires `ILiquidateCallback(callback).onLiquidate(...) == CALLBACK_SUCCESS`**
   (`midnight-contracts.txt:2417-2433`). The upstream bare fallback runs queued calls but does
   not return the magic value, so a real handler is mandatory. Its full shape
   (`midnight-contracts.txt:933`):

   ```solidity
   function onLiquidate(
     address caller, bytes32 id, Market memory market, uint256 collateralIndex,
     uint256 seizedAssets, uint256 repaidUnits, address borrower, address receiver,
     bytes memory data, uint256 badDebt
   ) external returns (bytes32);
   ```

   The handler: (a) `require(msg.sender == MIDNIGHT)` (re-entry gate — this replaces the
   self-call gate's role for the callback path); (b) decodes `data` into the swap step;
   (c) approves the router and swaps the `seizedAssets` collateral **argument**
   (already sitting on this contract, because we pass `receiver = address(this)`) into the loan
   token — `market.collateralParams[collateralIndex].token` → `market.loanToken`; (d) approves
   `MIDNIGHT` for the `repaidUnits` **argument** of the loan token so Midnight can pull the
   repay; (e) returns `CALLBACK_SUCCESS`. Note `seizedAssets` and `repaidUnits` are taken from
   the callback arguments, not from `data` — when the bot passes `seizedAssets=X, repaidUnits=0`
   the contract derives the final `repaidUnits` itself (`:2369`) and hands it to the callback,
   so reading it off the argument is the only correct source. The `call_g0oyU7o` self-call gate
   (`require(msg.sender == address(this))`) is otherwise unchanged.

Because `liquidate` sends the seized collateral to `receiver` **before** invoking the callback
and pulls the loan-token repay from `payer` (= `callback`) **after** it returns
(`midnight-contracts.txt:2415, 2436`), the swap and the Midnight approval both belong inside
`onLiquidate`. The outer `exec(Call[])` therefore needs just the `liquidate` call plus trailing
sweeps:

```
exec([
  call_g0oyU7o(midnight, 0, 0x00, encodeLiquidate(
    market, collateralIndex, seizedAssets, repaidUnits, borrower,
    postMaturityMode,
    /* receiver */ address(this),     // seized collateral lands here, pre-callback
    /* callback */ address(this),     // → onLiquidate runs the swap + approves Midnight
    /* data    */ abi.encode(swapStep) // swap params only; amounts come from callback args
  )),
  // Trailing sweeps — run AFTER liquidate() returns, so they don't strip the loan token
  // before Midnight's end-of-call transferFrom. Drain BOTH tokens so nothing is left behind:
  call_g0oyU7o(loanToken, 0, 0x00, skim(eoa)),       // swap proceeds minus the repay = profit
  call_g0oyU7o(collateralToken, 0, 0x00, skim(eoa))  // any collateral the swap didn't consume
])
```

**Full drain to the EOA — invariant.** The Executor is a shared, permissionless singleton, so
it must end every transaction holding **zero** of either token: anything left behind is up for
grabs by the next caller. The plan therefore ends with a sweep of **both** the loan token and
the collateral token to the calling EOA. Seizing 100% of a collateral slot and swapping all of
it into the loan token means the loan-token balance after repay is the bot's profit and the
collateral balance is normally zero — but we sweep collateral anyway to be defensive against
swap dust, partial fills, or a slot we under-seize. We use the upstream Executor's
`skim(token, recipient)`-style self-call helper (transfers the contract's _current_ balance, so
the encoder needs no balance prediction); both sweeps target the EOA. Belt-and-suspenders: the
liquidation `simulate()` reads the Executor's post-tx token balances and rejects any plan that
would leave a non-zero residual, so a missing-sweep regression fails closed in sim rather than
silently donating funds.

**TypeScript encoder.** Use [`executooor-viem`](https://www.npmjs.com/package/executooor-viem)
(the upstream `ExecutorEncoder`) where possible; add a thin Midnight-aware wrapper
(`execution/encode-call.ts`), `encodeExecForLiquidation(plan, step, recipient) → Hex`, that emits
the calldata for `Executor.exec_606BaXt(bytes[])` as the outer `(Midnight.liquidate, sweep
loanToken, sweep collateralToken)` sequence. The single `liquidate` call carries `receiver =
callback = EXECUTOOOR` and `data = abi.encode(step)`; `recipient` is the calling EOA both trailing
sweeps target. The swap and the Midnight loan-token approval ride inside the `data` and run in
`onLiquidate`, not as separate outer calls. Pure module, no RPC. The `step` is the per-collateral
swap — `router` (UniswapV3 `SwapRouter02` or compat), `tokenIn` (= collateral token), `tokenOut`
(= loan token), `fee` (500 / 3000 / 10000), and `amountOutMinimum` derived from the lens's fresh
USD value × `(10000 - slippageBps) / 10000`.

Per-collateral swap config at `SWAP_CONFIG_PATH`:

```json
{
  "<chainId>": {
    "<collateralToken>": { "router": "0x...", "fee": 500, "slippageBps": 50 }
  }
}
```

Missing entry → skip liquidation with `config.no_swap_path` log. The bot signs and broadcasts
`{ to: EXECUTOOOR_ADDRESS, data: encodeExecForLiquidation(plan, step, eoaAddress) }`, where
`eoaAddress` is the liquidator EOA that receives both trailing sweeps. The bot **never** calls
`Midnight.liquidate` directly.

**Gate whitelisting caveat.** `Midnight.liquidate` checks `canLiquidate(msg.sender)`, which
is the Executor address (not the EOA). Markets with non-trivial liquidator gates must
whitelist the singleton Executor. For markets we curate this is straightforward; for
third-party markets it becomes the gate owner's responsibility.

### Config

Env vars (fail-loud on missing required):

| Var                      | Required | Default                  | Purpose                                  |
| ------------------------ | -------- | ------------------------ | ---------------------------------------- |
| `CHAIN_ID`               | yes      | —                        | Must be in chain map                     |
| `RPC_URL`                | yes      | —                        | Primary RPC                              |
| `RPC_URL_FALLBACK`       | no       | —                        | Optional `failover` second endpoint      |
| `LIQUIDATOR_PRIVATE_KEY` | yes      | —                        | EOA hex key                              |
| `EXECUTOOOR_ADDRESS`     | yes      | —                        | Shared executooor singleton address      |
| `MIDNIGHT_API_URL`       | no       | `https://api.morpho.dev` | Base URL                                 |
| `SWAP_CONFIG_PATH`       | yes      | —                        | Per-collateral swap params JSON          |
| `MAX_FEE_GWEI`           | no       | `300`                    | Hard ceiling for fee bumps               |
| `CACHE_DIR`              | no       | `.cache`                 | Reserved; viem-dlc `NodeFsStore` if used |
| `LOG_LEVEL`              | no       | `info`                   |                                          |

Chain map in `config.ts`: `{ [chainId]: { chain, midnight: Address, deployer: Address } }` —
fail loudly when `CHAIN_ID` isn't present. The `deployer` is the stable CREATE2 deployer for
the deployless lens.

Startup validation: parse private key (0x + 32-byte hex), parse JSON swap config, verify
`EXECUTOOOR_ADDRESS` is a contract (`getCode` non-empty) — fatal on mismatch. Emit a one-line
`startup` log with chain id, EOA address, executooor address, midnight address.

## Considered Alternatives

### Alternative 1: Cron / one-shot topology

Run `main()` once per cron tick (every 30–60s), drain queue with a 5-minute internal wait,
exit. Matches v1's topology and ops surface area.

**Why rejected:** The daemon is barely more complex (a `setInterval`-polled
`getBlockNumber` loop wrapping the same tick function) and gives us per-block reactivity at
no extra cost. Cron would race itself when a queue drain runs long.

### Alternative 2: Use API for _everything_ including fresh state

The API exposes `debt`, `collaterals[]`, oracles, and (eventually) health. Could skip the
lens entirely.

**Why rejected:** The user's framing explicitly requires `eth_call` for any data needed for
the liquidation decision. The API is documented at 2 s freshness; a position can flip from
unhealthy → healthy or vice versa within a single block, and we don't want a 502 on the API
to determine whether we send a transaction. The API is for _discovery_ (who exists), the
lens is for _decisions_ (is it still true).

### Alternative 3: Multicall instead of a deployless lens

Continue v1's two-multicall pattern (one for gate, one for `isHealthy`) and add a third
for oracle reads. Avoids soltag entirely.

**Why rejected:** Three round-trips per tick at the wrong batch granularity, every value
fetched independently with no shared `block.timestamp`. The lens reads everything inside one
`eth_call`, evaluates LIF/RCF math against a single chain time, and returns exactly the
struct sizing wants. Multicall would force us to evaluate LIF using the host clock or a
separate `block.timestamp` read — both subtly wrong.

### Alternative 4: Persistent queue state across daemon restarts

Persist `pending` to disk via `NodeFsStore` so a restart can recover in-flight transactions.

**Why rejected:** Operationally fragile (stale state + chain divergence), and unnecessary —
`getTransactionCount('pending')` on init slots us above any in-flight tx, and the next tick
re-discovers the position if the tx was dropped. Chain is the source of truth.

### Alternative 5: Multi-hop swap routing inside the callback

Wire the callback to a path-aware router (Uniswap Universal Router, 0x).

**Why rejected:** Explicitly out of scope per the user's "single-hop, no routing" decision.
Volatile collateral configurations can use a permissive `slippageBps` or be omitted; the
fallback bot accepts coverage gaps over the complexity of routing.

## Assumptions & Constraints

- The Morpho Midnight API at `https://api.morpho.dev/v1/midnight/*` is reachable, public, and
  meaningfully tracks the chain (lag typically < 5 blocks).
- The `latest_indexed_block` field on `/v1/midnight/chains` is honest about indexer state.
- The API returns, for each market, the full `Market` struct and its `id` such that
  `Midnight.toId(market) == id` (the id is a CREATE2-style hash over the `Market`, salted by the
  contract's `INITIAL_CHAIN_ID`; the lens re-validates this rather than trusting the API).
- The modified Executor (`contracts/executooor/Executor.sol` in this repo — owner gate
  stripped) is deployed at `EXECUTOOOR_ADDRESS` on every supported chain.
- Markets we care about either have no `liquidatorGate` or have whitelisted the Executor.
- The deployless transport's `exfil: 'revert'` path is preserved by the operator's RPC
  provider (Alchemy / Infura preserve revert data; some self-hosted nodes do not — verify
  before deploy).
- Single-hop Uniswap-V3-compatible pools exist for each collateral the operator opts into.
- The operator funds the EOA with native gas, runs one process per chain, and manages the
  swap config file out-of-band.

## Dependencies

- `@morpho-org/viem-dlc@0.0.11` (in `workspaces.catalog`): `deployless`, `failover` transports;
  `policy()`, `factorisedFactoryCall`, `wrapDeploylessFactoryCall`, `resolveArrayFunction`,
  codec helpers.
- `soltag@0.0.17` (new — add to `workspaces.catalog`): inline-Solidity tagged template literal
  for authoring the lens.
- `openapi-fetch` (new runtime dep, ~5 KB): typed `fetch` client driven by the generated
  `paths` type.
- `openapi-typescript` (new dev dep): CLI used by `pull-schemas.ts` to emit
  `src/api/generated.ts`. Not a runtime dep.
- `executooor-viem` (new runtime dep): the upstream Rubilmax `ExecutorEncoder` TypeScript
  helpers. Our Midnight-aware encoder is a thin wrapper.
- `prompts` (new dev dep): used only by `scripts/pull-schemas.ts` for the interactive CLI.
- `viem` (catalog): `createPublicClient`, `createWalletClient`, `getBlockNumber` (polled),
  `simulateContract`, `sendTransaction`, `getTransactionReceipt`, `privateKeyToAccount`, and
  `createNonceManager` + `jsonRpc` (from `viem/nonce`).
- `@repo/abis/v2` (workspace): `MidnightAbi`. Add `ExecutorAbi` once the contract is finalized.
- `@repo/utils` (workspace): `tryCatch`, `allFulfilled`.
- In this repo (Solidity, under `contracts/executooor/`): the modified Executor contract.
- Out-of-repo: the Morpho Midnight API at `MIDNIGHT_API_URL`; the deployed Executor instance
  at `EXECUTOOOR_ADDRESS`.

## Observability

JSON-line via the v1 `logger.ts`. Stable event keys:

```
startup                  { chainId, liquidator, callback, midnight, apiUrl }
tick.begin               { block }
api.lag                  { latestIndexedBlock, ourBlock, lag }   // warn ≥5, error ≥30
positions.fetched        { count, markets, durationMs }          // markets = distinct count in the set
lens.read                { pairs, batches, durationMs }
lens.id_mismatch         { marketId, borrower }
lens.skipped             { marketId, borrower, reason }
plan.built               { marketId, borrower, collateralIndex, kind, seized, repaid }
simulate.ok              { marketId, borrower, gas, repaid }
simulate.revert          { marketId, borrower, reason }
tx.sent                  { marketId, borrower, nonce, txHash, maxFee, priority }
tx.bumped                { nonce, oldHash, newHash, attempt, maxFee, priority }
tx.confirmed             { nonce, txHash, blockNumber, gasUsed, status }
tx.dropped               { nonce, txHash, reason }
tx.reverted              { nonce, txHash, reason }
tick.end                 { block, durationMs, pendingCount, counters }
```

Counters emitted in `tick.end`: `positions_seen, lens_valid, liquidatable, plans,
simulated_ok, simulated_revert, sent, bumped, confirmed, reverted, dropped`. No external
metrics deps; logs are structured enough to ship.

## Security

- **Private key handling.** `LIQUIDATOR_PRIVATE_KEY` read from env once at startup, never
  logged, never written to disk. No `.env` file checked in (covered by repo `.gitignore`).
- **Gate target.** `canLiquidate` is checked against `EXECUTOOOR_ADDRESS`, not the EOA. The
  lens input carries the caller address explicitly so this can't drift between layers.
- **`id == Midnight.toId(market)` validation.** The lens calls the on-chain `toId` and flags
  mismatches as `valid: false`. We never call `liquidate` with an API-derived `Market` that
  hasn't passed this check.
- **Slippage on the swap.** `amountOutMinimum` derived from the lens's fresh USD value via a
  per-collateral `slippageBps`. Beyond that the swap reverts atomically mid-`liquidate` and
  the whole liquidate reverts — no loss, just a wasted gas estimate.
- **Full drain of the shared singleton.** The Executor is permissionless and shared, so any
  residual balance is claimable by the next caller. The dual-token sweep and the `simulate()`
  residual check that enforce a zero ending balance are described in §Executooor integration; the
  security property is that a missing-sweep regression fails closed in sim rather than donating
  funds.
- **Re-entrancy / callback auth.** Two modifications (drop the owner gate; add `onLiquidate`).
  The new `onLiquidate` handler **must gate `msg.sender == MIDNIGHT`** — otherwise any caller
  could invoke it directly and drive the contract's swap/approve logic with arbitrary `data`.
  The `call_g0oyU7o` self-call gate (`msg.sender == address(this)`) is unchanged. Because the
  singleton is shared and now carries a callback that moves tokens, the diff warrants a focused
  audit before deploy — flag it when the modified contract goes to review.
- **Replay / front-running.** No sensitive payload; the bot's transactions are public by
  construction (we're a fallback, not racing).

## Future Considerations

- A profitability gate as a follow-up TIB if operating cost becomes material.
- Multi-hop routing as a follow-up TIB once volatile collaterals matter to coverage.
- Multi-chain in one process if ops complexity favors it (probably not).
- A persisted queue state with replay-safe semantics, if restarts become frequent enough to
  warrant it.
- A flashloan-funded variant for liquidators without working capital — handled by wrapping the
  liquidate in `Midnight.flashLoan(address[] tokens, uint256[] assets, address callback, bytes data)`
  (`midnight-contracts.txt:2456`). This needs a second handler:
  `onFlashLoan(address caller, address[] tokens, uint256[] assets, bytes data) returns (bytes32)`
  (`:942`), which — like `onLiquidate` — must gate `msg.sender == MIDNIGHT` and return
  `CALLBACK_SUCCESS`. Not just queued calls: it's another mandatory Solidity handler.
- Extracting `api/`, `lens/`, and `queue/` into shared packages (`@repo/midnight-api`,
  `@repo/viem-dlc-lens`, `@repo/tx-queue`) once a second bot consumes them — explicitly
  premature today.

## Open Questions

- **Singleton deployment + gate whitelisting.** Where does the Executor singleton get
  deployed (canonical address via CREATE2?), and what's the process for getting it
  whitelisted in third-party `liquidatorGate`s? Acceptable for v2 to scope this to
  Morpho-curated markets only.
- **API outage policy.** Should the bot fail open to a lens-only discovery mode behind a flag
  (e.g., a minimal `eth_getLogs` scan over the last N blocks) when the API is sustained-down?
  Default for v2: no — accept temporary blindness. Revisit if outages happen.
- **Lens calibration target.** What do the inline gas constants in `lens/lens.sol.ts` target — Sepolia testnet? Mainnet
  fork? The coefficients differ by ~10% across opcodes-with-cold-sloads. Decide in phase 2.
- **Lens gas calibration on bad-debt positions.** Computing `badDebt` reuses the lens's existing
  collateral loop, so it adds no round-trips — but confirm the `BatchGasConfig` coefficients still
  hold for positions with all 16 slots activated (the worst-case loop). Decide alongside the
  calibration target above in phase 2.

## Verification

After each phase:

1. `bun install` succeeds with new catalog entries (`soltag@0.0.17`, viem-dlc kept at
   `0.0.11`).
2. `bun run --filter @bots/midnight-liquidation typecheck` → 0 errors.
3. `bun lint` → 0 warnings.
4. `bun test` → all unit tests pass, including:
   - LIF: normal mode (→ maxLif) vs post-maturity ramp boundaries (at maturity → WAD /
     mid-curve / past TIME_TO_MAX_LIF → maxLif).
   - `maxRepaidPreMaturity` matches the contract's `mulDivUp((debt−badDebt)−maxDebt, WAD²,
WAD²−lif·lltv)` exactly, including the bad-debt writeoff case (`badDebt > 0`); RCF cap with
     and without the `rcfThreshold` exemption; cap waived in post-maturity mode.
   - `plan()` mode selection: past maturity → postMaturityMode; pre-maturity healthy → skip.
   - `activeBits` bitmap iteration.
   - Nonce queue: parallel-submit nonce assignment, fee-bump ≥12.5%, gap detection.
   - API pagination: termination, hard-cap, error propagation.
   - Lens shapes: encode/decode roundtrip, selector match with
     `resolveArrayFunction(fragment)`.
   - Executor exec-encoder: selector + args golden hex against the Executor ABI, including the
     two trailing sweep calls (loan + collateral) targeting the recipient EOA.
5. Integration tests on an anvil fork (once Midnight is deployable there):
   - Boot anvil with Midnight + Uniswap V3 + a real pool. Create a liquidatable position via
     `vm.warp` past maturity. Run one tick. Assert receipt status=1, EOA loan-token balance
     increased, and the Executor holds **zero** loan token and **zero** collateral token after
     the tx (full-drain invariant).
   - Underprice the first send; assert the queue bumps and the replacement lands.
   - Point `MIDNIGHT_API_URL` to a 503 stub; assert the bot logs and skips without crashing.
6. Per-test vacuity check: flip one assertion in each new unit test file, confirm the test
   fails, then revert (CONVENTIONS gate).
7. Smoke run on a chain with Midnight deployed: daemon up for ≥1 h, observe expected
   `tick.end` cadence, verify no orphaned `pending` entries on graceful SIGTERM.

## References

- Morpho Midnight API (unified with the Router under `api.morpho.dev`; serves a first-class
  OpenAPI document consumed by `pull-schemas.ts`): docs at `https://api.morpho.dev/midnight/docs`
- Rubilmax executooor (basis for the modified callback singleton):
  `https://github.com/Rubilmax/executooor`
- viem-dlc: `https://github.com/morpho-org/viem-dlc`
- viem `createNonceManager`: `https://viem.sh/docs/accounts/local/createNonceManager`
- soltag: `https://github.com/haydenshively/soltag`
- Midnight contracts source-of-truth in repo: `docs/context/repos/midnight-contracts.txt`
  (protocol references in this TIB are pinned to commit `5e9ecd58`, generated 2026-06-03;
  line numbers cited inline are against that file). Key surfaces: `liquidate` `:2300`,
  `ILiquidateCallback.onLiquidate` `:933`, `isHealthy` `:2663`, `liquidationLocked` `:2656`,
  `IdLib.toId` `:339` / `Midnight.toId` `:2590`, LIF `:2362-2366`, RCF `:2378-2386`,
  bad-debt writeoff `:2326-2346`, `maxLif` derivation `:997` / market-creation validation `:2487`,
  continuous-fee accrual (`updatePositionView`) `:2516-2538`,
  `Market` / `CollateralParams` structs `:1098-1112`, `ConstantsLib` `:955-972`.
