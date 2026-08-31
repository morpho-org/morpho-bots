# TIB-2026-05-28: Midnight liquidation bot — v0

| Field      | Value                                                               |
| ---------- | ------------------------------------------------------------------- |
| **Status** | Accepted — implemented; on-chain deploy + go-live broadcast pending |
| **Date**   | 2026-05-28                                                          |
| **Author** | @hayden                                                             |
| **Scope**  | App: `bots/midnight-liquidation`                                    |

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

We build for two readers:

1. **Integrators** copying it as a reference implementation — the health, liquidatability, and
   LIF + RCF sizing logic must read as documentation.
2. **Ourselves** running it as a safety-net liquidator that values reliability over latency — it
   must _work_ correctly and predictably, not win races.

Three architectural choices anchor the design:

- **Discovery via a co-located rindexer instance.** rindexer indexes Midnight's `Take` event on
  Base into Postgres; the bot reads the indexed `(marketId, borrower)` universe each tick over
  `DATABASE_URL`. `Take` is the only path that creates debt, so its two indexed addresses
  (`taker`, `maker`) union to the candidate set and the lens drops non-debtors. We deliberately
  do **not** depend on a hosted indexer/API on the liquidation path (see Considered
  Alternatives).
- **Decisions via a `soltag`-authored lens** read through `@morpho-org/viem-dlc`'s `deployless`
  transport. Everything the liquidation decision depends on — including the canonical `Market`,
  read on-chain via `toMarket(id)` — is read fresh inside one `eth_call` against a single
  `block.timestamp`. Discovery says who _might_ be liquidatable; the lens says whether it still
  _is_.
- **Execution via a vendored, fully generic [`Rubilmax/executooor`](https://github.com/Rubilmax/executooor)**
  singleton (in `@repo/contracts`): the owner gate is stripped to make it a permissionless shared
  singleton, and **no protocol-specific Solidity is added**. The swap and the repay approval ride
  inside the liquidation callback as the Executor's own generic call queue. The single
  modification, and the reason no typed handler is needed, live in §Executor integration.

## Goals / Non-Goals

**Goals**

- Long-running runner, single chain per process, that reliably liquidates **every** position
  that becomes liquidatable while it is running.
- Correct sizing: maturity-aware LIF curve and pre-maturity RCF cap (with the
  `rcfThreshold` exemption). Collateral picked by USD value, freshly read in the same `eth_call`
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
- **Protocol-specific Solidity in the Executor.** The vendored Executor's only change from
  upstream is stripping the owner gate (plus a pragma relaxation). The swap and approvals ride
  inside the liquidate callback as the Executor's generic call queue, so there is no
  Midnight-specific handler and no `onBuy` / `onSell` / `onRepay` / `onFlashLoan` Solidity.
  Solidity lives in `@repo/contracts` (`solidity/`).
- Persisting queue state across runner restarts. Chain truth wins; we re-derive on startup.
- Replacing `@repo/utils` or `@repo/contracts` patterns. Reuse them as-is.

## Proposed Solution

### Module shape

Solidity lives in the `@repo/contracts` package, soltag-compiled at build time from vendored
sources:

```
packages/contracts/
  solidity/
    Executor.sol               // vendored Rubilmax/executooor: owner gate stripped
                               // (permissionless singleton), pragma 0.8.25 → ^0.8.25;
                               // otherwise byte-for-byte upstream
    interfaces/IMidnight.sol   // vendored from prime-monorepo (canonical interface + event set)
  scripts/{codegen,build,deploy-executor}.ts
  src/{abis,contracts}.ts      // generated: MidnightAbi; Executor (with the .with() factory)
  abis/Midnight.json           // materialized for rindexer
  foundry.toml                 // `forge fmt` only — soltag/bun do the compilation
```

The bot lives under `bots/midnight-liquidation/`:

```
src/
  config.ts          // env + swap-config JSON + per-chain Midnight map; fail loud
  index.ts           // boot: loadConfig → wire deps → runner.start(); SIGTERM/SIGINT
  constants.ts       // TIME_TO_MAX_LIF=900, WAD=1e18, ORACLE_PRICE_SCALE=1e36, CALLBACK_SUCCESS,
                     // MAX_COLLATERALS_PER_BORROWER=16, STUCK_BLOCKS=4, MAX_BUMP_ATTEMPTS=3
  client.ts          // deployless (+ optional failover) read client; getCode liveness gate
  signer.ts          // wallet client + createNonceManager; send / getReceipt / getBaseFee
  logger.ts          // JSON-line structured logger (bigints stringified)

  runner/
    runner.ts        // start/stop; wires modules; owns lifecycle
    tick.ts          // pure orchestrator: takes injected deps, runs one tick
    watcher.ts       // setInterval-driven getBlockNumber poll → coalesced new-block queue
                     // (HTTP only; no WebSocket transport, no eth_subscribe)
    eligibility.ts   // off-chain liquidatability + lens → plan-input mapping

  discovery/
    borrowers.ts     // reads (marketId, borrower) candidates + rindexer head from Postgres

  state/
    lens.sol.ts      // soltag lens source, codecs, inline gas config, the exported fetcher
    read-deployless-batch-lens.ts  // vendored viem-dlc helper (array-in/array-out, chunking)

  sizing/
    lif.ts           // pure: lifAt({ now, maturity, maxLif, postMaturityMode }) → bigint
    rcf.ts           // pure: maxRepaidPreMaturity + isRcfExempt (normal mode only)
    plan.ts          // pure: PlanInput → LiquidationPlan (mode, amounts, bad-debt realization)
    math.ts          // pure: mulDivUp / mulDivDown / zeroFloorSub
    bitmap.ts        // activeBits (shared with the lens decoder)

  execution/
    encode-call.ts   // pure: plan + swap → Executor.exec_606BaXt(bytes[]) calldata
    swap-step.ts     // pure: SwapConfigEntry + plan + lens → SwapStep (amountOutMinimum)
    simulate.ts      // eth_call the real exec from the EOA; returns ok | revert

  queue/
    pending-queue.ts // in-memory Map<nonce, Pending>; submit / bump / drop / onBlock; inflightLabels
    fee-policy.ts    // pure: EIP-1559 bump ≥12.5%; ceiling → drop

bunfig.toml          // preload soltag.preload.ts for `bun test` + the runtime
soltag.preload.ts    // hand-rolled Bun.plugin driving soltag's transform (compiles the lens on load)
rindexer.yaml        // rindexer project: index Midnight `Take` on Base
docker-compose.yml   // Postgres + rindexer + bot
Dockerfile           // multi-stage: bot; abi (materializes Midnight.json); rindexer
```

Pure modules are unit-tested; everything that touches the RPC / Postgres / `process` is covered
by the anvil fork suite (`test/fork/`).

### Implementation Phases

- **Phase 1 — Discovery + dry-run (no chain decisions).** Land `discovery/` (rindexer indexing
  `Take`), `config.ts`, and an `index.ts` dry-run that prints "would attempt" liquidations
  against the candidate set only. No lens, no signer. Discovery SQL and fail-loud config are
  unit-testable.

- **Phase 2 — Lens + sizing (still read-only).** Author the soltag lens, wire the deployless
  transport, replace dry-run eligibility + sizing with the lens path. Plans are now correct and
  fresh; `simulate` is the sink. End-to-end smoke on Base via a `toMarket` read + the `getCode`
  liveness gate.

- **Phase 3 — Runner + nonce queue + signed sends.** Add `runner/`, `queue/`, signer wiring.
  Exercise the queue and bumping with a _dummy_ broadcast (a direct-from-EOA `liquidate` that
  reverts deterministically on the unfunded loan-token pull) before the swap config exists.
  Replacement is verified later via a deliberately-underpriced first send.

- **Phase 4 — Generic Executor + callback-queue encoder + swap config.** Vendor the generic
  Executor, rework the encoder so the swap + approvals ride inside the liquidate callback,
  plug in the per-collateral swap config, tighten the submit gate to `ok`-only, land the anvil
  fork suite, and add the deterministic CREATE2 deploy command.

**Status:** Phases 1–4 are complete. Remaining for go-live: the on-chain Executor deploy run, the
testnet broadcast against a real Uniswap-V3 pool (including the manual underpriced-replacement
check), and lens gas calibration on a Base fork.

### Discovery design (rindexer)

Borrowers are discovered by a **co-located rindexer** instance bundled in the bot's
`docker-compose.yml`, which runs Postgres, rindexer (`start indexer`), and the bot against the
same database (`DATABASE_URL`). rindexer indexes Midnight's `Take` event on Base
(`0x3726353bCDDba7c29a17D46D8a35D1E8b2E51854`, from `startBlock 46758943`) into Postgres. The
event ABI is materialized from the regenerated `MidnightAbi` by the Dockerfile's `abi` stage
(`@repo/contracts build` emits `abis/Midnight.json`, copied into the rindexer image) — not
committed.

**Why `Take`.** `take` is the only Midnight path that creates debt. The debtor is the offer's
seller (`taker` when `offerIsBuy` else `maker`), indistinguishable from the indexed topics alone,
so discovery unions **both** indexed addresses as the candidate `(marketId, borrower)` universe:
over-inclusion is harmless (the lens drops non-debtors), while under-inclusion would miss a
liquidation. (Indexing any accrual event — e.g. a fee/credit `UpdatePosition` — would surface
positions with no debt and miss real borrowers; only `take` opens a position.)

`discovery/borrowers.ts` runs:

```sql
SELECT DISTINCT market_id, borrower
FROM (
  SELECT id_ AS market_id, taker AS borrower FROM midnight_liquidation_midnight.take
  UNION
  SELECT id_ AS market_id, maker AS borrower FROM midnight_liquidation_midnight.take
) candidates
```

returning `{ marketId, borrower }[]` (the table name follows rindexer's
`{project}_{contract}` convention). The candidate's `Market` config is **not** read here — the
lens fetches it on-chain via `toMarket(id)`, so no market-creation event is indexed and there is
no inline position data to trust.

**rindexer-lag signal.** `borrowers.ts` also exposes `rindexerSyncedBlock`
(`SELECT MAX(block_number) FROM …take`). Each tick compares it against the chain head the runner
polls and emits `rindexer.lag`. It is **observability-only**: the lens reads every candidate
fresh on-chain, so rindexer lag is coverage latency, not a correctness issue. The tick always
proceeds, and **fails open** if the query errors (`reason: 'unknown'`). It over-reports lag
during quiet periods with no `Take` events — acceptable, since it never gates a decision.

### Lens design (soltag)

A single elementwise function — required by viem-dlc's `resolveArrayFunction` (one dynamic
array in, one dynamic array out):

```solidity
function lens(Input[] calldata input) external view returns (LensOut[] memory output)
```

**Input element** (per pair): `struct Input { bytes32 id; address borrower; address caller; }`.

- The lens reads the canonical `Market` on-chain via `MIDNIGHT.toMarket(id)`. The id is a
  cryptographic commitment to the encoded `Market`, so reading the market from the id is both
  authoritative and removes any need for an off-chain `Market` input or an `id == toId(market)`
  re-check. An unknown id reverts `MarketNotCreated`, caught by a per-element try/catch that
  leaves a zeroed (`valid: false`) row — a revert never breaks the whole batch.
- `caller` is the address whose `canLiquidate` we want checked. **This is the
  `EXECUTOOOR_ADDRESS`, not the EOA** — `Midnight.liquidate` checks
  `market.liquidatorGate == address(0) || ILiquidatorGate(market.liquidatorGate).canLiquidate(msg.sender)`,
  and `msg.sender` will be the Executor singleton (it is the contract that calls `liquidate`).
  Getting this wrong is the most likely subtle bug if we forget.

**Output element** (per pair). The lens does **not** call any single `isLiquidatable`;
liquidatability is composed off-chain from health, lock, debt, and maturity, matching the
`liquidate()` path:

```solidity
struct LensOut {
  bool    valid;                  // toMarket(id) succeeded (id is a created market)
  bool    hasDebt;                // debtOf(id, borrower) > 0
  bool    healthy;                // maxDebt >= debt (matches isHealthy's final return)
  bool    locked;                 // liquidationLocked(id, borrower)
  bool    gateAllows;             // liquidatorGate==0 ? true : canLiquidate(caller) try/catch→false
  uint64  blockTimestamp;         // for LIF eval + the now>maturity test; avoid host clock drift
  uint128 debt;
  uint128 maxDebt;                // Σ collateral_i · price_i · lltv_i (over activated slots)
  uint128 badDebt;                // debt.zeroFloorSub(Σ collateral_i · price_i · WAD / maxLif_i);
                                  //   liquidate() writes this off before sizing — see rcf.ts
  uint128 activatedBitmap;        // collateralBitmap(id, borrower) (≤16 bits set)
  uint8   bestCollateralIdx;      // argmax over activated slots by USD value
  uint128 bestCollateralAmt;      // collateral(id, borrower, bestCollateralIdx)
  uint256 bestCollateralPrice;    // raw oracle price (ORACLE_PRICE_SCALE units)
  uint256 bestCollateralMaxLif;   // market.collateralParams[bestCollateralIdx].maxLif
  uint256 bestCollateralLltv;     // market.collateralParams[bestCollateralIdx].lltv
  Market  market;                 // the toMarket(id) read — passed straight into liquidate
}

// Off-chain (runner/eligibility.ts):
//   liquidatable = valid && gateAllows && hasDebt && !locked
//                  && (blockTimestamp > market.maturity || !healthy)
//   `!healthy` is exactly the contract's pre-maturity test `debt > maxDebt`
//   (isHealthy returns maxDebt >= debt); post-maturity needs only now > maturity.
//
// `healthy` and `badDebt` are derived from the FULL collateral loop, not a short-circuited sum,
// so they match the liquidate() path exactly. The RCF exemption (normal mode only) is computed
// off-chain in rcf.ts from `bestCollateral*` + `rcfThreshold`; it depends only on the liquidated
// slot, so the lens returns no separate field for it.
```

This gives us everything to (a) confirm liquidatable fresh, (b) pick the slot, (c) compute
`seizedAssets` / `repaidUnits` respecting LIF + RCF, and (d) pass the on-chain `Market` straight
into the `liquidate` call.

**Two passes, not one loop.** A single loop carrying `maxDebt` / `badDebt` / the argmax exceeds
the EVM stack ("stack too deep"), and soltag exposes no `viaIR`. The lens splits into
`_accumulate` (maxDebt down-down; badDebt ceil-ceil, seeded with debt and floored at 0 per slot;
health) and `_selectBest` (the USD-value argmax). Each activated slot is re-read in the second
pass — acceptable for a read-only lens.

**Colocated single file.** `state/lens.sol.ts` contains the entire lens module in one place:

1. The Solidity source as a `soltag` tagged template (compiled to a `factory` / `factoryData`
   pair).
2. Input + output codecs — the soltag type codegen (`.soltag/types.d.ts`, regenerated by the
   `soltag` CLI before typecheck) narrows the compiled `.abi`, so viem encodes the inputs and
   decodes the `LensOut` structs natively; no hand-written ABI fragment or manual
   `abi.encode/decode`.
3. Inline `BatchGasConfig` — placeholder `{ constant: 600_000, linear: 30_000, quadratic: 0 }`,
   to calibrate on a Base fork (including the 16-slot worst-case loop) before go-live.
4. The exported `readMidnightLiquidationLens(client, midnight, pairs): Promise<Map<key, LensOut>>`.

The fetcher delegates to the vendored `read-deployless-batch-lens.ts` helper (copied from
`packages/resolvers/src/rpc/` in `prime-monorepo`). That helper type-checks the array-in /
array-out shape, wraps viem-dlc's `policy(...)` + `readContract` so the deployless transport
recognizes and chunks the call (`batchSize: MAX_INITCODE_SIZE`, `exfil: 'revert'`), and returns a
`Map<K, V>` keyed/valued by user-supplied fns. We vendor it (one file copy) rather than depend on
a new shared package; if a second bot needs it we promote it to `@repo/utils`.

**soltag is a build-time transform.** A `sol`-tagged template throws at runtime unless
transformed (and unplugin's `unplugin.bun()` is unusable under bun — its `onLoad` returns
`undefined`). The bot ships `soltag.preload.ts` — a hand-rolled `Bun.plugin` driving soltag's
`transformSolTemplates` (optimizer on, scoped to this bot) — wired via `bunfig.toml` `preload`
for `bun test` and the Docker runtime. `soltag` + `solc` are therefore **runtime** deps in the
bot (the preload compiles the lens on load). The `@repo/contracts` ABIs are compiled at build
time instead.

### Sizing math

All pure, mirror the contract verbatim. `now = LensOut.blockTimestamp` (chain time, not host).
`maxLif` and `lltv` are **per-collateral** — read from `market.collateralParams[collateralIndex]`,
not from the market. The liquidator chooses `postMaturityMode` (see `plan.ts` below); the LIF
ramp applies only in that mode.

**Debt fidelity.** `liquidate` reads raw `_position.debt` with no pre-accrual step, and
`isHealthy` uses the same field; continuous fees accrue into `credit` / `pendingFee` /
`continuousFeeCredit`, **never** into `debt`. So the lens reading raw `debtOf(id, borrower)` is
exactly faithful to what `liquidate` computes — no fee field is needed in `LensOut`.

```ts
// sizing/lif.ts
function lifAt({ now, maturity, maxLif, postMaturityMode }: {
  now: bigint; maturity: bigint; maxLif: bigint; postMaturityMode: boolean
}): bigint {
  if (!postMaturityMode) return maxLif                           // normal mode: full incentive
  // post-maturity mode: linear ramp WAD → maxLif over TIME_TO_MAX_LIF
  const lif = WAD + ((maxLif - WAD) * (now - maturity)) / TIME_TO_MAX_LIF
  return lif < maxLif ? lif : maxLif                             // min(maxLif, …)
}

// sizing/rcf.ts — normal mode only (no cap in post-maturity mode).
// Subtlety: when the position carries bad debt, liquidate() writes it off
// (`_position.debt -= badDebt`) BEFORE computing maxRepaid, so the cap is taken against the
// *post-writeoff* debt. We pass the lens's `badDebt` and subtract it here so our cap matches
// the contract's exactly: maxRepaid = ((debt - badDebt) - maxDebt).mulDivUp(WAD², WAD² - lif·lltv)
function maxRepaidPreMaturity({ debt, badDebt, maxDebt, lif, lltv }: {
  debt: bigint; badDebt: bigint; maxDebt: bigint; lif: bigint; lltv: bigint
}): bigint {
  if (lltv >= WAD) return MAX_UINT
  const effectiveDebt = debt - badDebt          // = min(debt, Σ collateral·price·WAD/maxLif)
  // maxLif is derived from lltv as WAD²/(WAD - cursor·(WAD-lltv)), which makes maxLif·lltv <= WAD²
  // for every allowed lltv < WAD, so the denominator stays positive.
  return mulDivUp(effectiveDebt - maxDebt, WAD * WAD, WAD * WAD - lif * lltv)
}

// RCF cap is waived for the SAME slot being liquidated when the slot's pre-seizure value
// (converted to repaid-units by dividing through LIF, then subtracting maxRepaid with a zero
// floor) is below rcfThreshold.
function isRcfExempt({ collateralAmt, price, lif, maxRepaid, rcfThreshold }: {
  collateralAmt: bigint; price: bigint; lif: bigint; maxRepaid: bigint; rcfThreshold: bigint
}): boolean {
  const slotInLoanUnits = floorDiv(collateralAmt * price, ORACLE_PRICE_SCALE)
  const slotInRepaidUnits = floorDiv(slotInLoanUnits * WAD, lif)
  return zeroFloorSub(slotInRepaidUnits, maxRepaid) < rcfThreshold
}
```

`sizing/plan.ts` picks the mode, then the amounts:

- **Not liquidatable** (no debt, or locked) → skip.
- `postMaturityMode = now > market.maturity`. If pre-maturity **and** `healthy` → skip
  (full `maxLif` and the RCF cap apply only in normal mode; post-maturity gets the ramped LIF and
  no RCF cap).
- **Fully underwater** (`badDebt >= debt`) → **bad-debt realization**:
  `{ seizedAssets: 0, repaidUnits: 0 }`. The contract writes off the bad debt with no token
  movement; the encoder emits a bare `liquidate` (no callback queue, no swap, no sweeps).
- **Post-maturity** (no RCF cap) → seize 100% of the best slot **only if** its implied repaid
  units fit within the post-writeoff debt (`debt - badDebt`); otherwise pass
  `repaidUnits = debt - badDebt` and let the contract derive the smaller seize. Seizing 100%
  unconditionally over-repays when the slot is worth more than the debt — the common case of a
  solvent borrower who simply missed maturity — and the contract reverts `Panic(0x11)` on
  `_position.debt -= repaidUnits` (no clamp post-maturity).
- **Normal mode** (pre-maturity, unhealthy) → seize 100% of the slot if that stays within
  `maxRepaid` **or** the slot is RCF-exempt; otherwise pass `repaidUnits = maxRepaid`.

The plan emits exactly one nonzero amount; the contract derives the other side. The `badDebt`
correction in `maxRepaidPreMaturity` matters for the normal-mode cap-binding branch; the
post-maturity path uses `effectiveDebt` directly. An over-large `repaidUnits` fails closed in
`simulate()` rather than on-chain — a missed liquidation, never a loss.

### Tx queue

**Nonce assignment is delegated to viem's `createNonceManager`** (`viem/nonce`, with a `jsonRpc()`
source, attached to the `privateKeyToAccount` in `signer.ts`) — no hand-rolled counter. `signer.ts`
exposes a small primitive set the queue consumes: `send` (runs `prepareTransactionRequest` —
explicit `nonceManager` on first send — to claim + read the nonce, then `sendTransaction`),
`getReceipt`, and `getBaseFee`. Parallel sends claim sequential nonces automatically; the manager
syncs from `getTransactionCount('pending')` on first use and re-syncs on drift. Our queue does
**not** own a `nextNonce` cursor.

`queue/pending-queue.ts` owns what viem's manager does not — tracking, confirmation, and
bump/replace — via an in-memory `Map<nonce, Pending>`. Each `Pending` carries its `nonce`,
`txHash`, the source `request`, `label`, `submittedAtBlock`, the current `maxFeePerGas` /
`maxPriorityFeePerGas`, and an `attempt` counter.

**Submit.** `send(...)` claims the next nonce via the manager and returns the assigned nonce; we
record the entry. No awaiting needed between submits.

**Backpressure.** The queue exposes `inflightLabels()` — the set of `"${marketId}:${borrower}"`
labels currently pending — and the tick skips any candidate already in flight, so a position with
a pending tx is not re-planned/re-submitted.

**Fee bump.** Pure `bumpFees({ maxFeePerGas, maxPriorityFeePerGas, baseFee, maxFeeWei })`:

- new priority = max(prev × 1125/1000, prev + 1) // ≥12.5% EIP-1559 floor
- new max = max(prev × 1125/1000, baseFee × 2 + new priority)
- if the bumped max exceeds `maxFeeWei` → `drop()` rather than chase the spike

**Replacement.** When we bump, we **explicitly pass `nonce: pending.nonce`** to the send —
bypassing the nonce manager (which only acts when `nonce` is unset). This is the one case where we
hand-pick the nonce.

**Stuck detection.** Each polled block, scan `pending` for `currentBlock - submittedAtBlock >
STUCK_BLOCKS (4)` and not yet confirmed. Fetch receipt; null → bump + replace at the same nonce,
`attempt++`. After `MAX_BUMP_ATTEMPTS (3)`, log `tx.dropped` and remove from our map.

**Drift / gap awareness.** Viem's nonce manager re-syncs from chain on send errors. If a
confirmation from a higher nonce arrives while a lower nonce is still pending, we walk
lower-nonce pending entries, query their receipts, and mark each confirmed/replaced/dropped
accordingly. No `nextNonce` math on our side.

**Reorg awareness.** Deliberately none beyond receipt re-confirmation. Acceptable for a
coverage bot — a re-orged-out tx re-appears as a liquidatable position on the next tick.

**Shutdown (SIGTERM/SIGINT).** Stop the watcher, stop accepting new plans, log a final `shutdown`
dump of `pending` (hashes + nonces), and exit. Sends are fire-and-forget — pending txs continue
on-wire, and chain truth wins on restart (the signer's nonce manager re-syncs from the pending
chain nonce).

### Tick loop

`runner/watcher.ts` runs a `setInterval(getBlockNumber, BLOCK_POLL_MS)` loop (`BLOCK_POLL_MS =
2_000`, defined in `watcher.ts`) against the HTTP RPC; WebSocket transports and `eth_subscribe`
are explicitly avoided. On each new block height it enqueues an event; if a tick is mid-flight,
only the latest height is processed next (backlog coalesces).

`runner/tick.ts` per new block:

1. Emit the rindexer-lag signal (`rindexer.lag`); observability-only, fails open, always proceeds.
2. Discover `(marketId, borrower)` candidates from Postgres → lens inputs
   `{ id, borrower, caller = Executor }`.
3. Read the lens for all pairs in one deployless `eth_call` (`lens.read`).
4. Drop pairs whose label is already in `queue.inflightLabels()` (backpressure).
5. For each `isLiquidatable(out)`: `plan()` → resolve the per-collateral `buildSwapStep` (skip
   with `config.no_swap_path` if no route; bad-debt realizations skip swap config) →
   `simulate()`.
6. Submit **only** when `simulate` returns `ok` (`ok`-only gate: any revert — slippage, repay
   shortfall, or not-liquidatable — is an unfundable plan, so it's skipped, never broadcast).
7. `queue.onBlock(chainHead)` — confirmations, stuck-detection, bumps.
8. Emit `tick.end` with counters.

### Executor integration

We vendor [`Rubilmax/executooor`](https://github.com/Rubilmax/executooor) Solidity into
`@repo/contracts` (`solidity/Executor.sol`) and apply **one functional change**: remove
`require(msg.sender == OWNER)` from `exec_606BaXt` (and drop the `OWNER` immutable +
constructor argument), making it a permissionless shared singleton — any EOA can call
`exec_606BaXt(bytes[])`. The only other diff is a pragma relaxation (`0.8.25` → `^0.8.25`) so the
repo's solc (0.8.35) compile-verifies the vendored copy. **No constructor** means the singleton is
protocol- and chain-agnostic: one deployment serves any Midnight instance, at the same CREATE2
address on every chain. It requires a Cancun-capable chain (transient storage, `mcopy`).

**No typed `onLiquidate` handler is needed.** `Midnight.liquidate` takes a `callback` address and
requires `ILiquidateCallback(callback).onLiquidate(...) == CALLBACK_SUCCESS`
(`= keccak256("morpho.midnight.callbackSuccess") =
0x7f87788ea698181ea4d28d1576d0ba4fc92c0dbe5bf75b43692af2ce91dbaea2`). The upstream Executor's bare
`fallback` already services magic-value callbacks (Aave / Balancer / Morpho Blue flashloans): it
decodes its embedded blob as `(bytes[] queue, bytes returnData)`, runs the queue, and returns
`returnData` **raw** (Solidity's `fallback(bytes) returns (bytes)` applies no ABI wrapping).
Encoding the raw 32-byte `CALLBACK_SUCCESS` as the trailing bytes satisfies Midnight's check. A
typed handler's remaining benefits (exact-`repaidUnits` approval, token cross-checks, a `MIDNIGHT`
immutable gate) were bot-self-protection only — and with the owner gate stripped, **any** between-tx
balance or allowance on the singleton is already claimable/settable by anyone via `exec_606BaXt`,
so contract-side defenses add no third-party security. The security burden sits with each caller,
per transaction (the encoder + the simulate residual check). The pre-deploy audit shrinks to
"confirm a three-line deletion from upstream."

**The liquidation exec.** `execution/encode-call.ts` (`encodeLiquidationExec`) builds
`Executor.exec_606BaXt(bytes[])` as:

1. A single **9-arg** `Midnight.liquidate(market, collateralIndex, seizedAssets, repaidUnits,
borrower, postMaturityMode, receiver, callback, data)` with `receiver = callback = the
Executor`. The seized collateral lands on the Executor **before** the callback; the repay is
   pulled from the callback (= the Executor) **after** it returns. The call carries the Executor's
   callback context `{ sender: MIDNIGHT, dataIndex: 8 }` — `data` is the 9th arg (head word 8) of
   the **10-arg** `onLiquidate(caller, id, market, collateralIndex, seizedAssets, repaidUnits,
borrower, receiver, data, badDebt)` callback, and the Executor's fallback gates
   `msg.sender == MIDNIGHT`.
2. `data` carries `abi.encode(bytes[] queue, bytes returnData)` with `returnData = CALLBACK_SUCCESS`
   passed **raw** (not `abi.encode`'d — that would prepend an offset word and break the check). The
   queue, run when Midnight calls back into the Executor:
   - `approve(collateral → router, 0)` then `approve(collateral → router, balanceOf(executor))`
     — a **zero-first pair**. Anyone can pre-set a nonzero allowance from the shared singleton, so
     a single plain `approve` is a standing DoS on approve-from-nonzero-reverting (USDT-style)
     tokens.
   - `exactInputSingle` on the `SwapRouter02`-compatible router: collateral → loan token,
     `amountIn` = the Executor's live collateral balance (the cap-binding branch passes
     `seizedAssets = 0` and the contract derives the amount on-chain, so neither this nor the
     repay is known when the calldata is built), `amountOutMinimum` from the lens's fresh USD value
     × `(10000 - slippageBps) / 10000`.
   - `approve(loan → MIDNIGHT, 0)` then `approve(loan → MIDNIGHT, balanceOf(executor))` —
     **balance-based** (over-approving by the profit margin, since the recomputed `repaidUnits`
     isn't staticcall-readable), zero-first for the same reason. The residual allowance is inert
     while the full-drain invariant keeps the Executor's balance at zero between txs.

   The amounts use self-referential `balanceOf` placeholders: at exec time the Executor staticcalls
   `token.balanceOf(executor)` and splices the result over the amount word of the sub-call, so the
   encoder commits to no off-chain amount.

3. Two trailing outer sweeps (`skim` of the loan token then the collateral token to the EOA),
   running **after** `liquidate` returns — Midnight's end-of-call repay `transferFrom` happens
   within `liquidate`, so sweeping earlier would strip the loan token before the pull.

A **bad-debt realization** plan (`seizedAssets = repaidUnits = 0`) skips all of this: a bare
`liquidate(receiver = EOA, callback = 0, data = '0x')` with no callback queue and no sweeps —
Midnight writes off the bad debt without moving tokens.

**Full-drain invariant.** The Executor is shared and permissionless, so it must end every
transaction holding **zero** of either token — anything left behind is up for grabs by the next
caller. Seizing 100% of a slot and swapping all of it into the loan token means the loan-token
balance after repay is the bot's profit and the collateral balance is normally zero, but we sweep
both anyway against swap dust, partial fills, or an under-seize. Belt-and-suspenders: the
`simulate()` residual check rejects any plan that would leave a non-zero residual, so a
missing-sweep regression fails closed in sim rather than silently donating funds. (The structural
sweeps are unit-tested; the literal on-chain zero-residual post-state is asserted by the anvil
fork suite.)

**TypeScript encoder.** Uses upstream [`executooor-viem`](https://www.npmjs.com/package/executooor-viem)'s
`ExecutorEncoder.buildCall` (+ placeholders) for the inner calls, wrapped by the Midnight-aware
`encodeLiquidationExec(...)`. Pure, no RPC. `tokenIn` (= collateral) and `tokenOut` (= loan token)
are derived from the `Market` — not carried in `SwapStep` — so they can't drift from the
`liquidate` args. The `SwapStep` is just `{ router, fee, amountOutMinimum }`.

Per-collateral swap config at `SWAP_CONFIG_PATH`:

```json
{
  "<chainId>": {
    "<collateralToken>": { "router": "0x...", "fee": 500, "slippageBps": 50 }
  }
}
```

A single file may describe several chains; the bot reads its own chain's entry at swap time. A
missing entry for a non-bad-debt plan → skip with `config.no_swap_path`. The bot signs and
broadcasts `{ to: EXECUTOOOR_ADDRESS, data: encodeLiquidationExec(...) }`; it **never** calls
`Midnight.liquidate` directly.

**Gate whitelisting caveat.** `Midnight.liquidate` checks `canLiquidate(msg.sender)`, which is the
Executor address (not the EOA). Markets with non-trivial liquidator gates must whitelist the
singleton Executor. For markets we curate this is straightforward; for third-party markets it
becomes the gate owner's responsibility.

### Config

Env vars (fail-loud on missing required):

| Var                      | Required | Default  | Purpose                                          |
| ------------------------ | -------- | -------- | ------------------------------------------------ |
| `CHAIN_ID`               | yes      | —        | Must be in chain map (v0: Base `8453`)           |
| `RPC_URL`                | yes      | —        | Primary RPC (reads, simulation, sends)           |
| `RPC_URL_FALLBACK`       | no       | —        | Optional viem-dlc `failover` second endpoint     |
| `LIQUIDATOR_PRIVATE_KEY` | yes      | —        | EOA hex key (`0x` + 32-byte hex)                 |
| `EXECUTOOOR_ADDRESS`     | no       | derived  | Override; default is the derived CREATE2 address |
| `DATABASE_URL`           | yes      | —        | Postgres for the co-located rindexer (discovery) |
| `SWAP_CONFIG_PATH`       | yes      | —        | Per-collateral swap params JSON                  |
| `MAX_FEE_GWEI`           | no       | `300`    | Hard ceiling for fee bumps                       |
| `CACHE_DIR`              | no       | `.cache` | soltag / deployless cache dir                    |
| `LOG_LEVEL`              | no       | `info`   | `debug` / `info` / `warn` / `error`              |

Chain map in `config.ts`: `{ [chainId]: { chain, midnight: Address } }` — fail loudly when
`CHAIN_ID` isn't present. v0 wires Base (8453), Midnight =
`0x3726353bCDDba7c29a17D46D8a35D1E8b2E51854`. The deployless lens needs **no** per-chain deployer:
soltag bakes the canonical CREATE2 factory + `factoryData` into its compiled output, and the same
`Executor.with()` baking gives the derived `EXECUTOOOR_ADDRESS`.

Startup validation: parse the private key (`0x` + 32-byte hex), read + zod-validate the swap config
JSON, default/parse the derived `EXECUTOOOR_ADDRESS`, then `assertContractDeployed` (`getCode`
non-empty — a liveness gate, not an identity check; fatal with the deploy command when no code is
found). Emit a one-line `startup` log with `{ chainId, liquidator, callback, midnight }`.

### Hosting

The bot, its co-located rindexer, and Postgres deploy to **Railway**, a managed platform, rather
than a heavier internally-operated orchestration stack. The trade is iteration speed and ownership
against deeper platform integration: Railway needs no cross-team coordination to stand up, so a
single engineer can provision, deploy, and tear down the whole topology, and it stays fully under
the bot team's control. For a v0 safety-net liquidator that must _work_ reliably, that autonomy
outweighs the shared tooling, secrets management, and observability a fuller platform would bring;
promoting the bot onto a more managed platform is a natural follow-up if it ever becomes
load-bearing infrastructure. Railway also serves the reference-implementation reader: this bot is
open-source, and an outside integrator can stand up a Railway project from the committed
`Dockerfile` and deploy script far more easily than they could reproduce a bespoke internal
deployment stack.

The Railway topology mirrors the local `docker-compose.yml`: managed Postgres, a rindexer service
indexing `Take`, and the bot runner, all in one Railway project. The shared multi-stage
`Dockerfile` is the single build source for both Railway and compose — a `BUILD_TARGET` build-arg
selects the stage (Railway always builds the final stage and cannot pass `--target`), and the swap
config rides on a Railway volume the operator uploads out-of-band (no host bind mount). An
idempotent `scripts/deploy-railway.ts` drives the `railway` CLI, reading secrets from the
environment and setting them as service variables — never logged, never committed. These deploy
mechanics live in the deploy script, the `Dockerfile`, and the bot README, not here.

## Considered Alternatives

### Alternative 1: Cron / one-shot topology

Run `main()` once per cron tick (every 30–60s), drain queue with a short internal wait, exit.

**Why rejected:** The runner is barely more complex (a `setInterval`-polled `getBlockNumber` loop
wrapping the same tick function) and gives us per-block reactivity at no extra cost. Cron would
race itself when a queue drain runs long.

### Alternative 2: Discovery via a hosted Morpho API instead of a co-located rindexer

Refresh borrow positions from a hosted Morpho API each tick, each row carrying its `Market` config
inline.

**Why rejected:** The hosted position endpoint is **per-user** — it requires a `user` parameter, so
there is no global borrow-position listing to enumerate the borrower universe from. A hosted indexer
also adds an availability dependency on the liquidation hot path. A co-located rindexer indexing `Take` gives us
the full universe straight from chain logs with no external dependency, and the lens still reads
every decision fresh — so indexer lag is only coverage latency, never a correctness issue.

### Alternative 3: Trust an indexer's state for the liquidation decision (skip the lens)

An indexer (ours or hosted) exposes `debt`, `collaterals[]`, oracles, and health. We could size
and decide straight off it.

**Why rejected:** A position can flip unhealthy → healthy (or vice versa) within a single block,
and we will not let indexer lag or an RPC hiccup determine whether we send a transaction. Discovery
says _who_ might be liquidatable; the lens, read fresh in one `eth_call` against a single
`block.timestamp`, says _whether it still is_.

### Alternative 4: Multicall instead of a deployless lens

Use a two/three-multicall pattern (gate, `isHealthy`, oracle reads) and avoid soltag entirely.

**Why rejected:** Round-trips at the wrong batch granularity, every value fetched independently
with no shared `block.timestamp`. The lens reads everything inside one `eth_call`, evaluates
LIF/RCF math against a single chain time, and returns exactly the struct sizing wants. Multicall
would force LIF evaluation against the host clock or a separate `block.timestamp` read — both
subtly wrong.

### Alternative 5: Persistent queue state across runner restarts

Persist `pending` to disk so a restart can recover in-flight transactions.

**Why rejected:** Operationally fragile (stale state + chain divergence), and unnecessary —
`getTransactionCount('pending')` on init slots us above any in-flight tx, and the next tick
re-discovers the position if the tx was dropped. Chain is the source of truth.

### Alternative 6: Multi-hop swap routing inside the callback

Wire the callback queue to a path-aware router (Uniswap Universal Router, 0x).

**Why rejected:** Explicitly out of scope per the "single-hop, no routing" decision. Volatile
collateral configurations can use a permissive `slippageBps` or be omitted; the fallback bot
accepts coverage gaps over the complexity of routing.

## Assumptions & Constraints

- The co-located rindexer keeps reasonable pace with Base. Its lag is observability-only; the bot
  proceeds regardless and reads decision state fresh via the lens.
- Midnight's `Take` event is the only debt-creating path, and its indexed `taker` / `maker` cover
  every borrower (the lens drops the non-debtor of the pair).
- `toMarket(id)` returns the canonical `Market` for a created id and reverts for an unknown id (the
  lens isolates the revert per element). The id is a cryptographic commitment to the `Market`, so
  the lens never trusts an off-chain market.
- The generic Executor (`@repo/contracts` `Executor.sol` — owner gate stripped) is deployed at the
  derived CREATE2 address on every supported chain. The bot fails loud at startup with the deploy
  command if no code is found there.
- Markets we care about either have no `liquidatorGate` or have whitelisted the Executor.
- The deployless transport's `exfil: 'revert'` path is preserved by the operator's RPC provider
  (Alchemy / Infura preserve revert data; some self-hosted nodes do not — verify before deploy).
- Single-hop Uniswap-V3-compatible pools exist for each collateral the operator opts into.
- The operator funds the EOA with native gas, runs one process per chain, and manages the swap
  config file out-of-band. The chain is Cancun-capable (the Executor uses transient storage and
  `mcopy`).

## Dependencies

- `@morpho-org/viem-dlc` (catalog): `deployless`, `failover` transports; `policy()`,
  `resolveArrayFunction`, codec helpers.
- `soltag` + `solc` (catalog, **runtime**): the soltag preload compiles the lens on load; the
  `@repo/contracts` package soltag-compiles its ABIs/bytecode at build time.
- `executooor-viem` (catalog): the upstream `ExecutorEncoder` (`buildCall` + placeholders) and
  `executorAbi`. Our Midnight-aware encoder is a thin wrapper.
- `viem` (catalog): `createPublicClient`, `createWalletClient`, `getBlockNumber` (polled), `call`
  (simulation), `sendTransaction`, `getTransactionReceipt`, `getBlock`, `privateKeyToAccount`, and
  `createNonceManager` + `jsonRpc` (from `viem/nonce`).
- `zod` (catalog): swap-config validation.
- `@repo/contracts` (workspace): `MidnightAbi` and the vendored `Executor` (with the `.with()`
  deterministic factory). Soltag-compiled from vendored Solidity; also materializes
  `abis/Midnight.json` for rindexer.
- `@repo/utils` (workspace): `tryCatch`, `addressSchema`, `allFulfilled`.
- Out-of-repo: the co-located **rindexer** Postgres (borrower universe, `DATABASE_URL`); the
  `rindexer` image (ghcr) that indexes `Take`; the deployed Executor singleton at the derived
  address.

## Observability

JSON-line via `logger.ts` (`debug` / `info` / `warn` / `error`; bigints stringified). Stable event
keys:

```
startup              { chainId, liquidator, callback, midnight }
runner.start         { intervalMs }
runner.shutdown      { }
block.new            { height }                            // one per new block height (coalesced)
rindexer.lag         { chainHead, synced, lag } | { reason: 'unknown', chainHead }
                                                           //   observability; warn if lag>30, never skips
lens.read            { pairs, returned }
plan.built           { marketId, borrower, collateralIndex, seizedAssets, repaidUnits, postMaturityMode }
config.no_swap_path   { marketId, borrower, collateralIndex }   // no route configured for this collateral
simulate.ok          { marketId, borrower }
simulate.revert      { marketId, borrower, reason }        // unfundable plan → never broadcast
tx.sent              { label, nonce, txHash, maxFee, priority }
tx.bumped            { nonce, oldHash, newHash, attempt, maxFee, priority }
tx.confirmed         { nonce, txHash, blockNumber }
tx.dropped           { nonce, txHash, reason }             // reason: 'max_bump_attempts' | 'fee_ceiling'
tx.reverted          { nonce, txHash, blockNumber }
tick.end             { pairs, liquidatable, planned, noSwapPath, ok, reverted, submitted }
tick.error           { error }                             // a tick threw; the runner loop survives
watcher.error        { error }                             // a block poll (getBlockNumber) failed
shutdown             { signal, pending }
```

No external metrics deps: `error` goes to stderr, everything else to stdout, and that is the whole
sink — on Railway the platform captures both streams. The logs are structured enough to ship, but
nothing ships them yet. Forwarding these logs/traces to BetterStack and wiring Slack notifications
are deferred to v1 (see Future Considerations).

_Update (2026-07-14): the BetterStack log-forwarding half is now implemented additively — see
[TIB-2026-07-14-betterstack-log-forwarding](./TIB-2026-07-14-betterstack-log-forwarding.md)._

_Update (2026-08-31, BOTS-90): the field names in the catalogue above are historical. Every
position-scoped event now carries the position as a single **`id`** field valued
`lensKey(marketId, borrower)` — including the `tx.*` events, whose `label` field was renamed to `id`.
`marketId` / `borrower` survive on `plan.built` as human-readable extras only. See
[TIB-2026-08-28-midnight-send-shortfall-classification](./TIB-2026-08-28-midnight-send-shortfall-classification.md)
and the bots' READMEs._

## Security

- **Private key handling.** `LIQUIDATOR_PRIVATE_KEY` read from env once at startup, never logged,
  never written to disk. No `.env` file checked in (covered by repo `.gitignore`).
- **Gate target.** `canLiquidate` is checked against `EXECUTOOOR_ADDRESS`, not the EOA. The lens
  input carries the `caller` address explicitly so this can't drift between layers.
- **Canonical `Market` from `toMarket(id)`.** We never call `liquidate` with a `Market` we didn't
  read on-chain from its id; the id is a cryptographic commitment to the struct, so a forged or
  stale market can't slip in.
- **Slippage on the swap.** `amountOutMinimum` derived from the lens's fresh USD value via a
  per-collateral `slippageBps`. Beyond that the swap reverts atomically mid-`liquidate` and the
  whole liquidate reverts — no loss, just a wasted gas estimate.
- **Full drain of the shared singleton.** The Executor is permissionless and shared, so any
  residual balance is claimable by the next caller. The dual-token sweep and the `simulate()`
  residual check enforce a zero ending balance: a missing-sweep regression fails closed in sim
  rather than donating funds.
- **Permissionless singleton — caller-side defenses.** The Executor carries no protocol-specific
  Solidity and no owner gate, so between-tx balances and allowances are claimable/settable by
  anyone. Each caller defends per-transaction: **zero-first approve pairs** (no standing allowance
  a prior caller could weaponize, and no DoS on approve-from-nonzero tokens), a **balance-based**
  repay approval (inert under the zero-balance-between-txs invariant), and the simulate residual
  check. The callback path is gated on `msg.sender == MIDNIGHT` via the call's context; the
  `call_g0oyU7o` self-call gate (`msg.sender == address(this)`) is upstream-unchanged. Because the
  diff from upstream is a three-line deletion, the pre-deploy audit is correspondingly small —
  flag it when the vendored contract goes to review.
- **Replay / front-running.** No sensitive payload; the bot's transactions are public by
  construction (we're a fallback, not racing).

## Future Considerations

- A profitability gate as a follow-up TIB if operating cost becomes material.
- Multi-hop routing as a follow-up TIB once volatile collaterals matter to coverage.
- **Additional liquidity venues beyond Uniswap V3 — fast-follow.** Execution today resolves a single
  operator-declared Uniswap-V3-style `exactInputSingle` route per collateral (in
  `execution/swap-step.ts` and `execution/encode-call.ts`). A near-term follow-up is supporting other
  venues — additional AMMs (Aerodrome, Curve, Balancer) and/or DEX aggregators (0x, 1inch, CoW) — as
  alternative `SwapStep` route kinds selected from the swap config, widening collateral coverage where
  Uniswap V3 liquidity is thin. Distinct from the multi-hop item above, which is about path depth on
  one venue rather than the choice of venue. Each new venue rides the same generic-Executor callback
  queue, so it is an encoder/config change, not a contract change.
- Multi-chain in one process if ops complexity favors it (probably not).
- A persisted queue state with replay-safe semantics, if restarts become frequent enough to
  warrant it.
- **Richer observability (BetterStack traces + Slack notifications) — deferred to v1.** Today the bot
  emits only the structured JSON-line logs above to stdout/stderr, which Railway captures; there are
  no traces, metrics dashboards, or alerting integrations. Two follow-ups: (1) ship the logs/traces to
  **BetterStack** (the org's telemetry backend) for searchable retention, dashboards, and latency
  tracing across the discover → lens → simulate → submit path; and (2) wire **Slack notifications**
  for operationally significant events — confirmed liquidations (`tx.confirmed`) and the failure
  signals (`tx.reverted`, `tx.dropped`, sustained `tick.error` / `watcher.error`) that today surface
  only in logs. The stable event keys in Observability are designed to be shipped as-is, so this is an
  additive forwarding/alerting layer rather than a logging rework.
- Throughput under a large simultaneous wave of liquidatable accounts. The design is correct and
  uncapped for a wave — no discovery `LIMIT` in `discovery/borrowers.ts`, one batched/chunked
  deployless lens read, watcher tick-coalescing in `runner/watcher.ts` (the `draining` guard means
  slow ticks never overlap), `inflightLabels()` backpressure, and stuck-tx fee-bump — so the limit
  is throughput/latency, not correctness: a wave clears serially over several blocks rather than
  instantly. Bottlenecks, in order of impact:
  - Single liquidator EOA → one serialized nonce stream (`signer.ts` `createNonceManager`): all
    liquidations broadcast in nonce order from one account; a reverting tx still mines and advances,
    but an underpriced/stuck tx head-of-line-blocks higher nonces until the queue bumps it
    (`STUCK_BLOCKS=4`, `MAX_BUMP_ATTEMPTS=3`). This is the fundamental serializer.
  - Per-position simulate+submit is sequential within a tick — `runner/tick.ts` uses a plain
    `for … await simulate … await submit` loop (no bounded `Promise.all`), so tick latency grows
    linearly with liquidatable-position count; simulate is read-only and safe to parallelize.
  - The pending-queue sweep is sequential too — `queue/pending-queue.ts` `onBlock` awaits
    `getReceipt` per entry one at a time, linear in pending count.
  - `maxFeeWei` cap (default 300 gwei): waves often coincide with gas spikes, and bumps past the
    ceiling drop txs (`fee_ceiling`), throttling throughput under congestion.
  - Operational: the liquidator EOA must hold enough ETH to fund per-tx gas across the whole wave
    (the Executor self-funds swap/repay from seized collateral, not the gas).
    Candidate mitigations — all deferred, none needed for v0 single-position / low-volume operation:
    parallelize simulate (bounded concurrency), parallelize the queue's `getReceipt` sweep, run
    multiple liquidator EOAs (biggest win — breaks the single-nonce-stream serialization), and
    auto-raise `maxFeeWei` during detected waves.
- RPC-usage scalability — read/`eth_call` volume per block, distinct from the submission-throughput
  bullet above. Fine at v0, but the every-block full-universe lens read over an unbounded candidate
  set scales poorly. Concerns, in order of impact:
  - Full-universe lens read every block over a monotonically-growing set. `runner/tick.ts` reads the
    lens for the entire candidate set unconditionally every tick (step 3, before any liquidatability
    check), and `runner/watcher.ts` ticks every block (`BLOCK_POLL_MS = 2_000`). Discovery
    (`discovery/borrowers.ts` `BORROWERS_SQL`) is a `SELECT DISTINCT market_id, borrower` over every
    `taker`/`maker` of all `Take` events ever — no `LIMIT`/debt-filter/time-window — so it only grows;
    repaid/closed positions linger (lens returns `hasDebt=false`) and re-read every block. Compute
    scales with all-time borrowers, not active debt (each `computeOne` does `toMarket + debtOf +
liquidationLocked + collateralBitmap + per-slot oracle `price()`), and `toMarket(id)`is
recomputed per`(id, borrower)`rather than deduped per`marketId`.
  - Repeated `simulate` with no cooldown. Any liquidatable, not-in-flight position is re-simulated (an
    `eth_call`) every block (`runner/tick.ts`); a perpetually-liquidatable-but-unsubmittable position
    burns one every ~2s indefinitely — no backoff/de-dup beyond `inflightLabels()`.
  - Per-tx RPC amplification. Each submit's `prepareTransactionRequest` (`signer.ts`) does an
    `eth_estimateGas` on top of the raw send; the queue's `onBlock` (`queue/pending-queue.ts`) does a
    sequential `getReceipt` per entry every block (+ `getBaseFee`/re-broadcast on bump), so M pending
    txs = M `eth_getTransactionReceipt`/block until they clear.
  - Baseline cadence: pure HTTP polling on a fixed ~2s interval, no `eth_subscribe`/WebSocket and no
    oracle-update trigger, so the full per-tick read cost is paid every block regardless of price
    movement. (Adjacent, not RPC: the rindexer `DISTINCT`-union also runs every tick.)
    Candidate mitigations — most deferred, none needed for v0: prune/cooldown the candidate set (drop
    `hasDebt=false` pairs). Per-position failure backoff is now available (CRTR-2807): the
    `liquidate` transform records positions whose attempt fails to produce a submittable tx
    (`no_config`/`quote_failed`/`sim_reverted`) and skips re-quoting them for
    `POSITION_LIQUIDATION_COOLDOWN_MS` (opt-in, default 0 = off). Still deferred: cache immutable
    markets (`toMarket`
    by `marketId`) and dedupe within a read; tier the cadence (slow full scan + a per-block hot set, or
    trigger off oracle updates); size lens chunks to the provider's real `eth_call` cap; batch
    `getReceipt`.

## Open Questions

- **Singleton deployment — Resolved.** The Executor is deployed deterministically via the canonical
  Foundry/Arachnid CREATE2 factory (`0x4e59b44847b379578588920cA78FbF26c0B4956C`) with a fixed
  salt; the no-constructor bytecode lands at the **same address on every chain**
  (`0x6d9dEA0Ae96156862A534e5016173d3e001CB7D0`), which the bot derives from `Executor.with()` and
  the deploy script reuses (one salt, one source of truth). Deploy once per chain with
  `bun run --filter @repo/contracts deploy:executor` (idempotent, fail-loud, chain-agnostic — it
  resolves the chain from the live `eth_chainId`; needs `RPC_URL` + `DEPLOYER_PRIVATE_KEY`). Gate
  whitelisting in third-party `liquidatorGate`s remains the gate owner's responsibility; v0 scopes
  to Morpho-curated markets.
- **Discovery outage policy — Obsolete.** There is no hosted API to go down. Discovery is the local
  rindexer, and decisions read fresh via the lens; rindexer lag is coverage latency only.
- **Lens calibration target — still open.** The inline gas coefficients
  (`{ constant: 600_000, linear: 30_000, quadratic: 0 }`) are placeholders. Calibrate on a Base
  fork — including a position with all 16 slots activated (the worst-case loop) — before go-live.

## Verification

After each phase:

1. `bun install` succeeds with catalog entries (`soltag`, `solc`, `executooor-viem`, viem-dlc).
2. `bun run --filter @morpho-org/midnight-liquidation typecheck` → 0 errors (runs `soltag` first to
   regenerate the lens type codegen).
3. `bun lint` → 0 warnings.
4. `bun test` → all unit tests pass, including:
   - LIF: normal mode (→ maxLif) vs post-maturity ramp boundaries (at maturity → WAD / mid-curve /
     past `TIME_TO_MAX_LIF` → maxLif).
   - `maxRepaidPreMaturity` matches the contract's
     `mulDivUp((debt−badDebt)−maxDebt, WAD², WAD²−lif·lltv)` exactly, including the bad-debt
     writeoff case (`badDebt > 0`); RCF cap with and without the `rcfThreshold` exemption; cap
     waived in post-maturity mode.
   - `plan()` mode selection: past maturity → postMaturityMode; pre-maturity healthy → skip; the
     post-maturity over-seize clamp (repay `debt − badDebt` when 100% over-repays); the
     fully-underwater bad-debt realization (zero/zero plan).
   - `activeBits` bitmap iteration.
   - Nonce queue: parallel-submit nonce assignment, fee-bump ≥12.5%, gap detection,
     `inflightLabels` backpressure.
   - Lens shapes: encode/decode roundtrip, selector match via `resolveArrayFunction(fragment)`.
   - Executor exec-encoder: selector + args golden hex against the Executor ABI, including the
     callback queue (zero-first approve pairs, swap, balance-based repay approval) and the two
     trailing sweep calls (loan + collateral) targeting the recipient EOA.
   - Discovery SQL: the `taker`/`maker` union and the `MAX(block_number)` lag query.
5. Anvil fork suite (`test/fork/`): fork Base at a pinned block, reuse a real open position warped
   past maturity, deploy the Executor via the same CREATE2 factory, and drive the full real path
   (lens → plan → swap → `encodeLiquidationExec` → `simulate` → signed broadcast). Assert receipt
   success, the EOA gains the loan token, and the Executor ends holding **zero** of both tokens
   (the literal zero-residual post-state — the full-drain invariant). Separately: queue
   bump + replacement against a real node (automining off; advance past `STUCK_BLOCKS`, the
   same-nonce replacement lands). The deliberately-underpriced replacement stays a manual testnet
   gate (needs a funded EOA).
6. Per-test vacuity check: flip one assertion in each new unit test file, confirm the test fails,
   then revert (CONVENTIONS gate).
7. Smoke run on Base: runner up for ≥1 h, observe expected `tick.end` cadence, verify no orphaned
   `pending` entries on graceful SIGTERM.

## References

- Rubilmax executooor (basis for the generic singleton):
  `https://github.com/Rubilmax/executooor`
- viem-dlc: `https://github.com/morpho-org/viem-dlc`
- viem `createNonceManager`: `https://viem.sh/docs/accounts/local/createNonceManager`
- soltag: `https://github.com/haydenshively/soltag`
- **Canonical Midnight interface:** the vendored
  `packages/contracts/solidity/interfaces/IMidnight.sol`, re-vendored from `prime-monorepo`. It
  emits the real event set (`Take`, `MarketCreated`, `Repay`, `SupplyCollateral`,
  `WithdrawCollateral`, `Withdraw`, `Liquidate`, `FlashLoan`) and is byte-faithful to the deployed
  Base Midnight (`0x3726353bCDDba7c29a17D46D8a35D1E8b2E51854`). The authoritative surface for this
  TIB: **9-arg** `liquidate`, **10-arg** `onLiquidate` (return checked against
  `CALLBACK_SUCCESS = 0x7f87…aea2`), `toMarket` / `Market`.
- `docs/context/repos/midnight-contracts.txt` is a **historical snapshot** (commit `5e9ecd58`,
  generated 2026-06-03) that predates the deployed `main`. The inline `:NNNN` line numbers cited in
  a few comments here and in `sizing/plan.ts` point at that snapshot and are approximate; for the
  authoritative surface, trust the vendored interface above and the deployed contract.

### 2026-07-10 — persistent runner and Alternative 5 superseded by the pipeline architecture

[TIB-2026-07-13 (bot architecture)](./TIB-2026-07-13-bot-architecture.md) supersedes two of this
TIB's decisions. The persistent runner (block watcher + timer refresh loop) is replaced by one-shot
pipeline ops driven by unix loops; the markets whitelist refreshes inline when stale, fail-closed.
Alternative 5 ("Persistent queue state across runner restarts", rejected here) is inverted **as
required by the one-shot model**: a per-run process with no memory of its pending txs could never
fee-bump a stuck one. The spirit survives — persisted state is a hint reconciled against chain
truth, and losing the file degrades to this TIB's restart semantics.
