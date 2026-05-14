# TIB-2026-05-14: Architecture of the Vaults V1 bot framework and `kill-switch`

| Field      | Value                                                          |
| ---------- | -------------------------------------------------------------- |
| **Status** | Proposed                                                       |
| **Date**   | 2026-05-14                                                     |
| **Author** | @cashd                                                         |
| **Scope**  | Bot: `kill-switch` (with framework implications for Vaults V1) |

---

## Context

Morpho curators operating Vaults V1 (MetaMorpho V1.0 and V1.1) supply liquidity across potentially hundreds of underlying markets per vault. Each market is priced by an oracle whose price can drift away from the asset's true off-chain reference, whose `updatedAt` timestamp can stale out, or whose `price()` call can revert outright. When any of those conditions surfaces and the curator can't intervene fast enough, new deposits keep routing into a market the curator no longer trusts — and lender funds end up exposed to a broken price feed.

The curator needs an automated circuit breaker — a "kill switch" — that watches every block, detects oracle staleness, deviation, or reverting on the markets in each vault's supply queue, and stops new deposits to the affected markets without the curator having to be at a keyboard. The bot does **not** pull existing funds out; existing exposure drains naturally as users withdraw, and a separate future trigger (migrated from the existing Reallocation Bot V1, called out in the Linear project description) will handle the reallocate-existing-funds case.

[TIB-2026-04-16](../../../../docs/decisions/TIB-2026-04-16-bootstrap-curator-bots.md) stood up the `curator-bots` repo scaffolding and named the Kill Switch Bot as the first planned bot. That bootstrap TIB stopped at "empty `bots/`" — it did not decide how a bot is built. This TIB picks up there and settles the architecture.

A longer-horizon framing the team agreed on before drafting: kill switch is one specific `(trigger, action)` pair, but the Vaults V1 risk surface has more — curator-signaled rebalances, governance-triggered actions, the Reallocation Bot V1 migration, custom risk signals. Building kill switch as a one-off would force a redesign on bot #2. So this TIB establishes a shared **Vaults V1 bot framework** — single-process pipeline, block ingestion, RPC fault tolerance, multicall reads, the `(trigger, action)` abstraction, the pluggable wallet layer, observability, and failure-mode discipline — and ships kill switch as the first concrete `(trigger, action)` slotted into it.

Operational constraints that bound the design, per the Linear project description:

- **RPC-only on the hot path.** No indexers, no subgraphs, no external databases.
- **Stateless.** No `eth_logs` subscriptions, no historical event queries, no persisted state whose loss would break correctness. All caches reconstructable from current chain state.
- **Fault-tolerant + self-correcting.** Transient failures recover on the next block without manual intervention; persistent failures alert loudly and isolate per-vault so they cannot cascade.
- **Open-source deployable.** Curators clone (or fork) the repo, configure, and run their own instance.

## Goals / Non-Goals

**Goals**

- Establish a single architectural pattern — the **Vaults V1 bot framework** — that all future Vaults V1 `(trigger, action)` pairs adopt without redesigning ingestion, RPC fault tolerance, the wallet layer, observability, or failure-mode handling.
- Ship `kill-switch` as the first concrete `(trigger, action)`: oracle staleness ∪ deviation ∪ reverting → `setSupplyQueue` excluding the affected market(s).
- Evaluate **every block** (12s mainnet, ~2s L2s) across **hundreds of markets per vault**, on **multiple EVM chains**, inside **one Bun process**.
- Submit **one atomic batched write per chain per block** when the wallet supports EIP-5792's `atomicBatch` capability; fall back to **parallel, in-order single-call submissions** when it doesn't.
- Make every adapter layer pluggable: reference-price (morpho-api, DefiLlama, custom), oracle staleness (Chainlink, Pyth, RedStone, custom). Ship sensible defaults so the common case is configurable without writing code; require a fork to add new vendor-specific adapter implementations.
- Detect staleness **entirely on-chain**, by reading the underlying vendor feed directly (e.g., Chainlink `AggregatorV3.latestRoundData`) — never through the Morpho `IOracle` interface, which doesn't expose `updatedAt`.
- Stay RPC-only and stateless on the hot path. All caches reconstructable; restart is idempotent.
- Ship as an **open-source bot curators can clone and run** with a documented setup path (README, sample config, CONTRIBUTING, SECURITY, mainnet walkthrough).

**Success signal.** `kill-switch` runs continuously against at least one Vaults V1 vault on at least one mainnet chain for one week in live mode with no operator intervention; on a synthesized oracle condition (staleness, deviation, or revert) the bot emits one atomic batched transaction (or N parallel transactions in EOA mode) containing `setSupplyQueue` calls across every affected vault on that chain, with end-to-end latency (block seen → transaction submitted) under one block time. Before that, the same bot ran in dry-run mode against the same configuration for at least 24h with the operator reviewing `/status/near-misses` and confirming the bot's threshold tuning is correct.

**Non-Goals**

- **Vaults V2.** V2's allocator surface (multi-asset, market obligations, offers) is materially different and deserves its own TIB once V2 vaults are live.
- **New on-chain code.** This TIB does not propose deploying any new smart contracts.
- **Action surface broader than `setSupplyQueue`.** No `reallocate` (that's the future Reallocation Bot V1 migration), no cap management (timelocked, curator-only, not allocator-callable), no withdraw-queue updates (deferred to a follow-up if practice shows it's needed).
- **PublicAllocator interaction.** The `PublicAllocator` contract lets external callers move existing funds within configured flow caps; if a curator has it enabled with non-zero flow caps on an affected market, that path is outside this bot's protection scope. Disabling PublicAllocator for affected markets is a curator-side decision and not automated here.
- **Non-`kill-switch` `(trigger, action)` pairs.** Each future pair (Reallocation Bot V1 migration, curator-signaled rebalances, governance-triggered actions) gets its own follow-up TIB or Linear ticket against this framework.
- **Multi-pair-per-vault composition.** Each `(chain, vault)` in v1 is bound to **exactly one** `(trigger, action)` pair (composition model "A"). Multi-pair-per-vault is captured under Future Considerations.
- **Cross-bot coordination.** Multiple bot instances on the same vault is unsupported (each curator runs their own; one vault → one operator → one bot).
- **Off-chain databases, message queues, serverless.** Explicit non-goals — the bot is one long-lived Bun process per deployment.
- **Hot-reload of static config.** Config changes require redeploy. The framework's mode flips (dry-run → live, fuse override, etc.) are limited and discussed below.
- **Curator multi-tenancy.** One bot instance serves one curator's vaults. Multi-tenancy is the curator's choice if they want it, not a framework concern.

## Proposed Solution

### Architectural overview

A **single Bun process** runs all configured chains' pipelines concurrently on one event loop. For each chain, the pipeline per block is:

```
[chain pipeline, one per block]
  newHead → multicall (aggregate3): isAllocator + supplyQueue + oracle.price + vendor staleness feeds
        → reference-price adapter fetches (parallel HTTP, deduped per oracle)
        → BlockContext { reads, refPrices, blockNumber, blockTime, ... }
        → trigger.evaluate(ctx) → Intent[]            (kill-switch: OracleHealthTrigger)
        → action.plan(intents, ctx) → Call[]          (kill-switch: ClearSupplyQueueAction)
        → walletAdapter.sendCalls({ chainId, calls }) [atomic if capability reported, else parallel-queued]
        → walletAdapter.getCallsStatus(id) → terminal status
        → observe + record + update inflight tracker
```

Cross-cutting concerns — RPC failover, the `(trigger, action)` abstraction, the wallet abstraction, observability (OTEL), failure-mode handling (streak fuses, drift handling, role re-checks), and dry-run mode — live in the **framework layer** that future Vaults V1 bots reuse without modification. Kill switch is the first `(trigger, action)` pair slotted into the framework; everything below the trigger/action seam is framework, not kill-switch-specific.

### Tech stack

Inherits the repo posture established in [TIB-2026-04-16](../../../../docs/decisions/TIB-2026-04-16-bootstrap-curator-bots.md) (bun runtime + package manager, oxlint/oxfmt, `bun test`, `@repo/*` namespace, TS-as-config). Bot-framework-specific choices:

| Layer                     | Choice                                                                                                                                             | Rationale                                                                                                                                                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime                   | Bun (repo default)                                                                                                                                 | Fast startup, native WS client, good fetch perf for adapter calls.                                                                                                                                                                                 |
| Language                  | TypeScript strict (repo default)                                                                                                                   | Type safety across ABI decoding, price math, adapter and trigger/action interfaces.                                                                                                                                                                |
| Config format             | TS-as-config, operator-forked; Zod for runtime validation at the boundary                                                                          | Type safety and autocomplete at edit time; matches the "fork to extend" pattern used for custom adapters. Types are hand-written and canonical; Zod schemas validate at runtime and are kept in sync via a CI assertion.                           |
| Chain interaction         | viem (with `viem/experimental` for EIP-5792 wallet actions)                                                                                        | Typed ABI encoding, native multicall, lighter than ethers. EIP-5792 actions (`sendCalls`, `getCallsStatus`, `getCapabilities`) live in the experimental subpackage.                                                                                |
| Block ingestion           | `eth_subscribe('newHeads')` over a single WebSocket per chain, liveness watchdog                                                                   | Premium RPC tier eliminates WS reliability concerns. Lower latency than polling. Watchdog backstops silent failures.                                                                                                                               |
| Read batching             | Multicall3 (`0xcA11bde05977b3631167028862bE2a173976CA11`) `aggregate3` with `allowFailure: true`                                                   | Reverting oracle calls don't poison the whole batch; per-call success flags surface the revert as a trigger condition. Adaptive chunk sizing absorbs RPC gas variance.                                                                             |
| Reference-price source    | Per-oracle adapter (morpho-api, DefiLlama, custom) with `auto` default selection                                                                   | morpho-api covers most curator-tracked oracles natively; DefiLlama gives breadth for long-tail assets; custom adapter slot exists for closed/proprietary feeds.                                                                                    |
| Oracle staleness adapters | **Vendor-direct** (Chainlink `AggregatorV3`, Pyth `PriceFeed`, RedStone, …)                                                                        | The Morpho `IOracle` interface doesn't expose `updatedAt`; the bot reads the vendor feed directly. Operator declares vendor feed addresses per oracle in config. Ships default vendor adapters; fork to add new vendors.                           |
| Write path                | Wallet-agnostic via EIP-5792 `wallet_getCapabilities`; atomic-batch when supported, else parallel                                                  | The bot doesn't pick a wallet. WalletAdapter abstraction wraps an EOA-direct signer or a 1/1 smart wallet (Safe / CB Smart Wallet / EIP-7702 / etc.). Capability discovery at startup chooses the submission strategy.                             |
| Signing key custody       | `Bun.env.SIGNER_PRIVATE_KEY` to start; KMS / Turnkey / Privy later                                                                                 | Matches repo convention. Custodial upgrade tracked in Future Considerations.                                                                                                                                                                       |
| Hosting                   | Railway US-East as reference deployment; bot is portable (any Bun + RPC host runs it)                                                              | Persistent process, managed deploys, proximity to Alchemy us-east-1. Docker image is the primary distribution; Railway is one of many places to run it.                                                                                            |
| RPC provider              | Alchemy premium primary + ordered HTTP fallbacks (operator-supplied)                                                                               | Dedicated WS throughput; circuit breaker rotates on failure. Bot makes no recommendation beyond "at least two HTTP endpoints per chain".                                                                                                           |
| Observability             | OpenTelemetry (logs + metrics + traces) via OTLP HTTP/protobuf; env-var config; stdout fallback                                                    | Vendor-neutral; operator picks the backend (Honeycomb, Datadog, Grafana Cloud, self-hosted, …). Standard OTEL env var conventions. `/status` rich-health endpoint always on as a backstop; `/metrics` Prometheus endpoint is optional / droppable. |
| Health endpoints          | `Bun.serve()` exposing `/healthz`, `/readyz`, `/status`, `/status/near-misses` (dry-run only), `/admin/*` (token-gated), and optionally `/metrics` | Single small surface; no framework needed.                                                                                                                                                                                                         |

### The `(trigger, action)` abstraction

This is the framework's core extension point. The framework owns ingestion, reads, wallet submission, observability, and failure handling. Each `(trigger, action)` pair owns the bot-specific logic of "when should we act?" (the trigger) and "what calls do we submit?" (the action). For v1, exactly one pair per `(chain, vault)` — composition model **A**.

```typescript
interface Trigger<I extends Intent = Intent> {
  readonly name: string                                    // for logs/metrics/spans
  evaluate(ctx: BlockContext): Promise<I[]>                // pure function of BlockContext
}

interface Action<I extends Intent = Intent> {
  readonly name: string
  plan(intents: I[], ctx: BlockContext): Promise<Call[]>   // Call = { to, data, value }
}

type BotEntry = {
  chainId: number
  vault: Address
  markets: MarketId[]                                       // operator-declared per vault
  bot: string                                               // names a registered (Trigger, Action) pair
}
```

A `(trigger, action)` pair is **registered at compile time** in a single TypeScript map in framework code; the operator's config binds vaults to pair names via the `bot:` field. There is no dynamic loading. New pairs land as new entries in this map (typically via fork or upstream PR).

Kill switch is the v1 entry in this map: `'kill-switch': { trigger: OracleHealthTrigger, action: ClearSupplyQueueAction }`.

When the Reallocation Bot V1 trigger migrates in (called out in the Linear project description), it lands as a second entry: `'reallocate-v1': { trigger: ReallocationSignalTrigger, action: ReallocateAction }`. Curators choose per-vault which pair to bind. Running both on the same vault is composition model B and is captured under Future Considerations.

### Single-process async pipeline

One Bun process, one event loop. Each chain runs as an independent async pipeline. No worker threads, no process-per-chain — the bottleneck is I/O (RPC calls + adapter HTTP), not CPU.

```
[main thread]
  ├─ chain pipeline (A)  ─→  multicall + adapters  ─→  trigger.evaluate  ─→  action.plan  ─→  wallet.sendCalls
  ├─ chain pipeline (B)  ─→  multicall + adapters  ─→  trigger.evaluate  ─→  action.plan  ─→  wallet.sendCalls
  ├─ chain pipeline (C)  ─→  multicall + adapters  ─→  trigger.evaluate  ─→  action.plan  ─→  wallet.sendCalls
  └─ health server (Bun.serve)  →  /healthz, /readyz, /status, /admin/*, optional /metrics
```

**Why not multithreaded.** 2–4 RPC calls per chain per block plus a handful of adapter HTTP calls is ~10–20 concurrent fetches total across all chains. Bun's event loop dispatches that trivially. ABI decoding is microseconds. CPU is never the constraint before RPC rate limits.

**Scaling path.** If single-process is outgrown (10+ chains, decode time > 50ms, p99 block-pipeline-duration > 1 block), graduate to process-per-chain. Skip worker threads — they add complexity without the fault isolation of separate processes.

**Cross-vault failure isolation.** A failure on `(chainA, vaultX)` never affects the bot's ability to protect `(chainA, vaultY)` or `(chainB, *)`. State is per-vault (inflight tracker, fuse counter); fields are scoped; trigger/action evaluation is pure-function-of-BlockContext.

### Block ingestion: WebSocket event-driven

Premium RPC tier (Alchemy Growth/Enterprise or equivalent) is assumed. Dedicated WS connections, server-side keepalive, reconnection buffering — the reliability concerns that motivate HTTP polling fallbacks on free/shared tiers do not apply.

**Subscription.** One WS connection per chain via `eth_subscribe('newHeads')`. On each new head event, the block number flows into the chain's pipeline.

```typescript
const client = createPublicClient({ chain, transport: webSocket(rpcUrl) })

client.watchBlockNumber({
  onBlockNumber: (blockNumber) => pipeline.emit(blockNumber),
  onError: (error) => reconnect(chainId, error),
})
```

**Liveness watchdog.** If no block arrives within 3× the expected block time (configurable per chain; defaults ship for major chains — 12s mainnet, 2s Base/Arbitrum/Optimism, etc.), the subscription is considered dead. The watchdog triggers reconnect or RPC rotation.

**Reconnection strategy.** On WS disconnect or liveness timeout: (1) reconnect same endpoint (transient blips); (2) if 3 consecutive reconnects fail within 30s, rotate to next RPC endpoint via the circuit breaker; (3) on successful reconnect, fetch current block via one HTTP `eth_getBlockNumber` to resync, then resume WS subscription.

**Cancellation on new block.** If block N processing is still in flight when N+1 arrives, cancel N via `AbortController` and start N+1. Stale results from a prior block are worthless for kill-switch decisions.

### Read path: Multicall3 `aggregate3` with adaptive chunking

All on-chain reads per block fold into one or more `Multicall3.aggregate3(allowFailure: true)` calls. Per chain per block, the batch contains:

1. **`vault.supplyQueue(i)` enumerations** — for each configured vault, read the current supply queue (the per-vault list of `MarketId`s).
2. **`vault.isAllocator(walletAddress)`** — per vault. Per-block re-check; revocation surfaces in the same block it happens (settled in grill question 6 / tension B).
3. **Oracle `price()` calls** — one per unique oracle across the deduped watched-market set on this chain.
4. **Vendor staleness reads** — for each oracle, the calls its staleness adapter contributes (e.g., for Chainlink: `latestRoundData()` on each configured underlying feed). Reads the vendor feed **directly**, never the Morpho `IOracle` wrapper.

Per-call `allowFailure: true` is the critical knob: a reverting `oracle.price()` becomes a per-call success flag in the response (not a multicall-wide revert), which the bot reads as the "reverting" trigger condition (one of kill switch's three).

**Adaptive chunking.** Start at batch size ~150. If a chunk reverts (gas limit), shrink by 25%. If all succeed, grow by 10. Caps at 200. Failed chunks retry at smaller sizes. Per-RPC-endpoint chunk size memoized across blocks.

This collapses ~400 individual `eth_call`s into 1–4 round-trips per chain per block. Per [CONVENTIONS.md](../../../../docs/CONVENTIONS.md), prefer `readDeploylessBatchLens` when a Lens contract models the entity well; for the heterogeneous price + staleness + state read here, Multicall3 is the right tool.

### Discovery model: declared markets, deduplicated reads, runtime drift handling

Operator config declares **vaults** (per chain) and **markets** (per vault). Markets are dedup'd across vaults at the bot's read layer — one oracle read per unique oracle on a chain, regardless of how many vaults reference it. Per-oracle configuration (staleness adapter, reference adapter, thresholds) lives in a separate config block, keyed by the Morpho oracle wrapper address that `MorphoBlue.idToMarketParams(marketId).oracle` resolves to.

**Startup gate (fail loud, never silently degrade).** For each `(chain, vault)` in config, in this order:

1. **RPC reachability.** `eth_chainId` responds; returned ID matches declared `id`. Catches misconfigured RPC URLs.
2. **Wallet derivation.** EOA mode: derive address from `signer.privateKeyEnv`. Smart-wallet mode: read `wallet.address` from config.
3. **Wallet exists on-chain (smart-wallet only).** `eth_getCode(wallet.address) > 0x` — catches "Safe not yet deployed on this chain".
4. **Allocator role check.** `vault.isAllocator(wallet) == true` for every `(chain, vault)`. **Bot refuses to start** if any check fails, reporting the broken `(chain, vault, wallet)` triple.
5. **EIP-5792 capability probe.** `walletAdapter.getCapabilities(chainId)`. Records whether `atomicBatch` is reported. EOA path returns `{ atomicBatch: false }` synthetically.
6. **Wallet balance floor.** `eth_getBalance` >= configured per-chain floor. **FAIL** in live mode; **WARN** in dry-run mode (no gas will be spent).
7. **Market → oracle resolution.** For every declared market, read `MorphoBlue.idToMarketParams(marketId)` once; cache the resulting oracle address process-locally (markets are immutable). **Fail loud** if any market resolves to an oracle without a config entry in `oracleConfigs`.

**Runtime drift handling.** If on a later block the bot finds a market in a vault's `supplyQueue` whose oracle isn't configured (curator added a market with a new oracle while the bot was running):

- **Staleness + reverting checks still run** with fallback defaults (24h staleness, single revert), because they're pure on-chain reads needing no operator input.
- **Deviation check is skipped** (no reference adapter configured → no reference price → can't compute deviation).
- **High-severity alert** to the operator: "new oracle in vault — configure it or accept the deviation-blind protection".

This preserves a partial-protection floor for newly-added markets without requiring an instant config update, while making the visibility gap loud enough that the operator can't miss it.

### Adapters: oracle staleness and reference-price

Two adapter layers, orthogonal in config, both per-oracle, both with default implementations the bot ships and a "fork to add new vendor / source" extension model.

**Oracle staleness adapters** read `updatedAt` directly from the vendor feed (Chainlink, Pyth, RedStone, …) — never through the Morpho `IOracle` interface, which doesn't expose a timestamp. Operator declares the vendor feed addresses for each oracle in config.

```typescript
interface OracleStalenessAdapter {
  readonly name: string                                            // 'chainlink', 'pyth', 'redstone', ...
  getStalenessReads(spec: AdapterSpec): readonly Call[]            // contributes to the per-block multicall
  decodeStaleness(spec: AdapterSpec, results: readonly Bytes[]): { minUpdatedAt: number }
}
```

v1 ships built-in adapters for **Chainlink** (reads `latestRoundData().updatedAt` on the operator-declared base/quote feed addresses, returns the min), **Pyth** (reads `priceFeed.publishTime`), and **RedStone** (reads the per-signature timestamp). Adding a new vendor adapter requires a fork — the adapter map is compile-time.

**Reference-price adapters** fetch the off-chain reference price the trigger compares against the on-chain oracle price.

```typescript
interface ReferencePriceAdapter {
  readonly name: string                                            // 'morpho-api', 'defillama', custom
  fetch(spec: AdapterSpec, ctx: AdapterContext): Promise<{ price: bigint; observedAt: number }>
}
```

v1 ships **morpho-api** (`api.morpho.org` GraphQL) and **DefiLlama** (`coins.llama.fi` REST). The `auto` adapter selection in operator config means "try morpho-api first; fall back to DefiLlama if morpho-api has no coverage for this market". Operators opt out of `auto` by naming an adapter explicitly. Custom adapters require a fork.

Adapter failure handling: when a reference-price adapter call fails (HTTP 5xx, timeout, throws), the deviation check is skipped for that oracle this block; staleness and reverting still run. After K consecutive failures on the same oracle (default K=50 ≈ 10min on a 12s chain), a high-severity alert fires; the operator decides whether to swap adapter or accept reduced protection.

**Operator config shape:**

```typescript
// bots/kill-switch/src/config.ts (operator-forked)
export const config: KillSwitchBotConfig = {
  defaults: {
    signer: { privateKeyEnv: 'SIGNER_PRIVATE_KEY' },
  },
  chains: [
    {
      id: 1,
      rpc: {
        ws: process.env.ALCHEMY_WS_MAINNET!,
        http: [process.env.ALCHEMY_HTTP_MAINNET!, process.env.INFURA_HTTP_MAINNET!],
      },
      wallet: { type: 'smart-wallet', address: '0xSAFE_MAINNET' },
      walletBalanceFloor: '0.05',                                   // ETH; required, no default ships
      dryRun: false,
      vaults: [
        { address: '0xVAULT_A', bot: 'kill-switch', markets: ['0xMARKET_1', '0xMARKET_2', ...] },
        { address: '0xVAULT_B', bot: 'kill-switch', markets: [...] },
      ],
    },
    { id: 8453, /* ... */ },
  ],
  oracleConfigs: [
    {
      morphoOracleAddress: '0xMORPHO_ORACLE_X',
      stalenessAdapter: 'chainlink',
      stalenessFeeds: ['0xCHAINLINK_BASE_FEED', '0xCHAINLINK_QUOTE_FEED'],
      stalenessSeconds: 1800,
      deviationBps: 50,
      referenceAdapter: 'morpho-api',
      referenceSpec: { marketId: '0xMARKET_1' },
    },
    // ...
  ],
}
```

### Kill Switch: trigger + action

The v1 `(trigger, action)` pair is `kill-switch = (OracleHealthTrigger, ClearSupplyQueueAction)`.

**`OracleHealthTrigger.evaluate(ctx)`** emits an `OracleHealthIntent` for each `(vault, marketId)` whose oracle fires any of three conditions:

| Condition | Predicate                                                           |
| --------- | ------------------------------------------------------------------- | ---------------------- | ------------------------------------ |
| Staleness | `blockTime - oracleUpdatedAt > stalenessSeconds`                    |
| Deviation | `                                                                   | oraclePrice - refPrice | / refPrice \* 10_000 > deviationBps` |
| Reverting | The oracle's `price()` per-call success flag was `false` this block |

A single revert is enough to fire reverting (RPC blips fail the whole multicall, not per-call). Configured thresholds are per-oracle. A market whose oracle is reverting can't be price-checked, so deviation/staleness are skipped for it on that block — but reverting itself fires the protection, so the market is still protected.

**`ClearSupplyQueueAction.plan(intents, ctx)`** consumes the per-`(vault, marketId)` intents and, for each vault with at least one affected market in its current `supplyQueue`, produces exactly one `Call`:

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

- **Idempotent.** If the affected market is no longer in the current `supplyQueue` (curator removed it manually, or a prior bot fire already filtered it), no `Call` is produced for that vault.
- **No-op safe.** Restart between detection and submission, or two concurrent bot instances by mistake, produce calls whose effect is "set the queue to the already-current state" — a transactional no-op, not a corruption.
- **Atomic per call.** A single `setSupplyQueue` either lands fully or reverts fully; there's no partial-update state.

The V1.0 and V1.1 `setSupplyQueue` signatures are byte-for-byte identical (the V1.1 ABI diffs are purely additive — `lostAssets`, `setName`/`setSymbol`, `UpdateLostAssets`). The bot uses the V1.0 ABI subset for both generations.

### RPC fault tolerance

**Per-endpoint circuit breaker.** Each chain config holds an ordered list of RPC URLs. Per endpoint: consecutive-failure counter, last failure timestamp, rolling p95 latency. After N consecutive failures or sustained p95 above threshold, the endpoint is marked degraded; the bot rotates to the next; the degraded entry recovers after cooldown.

**WS subscription.** Single active subscription per chain to the primary RPC. The liveness watchdog (above) triggers rotation if silent. On reconnect, one HTTP `eth_getBlockNumber` resyncs before re-subscribing.

**Multicall failover (read path).**

```
attempt RPC1 with per-chain AbortController timeout
  → on failure, attempt RPC2
  → on failure, attempt RPC3
  → if all fail, skip block + emit `multicall.all_endpoints_failed` + alert via metric threshold
```

**Shared state.** Circuit-breaker state is shared between WS and HTTP — degraded endpoints are skipped for both.

### Wallet abstraction: agnostic via EIP-5792 capability discovery

The bot does **not** pick a smart wallet implementation. The framework exposes a single `WalletAdapter` interface; v1 ships two concrete implementations (EOA-direct, Safe-1/1); the framework code never names a wallet vendor.

```typescript
interface WalletAdapter {
  readonly type: 'eoa' | 'smart-wallet'
  readonly address: Address
  getCapabilities(chainId: number): Promise<{ atomicBatch: boolean; /* other EIP-5792 caps */ }>
  sendCalls(params: { chainId: number; calls: Call[] }): Promise<{ id: string }>
  getCallsStatus(id: string): Promise<{ status: 'PENDING' | 'CONFIRMED' | 'REVERTED'; ... }>
}
```

**Capability discovery at startup.** The bot calls `walletAdapter.getCapabilities(chainId)` for each configured chain and records whether `atomicBatch` is reported. If yes → calls across all affected vaults on that chain in the same block batch into one `wallet_sendCalls`. If no → calls are submitted **in parallel via the WalletAdapter's internal sequential queue**, which manages nonce ordering so no nonce conflicts occur. The framework's action layer never sees this difference — it always calls `sendCalls(calls)` and the adapter handles the rest.

**Wallet types supported in v1:**

- **EOA-direct.** The bot signs and submits standard transactions with `Bun.env.SIGNER_PRIVATE_KEY`. `atomicBatch: false`. N affected vaults → N parallel transactions, the WalletAdapter's internal queue orders nonces correctly.
- **1/1 smart wallet.** A smart wallet whose sole signer is the EOA derived from `Bun.env.SIGNER_PRIVATE_KEY`. The bot is the only entity that can sign for it. Common concrete forms: Safe with threshold=1, Coinbase Smart Wallet, EIP-7702-delegated EOA. The bot does not require multi-sig wallets, by design — multi-sig coordination is out of scope.

Future wallet adapters (e.g., custom institutional wallets, managed-signer wallets with KMS/Turnkey/Privy) plug into the same interface without framework changes.

**Action simulation before submit.** Before broadcasting, the bot simulates the call(s) via `eth_call` against the wallet's `execute` (or equivalent) entrypoint. On simulation revert: skip submission, log + alert with the diff between the bot's computed state and the chain's actual state, retry on next block (the most common cause is a race with curator's manual queue change, which self-corrects on the next read).

**Inflight TX tracking.** Per-vault in-memory map of pending sendCalls IDs. The bot skips planning for a vault with an inflight call; clears on terminal status (`CONFIRMED` or `REVERTED`). Lost on restart, but post-restart the per-block read sees the filtered queue (if confirmed) or unfiltered (if reverted/abandoned) and re-plans idempotently. Hard timeout: 20 blocks before treating an inflight as abandoned.

**Stuck-TX recovery.** EOA mode: the WalletAdapter handles replace-with-higher-gas internally (out of scope for the TIB; an interface guarantee). Smart-wallet mode: if `getCapabilities` reports a replace capability, use it; else fall back to re-issuing `wallet_sendCalls` with the same logical batch at higher fee — the previous batch either lands first (idempotent because of the inflight filter) or is replaced by the higher-fee submission.

### Multi-chain configuration

Per-chain `wallet`, `rpc`, and `vaults` blocks are **required** — no top-level shorthand. Same EOA private key across chains is the common case (one env var, one address), but the bot doesn't assume identical wallet addresses across chains. Each chain can independently be:

- EOA mode (key-derived address, identical across chains)
- 1/1 smart wallet at a canonical CREATE2 address (identical across chains)
- 1/1 smart wallet at a non-canonical address (distinct per chain)
- A mix — EOA on cheap L2s, smart wallet on mainnet

The startup gate validates each chain independently. A single chain failing any gate (allocator revoked, balance below floor, etc.) refuses the whole bot start, with the operator told exactly which `(chain, vault, wallet)` triple failed — keeping the "fail-loud, never silently start partial" property.

### Dry-run mode

A `DryRunWalletAdapter` wraps the real WalletAdapter for a chain when dry-run is active. It delegates everything to the real adapter **except `sendCalls`**, which it intercepts: logs the would-be `Call[]`, runs the simulation step (so simulation-revert errors still surface), records a "would-have-fired" entry in `/status/near-misses`, and returns a fake but deterministic call ID. The framework code is unchanged; only the adapter behaves differently.

**Granularity.** Per-chain in config (`chains[].dryRun: true | false`, default `false`); plus a global env override (`DRY_RUN=true`) that forces every chain into dry-run regardless of per-chain setting. The override exists for emergencies — "I just need to pause everything safely without editing config."

**Startup gate in dry-run.** All gates still run. The balance-floor check is **demoted from FAIL to WARN** (no gas will be spent); allocator-role check, capability probe, RPC reachability, etc., all remain FAIL — they're informative about whether the bot _could_ fire when flipped.

**Flip mechanism.** Config change + restart. **Not hot-flippable out of dry-run** (granting action authority is high blast radius if abused). Hot-flipping _into_ dry-run is supported via the `/admin/dry-run?chain=<id>&value=true` admin endpoint (auth-gated by `ADMIN_TOKEN`) — easier to make the bot safer at runtime, harder to make it more powerful.

**OTEL.** Each chain's dry-run state propagates as an OTEL resource attribute (`dry_run=true|false`) on every log / metric / trace from that chain. Operators can filter dashboards and alerts by this.

**`/status/near-misses` (dry-run only).** A separate endpoint that exposes evaluations that came close to firing but didn't — useful during dry-run for threshold tuning. Each entry includes the per-condition deltas (e.g., "deviation was 47 bps; threshold is 50 bps"). Disappears in live mode to keep `/status` clean.

### Observability

The framework adopts **OpenTelemetry** as the observability primitive. All internal log/metric/trace emission goes through the OTEL JS API (`@opentelemetry/api`). The framework never `console.log`s and never names a specific backend — that's the structural commitment that makes "provider of their choice" actually work.

**Three signal types from v1: logs + metrics + traces.** Traces are technically heaviest to instrument exhaustively, but the per-block pipeline has a small fixed set of spans (~6–8) — cheap to add up front, expensive to retrofit. Including from v1.

**Wire protocol: OTLP HTTP/protobuf.** Vendor-neutral; supported by Honeycomb, Datadog, Grafana Cloud (Tempo/Loki/Mimir), New Relic, Dynatrace, self-hosted stacks. Works through more network configurations than gRPC (corporate proxies, restrictive egress); lower dependency weight.

**Config: env-var-only, standard OTEL conventions:**

```
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io
OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=<api-key>
OTEL_SERVICE_NAME=kill-switch-bot
OTEL_RESOURCE_ATTRIBUTES=curator.name=example,deployment.environment=production
```

No YAML-level OTEL config. Two reasons: (1) OTEL headers carry API keys and belong in env, not committed config; (2) operators wiring up a backend follow the backend's docs, which are universally written against these env vars.

**Fallback when not configured.** If `OTEL_EXPORTER_OTLP_ENDPOINT` isn't set: logs go to stdout as JSON-per-line via `ConsoleLogRecordExporter` (Railway / k8s pick these up); traces drop silently; metrics are still emitted internally but only reachable via the `/metrics` Prometheus scrape endpoint, which is **the last implementation phase and explicitly droppable for scope** (see Implementation Phases). `/status` is always available as the operator's primary backstop.

**Bun compatibility caveat.** The OTEL JS SDK is Node.js-API-shaped and mostly works on Bun, but `@opentelemetry/auto-instrumentations-node` has known issues on Bun (fetch hooks, undici hooks). **Manual instrumentation only** — no auto-instrumentation package. The framework's surface is small enough that manual is more predictable and costs about the same as wiring up structured logs by hand.

**Hot-path bound — OTEL never blocks correctness.** The SDK's batch processor buffers spans/logs in memory and exports asynchronously:

- **Bounded queue: 8192 records** for logs/spans, 256 for metrics (OTEL-default-ish).
- **On drop:** a Prometheus counter `otel_records_dropped_total{type}` emits even in stdout-fallback mode (writes to `/metrics`, no OTLP dependency).
- **Critical-path bypass:** FATAL and ERROR-level logs **additionally** write to stdout synchronously via a separate path that doesn't go through the OTEL processor. If OTEL is broken or slow, ERROR logs still reach Railway/k8s stdout.

This makes the OTEL pipeline strictly best-effort: it cannot cause a missed trigger or unsent transaction.

**`/status` rich-health endpoint.** Always on; returns JSON with the bot's absolute core stats. Operators can curl it, wire it to an uptime monitor, or build a dashboard around it with zero observability infrastructure of their own.

```jsonc
{
  "bot": "kill-switch",
  "version": "0.1.0",
  "mode": { "global": "live", "perChain": { "1": "live", "8453": "dry-run" } },
  "uptimeSeconds": 3600,
  "chains": [
    {
      "id": 1,
      "lastBlockProcessed": 18500000,
      "lastBlockProcessedAt": "2026-05-14T15:30:00Z",
      "secondsSinceLastBlock": 6,
      "expectedBlockTimeSeconds": 12,
      "rpc": [{ "url": "alchemy", "state": "healthy", "p95LatencyMs": 45 }, ...],
      "wallet": { "type": "smart-wallet", "address": "0xSAFE_MAINNET", "atomicBatchSupported": true, "balanceNative": "0.245", "belowFloor": false },
      "vaults": [{ "address": "0xVAULT", "isAllocator": true, "marketsWatched": 12, "fuseState": "open", "lastActionAt": "2026-05-13T10:00:00Z", "lastActionTxHash": "0x..." }, ...],
      "oracleConfigsHealth": { "configured": 8, "unconfigured": 0 }
    }
  ],
  "recentActions": [/* ring buffer, last 50 successful evaluations */],
  "errors": { "last24h": 0, "lastError": null }
}
```

**Signal catalog (high-level; specific names locked at impl time).**

- **Logs (OTEL severity-tagged).** `block.seen`, `multicall.ok`, `multicall.failed`, `multicall.partial_revert` (carries per-call success flags), `adapter.fetch.ok`, `adapter.fetch.failed`, `oracle.staleness.evaluated`, `oracle.deviation.evaluated`, `oracle.reverting.detected`, `trigger.fired`, `action.planned`, `action.simulation.ok`, `action.simulation.reverted`, `wallet.sendCalls.submitted`, `wallet.sendCalls.confirmed`, `wallet.sendCalls.reverted`, `wallet.getCapabilities` (startup), `rpc.circuit.open`, `rpc.rotated`, `watchdog.fired`, `startup.gate.passed`, `startup.gate.failed`, `fuse.engaged`, `fuse.cleared`, `drift.new_oracle_detected`.
- **Metrics.** Counters: `blocks_processed_total{chain}`, `blocks_skipped_total{chain,reason}`, `trigger_fires_total{trigger,chain,vault,marketId,reason}`, `action_submissions_total{chain,vault}`, `action_reverts_total{chain,vault}`, `otel_records_dropped_total{type}`. Histograms: `multicall_latency_ms{chain,endpoint}`, `adapter_latency_ms{adapter}`, `action_confirm_latency_ms{chain,vault}`, `block_pipeline_duration_ms{chain}`. Gauges: `rpc_endpoint_state{chain,endpoint}`, `wallet_balance_native{chain,wallet}`, `oracles_unconfigured_total{chain,vault}`, `fuse_engaged{chain,vault}` (0/1).
- **Traces.** Root span `block.pipeline {chain,blockNumber}`. Child spans: `multicall {chain,chunkSize}`, `adapter.fetch {adapter,oracle}`, `trigger.evaluate {trigger}`, `action.plan {action}`, `action.simulate {chain,vault}`, `wallet.sendCalls {chain,vault}`, `wallet.getCallsStatus {id}`. Errors attached to spans as OTEL exceptions.

### Failure modes & posture

**Posture: fail-safe and alert-loud.** When the bot can't do its job perfectly, it does as much as it safely can, alerts the operator, and never silently degrades into a state where it could miss a kill-switch trigger. **Per-vault failure isolation** is the cross-cutting invariant.

**Failure-mode catalog:**

| #   | Mode                                      | Cause                                                       | Response                                                                                                                                                                                                                                                                                                     |
| --- | ----------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | RPC endpoint degraded                     | Provider rate-limit, latency spike                          | Circuit breaker rotates to next endpoint; degraded cooldown then re-tried.                                                                                                                                                                                                                                   |
| 2   | All RPCs failed                           | Provider-wide outage                                        | Skip block; `multicall.all_endpoints_failed` log + metric; retry next block; alert via metric threshold.                                                                                                                                                                                                     |
| 3   | WebSocket drops                           | Provider rebalance, network blip                            | Reconnect same endpoint; rotate after 3 fails in 30s; HTTP `getBlockNumber` resync on reconnect.                                                                                                                                                                                                             |
| 4   | Multicall partial revert (oracle reverts) | An oracle's `price()` reverts                               | `aggregate3` per-call success flags surface it; the reverting trigger condition fires. **Normal flow, not an error.**                                                                                                                                                                                        |
| 5   | Reference adapter fails                   | morpho-api down, DefiLlama 503, custom adapter throws       | Skip deviation check for that oracle this block; staleness + reverting still run. After K consecutive failures (default K=50): high-severity alert.                                                                                                                                                          |
| 6   | Action simulation reverts (pre-broadcast) | Race with curator manual change; bot-computed queue invalid | Skip submission; log + alert with diff (computed vs current queue); next block re-reads idempotently.                                                                                                                                                                                                        |
| 7   | Action TX reverts (post-broadcast)        | Race won between sim and submission                         | Log + alert; clear inflight; next block re-reads and re-evaluates.                                                                                                                                                                                                                                           |
| 8   | Action TX revert streak on a vault        | Persistent issue (race losses, config mismatch, bug)        | **Per-vault streak fuse.** After N=3 consecutive failed submissions: pause action submission for that vault for M=50 blocks. Trigger evaluation, observability, `/status` continue. Streak resets on success or manual `/admin/unfuse`. Exponential re-fuse on continued failure: 50 → 200 → 800 → max 3200. |
| 9   | Action TX stuck pending                   | Mempool congestion, underpriced gas                         | EOA mode: WalletAdapter handles replace-with-higher-gas internally. Smart-wallet mode: use capability if reported, else re-issue with higher fee.                                                                                                                                                            |
| 10  | Wallet balance below floor (mid-run)      | Bot has been firing; operator hasn't topped up              | Metric + `/status` flag + WARN log. **Bot continues** (detection + alerts continue); no auto-pause.                                                                                                                                                                                                          |
| 11  | Allocator role revoked mid-run            | Curator changed vault config                                | Detected via per-block `isAllocator` read in the standard multicall (B3). High-severity alert; bot continues for OTHER vaults (per-vault isolation).                                                                                                                                                         |
| 12  | New oracle in supplyQueue without config  | Curator added a market mid-run                              | Apply fallback staleness (24h) + reverting checks; skip deviation (no reference); high-severity alert.                                                                                                                                                                                                       |
| 13  | Process crash / restart                   | OOM, deploy, signal                                         | Stateless recovery: re-read everything on next block. Inflight from before crash unknown to bot but idempotent (`setSupplyQueue` of already-filtered queue is a no-op).                                                                                                                                      |
| 14  | Two bot instances against same vault      | Operator mistake or HA experiment                           | Both attempt to fire; first lands, second's read sees filtered queue and skips. Documented as **not supported** but not actively prevented.                                                                                                                                                                  |
| 15  | OTEL endpoint unreachable                 | Backend outage, network issue                               | OTEL queue buffers (bounded); drops on overflow → `otel_records_dropped_total` Prom counter; FATAL/ERROR additionally write to stdout synchronously.                                                                                                                                                         |

**Admin endpoints (token-gated, `ADMIN_TOKEN` env var):**

- `POST /admin/unfuse?vault=<addr>` — clear a per-vault fuse manually.
- `POST /admin/dry-run?chain=<id>&value=true` — hot-flip a chain _into_ dry-run (no auth-bypass to flip _out_).

These are the only runtime mutations the framework exposes. Both write a structured audit log and emit OTEL spans.

### Hosting

- **Primary distribution: Docker / OCI image** built from this repo via the workspace CI (image build is part of the open-source-readiness phase). Operators run on any Docker-compatible host.
- **Reference deployment: Railway US-East.** Documented in the bot's README with a one-command deploy; recommended for solo curators who want zero-ops. Tradeoff vs bare metal Hetzner: ~5–15 ms vs ~1–5 ms RPC RTT, in exchange for managed deploys, built-in metrics, no systemd/SSH.
- **Local: `bun start`** with the operator's `config.ts` and env vars set. Used for first-time setup, dry-run validation, threshold tuning.
- **Bot is portable.** It's a Bun process + RPC URLs + an OTEL endpoint (optional). It runs anywhere those three exist. The TIB does not couple the bot to Railway.

### Implementation Phases

Each phase below is tracked as its own Linear ticket and ships as an independent PR in dependency order. Effort: S (≤1d), M (1–3d), L (3–5d).

**Phase 1 — Framework skeleton.** `bots/kill-switch/` directory; single-process pipeline harness; `Trigger` / `Action` / `BotEntry` / `BlockContext` / `Intent` / `Call` interfaces; config loader (TS-as-config with Zod boundary validation, hand-written types, CI assertion of schema↔type alignment); per-chain `AbortController` plumbing; `Bun.serve()` health server with `/healthz` and `/readyz` stubs. **Effort:** M. **Blocks:** 2–8.

**Phase 2 — Block ingestion + RPC fault tolerance.** WS subscription per chain, liveness watchdog with per-chain block-time defaults (12s mainnet, 2s Base/Arbitrum/Optimism, etc.), reconnect/rotate logic, shared per-endpoint circuit breaker, HTTP failover for read path, shared state between WS and HTTP. **Effort:** M. **Blocks:** 3, 6.

**Phase 3 — Read path: `aggregate3` + adaptive multicall.** Multicall3 client with `allowFailure: true`, adaptive chunk sizing per RPC endpoint, `BlockContext` builder combining on-chain reads with adapter results (parallel), per-block `isAllocator` read folded into the multicall. **Effort:** M. **Blocks:** 5.

**Phase 4 — Adapters: staleness + reference-price.** Both adapter interfaces (`OracleStalenessAdapter`, `ReferencePriceAdapter`); built-in vendor staleness adapters for Chainlink, Pyth, RedStone; built-in reference-price adapters for morpho-api and DefiLlama; `auto` reference selection logic; per-oracle config schema; market → Morpho oracle resolution at startup with process-local cache. **Effort:** L. **Blocks:** 5.

**Phase 5 — Kill Switch `(trigger, action)`.** `OracleHealthTrigger` (staleness ∪ deviation ∪ reverting against `BlockContext`); `ClearSupplyQueueAction` producing the `setSupplyQueue` `Call`; per-vault state machine (inflight tracker, fuse counter, idempotent recovery); pair registration in framework map (`'kill-switch'`). **Effort:** M. **Blocks:** 6.

**Phase 6 — Wallet abstraction + startup gate + dry-run wrapper.** `WalletAdapter` interface; EOA-direct implementation (with internal sequential queue for nonce ordering); Safe-1/1 implementation (first concrete smart-wallet); `DryRunWalletAdapter` wrapper; EIP-5792 `getCapabilities` probe and atomic-batch selection at startup; action simulation; stuck-TX recovery; the seven-step fail-loud startup gate. **Effort:** L. **Blocks:** 7, 9.

**Phase 7 — Observability core.** OTEL SDK wiring (logs + metrics + traces), OTLP HTTP/protobuf exporter, env-var config, stdout-fallback, manual instrumentation throughout (no auto-instrumentation on Bun), bounded queue with drop counter, FATAL/ERROR stdout bypass, `/status` rich-health endpoint, `/status/near-misses` (dry-run only), `/admin/*` endpoints (token-gated). **Effort:** L. **Blocks:** 9.

**Phase 8 — Failure-mode resilience.** Per-vault streak fuse (N=3, M=50, exponential re-fuse to 3200); reference-adapter K-consecutive-failure escalation; runtime drift handler for new oracles in supplyQueue; OTEL hot-path queue bounds and overflow handling; admin unfuse and dry-run hot-flip-in endpoints wired to the fuse / mode state. **Effort:** M. **Blocks:** 9.

**Phase 9 — Open-source readiness.** README (clone-to-running in <10 min for a technical operator); CONTRIBUTING.md (how forks contribute back); SECURITY.md (vuln disclosure email, response SLA, scope); sample `config.ts` with placeholder values that don't imply any specific curator; "from clone to first dry-run fire" mainnet walkthrough; Docker image build (via repo CI) and publish; license file (MIT, pending engineering leadership confirmation per Open Questions). **Effort:** M. **Blocks:** 10.

**Phase 10 — Mainnet canary + acceptance.** Run against one curator-owned V1 vault on mainnet in dry-run for ≥24h; curator reviews `/status/near-misses` and confirms threshold tuning; synthesize a deviation event in dry-run to verify the bot would have fired correctly; flip to live behind a curator-acknowledged flag; observe for one week. **Effort:** L. **Blocks:** Merge `kill-switch` v1.0.

**Phase 11 — `/metrics` Prometheus endpoint (optional, droppable for scope).** Pull-mode metrics exposition for operators in pull-based metrics shops with zero OTEL adoption; emits the same metric set as the OTEL push pipeline plus `otel_records_dropped_total`. **Effort:** S. **Blocks:** none — can be deferred indefinitely without losing kill-switch functionality.

## Considered Alternatives

### Alternative 1: Custom `MorphoBatchAllocator` contract for batched writes

Deploy a stateless singleton (`MorphoBatchAllocator`) per chain via CREATE2. The contract holds the `ALLOCATOR` role on vaults and forwards `setSupplyQueue` calls only after verifying that `msg.sender` (the bot's EOA) is also an allocator on the target vault. Bot signs as an EOA, calls one `batchSetSupplyQueue(Call[])` per block.

**Why rejected.** EIP-5792 plus a smart wallet (or an EOA-direct adapter for curators who prefer no smart wallet) gets the same atomicity, the same one-TX-per-block nonce simplification, and the same cross-vault batching without the team writing, auditing, or maintaining any on-chain code. The custom contract also forces the curator to grant the `ALLOCATOR` role to **two** addresses per vault (the bot's EOA and the batcher contract); the wallet-abstraction path requires **one** grant. The argument for the custom contract was that programmatic smart wallets weren't viable for bot signers when the original ADR was sketched — that argument no longer holds with mature Safe Protocol Kit, Coinbase Smart Wallet, and EIP-7702.

### Alternative 2: Multithreaded or process-per-chain runtime

Run one worker thread per chain, or one OS process per chain, to isolate failures and CPU.

**Why rejected.** The workload is I/O-bound — 10–20 concurrent fetches across all chains, ABI decode in microseconds. Bun's event loop dispatches that without effort. Worker threads add complexity with no fault isolation (they share the process); process-per-chain adds real isolation but multiplies the deploy and monitoring surface for ms-level decode speedup we don't need. The scaling path (Future Considerations) goes straight from single-process to process-per-chain when measured CPU or decode latency pushes the threshold.

### Alternative 3: HTTP polling instead of WebSocket

Poll `eth_blockNumber` every 500ms per chain.

**Why rejected.** 10 req/s burning compute units on "no new block" responses; ~250ms detection lag on L2s. Premium WS tier eliminates the fragility argument. The liveness watchdog already protects against silent WS failures and is ten lines of code; a hybrid WS+HTTP system is an order of magnitude more.

### Alternative 4: `Multicall3.aggregate` instead of `aggregate3`

Use the plain `aggregate` function which reverts the whole batch on any inner call failure.

**Why rejected.** A reverting oracle is one of the kill-switch's three trigger conditions. Using `aggregate` makes a reverting oracle indistinguishable from a network failure — both fail the whole multicall, and the bot would have to retry to discover whether any specific oracle was the cause. `aggregate3` with per-call `allowFailure: true` surfaces the revert as data instead of an error, which is exactly what the trigger logic needs.

### Alternative 5: Static multicall chunk sizes

Fix the multicall chunk size at a conservative number (e.g., 50) that fits under gas on every chain.

**Why rejected.** Different RPC providers have different practical `eth_call` gas ceilings; pinning the lowest common denominator wastes round-trips where 150–200 calls per chunk fit comfortably. Adaptive sizing absorbs that variance with grow/shrink logic and no operational surface.

### Alternative 6: Sequential per-TX writes from the bot's EOA, no smart wallet

Skip the wallet abstraction entirely; the bot is always an EOA, submitting one `setSupplyQueue` TX per vault sequentially.

**Why rejected.** Sequential is unnecessarily slow when the wallet supports atomic batching — N vaults × ~12 s/tx is dozens of seconds at worst. The wallet abstraction makes the EOA path _and_ the smart-wallet path equally available; operators who want EOA just configure `wallet.type: 'eoa'`. We lose nothing by supporting both; we gain the atomic-batch fast-path for free where the wallet can offer it.

### Alternative 7: Hardcode reference price to morpho-api only

Skip the reference-price adapter abstraction; assume morpho-api covers every oracle.

**Why rejected.** morpho-api's coverage is excellent for protocol-team-curated markets but a long tail of curator-deployed markets reference oracles whose underlying assets morpho-api doesn't price. DefiLlama covers most of that tail. The adapter abstraction is ~30 lines of TypeScript; the alternative is morpho-api outages directly creating coverage gaps and a "morpho-api doesn't price this asset" support burden every time a curator onboards an unusual market.

### Alternative 8: Off-chain staleness detection

Track each oracle's last `updatedAt` in an in-memory map keyed by `(chainId, oracleAddress)`, updated from an off-chain feed (Chainlink monitor, vendor API).

**Why rejected.** The oracle's own `updatedAt` is the canonical signal. Reading the vendor feed directly (Chainlink `AggregatorV3.latestRoundData`, Pyth `priceFeed.publishTime`, etc.) folds into the existing multicall at zero extra round-trip cost and removes an off-chain dependency from the most catastrophic-failure-mode detection path.

### Alternative 9: Staleness via the Morpho `IOracle` interface

Read staleness from `morphoOracleAddress` (the address the vault knows about) rather than going directly to the vendor feed.

**Why rejected.** The Morpho `IOracle` interface exposes only `price()` — no `updatedAt`. The bot would have to know about Morpho's `ChainlinkOracle` wrapper's specific layout (`BASE_FEED_1`, `QUOTE_FEED_1`, etc.) and have a different code path for every Morpho oracle implementation. Going directly to the vendor feed keeps the bot's per-block read path uniform: one adapter per vendor, operator-declared feed addresses, no Morpho-wrapper-specific logic.

### Alternative 10: Per-vault multi-pair composition in v1 (model B/C)

Allow multiple `(trigger, action)` pairs per vault from day one, either via disjoint market subsets (B) or with arbitrary overlap + an intent-merge layer (C).

**Why rejected for v1.** Kill switch is the only pair shipping in v1; the framework needs the _abstraction_ (Trigger / Action / BotEntry / `bot:` field in config), but the v1 binding is one pair per vault. Adding model B's disjoint-subset validation or model C's intent-merge layer now would expand the framework's correctness surface (the most operationally critical thing in a kill switch) for use cases that don't exist yet. B is captured as the planned next step when the Reallocation Bot V1 trigger migrates in.

### Alternative 11: YAML config instead of TS-as-config

Load operator config from a YAML file at a path env var (`KILL_SWITCH_CONFIG_PATH`). Same Zod schema validates at startup.

**Why rejected.** The framework's `(trigger, action)` registry is TS-by-name, custom adapters require fork, and config has nested unions where typos and shape errors are easy to introduce. YAML loses the autocomplete + type-checking that those surfaces rely on. The fork-based workflow is also the established extension pattern for adapters — keeping config in the same TS source tree avoids splitting the operator's mental model across two artifacts. Cost paid: a curator who'd like to run the unmodified bot still has to fork to set config. Accepted, given the operator audience (technical curators with engineering support).

### Alternative 12: Zod `z.infer` as the source of truth for config types

Define config types as `type KillSwitchBotConfig = z.infer<typeof KillSwitchBotConfigSchema>` so the schema _is_ the type — common TS+Zod idiom.

**Why rejected.** Inferred types lose readability (large `z.infer<typeof Schema>` blobs at hover time), cross-reference comments / JSDoc, and IDE rename / refactor support. Hand-written types stay canonical, kept in sync with the schema via a CI assertion that `z.infer<typeof Schema>` is assignable to the hand-written type and vice versa. Costs ~5 lines of test code; recovers the type-system experience.

### Alternative 13: Per-block allocator-role re-check via a separate `eth_call`

Run a periodic `isAllocator(wallet)` check (e.g., every 60s) outside the per-block multicall.

**Why rejected.** It's one extra inner call in a Multicall3 batch the bot is already running — negligible cost. Periodic re-check creates a 60s window where the bot might fire-and-fail; per-block re-check catches revocation in the same block it happens and surfaces it as a clean alert. Operators paying for premium RPC tiers might still prefer the 60s window for cost reasons — captured as a future tunable, not a v1 reason to skip.

### Alternative 14: Exponential backoff instead of streak fuse for action TX reverts

Linear-then-exponential backoff (block N, N+2, N+4, N+8, …) instead of a "pause for M blocks" fuse.

**Why rejected.** A fuse with explicit state surfaces to `/status` and OTEL as a single boolean an operator can monitor. Exponential backoff with growing intervals is harder to reason about — the operator has to infer "the bot is in trouble" from the pattern of attempts, vs. seeing `fuseEngaged: true` in the status. The fuse also explicitly preserves trigger evaluation + observability while suppressing only submission, so the operator sees what's happening, just not gas-burning attempts.

### Alternative 15: Hot-flippable dry-run via admin endpoint

Allow `/admin/dry-run?chain=<id>&value=false` to flip a chain from dry-run into live mode at runtime.

**Why rejected (asymmetric flip kept).** Flipping a kill switch from "no action authority" to "full action authority" is a high-blast-radius change. It should be a deliberate, reviewable, recorded act through git and deploy — not a `curl` from someone's laptop. The reverse direction (flipping _into_ dry-run hot) is kept because it's the operationally safer direction (granting suppression, not authority).

## Assumptions & Constraints

- **Premium RPC tier.** Dedicated WS, keepalive, reconnection buffering. Reliability stories from free/shared tiers do not apply.
- **EIP-5792 capability discovery is honest.** The selected wallet truthfully reports `atomicBatch` (and any other capability the framework relies on). False positives — wallet claims atomic-batch but doesn't deliver — break atomicity expectations. False negatives are safe (bot falls back to parallel-queued).
- **Vault `ALLOCATOR` role grants `setSupplyQueue`.** Validated at startup per `(chain, vault)`. Cap management remains curator-only and is not in the bot's surface.
- **Markets are immutable.** `MorphoBlue.idToMarketParams(marketId)` returns the same `(loanToken, collateralToken, oracle, irm, lltv)` forever after market creation. The bot caches the market → oracle resolution process-locally.
- **V1.0 and V1.1 share the allocator-relevant surface.** Confirmed by ABI diff — V1.1 adds only `lostAssets`, `setName`/`setSymbol`, and an `UpdateLostAssets` event. The bot uses the V1.0 ABI subset for both generations; it is forward-compatible.
- **In-memory state is acceptable.** Inflight tracker, RPC circuit-breaker state, fuse counters, market → oracle cache. Restart loses these; the worst case is one duplicate `setSupplyQueue` that's a no-op, or one re-evaluation of an already-protected vault. Stateless property preserved.
- **Signing key in env.** `Bun.env.SIGNER_PRIVATE_KEY` is v1; KMS / Turnkey / Privy is in Future Considerations. Operators MUST treat their deploy environment as the trust boundary.
- **Block timestamps are monotonic and chain-truthful.** Sequencer-time anomalies on L2s are a known risk; the bot's fail-safe stance means a clock anomaly causes (at worst) an early kill-switch — the safer direction.
- **PublicAllocator is out of scope.** If a curator has PublicAllocator enabled with non-zero flow caps on an affected market, that path is not covered by `setSupplyQueue`. Curator-side decision.
- **Open-source distribution is a hard product requirement.** Per the Linear project description: _"Create an open-source deployable bot for Curators to run."_ All current and planned dependencies are permissive-compatible (MIT / Apache 2.0); any future copyleft dependency requires a license-impact review.

## Dependencies

- **viem** (workspace catalog), including `viem/experimental` for EIP-5792 `sendCalls` / `getCallsStatus` / `getCapabilities` actions.
- **Bun** runtime (repo-pinned). Native WS client, `Bun.serve()` for the health server, `bun:test` for tests.
- **`@opentelemetry/api` + `@opentelemetry/sdk-node`** + an OTLP HTTP exporter (`@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/exporter-logs-otlp-http`, `@opentelemetry/exporter-metrics-otlp-http`). **No `@opentelemetry/auto-instrumentations-node`** (Bun-compat).
- **`@safe-global/protocol-kit`** for the v1 Safe-1/1 smart-wallet adapter (first concrete smart-wallet implementation).
- **Reference-price APIs.** morpho-api (`https://blue-api.morpho.org/graphql`) and DefiLlama (`https://coins.llama.fi`). Both public; no key required.
- **RPC providers.** Alchemy primary; one HTTP fallback minimum per chain (operator-supplied).
- **`@repo/utils`** — `tryCatch`, structured-log helpers, env-reading conventions.
- **`@repo/abis`** — V1.0/V1.1 MetaMorpho ABI (V1.0 subset is forward-compatible), MorphoBlue ABI, Multicall3 ABI, SafeWalletAbi, OracleAbi.
- **Hosting.** Railway US-East (reference); Docker / OCI image for any other host. No Sentry, no Datadog vendor dep — observability is OTEL-only.
- **Zod** for runtime config validation.

## Security

- **Threat model.** The bot's authority is bounded by the `ALLOCATOR` role on vaults it operates against. A compromised signing key gives an attacker the ability to call `setSupplyQueue` on those vaults (replicating the curator's allocator-role surface) — not to move funds out of the protocol, not to mint shares, not to change curator. Blast radius: the attacker can reshape the supply queue within the markets the curator already permitted. The action surface is strictly less than the curator's, by design.
- **Signer custody.** v1 reads the EOA private key from `Bun.env.SIGNER_PRIVATE_KEY` (the EOA signer in both EOA-direct mode and 1/1-smart-wallet mode — the smart wallet's sole signer is this EOA). Hosting environment (Railway / Docker host) is the trust boundary. Future custody upgrade to managed signing (KMS, Turnkey, Privy) tracked in Future Considerations; the WalletAdapter abstraction is the seam.
- **Admin endpoint auth.** `/admin/unfuse`, `/admin/dry-run` (into-dry-run only) gated by `Bun.env.ADMIN_TOKEN`. Token rotation is the operator's responsibility; the bot doesn't manage it. Every admin call writes a structured audit log + OTEL span.
- **Reference-price tamper risk.** A compromised reference-price source (morpho-api, DefiLlama, custom adapter) can fabricate deviation and induce a false fire. Mitigations: (1) operators set their own `deviationBps` thresholds — the bot does not act on tiny apparent deviations; (2) per-oracle adapter is operator-chosen; (3) future TIB may add cross-adapter agreement (N-of-M required to confirm deviation).
- **RPC tamper risk.** A compromised RPC endpoint can fabricate on-chain reads. Mitigations: (1) circuit breaker reduces dependence on any one endpoint; (2) per CONVENTIONS.md, RPC calls use explicit block tags for determinism; (3) future TIB may add per-block cross-RPC agreement on critical reads.
- **OTEL header leakage.** `OTEL_EXPORTER_OTLP_HEADERS` carries API keys. Standard env-var custody applies; the bot never logs the header.
- **No upgradeable contracts owned by the team.** The bot does not deploy contracts; the on-chain code it depends on (Morpho V1 vault, the chosen smart wallet) is vendor-audited and either non-upgradeable or upgradeable by parties outside the team's threat model.
- **Repo Strict Rules.** Secrets never enter the repo. Pre-commit + commit-msg hooks established by the bootstrap TIB stay in effect. The sample `config.ts` ships with placeholder values that don't imply any real curator's vault.

## Future Considerations

- **Bot #2: Reallocation Bot V1 migration.** A future `(trigger, action)` pair migrating the existing `morpho-blue-liquidation-bot` reallocation logic into this framework. Lands as a new entry in the `(trigger, action)` registry, with its own TIB.
- **Multi-pair-per-vault composition (model B).** Disjoint market subsets — when a curator wants kill switch + reallocation on the same vault but on different markets. Lands when the Reallocation pair arrives, since that's when the composition need becomes real.
- **Model C — arbitrary-overlap pairs with intent merging.** Captured but deferred until a curator wants kill switch + reallocation simultaneously observing the same markets, which requires real operator input on the semantics of disagreement.
- **Vaults V2 support.** V2's allocator surface (multi-asset, market obligations, offers) is materially different. A separate TIB extends or supersedes this one when V2 vaults are live.
- **Process-per-chain.** Triggered by sustained decode time > 50ms, 10+ active chains, or a need for true fault isolation between chains. Adds OS-level deploys; deferred until measured signal.
- **Managed signer custody.** KMS, Turnkey, Privy replace `Bun.env.SIGNER_PRIVATE_KEY`. The WalletAdapter is the seam — only the inner signer's `signMessage` / `signTypedData` changes.
- **Cross-adapter price agreement.** Require N-of-M reference-price adapters to agree before firing deviation. Useful once a curator runs the bot on a high-stakes vault.
- **Per-block cross-RPC agreement.** Read the same oracle from 2+ RPCs and only act on agreement. Adds latency and cost; defer until a real attack scenario justifies it.
- **In-process state persistence.** If `recentActions` / fuse counter loss across restarts becomes operationally painful, a small SQLite or Bun KV layer can persist them without crossing into "external database on the hot path".
- **Hot-reload of certain config fields.** Threshold tuning during dry-run currently requires restart. A future iteration may allow live threshold changes via `/admin/threshold?…` (token-gated, audit-logged) without touching the hot path.
- **PublicAllocator interaction.** If curators run PublicAllocator with non-zero flow caps on markets the kill switch is protecting, a follow-up TIB may add a companion action to zero PublicAllocator flow caps as part of the protective batch.
- **Multi-bot coordination.** When multiple bots watch the same vault (e.g., curator's bot + a service bot), a lightweight coordination mechanism prevents duplicate actions. Defer until the second curator-side bot ships.
- **Public-cut-over TIB.** TIB-2026-04-16 called for a separate TIB covering pre-flip git-history audit, licensing, and config redaction. This TIB defers the license pick (MIT recommended) to that work.

## Open Questions

These do not block acceptance — they're the discussion-call agenda.

1. **License pick.** MIT is recommended (ecosystem norm, smaller patent surface, max downstream compatibility). Final decision reserved for engineering leadership and settled in the repo-wide public-cut-over TIB called for by TIB-2026-04-16.
2. **Wallet balance floor default per chain.** Bot ships no default — operator declares per-chain. The right default would be "enough gas for N batched fires at p99 base fee" for some N; agreeing on N (and whether different defaults make sense for L1 vs L2s) is a documentation question this TIB doesn't settle.
3. **Final list of staleness adapters in v1.** Chainlink, Pyth, RedStone are intended; other vendors (Chronicle, API3, Ethena's internal oracle, etc.) wait for concrete curator demand. The Phase 4 PR locks the final list.
4. **`/metrics` Prometheus endpoint inclusion.** Phase 11 is droppable for scope. The discussion call decides whether `/metrics` is "ships in v1.0" or "fast-follow if any curator asks for it".
5. **Block-time defaults vs operator-declared.** v1 ships defaults for major chains; operators can override per-chain. The discussion call should confirm whether the defaults are kept in code (chain → block-time map in `@repo/utils` or similar) or moved into operator config entirely.

## References

- [TIB-2026-04-16: Bootstrap `curator-bots` repo from `morpho-apps` foundations](../../../../docs/decisions/TIB-2026-04-16-bootstrap-curator-bots.md) — the repo scaffolding this TIB builds on.
- [docs/CONVENTIONS.md](../../../../docs/CONVENTIONS.md) — RPC efficiency rules, structured log expectations, env-var access, test conventions.
- [docs/GUIDANCE.md](../../../../docs/GUIDANCE.md) — TIB process this document is travelling through.
- [docs/context/repos/morpho-vaults-v2.txt](../../../../docs/context/repos/morpho-vaults-v2.txt) — context on the V2 vault surface this TIB explicitly defers.
- [Linear project: Kill Switch Bot](https://linear.app/morpho-labs/project/kill-switch-bot-0250d77e9ef3) — product goals, trigger criteria (oracle staleness, deviation, reverting), non-goals (MEV resistance), and the framework framing this TIB realizes.
- [Linear CRTR-2405](https://linear.app/morpho-labs/issue/CRTR-2405/docskill-switch-write-architecture-tib-for-vaults-v1-bot-framework) — the ticket tracking this TIB.
- [EIP-5792: Wallet Call API](https://eips.ethereum.org/EIPS/eip-5792) — the standard the write path uses for capability discovery and batched submission.
- [EIP-7702: Set EOA account code](https://eips.ethereum.org/EIPS/eip-7702) — relevant for the post-Pectra option in the WalletAdapter's smart-wallet implementation space.
- [viem experimental actions](https://viem.sh/experimental/) — `sendCalls`, `getCallsStatus`, `getCapabilities`, `showCallsStatus`.
- [Multicall3](https://www.multicall3.com/) — deployment registry the read path depends on; `aggregate3` documentation.
- [OpenTelemetry JS SDK](https://opentelemetry.io/docs/languages/js/) — observability primitive; OTLP HTTP exporter docs.
- [Safe Protocol Kit](https://docs.safe.global/sdk/protocol-kit) — first concrete smart-wallet adapter implementation.
- Granola — discussion call recording _to be linked after the call_.

<!--
TIB conventions:
- Once accepted, do not substantively edit this TIB. If the decision needs to change,
  create a new TIB that supersedes this one and update the Status/Superseded by fields.
- Addenda may be appended to record operational updates that affect
  how the TIB is applied without changing the decision itself.
- TIB identifiers use CalVer (YYYY-MM-DD) based on the date the TIB was first drafted.
-->
