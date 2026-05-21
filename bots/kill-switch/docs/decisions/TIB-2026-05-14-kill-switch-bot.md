# TIB-2026-05-14: Architecture of the kill-switch bot

| Field      | Value              |
| ---------- | ------------------ |
| **Status** | Proposed           |
| **Date**   | 2026-05-14         |
| **Author** | @cashd             |
| **Scope**  | Bot: `kill-switch` |

---

## Context

Morpho curators operating Vaults V1 (MetaMorpho V1.0 and V1.1) supply liquidity across potentially hundreds of underlying markets per vault. Each market is priced by an oracle whose price can drift away from the asset's true off-chain reference, whose `updatedAt` timestamp can stale out, or whose `price()` call can revert outright. When any of those conditions surfaces and the curator can't intervene fast enough, new deposits keep routing into a market the curator no longer trusts — and lender funds end up exposed to a broken price feed.

The curator needs an automated circuit breaker — a "kill switch" — that watches the chain, detects oracle staleness, deviation, or reverting on the markets in a vault's supply queue, and stops new deposits to the affected markets without the curator having to be at a keyboard. The bot does **not** pull existing funds out; existing exposure drains naturally as users withdraw, and a future Reallocation Bot (called out in the Linear project description) will handle the reallocate-existing-funds case.

[TIB-2026-04-16](../../../../docs/decisions/TIB-2026-04-16-bootstrap-curator-bots.md) stood up the `curator-bots` repo scaffolding and named the Kill Switch Bot as the first planned bot. That bootstrap TIB stopped at "empty `bots/`" — it did not decide how the bot is built. This TIB picks up there and settles the architecture for `kill-switch` only.

Operational constraints that bound the design, per the Linear project description:

- **RPC-only on the hot path.** No indexers, no subgraphs, no external databases.
- **Stateless.** No `eth_logs` subscriptions, no historical event queries, no persisted state whose loss would break correctness. All caches reconstructable from current chain state.
- **Fault-tolerant + self-correcting.** Transient failures recover on the next tick without manual intervention; persistent failures alert loudly.
- **Open-source deployable.** Curators clone (or fork) the repo, configure, and run their own instance.

**Process model up front.** The bot ships as **one Bun process per `(chain, vault)`**. A curator running N vaults across M chains runs N processes total — container orchestration (Docker Compose, k8s, Railway services) is the curator's responsibility. Each process has its own private key, its own RPC list, and its own vault config. This gives true fault isolation between vaults and chains, trivial nonce management (one process = one nonce stream), and a drastically simpler implementation than a single multi-tenant runtime.

## Goals / Non-Goals

**Goals**

- Detect oracle health issues — **staleness**, **deviation**, **reverting** — on every market in a vault's `supplyQueue` and call `setSupplyQueue` excluding the affected markets.
- Run as **one Bun process per `(chain, vault)`**. Operator orchestrates multiple processes if they have multiple vaults or chains.
- Submit calls from a single EOA per process via viem's `nonceManager`. v1 is EOA-only; smart-wallet support is captured under Future Considerations.
- Make adapter layers pluggable: **oracle staleness** (Chainlink, Pyth, RedStone) and **reference-price** (vendor-direct Chainlink/Pyth/RedStone as gold standard, plus morpho-api and DefiLlama as discouraged-but-shipped reference implementations). Ship sensible defaults so the common case is configurable without writing code; require a fork to add new vendor-specific implementations.
- Detect staleness **entirely on-chain**, by reading the underlying vendor feed directly (e.g., Chainlink `AggregatorV3.latestRoundData`) — never through the Morpho `IOracle` interface, which doesn't expose `updatedAt`.
- Stay RPC-only and stateless on the hot path. All caches reconstructable; restart is idempotent.
- Ship as an **open-source bot curators can clone and run** with a documented setup path (README, sample config, CONTRIBUTING, SECURITY, mainnet walkthrough).

**Success signal.** `kill-switch` runs continuously against one Vaults V1 vault on mainnet for one week in live mode with no operator intervention; on a synthesized oracle condition (staleness, deviation, or revert), the bot emits one `setSupplyQueue` transaction within one polling interval (block seen → tx broadcast). Before that, the same bot ran in dry-run mode against the same configuration for at least 24h with the operator reviewing `/status/near-misses` and confirming threshold tuning.

**Non-Goals**

- **Vaults V2.** V2's allocator surface (multi-asset, market obligations, offers) is materially different and deserves its own TIB once V2 vaults are live.
- **New on-chain code.** This TIB does not propose deploying any new smart contracts.
- **A "Vaults V1 bot framework" abstraction.** No `(trigger, action)` registry, no `BotEntry`, no shared multi-bot scaffolding in v1. If a second curator bot lands, that work decides what to extract — this TIB does not anticipate it.
- **Multi-vault or multi-chain per process.** One process serves exactly one `(chain, vault)`. Curators run multiple processes for multiple vaults / chains.
- **Action surface broader than `setSupplyQueue`.** No `reallocate` (future Reallocation Bot), no cap management (timelocked, curator-only), no withdraw-queue updates.
- **PublicAllocator interaction.** If a curator has it enabled with non-zero flow caps on an affected market, that path is outside this bot's protection scope. Curator-side decision.
- **Smart-wallet submission.** EOA-only in v1. Smart-wallet (Safe-1/1, CB Smart Wallet, EIP-7702) tracked under Future Considerations.
- **OpenTelemetry / distributed tracing / Prometheus `/metrics`.** v1 ships stdout JSON logs + `/status`. OTEL gets its own follow-up TIB if a curator asks for it.
- **Streak fuse / submission backoff.** If the bot's submission keeps reverting, the bot keeps trying. The curator's signal is gas burn + `/status` revert counters. Re-evaluate if operator experience shows uncapped retries are worse than alternatives.
- **Admin endpoints.** No `/admin/unfuse` (no fuse), no `/admin/dry-run` hot-flip. Dry-run is config + restart only — restart is cheap when the process serves one vault.
- **Reference-price `auto` selection.** Operator must declare a reference adapter explicitly per oracle (or omit deviation entirely).
- **Hot-reload of static config.** Config changes require restart.

## Proposed Solution

### Architectural overview

One Bun process serves exactly one `(chain, vault)`. The per-tick loop is:

```
[per-tick loop, every pollIntervalMs]
  poll eth_blockNumber
    → if blockNumber > lastSeen, run the pipeline
        → multicall (aggregate3): isAllocator + supplyQueue + oracle.price + vendor staleness feeds
        → reference-price adapter fetches (parallel HTTP, deduped per oracle)
        → evaluate: per-market staleness ∪ deviation ∪ reverting
        → plan: setSupplyQueue with affected markets removed (idempotent)
        → simulate via eth_call from wallet
        → submit one TX through viem nonceManager
        → observe via stdout JSON + /status
```

There is no "framework layer" — the code is organized internally (evaluator, writer, adapter interfaces, polling loop, RPC client, health server), but those are implementation modules, not extension surfaces other bots reuse.

### Tech stack

Inherits the repo posture established in [TIB-2026-04-16](../../../../docs/decisions/TIB-2026-04-16-bootstrap-curator-bots.md) (bun runtime + package manager, oxlint/oxfmt, `bun test`, `@repo/*` namespace, TS-as-config). Bot-specific choices:

| Layer                     | Choice                                                                                                                       | Rationale                                                                                                                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime                   | Bun (repo default)                                                                                                           | Fast startup, good fetch perf for adapter calls.                                                                                                                                                                                                 |
| Language                  | TypeScript strict (repo default)                                                                                             | Type safety across ABI decoding, price math, adapter interfaces.                                                                                                                                                                                 |
| Config format             | TS-as-config, operator-forked; Zod for runtime validation at the boundary                                                    | Type safety and autocomplete at edit time; matches the "fork to extend" pattern used for custom adapters. Types are hand-written and canonical; Zod schemas validate at runtime and are kept in sync via a CI assertion.                         |
| Chain interaction         | viem (stable surface)                                                                                                        | Typed ABI encoding, native multicall, viem's `nonceManager` for ordered EOA submission, lighter than ethers.                                                                                                                                     |
| Block ingestion           | **HTTP polling** of `eth_blockNumber` at configurable interval (default 10s mainnet, 4s L2)                                  | Simpler than WS. Reaction time is not a sub-block product requirement. No watchdog, no reconnect, no rotate-on-WS-failure machinery.                                                                                                             |
| Read batching             | Multicall3 (`0xcA11bde05977b3631167028862bE2a173976CA11`) `aggregate3` with `allowFailure: true`, **static chunk size ~100** | Reverting oracle calls don't poison the whole batch; per-call success flags surface the revert as a trigger condition. Static chunking is simpler than adaptive grow/shrink; ~100 fits gas on every chain we target.                             |
| Reference-price source    | Per-oracle adapter, **operator-declared explicitly** — no `auto` default                                                     | Recommended: `chainlink-direct`, `pyth-direct`, `redstone-direct` (vendor-direct, independent of the Morpho oracle under test). Discouraged-but-shipped: `morpho-api`, `defillama` as reference implementations (see circularity warning below). |
| Oracle staleness adapters | **Vendor-direct** (Chainlink `AggregatorV3`, Pyth `PriceFeed`, RedStone, …)                                                  | The Morpho `IOracle` interface doesn't expose `updatedAt`; the bot reads the vendor feed directly. Operator declares vendor feed addresses per oracle in config. Ships default vendor adapters; fork to add new vendors.                         |
| Write path                | EOA-direct submission via viem; `nonceManager` orders nonce issuance within the process                                      | One process = one EOA = one nonce stream. No abstraction layer; the EOA submitter is inlined.                                                                                                                                                    |
| Signing key custody       | `Bun.env.SIGNER_PRIVATE_KEY`                                                                                                 | Matches repo convention. Custodial upgrade (KMS / Turnkey / Privy) tracked in Future Considerations.                                                                                                                                             |
| Hosting                   | Railway US-East as reference deployment; bot is portable (any Bun + RPC host runs it)                                        | Persistent process, managed deploys, proximity to Alchemy us-east-1. Docker image is the primary distribution; Railway is one of many places to run it.                                                                                          |
| RPC provider              | Operator-supplied ordered HTTP list; per-endpoint circuit breaker rotates on failure                                         | Bot makes no recommendation beyond "at least two HTTP endpoints".                                                                                                                                                                                |
| Observability             | **stdout JSON logs** + `/status` rich-health endpoint                                                                        | Vendor-neutral; containers (Railway, Docker, k8s) pick up stdout natively. OTEL deferred to a follow-up TIB.                                                                                                                                     |
| Health endpoints          | `Bun.serve()` exposing `/healthz`, `/readyz`, `/status`, `/status/near-misses` (dry-run only)                                | Single small surface; no framework needed.                                                                                                                                                                                                       |

### Block ingestion: HTTP polling

A single HTTP poll loop in the process. Every `pollIntervalMs` (configurable, default 10s mainnet / 4s L2):

1. Call `eth_blockNumber`.
2. If the returned number is greater than `lastSeen`, run the per-tick pipeline against that block number.
3. Otherwise, sleep and poll again.

```typescript
while (!stopRequested) {
  const blockNumber = await client.getBlockNumber()
  if (blockNumber > lastSeen) {
    lastSeen = blockNumber
    await runTick(blockNumber)
  }
  await sleep(pollIntervalMs)
}
```

**Why polling, not WebSocket.** Reaction time isn't a sub-block product requirement — the oracle conditions this bot detects (staleness on the order of minutes, deviation on the order of bps drift, outright revert) are seconds-to-minutes phenomena, not block-to-block races. Polling at 10s on mainnet adds at most one polling interval of latency over WS, in exchange for removing the WS connection lifecycle (reconnect, keepalive, liveness watchdog, rotate-on-WS-failure) entirely.

**Cancellation on new block.** If a tick for block N is still running when the next poll returns N+1, cancel N via `AbortController` and start N+1. Stale results from a prior block are worthless for kill-switch decisions.

**Poll failure.** If `eth_blockNumber` itself fails (RPC error, timeout), the per-endpoint circuit breaker counts the failure and the next attempt rotates to the next RPC. The tick is skipped; the bot tries again next interval.

### Read path: Multicall3 `aggregate3`, static chunk size

All on-chain reads per tick fold into one or more `Multicall3.aggregate3(allowFailure: true)` calls. Per tick the batch contains:

1. **`vault.supplyQueue(i)` enumerations** — the current supply queue.
2. **`vault.isAllocator(walletAddress)`** — per-tick re-check; revocation surfaces in the same tick it happens.
3. **Oracle `price()` calls** — one per unique oracle across the deduped watched-market set.
4. **Vendor staleness reads** — for each oracle, the calls its staleness adapter contributes (e.g., for Chainlink: `latestRoundData()` on each configured underlying feed). Reads the vendor feed **directly**, never the Morpho `IOracle` wrapper.

Per-call `allowFailure: true` is the critical knob: a reverting `oracle.price()` becomes a per-call success flag in the response (not a multicall-wide revert), which the bot reads as the "reverting" trigger condition (one of kill switch's three).

**Static chunk size.** Fixed at ~100 calls per chunk (configurable). If a chunk would exceed practical RPC gas ceilings, the operator lowers the value. Hand-rolled adaptive chunking and library options (viem-dlc / soltag-lens) are captured under Future Considerations — for the read volume one vault produces, static is sufficient.

This collapses ~200 individual `eth_call`s into 1–2 round-trips per tick. Per [CONVENTIONS.md](../../../../docs/CONVENTIONS.md), prefer `readDeploylessBatchLens` when a Lens contract models the entity well; for the heterogeneous price + staleness + state read here, Multicall3 is the right tool.

### Markets and oracle configuration

Operator config declares the **vault** (one) and its **markets** (one or more). Each oracle in use is configured separately in `oracleConfigs`, keyed by the Morpho oracle wrapper address that `MorphoBlue.idToMarketParams(marketId).oracle` resolves to.

**Startup gate (fail loud, never silently degrade).** For the configured `(chain, vault)`, in this order:

1. **RPC reachability.** `eth_chainId` responds; returned ID matches declared `id`. Catches misconfigured RPC URLs.
2. **Wallet derivation.** Derive EOA address from `signer.privateKeyEnv`.
3. **Allocator role check.** `vault.isAllocator(walletAddress) == true`. **Bot refuses to start** if this fails.
4. **Wallet balance floor.** `wallet.balance >= configured floor`. **FAIL** in live mode; **WARN** in dry-run mode (no gas will be spent).
5. **Market → oracle resolution.** For every declared market, read `MorphoBlue.idToMarketParams(marketId)` once; cache the resulting oracle address process-locally (markets are immutable). **Fail loud** if any market resolves to an oracle without a config entry in `oracleConfigs`.

**Runtime drift handling.** If on a later tick the bot finds a market in the vault's `supplyQueue` whose oracle isn't configured (curator added a market with a new oracle while the bot was running):

- **Staleness + reverting checks still run** with fallback defaults (24h staleness, single revert), because they're pure on-chain reads needing no operator input.
- **Deviation check is skipped** (no reference adapter configured → no reference price → can't compute deviation).
- **High-severity stdout ERROR** to the operator: "new oracle in vault — configure it or accept the deviation-blind protection".

This preserves a partial-protection floor for newly-added markets without requiring an instant config update, while making the visibility gap loud enough that the operator can't miss it.

### Adapters: oracle staleness and reference-price

Two adapter layers, orthogonal in config, both per-oracle, both with default implementations the bot ships and a "fork to add new vendor / source" extension model.

**Oracle staleness adapters** read `updatedAt` directly from the vendor feed (Chainlink, Pyth, RedStone, …) — never through the Morpho `IOracle` interface, which doesn't expose a timestamp. Operator declares the vendor feed addresses for each oracle in config.

```typescript
interface OracleStalenessAdapter {
  readonly name: string                                            // 'chainlink', 'pyth', 'redstone', ...
  getStalenessReads(spec: AdapterSpec): readonly Call[]            // contributes to the per-tick multicall
  decodeStaleness(spec: AdapterSpec, results: readonly Bytes[]): { minUpdatedAt: number }
}
```

v1 ships built-in adapters for **Chainlink** (reads `latestRoundData().updatedAt` on the operator-declared base/quote feed addresses, returns the min), **Pyth** (reads `priceFeed.publishTime`), and **RedStone** (reads the per-signature timestamp). Adding a new vendor adapter requires a fork.

**Reference-price adapters** fetch the off-chain reference price the deviation check compares against the on-chain oracle price.

```typescript
interface ReferencePriceAdapter {
  readonly name: string                                            // 'chainlink-direct', 'pyth-direct', 'morpho-api', ...
  fetch(spec: AdapterSpec, ctx: AdapterContext): Promise<{ price: bigint; observedAt: number }>
}
```

v1 ships two tiers:

**Recommended (vendor-direct):**

- **`chainlink-direct`** — reads price from a Chainlink feed the operator declares as the reference. The operator MUST choose a feed independent of the Morpho oracle under test (e.g., reference a different deployment, a different chain's feed, or a different aggregation) — using the same feed the Morpho oracle wraps is self-referential and defeats the deviation check.
- **`pyth-direct`** — reads price from a Pyth feed under the same independence requirement.
- **`redstone-direct`** — reads price from a RedStone feed under the same independence requirement.

**Discouraged, shipped as reference implementations:**

- **`morpho-api`** (`api.morpho.org` GraphQL) and **`defillama`** (`coins.llama.fi` REST). Both are HTTP-based adapters useful as **examples of what a custom adapter looks like**, but **their use in production is discouraged** because of a circularity risk: morpho-api currently transitively sources prices from DefiLlama, and DefiLlama may source from the same on-chain oracles the kill switch is testing. A self-referential reference price masks the very deviation the bot exists to detect.

Selecting `morpho-api` or `defillama` for an oracle's `referenceAdapter` emits a high-severity WARN at startup and on every fetch, naming the oracle and the adapter. Operators may proceed knowingly; the warning ensures it's not silent.

Operators MUST pick a reference adapter **explicitly** per oracle. There is no `auto` selection. If `deviationBps` is omitted from an oracle's config, the deviation check is skipped for that oracle and only staleness + reverting run.

Adding a custom reference adapter requires a fork.

**Adapter failure handling.** When a reference-price adapter call fails (HTTP 5xx, timeout, throws), the deviation check is skipped for that oracle this tick; staleness and reverting still run. Persistent failure surfaces as a stdout WARN counter the operator can monitor via `/status`. (No streak fuse — see Failure modes.)

**Operator config shape:**

```typescript
// bots/kill-switch/src/config.ts (operator-forked)
export const config: KillSwitchBotConfig = {
  signer: { privateKeyEnv: 'SIGNER_PRIVATE_KEY' },
  chain: {
    id: 1,
    rpc: { http: [process.env.RPC_PRIMARY!, process.env.RPC_FALLBACK!] },
    pollIntervalMs: 10_000,
    walletBalanceFloor: '0.05',                                   // ETH; required, no default ships
  },
  vault: {
    address: '0xVAULT_A',
    markets: ['0xMARKET_1', '0xMARKET_2', /* ... */],
  },
  oracleConfigs: [
    {
      morphoOracleAddress: '0xMORPHO_ORACLE_X',
      stalenessAdapter: 'chainlink',
      stalenessSpec: { feeds: ['0xCHAINLINK_BASE_FEED', '0xCHAINLINK_QUOTE_FEED'] },
      stalenessSeconds: 1800,
      // Deviation is optional. Omit referenceAdapter + deviationBps to skip the deviation check
      // for this oracle and run only staleness + reverting.
      deviationBps: 50,
      referenceAdapter: 'chainlink-direct',                       // recommended; vendor-direct
      referenceSpec: { feed: '0xINDEPENDENT_CHAINLINK_FEED' },
    },
    // ...
  ],
  dryRun: false,
}
```

### Kill switch: evaluation and writer

The per-tick evaluator emits, for each `(market)` in the vault's `supplyQueue` whose oracle fires any of three conditions, an `OracleHealthIntent`:

| Condition | Predicate                                                          |
| --------- | ------------------------------------------------------------------ | ---------------------- | ------------------------------------ |
| Staleness | `blockTime - oracleUpdatedAt > stalenessSeconds`                   |
| Deviation | `                                                                  | oraclePrice - refPrice | / refPrice \* 10_000 > deviationBps` |
| Reverting | The oracle's `price()` per-call success flag was `false` this tick |

A single revert is enough to fire reverting (RPC blips fail the whole multicall, not per-call). Configured thresholds are per-oracle. A market whose oracle is reverting can't be price-checked, so deviation/staleness are skipped for it on that tick — but reverting itself fires the protection, so the market is still protected.

The writer consumes the intents and, if at least one affected market remains in the current `supplyQueue`, produces exactly one `Call`:

```typescript
{
  to: vault,
  data: encodeFunctionData({
    abi: MetaMorphoAbi,
    functionName: 'setSupplyQueue',
    args: [filteredSupplyQueue],     // current supplyQueue with affected markets removed
  }),
  value: 0n,
}
```

Properties:

- **Idempotent.** If the affected market is no longer in the current `supplyQueue` (curator removed it manually, or a prior fire already filtered it), no `Call` is produced.
- **No-op safe.** Restart between detection and submission, or two concurrent bot instances by mistake, produce calls whose effect is "set the queue to the already-current state" — a transactional no-op, not a corruption.
- **Atomic per call.** A single `setSupplyQueue` either lands fully or reverts fully.

The V1.0 and V1.1 `setSupplyQueue` signatures are byte-for-byte identical (the V1.1 ABI diffs are purely additive — `lostAssets`, `setName`/`setSymbol`, `UpdateLostAssets`). The bot uses the V1.0 ABI subset for both generations.

### Write path: EOA submission

One process → one EOA → one nonce stream. The submission path is inlined:

- **Simulation.** Before broadcast, the planned call is simulated via `eth_call` with `from: walletAddress` — `msg.sender` inside the called contract is correctly the bot's EOA, so the allocator-role check passes during simulation when it'll pass at submission. Simulation-revert errors are caught and surface as a structured log + `/status` entry; the submission is skipped and the next tick re-evaluates idempotently.
- **Nonce ordering.** viem's `nonceManager` issues nonces sequentially. Within a single process this is trivial (one in-flight TX at a time on the kill-switch hot path; the `nonceManager` is still useful for nonce caching and recovery from RPC nonce-state drift).
- **Inflight tracking.** Per-process in-memory pending-tx tracker. While a TX is inflight the writer doesn't re-plan; clears on terminal status. Lost on restart, but stateless recovery: post-restart the next tick reads the filtered queue (if confirmed) or the unfiltered queue (if reverted/abandoned) and re-plans idempotently. Hard timeout: 20 blocks before treating an inflight as abandoned.
- **Stuck-TX recovery.** If a broadcast TX hasn't confirmed within `min(3 blocks, 30s)`, replace-at-nonce with a 1.5× gas bump; cap at 3 bumps; after exhaustion, mark the submission failed and let the next tick retry.
- **Persistent revert handling.** **No streak fuse.** If submissions keep reverting (e.g., a config bug or a persistent race), the bot keeps trying every tick. The operator's signal is the gas burn and the revert counter exposed in `/status`. A fuse adds complexity for a failure mode the operator can detect and respond to manually; if real operator experience shows uncapped retries are worse than the alternative, a fuse can land in a follow-up.

### RPC fault tolerance

**Per-endpoint circuit breaker.** The chain config holds an ordered list of HTTP RPC URLs. Per endpoint: consecutive-failure counter, last failure timestamp, rolling p95 latency. After N consecutive failures or sustained p95 above threshold, the endpoint is marked degraded; the bot rotates to the next; the degraded entry recovers after cooldown.

**Multicall failover (read path):**

```
attempt RPC1 with AbortController timeout
  → on failure, attempt RPC2
  → on failure, attempt RPC3
  → if all fail, skip tick + emit `multicall.all_endpoints_failed` + /status flag
```

**Shared state.** Circuit-breaker state is shared between the poll loop and the multicall path — degraded endpoints are skipped for both.

### Dry-run mode

A `dryRun: true` flag in config replaces broadcast with simulation-and-record. When dry-run is active:

- The bot still runs simulation (so simulation-revert errors still surface in logs).
- It does **not** broadcast the TX. Instead it records a "would-have-fired" entry in `/status/near-misses` and a structured log line with the planned call.
- The startup balance-floor check is **demoted from FAIL to WARN** (no gas will be spent); all other startup gates remain FAIL.

**Flip mechanism.** Config change + restart only. Per-vault process makes restart cheap. No admin endpoints, no hot flip.

**`/status/near-misses`** (dry-run only) exposes evaluations that came close to firing — useful during canary for threshold tuning. Each entry includes the per-condition deltas (e.g., "deviation was 47 bps; threshold is 50 bps"). Disappears in live mode to keep `/status` clean.

### Observability

**stdout JSON logs.** All structured logs go to stdout as JSON-per-line. Containers (Railway, Docker, k8s) pick them up natively; operators wire those into whatever log aggregator they use. The bot never names a specific backend.

**`/status` rich-health endpoint.** Always on; returns JSON with the bot's absolute core stats. Operators can curl it, wire it to an uptime monitor, or build a dashboard around it with zero observability infrastructure.

```jsonc
{
  "bot": "kill-switch",
  "version": "0.1.0",
  "mode": "live",                              // or "dry-run"
  "uptimeSeconds": 3600,
  "chain": {
    "id": 1,
    "lastBlockProcessed": 18500000,
    "lastBlockProcessedAt": "2026-05-14T15:30:00Z",
    "secondsSinceLastBlock": 6,
    "pollIntervalMs": 10000,
    "rpc": [{ "url": "alchemy", "state": "healthy", "p95LatencyMs": 45 }, /* ... */]
  },
  "wallet": { "address": "0xEOA", "balanceNative": "0.245", "belowFloor": false },
  "vault": {
    "address": "0xVAULT",
    "isAllocator": true,
    "marketsWatched": 12,
    "lastActionAt": "2026-05-13T10:00:00Z",
    "lastActionTxHash": "0x...",
    "consecutiveReverts": 0
  },
  "oracleConfigsHealth": { "configured": 8, "unconfigured": 0 },
  "recentActions": [/* ring buffer, last 50 evaluations that produced a call */],
  "errors": { "last24h": 0, "lastError": null }
}
```

**Log catalog (high-level; specific names locked at impl time).** `tick.start`, `tick.skipped`, `multicall.ok`, `multicall.failed`, `multicall.partial_revert` (carries per-call success flags), `adapter.fetch.ok`, `adapter.fetch.failed`, `oracle.staleness.evaluated`, `oracle.deviation.evaluated`, `oracle.reverting.detected`, `kill_switch.fire`, `tx.simulated.ok`, `tx.simulated.reverted`, `tx.broadcast`, `tx.confirmed`, `tx.reverted`, `tx.bumped`, `rpc.circuit.open`, `rpc.rotated`, `startup.gate.passed`, `startup.gate.failed`, `drift.new_oracle_detected`, `reference_adapter.discouraged_use_warning`.

**OpenTelemetry / `/metrics` Prometheus / distributed tracing.** Deferred. v1 ships stdout JSON + `/status`; that gets a curator to "I know what my bot is doing" without adding a dependency stack or expanding this TIB's surface. A follow-up TIB covers OTEL once one curator running v1 actually asks for it.

### Failure modes & posture

**Posture: fail-safe and alert-loud.** When the bot can't do its job perfectly, it does as much as it safely can, alerts the operator via stdout + `/status`, and never silently degrades into a state where it could miss a kill-switch trigger.

| #   | Mode                                      | Cause                                                       | Response                                                                                                                                                                                                          |
| --- | ----------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | RPC endpoint degraded                     | Provider rate-limit, latency spike                          | Circuit breaker rotates to next endpoint; degraded cooldown then re-tried.                                                                                                                                        |
| 2   | All RPCs failed                           | Provider-wide outage                                        | Skip tick; `multicall.all_endpoints_failed` log + `/status` flag; retry next tick.                                                                                                                                |
| 3   | Multicall partial revert (oracle reverts) | An oracle's `price()` reverts                               | `aggregate3` per-call success flags surface it; the reverting trigger condition fires. **Normal flow, not an error.**                                                                                             |
| 4   | Reference adapter fails                   | morpho-api down, DefiLlama 503, custom adapter throws       | Skip deviation check for that oracle this tick; staleness + reverting still run. Persistent failure → stdout WARN; `/status` counter.                                                                             |
| 5   | Action simulation reverts (pre-broadcast) | Race with curator manual change; bot-computed queue invalid | Skip submission; log + `/status` with diff (computed vs current queue); next tick re-reads idempotently.                                                                                                          |
| 6   | Action TX reverts (post-broadcast)        | Race won between sim and submission                         | Log + `/status` revert counter increments; clear inflight; next tick re-reads and re-evaluates. **No fuse — bot keeps trying.**                                                                                   |
| 7   | Action TX stuck pending                   | Mempool congestion, underpriced gas                         | Replace-at-nonce with 1.5× bump; detect at `min(3 blocks, 30s)`; 3-bump cap; after exhaustion, log as `submission_failed` and let next tick retry.                                                                |
| 8   | Wallet balance below floor (mid-run)      | Bot has been firing; operator hasn't topped up              | Metric + `/status` flag + stdout WARN. Bot continues (detection + alerts continue); no auto-pause.                                                                                                                |
| 9   | Allocator role revoked mid-run            | Curator changed vault config                                | Detected via per-tick `isAllocator` read in the standard multicall. stdout ERROR; bot continues (subsequent submissions will fail at simulation, which is the right shape — the operator sees the revoke loudly). |
| 10  | New oracle in supplyQueue without config  | Curator added a market mid-run                              | Apply fallback staleness (24h) + reverting checks; skip deviation (no reference); stdout ERROR.                                                                                                                   |
| 11  | Process crash / restart                   | OOM, deploy, signal                                         | Stateless recovery: re-read everything on next tick. Inflight from before crash unknown to bot but idempotent (`setSupplyQueue` of already-filtered queue is a no-op).                                            |
| 12  | Two bot instances against same vault      | Operator mistake or HA experiment                           | Both attempt to fire; first lands, second's read sees filtered queue and skips. Documented as **not supported** but not actively prevented.                                                                       |

### Hosting

- **Primary distribution: Docker / OCI image** built from this repo via the workspace CI (image build is part of the open-source-readiness phase). Operators run one container per `(chain, vault)`.
- **Reference deployment: Railway US-East.** Documented in the bot's README with a one-command deploy; recommended for solo curators who want zero-ops. Tradeoff vs bare metal Hetzner: ~5–15 ms vs ~1–5 ms RPC RTT, in exchange for managed deploys, built-in metrics, no systemd/SSH.
- **Local: `bun start --config ./config.ts`** with env vars set. Used for first-time setup, dry-run validation, threshold tuning.
- **Bot is portable.** It's a Bun process + RPC URLs + a config file. It runs anywhere those exist. The TIB does not couple the bot to Railway.

### Implementation Phases

Each phase below is tracked as its own Linear ticket and ships as an independent PR in dependency order. Effort: S (≤1d), M (1–3d), L (3–5d).

**Phase 1 — Skeleton + config.** `bots/kill-switch/` directory; single per-vault process harness with polling loop; config loader (TS-as-config with Zod boundary validation, hand-written types, CI assertion of schema↔type alignment); `AbortController` plumbing; `Bun.serve()` health server with `/healthz`, `/readyz` stubs. **Effort:** M. **Blocks:** 2–7.

**Phase 2 — RPC fault tolerance.** Per-endpoint circuit breaker, ordered HTTP failover, shared state between poll loop and multicall path. **Effort:** M. **Blocks:** 3, 6.

**Phase 3 — Read path: `aggregate3` + static chunking.** Multicall3 client with `allowFailure: true`, static chunk size (~100, configurable), `BlockContext` builder combining on-chain reads with adapter results (parallel), per-tick `isAllocator` folded into the multicall. **Effort:** M. **Blocks:** 4, 5.

**Phase 4 — Staleness adapters.** `OracleStalenessAdapter` interface; built-in vendor adapters for Chainlink, Pyth, RedStone; per-oracle config schema; market → Morpho oracle resolution at startup with process-local cache. **Effort:** M. **Blocks:** 6.

**Phase 5 — Reference-price adapters.** `ReferencePriceAdapter` interface; built-in vendor-direct adapters (`chainlink-direct`, `pyth-direct`, `redstone-direct`); discouraged-but-shipped `morpho-api` and `defillama` adapters with startup + fetch-time circularity warnings. No `auto` selection — operator declares per oracle explicitly. **Effort:** M. **Blocks:** 6.

**Phase 6 — Kill switch detection + writer.** Evaluation logic (staleness ∪ deviation ∪ reverting against `BlockContext`); `setSupplyQueue` writer; inflight tracker; idempotent recovery. **Effort:** M. **Blocks:** 7.

**Phase 7 — EOA submission + startup gate + dry-run wrapper.** viem `nonceManager` integration; per-call `eth_call` simulation; stuck-TX recovery (1.5× bump, 3-bump cap); five-step fail-loud startup gate; dry-run mode (config flag + `/status/near-misses` endpoint). **Effort:** L. **Blocks:** 8.

**Phase 8 — Open-source readiness + mainnet canary.** README (clone-to-running in <10 min for a technical operator); CONTRIBUTING.md (how forks contribute back); SECURITY.md (vuln disclosure, scope); sample `config.ts` with placeholder values; "from clone to first dry-run fire" mainnet walkthrough; Docker image build (via repo CI) and publish; license file (MIT, pending engineering leadership confirmation per Open Questions). Then: run against one curator-owned V1 vault on mainnet in dry-run for ≥24h; curator reviews `/status/near-misses` and confirms threshold tuning; synthesize a deviation event in dry-run to verify the bot would have fired correctly; flip to live behind a curator-acknowledged flag; observe for one week. **Effort:** L. **Blocks:** Merge `kill-switch` v1.0.

## Considered Alternatives

### Alternative 1: Single multi-chain, multi-vault Bun process

Run one process that handles all chains and vaults concurrently on the event loop, with chain-and-vault-scoped state inside.

**Why rejected.** Adds complexity for benefits curators can get for free by spinning up N independent processes. Process-per-vault gives true fault isolation (a panic on vault A doesn't affect vault B), trivial nonce management (one process = one nonce stream, no cross-vault serialization to reason about), and a much simpler implementation. Curators with N vaults orchestrate N processes via Docker Compose / k8s / Railway services — that's a problem container runtimes already solve well. The "elegant" event-loop multi-tenant story was solving a problem we don't have.

### Alternative 2: WebSocket `eth_subscribe('newHeads')`

Subscribe via WS and react to new heads.

**Why rejected.** Reaction time isn't a sub-block product requirement; staleness/deviation/revert are seconds-to-minutes phenomena. Polling at 10s mainnet / 4s L2 satisfies the product bar; the WS-lifecycle machinery (reconnect, keepalive, liveness watchdog, rotate-on-WS-failure) is real complexity we don't need.

### Alternative 3: `Multicall3.aggregate` instead of `aggregate3`

Use the plain `aggregate` function which reverts the whole batch on any inner call failure.

**Why rejected.** A reverting oracle is one of the kill-switch's three trigger conditions. Using `aggregate` makes a reverting oracle indistinguishable from a network failure — both fail the whole multicall, and the bot would have to retry to discover whether any specific oracle was the cause. `aggregate3` with per-call `allowFailure: true` surfaces the revert as data instead of an error, which is exactly what the trigger logic needs.

### Alternative 4: Adaptive multicall chunk sizing

Start large, shrink on revert, grow on success.

**Why rejected for v1.** Hand-rolled adaptive chunking is real code surface to maintain and reason about. Static ~100 fits comfortably under gas on every chain we target for one vault's read volume. If RPC ceilings tighten or we measure waste, revisit. viem-dlc / soltag-lens auto-chunking is captured as a future possibility.

### Alternative 5: Off-chain staleness detection

Track each oracle's last `updatedAt` in an in-memory map keyed by `(chainId, oracleAddress)`, updated from an off-chain feed (Chainlink monitor, vendor API).

**Why rejected.** The oracle's own `updatedAt` is the canonical signal. Reading the vendor feed directly (Chainlink `AggregatorV3.latestRoundData`, Pyth `priceFeed.publishTime`, etc.) folds into the existing multicall at zero extra round-trip cost and removes an off-chain dependency from the most catastrophic-failure-mode detection path.

### Alternative 6: Staleness via the Morpho `IOracle` interface

Read staleness from `morphoOracleAddress` (the address the vault knows about) rather than going directly to the vendor feed.

**Why rejected.** The Morpho `IOracle` interface exposes only `price()` — no `updatedAt`. The bot would have to know about Morpho's `ChainlinkOracle` wrapper's specific layout (`BASE_FEED_1`, `QUOTE_FEED_1`, etc.) and have a different code path for every Morpho oracle implementation. Going directly to the vendor feed keeps the bot's per-tick read path uniform: one adapter per vendor, operator-declared feed addresses, no Morpho-wrapper-specific logic.

### Alternative 7: YAML config instead of TS-as-config

Load operator config from a YAML file at a path env var.

**Why rejected.** Custom adapters require fork (TS code anyway), and config has nested unions where typos and shape errors are easy to introduce. YAML loses the autocomplete + type-checking that those surfaces rely on. The fork-based workflow is also the established extension pattern for adapters — keeping config in the same TS source tree avoids splitting the operator's mental model across two artifacts.

### Alternative 8: Zod `z.infer` as the source of truth for config types

Define config types as `type KillSwitchBotConfig = z.infer<typeof KillSwitchBotConfigSchema>` so the schema _is_ the type — common TS+Zod idiom.

**Why rejected.** Inferred types lose readability (large `z.infer<typeof Schema>` blobs at hover time), cross-reference comments / JSDoc, and IDE rename / refactor support. Hand-written types stay canonical, kept in sync with the schema via a CI assertion that `z.infer<typeof Schema>` is assignable to the hand-written type and vice versa. Costs ~5 lines of test code; recovers the type-system experience.

### Alternative 9: Per-vault streak fuse with exponential re-fuse

After N=3 consecutive submission failures, pause submission for M=50 blocks; re-engage in 50 → 200 → 800 → 3200 blocks.

**Why rejected for v1.** Adds explicit fuse state and a "paused but still evaluating" mode that an operator must reason about. Simpler posture: the bot keeps trying every tick on persistent failure, and the operator monitors `/status.vault.consecutiveReverts`. Gas burn is the natural signal that something's wrong. If real operator experience shows uncapped retries are worse than the alternative (e.g., burning material gas on a deterministic bug), a fuse can land in a follow-up.

### Alternative 10: OpenTelemetry observability stack from v1

OTLP HTTP/protobuf exporter, three signal types (logs + metrics + traces), signal catalog, hot-path queue bounds, `/metrics` Prometheus endpoint.

**Why deferred.** Real value but real scope. v1 ships stdout JSON + `/status`; that gets a curator to "I know what my bot is doing" without adding a chunk of dependencies (the OTEL JS SDK, OTLP exporters, manual instrumentation everywhere) or another ~50 lines of TIB. OTEL gets its own follow-up TIB once one curator running v1 actually asks for it.

### Alternative 11: `auto` reference adapter selection (morpho-api → DefiLlama fallback)

The earlier draft of this TIB had `referenceAdapter: 'auto'` resolve to "try morpho-api; if no coverage, fall back to DefiLlama".

**Why rejected.** Both morpho-api and DefiLlama have a circularity risk: morpho-api currently transitively sources from DefiLlama, and DefiLlama may source from the same on-chain oracles the kill switch is testing. A self-referential reference price masks the very deviation the bot exists to detect. `auto` would silently put operators on this path. v1 requires explicit per-oracle declaration; vendor-direct adapters (`chainlink-direct`, `pyth-direct`, `redstone-direct`) are the recommended choices; morpho-api and defillama ship as reference implementations with prominent warnings.

### Alternative 12: Smart-wallet / Safe-1/1 / EIP-7702 submission in v1

Submit through a smart wallet for atomic batching.

**Why rejected for v1.** Process-per-vault makes cross-vault atomic batching irrelevant — each process produces exactly one `Call` per tick, so there's nothing to batch. Smart-wallet support re-opens if a future composite action (multiple calls atomically) is required. Tracked under Future Considerations.

### Alternative 13: Custom `MorphoBatchAllocator` contract

Deploy a stateless singleton (`MorphoBatchAllocator`) per chain via CREATE2; bot signs one `batchSetSupplyQueue(Call[])` per tick.

**Why rejected.** Same root reason as Alternative 12 — there's nothing to batch when each process serves one vault. Plus: the team would own, audit, and maintain a new on-chain artifact, and curators would have to grant `ALLOCATOR` to two addresses per vault. Hard pass.

### Alternative 14: Periodic allocator-role re-check via a separate `eth_call`

Run a periodic `isAllocator(wallet)` check (e.g., every 60s) outside the per-tick multicall.

**Why rejected.** It's one extra inner call in a Multicall3 batch the bot is already running — negligible cost. Periodic re-check creates a window where the bot might fire-and-fail; per-tick re-check catches revocation in the same tick it happens and surfaces it cleanly.

### Alternative 15: A "Vaults V1 bot framework" abstraction in v1

Build the bot on a `(trigger, action)` registry, `BotEntry` config shape, and shared scaffolding designed to host future Vaults V1 bots (Reallocation Bot V1 migration, governance-triggered actions, etc.).

**Why rejected for v1.** v1 ships one bot. Designing a framework abstraction around a single concrete instance is the kind of speculative generality that ages badly — the second bot, when it arrives, will reveal which seams the framework actually needed and which were guesses. Building the framework now also expands the v1 correctness surface (the most operationally critical thing in a kill switch) for use cases that don't exist yet. If a second bot lands, that work will decide whether to extract a framework from kill switch's structure.

## Assumptions & Constraints

- **Process model.** One Bun process per `(chain, vault)`. Curator orchestrates multiple processes for multiple vaults or chains. Container orchestration is the curator's responsibility.
- **EOA submission via viem `nonceManager`.** Within a single process, nonce issuance is sequential and the kill-switch hot path produces at most one in-flight TX. Assumption holds for the chains this bot targets.
- **Vault `ALLOCATOR` role grants `setSupplyQueue`.** Validated at startup. Cap management remains curator-only and is not in the bot's surface.
- **Markets are immutable.** `MorphoBlue.idToMarketParams(marketId)` returns the same `(loanToken, collateralToken, oracle, irm, lltv)` forever after market creation. The bot caches the market → oracle resolution process-locally.
- **V1.0 and V1.1 share the allocator-relevant surface.** Confirmed by ABI diff — V1.1 adds only `lostAssets`, `setName`/`setSymbol`, and an `UpdateLostAssets` event. The bot uses the V1.0 ABI subset for both generations; it is forward-compatible.
- **In-memory state is acceptable.** Inflight tracker, RPC circuit-breaker state, market → oracle cache. Restart loses these; the worst case is one duplicate `setSupplyQueue` that's a no-op, or one re-evaluation of an already-protected vault. Stateless property preserved.
- **Signing key in env.** `Bun.env.SIGNER_PRIVATE_KEY` is v1; KMS / Turnkey / Privy is in Future Considerations. Operators MUST treat their deploy environment as the trust boundary.
- **Block timestamps are monotonic and chain-truthful.** Sequencer-time anomalies on L2s are a known risk; the bot's fail-safe stance means a clock anomaly causes (at worst) an early kill-switch — the safer direction.
- **PublicAllocator is out of scope.** If a curator has PublicAllocator enabled with non-zero flow caps on an affected market, that path is not covered by `setSupplyQueue`. Curator-side decision.
- **Reference-price source independence.** Operators MUST configure a reference adapter whose data path is independent of the Morpho oracle under test. morpho-api / DefiLlama adapters ship as reference implementations only; their use is discouraged and warned about at startup + fetch time.
- **Open-source distribution is a hard product requirement.** Per the Linear project description: _"Create an open-source deployable bot for Curators to run."_ All current dependencies are permissive-compatible (MIT / Apache 2.0); any future copyleft dependency requires a license-impact review.

## Dependencies

- **viem** (workspace catalog). Stable surface only — `sendTransaction`, `waitForTransactionReceipt`, `nonceManager`, `call` (for simulation), HTTP transport with JSON-RPC batching.
- **Bun** runtime (repo-pinned). `Bun.serve()` for the health server, `bun:test` for tests.
- **Reference-price endpoints.** Vendor-direct (Chainlink/Pyth/RedStone) — on-chain via Multicall3, no HTTP dependency. morpho-api (`https://blue-api.morpho.org/graphql`) and DefiLlama (`https://coins.llama.fi`) — discouraged-but-shipped reference implementations; no key required.
- **RPC providers.** At least two HTTP endpoints per chain (operator-supplied). No specific provider required.
- **`@repo/utils`** — `tryCatch`, structured-log helpers, env-reading conventions.
- **`@repo/abis`** — V1.0/V1.1 MetaMorpho ABI subset (V1.0 is forward-compatible), MorphoBlue ABI, Multicall3 ABI, OracleAbi, vendor feed ABIs (Chainlink `AggregatorV3`, Pyth `PriceFeed`, RedStone).
- **Hosting.** Railway US-East (reference); Docker / OCI image for any other host. No Sentry, no Datadog, no OTEL.
- **Zod** for runtime config validation.

## Security

- **Threat model.** The bot's authority is bounded by the `ALLOCATOR` role on the one vault the process serves. A compromised signing key gives an attacker the ability to call `setSupplyQueue` on that vault (replicating the curator's allocator-role surface) — not to move funds out of the protocol, not to mint shares, not to change curator. Blast radius: reshape the supply queue within the markets the curator already permitted on that vault. The action surface is strictly less than the curator's, by design.
- **Signer custody.** v1 reads the EOA private key from `Bun.env.SIGNER_PRIVATE_KEY`. Hosting environment (Railway / Docker host) is the trust boundary. Future custody upgrade to managed signing (KMS, Turnkey, Privy) tracked in Future Considerations.
- **Reference-price tamper risk.** A compromised reference-price source (morpho-api, DefiLlama, custom adapter) can fabricate deviation and induce a false fire. Mitigations: (1) operators set their own `deviationBps` thresholds — the bot does not act on tiny apparent deviations; (2) per-oracle adapter is operator-chosen and recommended choices are vendor-direct; (3) morpho-api / DefiLlama adapters are flagged as discouraged; (4) future TIB may add cross-adapter agreement.
- **RPC tamper risk.** A compromised RPC endpoint can fabricate on-chain reads. Mitigations: (1) circuit breaker reduces dependence on any one endpoint; (2) per CONVENTIONS.md, RPC calls use explicit block tags for determinism; (3) future TIB may add per-block cross-RPC agreement on critical reads.
- **No upgradeable contracts owned by the team.** The bot does not deploy contracts; the on-chain code it depends on (Morpho V1 vault, vendor feed contracts) is vendor-audited and either non-upgradeable or upgradeable by parties outside the team's threat model.
- **Repo Strict Rules.** Secrets never enter the repo. Pre-commit + commit-msg hooks established by the bootstrap TIB stay in effect. The sample `config.ts` ships with placeholder values that don't imply any real curator's vault.

## Future Considerations

- **OpenTelemetry observability.** Logs / metrics / traces via OTLP HTTP/protobuf, signal catalog, hot-path queue bounds, optional `/metrics` Prometheus endpoint. Deferred to a follow-up TIB; v1 ships stdout JSON + `/status`.
- **Managed signer custody.** KMS, Turnkey, Privy replace `Bun.env.SIGNER_PRIVATE_KEY`. Only the inner signer's `signMessage` / `signTypedData` changes.
- **Smart-wallet submission (Safe-1/1, CB Smart Wallet, EIP-7702).** Reopens cross-call atomic batching if a future composite action needs it. v1's process-per-vault model has nothing to batch.
- **Cross-adapter price agreement.** Require N-of-M reference-price adapters to agree before firing deviation. Useful once a curator runs the bot on a high-stakes vault and wants belt-and-braces on the reference source.
- **Per-block cross-RPC agreement.** Read the same oracle from 2+ RPCs and only act on agreement. Adds latency and cost; defer until a real attack scenario justifies it.
- **In-process state persistence.** If `recentActions` / inflight loss across restarts becomes operationally painful, a small SQLite or Bun KV layer can persist them without crossing into "external database on the hot path".
- **Hot-reload of certain config fields.** Threshold tuning during dry-run currently requires restart. A future iteration may allow live threshold changes via an admin endpoint (token-gated, audit-logged) without touching the hot path.
- **PublicAllocator companion action.** If curators run PublicAllocator with non-zero flow caps on markets the kill switch is protecting, a follow-up TIB may add a companion action to zero PublicAllocator flow caps as part of the protective action.
- **Adaptive multicall chunking.** Hand-rolled grow/shrink, or buy in to viem-dlc / soltag-lens auto-chunking. Static ~100 is fine for v1.
- **Streak fuse / submission backoff.** If real operator experience shows uncapped retries waste enough gas to matter, add a fuse pattern.
- **A shared "curator bots" framework.** When the second curator bot lands (e.g., Reallocation Bot V1 migration, governance-triggered actions), that work decides what to extract from kill switch's structure. v1 deliberately does not anticipate it.
- **Vaults V2 support.** V2's allocator surface (multi-asset, market obligations, offers) is materially different. A separate TIB extends or supersedes this one when V2 vaults are live.
- **Public-cut-over TIB.** TIB-2026-04-16 called for a separate TIB covering pre-flip git-history audit, licensing, and config redaction. This TIB defers the license pick (MIT recommended) to that work.

## Open Questions

These do not block acceptance — they're the discussion-call agenda.

1. **License pick.** MIT is recommended (ecosystem norm, smaller patent surface, max downstream compatibility). Final decision reserved for engineering leadership and settled in the repo-wide public-cut-over TIB called for by TIB-2026-04-16.
2. **Wallet balance floor default per chain.** Bot ships no default — operator declares per-chain. The right default would be "enough gas for N consecutive submissions at p99 base fee" for some N; agreeing on N (and whether different defaults make sense for L1 vs L2s) is a documentation question this TIB doesn't settle.
3. **Final list of staleness + reference-price adapters in v1.** Chainlink, Pyth, RedStone are intended for both layers; other vendors (Chronicle, API3, Ethena's internal oracle, etc.) wait for concrete curator demand. The Phase 4 / Phase 5 PRs lock the final lists.
4. **Polling interval defaults.** Proposed defaults are 10s mainnet, 4s L2. The discussion call should confirm these are right and whether to ship them as a chain → poll-interval map in `@repo/utils` or move them entirely into operator config.

## References

- [TIB-2026-04-16: Bootstrap `curator-bots` repo from `morpho-apps` foundations](../../../../docs/decisions/TIB-2026-04-16-bootstrap-curator-bots.md) — the repo scaffolding this TIB builds on.
- [docs/CONVENTIONS.md](../../../../docs/CONVENTIONS.md) — RPC efficiency rules, structured log expectations, env-var access, test conventions.
- [docs/GUIDANCE.md](../../../../docs/GUIDANCE.md) — TIB process this document is travelling through.
- [docs/context/repos/morpho-vaults-v2.txt](../../../../docs/context/repos/morpho-vaults-v2.txt) — context on the V2 vault surface this TIB explicitly defers.
- [Linear project: Kill Switch Bot](https://linear.app/morpho-labs/project/kill-switch-bot-0250d77e9ef3) — product goals, trigger criteria (oracle staleness, deviation, reverting), non-goals (MEV resistance).
- [Linear CRTR-2405](https://linear.app/morpho-labs/issue/CRTR-2405/docskill-switch-write-architecture-tib-for-vaults-v1-bot-framework) — the ticket tracking this TIB.
- [Multicall3](https://www.multicall3.com/) — deployment registry the read path depends on; `aggregate3` documentation.
- Granola — discussion call recording _to be linked after the call_.

<!--
TIB conventions:
- Once accepted, do not substantively edit this TIB. If the decision needs to change,
  create a new TIB that supersedes this one and update the Status/Superseded by fields.
- Addenda may be appended to record operational updates that affect
  how the TIB is applied without changing the decision itself.
- TIB identifiers use CalVer (YYYY-MM-DD) based on the date the TIB was first drafted.
-->
