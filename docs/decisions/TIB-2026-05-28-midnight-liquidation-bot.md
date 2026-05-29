# TIB-2026-05-28: Midnight liquidation bot — v0

| Field      | Value                            |
| ---------- | -------------------------------- |
| **Status** | Proposed                         |
| **Date**   | 2026-05-28                       |
| **Author** | @hayden                          |
| **Scope**  | App: `bots/midnight-liquidation` |

---

## Context

Morpho Midnight is a multi-collateral, maturity-aware credit primitive where positions
become liquidatable on `debt > 0` AND (unhealthy OR past maturity). Liquidations are
time-sensitive — the liquidation incentive factor grows linearly from 1× to `maxLif` over
the 15 minutes following maturity — and the multi-collateral structure (up to 128 slots per
obligation, each with its own `lltv`, `maxLif`, and oracle) makes sizing meaningfully harder
than on Morpho Blue.

We're building this bot with two distinct readers in mind:

1. **Integrators** copying it as a reference implementation. The health, liquidatability,
   and LIF + RCF sizing logic must read as documentation.
2. **Ourselves** running it as a fallback that catches positions the competitive ecosystem
   misses. It must _work_, not be _competitive_: no profitability gate, no MEV-aware bidding.

The bot standardizes on three architectural choices:

- **Discovery via the Morpho Midnight API** (`https://api.morpho.dev/v1/midnight/*`). The API
  returns paginated markets, positions, and indexer status. We never hit `eth_getLogs` for
  discovery.
- **Onchain inspection via a `soltag`-authored lens** read through `@morpho-org/viem-dlc`'s
  `deployless` transport. Any data available from both the API and `eth_call` is sourced from
  `eth_call` for freshness; the API drives discovery and config only.
- **Execution via a modified [`Rubilmax/executooor`](https://github.com/Rubilmax/executooor)**
  vendored into this repo under `contracts/executooor/`. Modification is small and surgical:
  drop the `require(msg.sender == OWNER)` from `exec_606BaXt` so the contract becomes a
  permissionless shared singleton — any EOA can call `exec(Call[])`. Callbacks
  (`onLiquidate(...)` and any future Midnight hooks) need no Solidity changes; the upstream
  Executor already routes them via a transient-storage continuation. The single-hop DEX swap
  is just another `Call` queued alongside the `liquidate` call. A viem-managed nonce plus an
  in-memory tracking queue submits parallel transactions and bumps stuck nonces.

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
- Custom callback Solidity beyond stripping the executooor owner gate. The bot uses the
  upstream Executor's existing transient-storage continuation for `onLiquidate` — no
  callback-shape-specific selector or wrapper. Solidity lives in this repo at
  `contracts/executooor/`.
- Persisting queue state across daemon restarts. Chain truth wins; we re-derive on startup.
- Replacing `@repo/utils` or `@repo/abis` patterns. Reuse them as-is.

## Proposed Solution

### Module shape

Solidity lives at the repo root:

```
contracts/executooor/
  Executor.sol         // vendored from Rubilmax/executooor with owner gate stripped
  interfaces/          // unchanged from upstream
```

The bot lives under `bots/midnight-liquidation/src/`:

```
config.ts            // env + JSON file + per-chain Midnight/deployer map; fail loud
index.ts             // boot: loadConfig → daemon.start(); SIGTERM handler
constants.ts         // TIME_TO_MAX_LIF=900, WAD=1e18, ORACLE_PRICE_SCALE=1e36, etc.

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
  markets.ts         // listMarkets() + MarketIndex (frozen Map, refresh-if-stale)
  positions.ts       // listBorrowPositions({ market_ids, debt_gte })
  chains.ts          // getIndexerStatus() for staleness gate

lens/
  lens.sol.ts        // single file: soltag template, input/output codecs, inline
                     // gas constants, and the exported readMidnightLiquidationLens fetcher
  read-deployless-batch-lens.ts  // vendored from prime-monorepo
                                 // packages/resolvers/src/rpc/; helper that wraps
                                 // viem-dlc's policy() + single-array-in/out pattern

sizing/
  lif.ts             // pure: lifAt(now, maturity, maxLif, isHealthy) → bigint
  rcf.ts             // pure: maxRepaidPreMaturity + exemption check
  plan.ts            // pure: LensOut → LiquidationPlan
  bitmap.ts          // activeBits (shared with lens decoder)

execution/
  encode-call.ts     // pure: LiquidationPlan + SwapStep → Executor.exec(bytes[]) calldata
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

- **Phase 1 — API + market index (no chain work).** Land `api/`, `config.ts` v2 envs, and an
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
It's an interactive CLI (`prompts`-driven) that knows two parser modes: `json` for upstream
OpenAPI endpoints (like Router), and `scalar-html` for the Midnight API (the spec is embedded
in the Scalar docs HTML at `https://api.morpho.dev/midnight/docs` as
`Scalar.createApiReference('#app', { content: {...} })` — the parser brace-matches the inline
object out). Both `openapi.json` and `generated.ts` are committed.

Run manually only — never wire into CI or `prebuild`. The build must stay offline so a flaky
upstream can't break it, and schema updates land as reviewable diffs. Drop-in port: same
shape, swap `pnpm`-isms for `bun`, point at our `src/api/openapi.json` output path.

**Client.** `api/client.ts` exports a single `createApiClient(baseUrl)` that wires
`openapi-fetch` against the generated `paths` type, plus a thin `apiCall<P, M>(client, path,
method, params)` helper that `tryCatch`-wraps requests, normalizes 4xx/5xx into a
discriminated error (per the API's `MidnightErrorResponseDto`), and rejects non-JSON
responses (e.g. HTML 502 pages). No second cache layer — the API's
`Cache-Control: public, max-age=2, stale-while-revalidate=1` is exactly the freshness we want
per tick.

```ts
import createClient from 'openapi-fetch'
import type { paths } from './generated'

export function createApiClient(baseUrl: string) {
  return createClient<paths>({ baseUrl, headers: { 'User-Agent': 'curator-bots/midnight-liquidation' } })
}
```

**Pagination.** A single pure async generator wraps the cursor protocol used by `/markets`,
`/positions`, and `/activities` (all three return `{ cursor, data }`):

```ts
async function* paginate<T>(
  fetchPage: (cursor?: string) => Promise<{ data: T[]; cursor: string | null }>
): AsyncGenerator<T> { /* hard cap at 100 pages as a circuit breaker */ }
```

`markets.ts`, `positions.ts`, `chains.ts` are thin wrappers that bind the typed client into
`paginate(…)` and return arrays / single objects. The generated types do all the parameter
checking; we don't add Zod.

**Discovery cadence.** `MarketIndex` is a frozen `Map<MarketId, Market>` rebuilt on a
5-minute TTL — markets are append-only-ish, and missing a new market means we miss one tick
of borrow activity which the next tick catches. Positions are refreshed every tick via
`/v1/midnight/positions?type=borrow&debt_gte=1&market_ids=…&limit=200`.

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

**Input element** (per pair): `abi.encode(Obligation obligation, bytes32 id, address borrower, address caller)`.

- The lens recomputes `keccak256(abi.encode(obligation))` and compares against `id` — any
  mismatch sets `valid: false` (do not revert; would break the whole batch).
- `caller` is the address whose `canLiquidate` we want checked. **This is the
  `EXECUTOOOR_ADDRESS`, not the EOA** — `Midnight.liquidate` checks `canLiquidate(msg.sender)`
  (line 1510 of `midnight-contracts.txt`), and `msg.sender` will be the executooor singleton.
  Getting this wrong is the most likely subtle bug in v2 if we forget.

**Output element** (per pair):

```solidity
struct LensOut {
  bool    valid;                  // id == keccak(obligation)
  bool    liquidatable;           // Midnight.isLiquidatable(...)
  bool    gateAllows;             // canLiquidate(caller); try/catch → false on revert
  uint64  blockTimestamp;         // for LIF eval, avoid host clock drift
  uint128 debt;
  uint128 maxDebt;                // Σ collateral_i · price_i · lltv_i
  uint128 activatedBitmap;
  uint8   bestCollateralIdx;      // argmax over activated slots by USD value
  uint128 bestCollateralAmt;
  uint256 bestCollateralUsd;      // USD18 value
  uint256 bestCollateralPrice;    // raw oracle price (ORACLE_PRICE_SCALE units)
  uint256 bestCollateralMaxLif;
  uint256 bestCollateralLltv;
  uint256 remainingCollateralUsd; // sum over OTHER activated slots; for RCF exemption
}
```

This gives us everything to (a) confirm liquidatable fresh, (b) pick the slot, (c) compute
`seizedAssets` / `repaidUnits` respecting LIF + RCF, (d) reconstruct the Solidity `Obligation`
for the `liquidate` call (already have it from the API; the `valid` flag confirms ordering).

**Colocated single file.** `lens/lens.sol.ts` contains the entire lens module in one place:

1. The Solidity source as a `soltag` tagged template (compiled at build time to a `factory`
   - `factoryData` pair).
2. Input + output codecs (`encodeAbiParameters` for the input triple; struct decoder for
   `LensOut`).
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

```ts
// sizing/lif.ts
function lifAt(now: bigint, maturity: bigint, maxLif: bigint, isUnhealthy: boolean): bigint {
  if (isUnhealthy) return maxLif                                  // pre-maturity unhealthy
  if (now <= maturity) return WAD                                 // pre-maturity healthy
  const elapsed = now - maturity
  if (elapsed >= TIME_TO_MAX_LIF) return maxLif
  return WAD + ((maxLif - WAD) * elapsed) / TIME_TO_MAX_LIF
}

// sizing/rcf.ts — pre-maturity unhealthy only
function maxRepaidPreMaturity(debt: bigint, maxDebt: bigint, lif: bigint, lltv: bigint): bigint {
  if (lltv >= WAD) return MAX_UINT
  const denom = WAD - ceilDiv(lif * lltv, WAD)
  return ceilDiv((debt - maxDebt) * WAD, denom)
}

// Exempt when remaining-collateral value after seize < rcfThreshold (in loan-asset units).
```

`sizing/plan.ts` chooses between `{ seizedAssets, repaidUnits=0 }` and
`{ seizedAssets=0, repaidUnits }`:

- post-maturity OR pre-maturity-unhealthy with no cap binding → `seizedAssets =
bestCollateralAmt` (100% of slot)
- pre-maturity-unhealthy with cap binding (and not exempt) → `repaidUnits = maxRepaid`
- otherwise (lens flagged not-liquidatable) → skip

### Tx queue

**Nonce assignment is delegated to viem's `createNonceManager`** — no hand-rolled counter.

```ts
import { createNonceManager, jsonRpc } from 'viem/nonce'
import { privateKeyToAccount } from 'viem/accounts'

const nonceManager = createNonceManager({ source: jsonRpc() })
const account = privateKeyToAccount(LIQUIDATOR_PRIVATE_KEY, { nonceManager })
```

With this in place, parallel `walletClient.sendTransaction(...)` calls automatically claim
sequential nonces; the manager syncs from `getTransactionCount('pending')` on first use and
again whenever an error indicates drift. We get concurrent-safe nonce assignment, restart
safety (pulls from `'pending'`), and out-of-band gap detection for free. Our queue does
**not** own a `nextNonce` cursor.

`queue/pending-queue.ts` owns what viem's manager does not — tracking, confirmation, and
bump/replace. Per-pending entry:

```ts
type Pending = {
  nonce: number
  txHash: Hex
  plan: LiquidationPlan
  submittedAtBlock: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  attempt: number
  state: 'sent' | 'confirmed' | 'replaced' | 'dropped'
}
```

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

1. Refresh `MarketIndex` if TTL expired (no-op otherwise).
2. Indexer staleness gate (`/v1/midnight/chains`); skip tick if `lag > 30`.
3. Fetch borrow positions from the API.
4. Drop `(marketId, borrower)` pairs already non-terminal in the queue (backpressure — keep a
   small `inflight: Set<\`${marketId}:${borrower}\`>` owned by the daemon).
5. Call `readLens(pairs)`.
6. For each valid+liquidatable+gateAllows: `plan()` → `simulate()` → `pendingQueue.submit()`.
7. `pendingQueue.onBlock(blockNumber)` — confirmations, stuck-detection, bumps.
8. Emit `tick.end` with counters.

### Executooor integration

We vendor [`Rubilmax/executooor`](https://github.com/Rubilmax/executooor) Solidity into
`contracts/executooor/Executor.sol` and apply **one surgical modification**: remove the
`require(msg.sender == OWNER)` from `exec_606BaXt`. That makes the contract a permissionless
shared singleton — any EOA can call `exec(Call[])`. Nothing else changes:

- The Executor still holds no state across transactions (it has no storage besides the
  transient continuation slot, which is `TLOC 0` and resets per-tx).
- The `call_g0oyU7o` self-call gate (`require(msg.sender == address(this))`) is unchanged,
  so callback re-entry is still safe.
- The `OWNER` immutable + constructor argument are dropped (no longer needed).

**No `onLiquidate(...)` Solidity to add.** The Executor's bare fallback runs the next queued
call scoped by the transient context. The bot stashes a sequence of calls via `exec`:

```
exec([
  call_g0oyU7o(midnight, 0, ctx, encodeLiquidate(plan, abi.encode(swapStep))),
  // Stashed continuations consumed by the fallback when Midnight calls
  // back into the Executor mid-liquidate:
  call_g0oyU7o(collateralToken, 0, 0x00, encodeApprove(router, seizedAmt)),
  call_g0oyU7o(router, 0, 0x00, encodeExactInputSingle(...))
])
```

Midnight calls back to `Executor.<unknown selector>` with the `onLiquidate` calldata; the
fallback recognizes the context, runs the next queued call (the approve), then the next
(the swap), then control returns to `Midnight.liquidate` which pulls the loan-token repay
from the Executor. Any residual loan-token sits on the Executor and is swept by the EOA in a
trailing `call_g0oyU7o(loanToken, 0, 0, transfer(eoa, balance))` step (or via the upstream
`transfer(recipient, amount)` self-call helper that auto-skims the current balance).

**TypeScript encoder.** Use [`executooor-viem`](https://www.npmjs.com/package/executooor-viem)
(the upstream `ExecutorEncoder`) where possible; add a thin Midnight-aware wrapper
(`execution/encode-call.ts`) that emits the `(Midnight.liquidate, approve, swap, sweep)`
sequence given a `LiquidationPlan + SwapStep`. Pure module, no RPC.

```ts
type SwapStep = {
  router: Address              // UniswapV3 SwapRouter02 (or compat)
  tokenIn: Address             // = collateralToken
  tokenOut: Address            // = obligation.loanToken
  fee: number                  // 500 / 3000 / 10000
  amountOutMinimum: bigint     // derived from lens USD value × (10000 - slippageBps)/10000
}

function encodeExecForLiquidation(plan: LiquidationPlan, step: SwapStep): Hex
  // returns the calldata for Executor.exec_606BaXt(bytes[])
```

Per-collateral swap config at `SWAP_CONFIG_PATH`:

```json
{
  "<chainId>": {
    "<collateralToken>": { "router": "0x...", "fee": 500, "slippageBps": 50 }
  }
}
```

Missing entry → skip liquidation with `config.no_swap_path` log. The bot signs and broadcasts
`{ to: EXECUTOOOR_ADDRESS, data: encodeExecForLiquidation(plan, step) }`. The bot
**never** calls `Midnight.liquidate` directly.

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

Continue v1's two-multicall pattern (one for gate, one for `isLiquidatable`) and add a third
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
- `keccak256(abi.encode(Obligation)) == market_id` for every market the API returns.
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
markets.refreshed        { count, durationMs }
positions.fetched        { count, durationMs }
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
- **`id == keccak(Obligation)` validation.** The lens recomputes and flags mismatches as
  `valid: false`. We never call `liquidate` with an API-derived `Obligation` that hasn't
  passed the rehash check.
- **Slippage on the swap.** `amountOutMinimum` derived from the lens's fresh USD value via a
  per-collateral `slippageBps`. Beyond that the swap reverts atomically mid-`liquidate` and
  the whole liquidate reverts — no loss, just a wasted gas estimate.
- **Re-entrancy.** The modification is small and surgical (drop the owner gate). The
  Executor's transient-storage continuation already gates callback re-entry via
  `msg.sender == address(this)`. Because the singleton is shared, the diff still warrants a
  focused audit before deploy — flag it when the modified contract goes to review.
- **Replay / front-running.** No sensitive payload; the bot's transactions are public by
  construction (we're a fallback, not racing).

## Future Considerations

- A profitability gate as a follow-up TIB if operating cost becomes material.
- Multi-hop routing as a follow-up TIB once volatile collaterals matter to coverage.
- Multi-chain in one process if ops complexity favors it (probably not).
- A persisted queue state with replay-safe semantics, if restarts become frequent enough to
  warrant it.
- A flashloan-funded variant for liquidators without working capital — handled by queueing a
  flashloan call ahead of the liquidate in the `exec(Call[])` array; the Executor's
  transient continuation already handles the flashloan callback. No further Solidity changes
  needed.
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
- **`continuous_fee` accrual.** The API exposes `continuous_fee_credit` per market; do we
  need to surface it in `LensOut` for sizing accuracy when debt has drifted with fees? Worth
  checking against the contract's debt-accrual semantics during phase 2.

## Verification

After each phase:

1. `bun install` succeeds with new catalog entries (`soltag@0.0.17`, viem-dlc kept at
   `0.0.11`).
2. `bun run --filter @bots/midnight-liquidation typecheck` → 0 errors.
3. `bun lint` → 0 warnings.
4. `bun test` → all unit tests pass, including:
   - LIF curve boundaries (pre-maturity / at maturity / mid-curve / past max).
   - RCF cap with and without the `rcfThreshold` exemption.
   - `activeBits` bitmap iteration.
   - Nonce queue: parallel-submit nonce assignment, fee-bump ≥12.5%, gap detection.
   - API pagination: termination, hard-cap, error propagation.
   - Lens shapes: encode/decode roundtrip, selector match with
     `resolveArrayFunction(fragment)`.
   - Executor exec-encoder: selector + args golden hex against the Executor ABI.
5. Integration tests on an anvil fork (once Midnight is deployable there):
   - Boot anvil with Midnight + Uniswap V3 + a real pool. Create a liquidatable position via
     `vm.warp` past maturity. Run one tick. Assert receipt status=1 and EOA loan-token
     balance increased.
   - Underprice the first send; assert the queue bumps and the replacement lands.
   - Point `MIDNIGHT_API_URL` to a 503 stub; assert the bot logs and skips without crashing.
6. Per-test vacuity check: flip one assertion in each new unit test file, confirm the test
   fails, then revert (CONVENTIONS gate).
7. Smoke run on a chain with Midnight deployed: daemon up for ≥1 h, observe expected
   `tick.end` cadence, verify no orphaned `pending` entries on graceful SIGTERM.

## References

- Morpho Midnight API: `https://api.morpho.dev/midnight/docs`
- Rubilmax executooor (basis for the modified callback singleton):
  `https://github.com/Rubilmax/executooor`
- viem-dlc: `https://github.com/morpho-org/viem-dlc`
- viem `createNonceManager`: `https://viem.sh/docs/accounts/local/createNonceManager`
- soltag: `https://github.com/haydenshively/soltag`
- Midnight contracts source-of-truth in repo: `docs/context/repos/midnight-contracts.txt`
