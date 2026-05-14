# TIB-2026-05-14: `WalletAdapter` — EOA-direct submitter (v1, smart-wallet forward-compat)

| Field      | Value                                                                      |
| ---------- | -------------------------------------------------------------------------- |
| **Status** | Proposed                                                                   |
| **Date**   | 2026-05-14                                                                 |
| **Author** | @cashd                                                                     |
| **Scope**  | Framework: `WalletAdapter` (kill-switch v1; future Vaults V1 bots inherit) |

---

## Context

[TIB-2026-05-14-vaults-v1-bot-framework](./TIB-2026-05-14-vaults-v1-bot-framework.md) names the `WalletAdapter` as the framework's seam between the per-block action pipeline and on-chain submission. The framework TIB pins the seam's role (one method on the hot path, capability stub for forward-compat, dry-run wrapper, per-vault inflight tracking owned by the framework) but does not pin the adapter's internals: nonce management, simulation primitive, stuck-TX recovery, `SubmissionResult` shape, error taxonomy, or the forward-compat choices that ease a smart-wallet drop-in later.

This TIB settles those internals for the v1 EOA-direct adapter and locks the interface shape that the smart-wallet follow-up will inherit without breaking framework call sites.

An earlier draft of the framework TIB committed to shipping **two** concrete adapters in v1 — EOA-direct and a 1/1 Safe — under an EIP-5792-shaped surface (`sendCalls` / `getCallsStatus` / `getCapabilities`). During design review we simplified to EOA-only for v1: with no smart wallet there is nothing to fuse across calls, so the EIP-5792 surface, the cross-call atomic-batch branch in the framework, and the `@safe-global/protocol-kit` dependency all collapse. The smart-wallet adapter becomes a clean follow-up under a narrower interface.

## Goals / Non-Goals

**Goals**

- Define a single `WalletAdapter` interface that v1 EOA-direct implements and that a future smart-wallet implementation drops into without changing framework call sites.
- Lock the EOA-direct submission flow: per-chain nonce management, per-call simulation, parallel TX dispatch, stuck-TX recovery, per-call result attribution.
- Define the `SubmissionResult` shape so triggers receive uniform per-call outcomes regardless of which adapter is configured.
- Define the `DryRunWalletAdapter` wrapper semantics for the EOA adapter.
- Identify the small set of internal primitives (nonce manager, gas-bump-and-replace, simulation helper) that should be reusable across adapter implementations.

**Non-Goals**

- **Smart-wallet adapter implementation.** Safe-1/1, CB Smart Wallet, EIP-7702 — separate follow-up TIB, scoped against this interface. This TIB only pins forward-compat decisions, not the smart-wallet's internals.
- **Cross-trigger fusion / batch queue.** No microbatch debounce, no per-chain flush sessions. Pure EOA has nothing to fuse; adding a queue is speculative work for the smart-wallet adapter and lives there if needed.
- **Custodial signer integration.** KMS / Turnkey / Privy is a swap of the inner signer behind the same adapter — out of scope here, captured in Future Considerations.
- **Multi-sig wallets.** Out of scope by the framework TIB.
- **Cap management, withdraw-queue updates, or any action surface beyond what the framework's action layer produces as `Call[]`.** The adapter is dumb about what calls mean; it just submits them.

## Proposed Solution

### Interface

```typescript
interface WalletAdapter {
  /** Address that must hold the allocator role on every configured vault. */
  readonly address: Address

  /**
   * Submit calls from a single trigger's `action.plan` output.
   * The adapter handles simulation, nonce assignment, dispatch, and stuck-TX recovery.
   * Concurrent `submit` calls on the same chain are safe — nonce issuance is serialized.
   */
  submit(
    chainId: number,
    calls: readonly Call[],
    meta?: SubmissionMeta
  ): Promise<SubmissionResult>

  /** Native-token balance of the submitter on `chainId`. Used by the startup gate and `/status`. */
  getBalance(chainId: number): Promise<bigint>

  /**
   * Capability probe. Stub in v1 (always `{ atomicBatch: false }` for EOA).
   * Smart-wallet adapter returns `{ atomicBatch: true }`. Framework does not branch on it today,
   * but `/status` exposes it and future framework logic may consume it.
   */
  getCapabilities(chainId: number): Promise<{ atomicBatch: boolean }>
}

type Call = {
  readonly to: Address
  readonly data: Hex
  readonly value?: bigint
}

type SubmissionMeta = {
  readonly trigger: string  // e.g., 'kill-switch'
  readonly vault: Address   // for OTEL labeling and audit logs
}

type SubmissionResult = {
  status: 'CONFIRMED' | 'REVERTED' | 'SIMULATION_REVERTED' | 'SUBMISSION_FAILED'
  txHashes: readonly Hex[]  // N for EOA-direct, 1 for atomic-batch
  calls: ReadonlyArray<{
    status: 'success' | 'reverted' | 'simulation_reverted' | 'dropped'
    txHash?: Hex             // per-call for EOA, shared for atomic-batch
    revertReason?: string
  }>
}
```

**Design properties of the interface:**

- **`submit` is the only hot-path method.** Triggers don't poll, don't manage handles, don't observe intermediate state. They `await` one promise.
- **`Call[]`, not single `Call`.** Even though kill-switch's `ClearSupplyQueueAction` produces one call per vault, the array shape matches the smart-wallet's native atomic primitive. EOA splits, smart-wallet bundles — same call site.
- **`address` is the allocator address.** For EOA it's the submitter EOA. For Safe (future) it's the Safe contract; the inner submitter EOA stays adapter-internal.
- **`SubmissionResult.calls` is N-shaped for both adapter types.** EOA fills per-call txHashes; smart-wallet fills one shared txHash referenced from every call entry. The caller never needs to know which it is.
- **`getCapabilities` is a stub in v1 but lives in the interface.** Cheaper than retrofitting later, and `/status` can report it without an adapter-type check.

### Internal model (EOA-direct)

Per-chain state inside the adapter:

```
chain C:
  client          // viem WalletClient with nonceManager attached
  publicClient    // viem PublicClient for simulation + receipt polling
  nonceManager    // viem's nonceManager — issues monotonically increasing nonces
                  //   under concurrent submission; persists across submit() calls
```

There is **no** queue, no debounce timer, no flush session. Concurrent `submit` calls run in parallel; the nonce manager serializes only the assignment of nonces, not the rest of the work.

### Submission flow for one `submit(chainId, calls)`

```
1. Resolve client + nonceManager for chainId.
2. Simulate every call in parallel via eth_call with `from: this.address`,
   `to: call.to`, `data: call.data`. JSON-RPC batching at the viem HTTP transport
   collapses the N requests into one round-trip on capable RPCs.
3. Partition by simulation outcome:
   - simulation_reverted → mark `dropped` (carry the revert reason)
   - simulation_ok → continue to dispatch
4. For each ok call: viem assigns a nonce via nonceManager and dispatches sendTransaction
   in parallel.
5. For each dispatched TX: await waitForTransactionReceipt with stuck-detection
   (see Stuck-TX recovery).
6. Aggregate results into SubmissionResult:
   - All calls succeed on-chain → CONFIRMED
   - Some succeed, some revert post-broadcast → REVERTED (overall),
     with per-call status reflecting each outcome
   - All calls dropped at sim → SIMULATION_REVERTED (no broadcast attempted)
   - Any RPC-layer or signer-layer failure prevented broadcast → SUBMISSION_FAILED
7. Return SubmissionResult.
```

### Simulation primitive

Each pending call simulates via `publicClient.call({ from: this.address, to, data })`. `msg.sender` inside the called contract is `this.address` (the bot's EOA), so vault `isAllocator(msg.sender)` checks pass during simulation when they'll pass at submission. Multicall3-based simulation is **not** used here because Multicall3's inner `call` changes `msg.sender` to itself, which breaks every privileged check.

`Promise.allSettled([...calls.map(simulateOne)])` gives per-call attribution natively. The HTTP transport's `batch: true` option folds the N requests into one JSON-RPC batch; the fallback (non-batching RPC) is N serial requests, acceptable at the volumes this bot produces (≤10 calls per submit in practice).

A simulation revert is **expected, recoverable**, and **per-call**. The most common cause is a race with a curator's manual `setSupplyQueue` change between the bot's read and the bot's submit — the offending call is dropped, the rest dispatch, and the dropped vault re-evaluates idempotently next block.

### Dispatch and nonce management

viem's `nonceManager` is attached to the `WalletClient`. Concurrent `sendTransaction` calls each grab the next nonce under an internal lock; the rest of the submission (RPC dispatch, receipt polling) runs in parallel.

This means: if trigger A and trigger B both call `submit(chainId, [callA])` and `submit(chainId, [callB])` concurrently, the adapter assigns nonces N and N+1 (in some order, doesn't matter — calls are independent), dispatches both in parallel, and each receipt-watcher runs independently. No explicit serialization in the adapter code — viem owns this primitive.

### Stuck-TX recovery

Each dispatched TX has its own watcher. The watcher:

- Calls `waitForTransactionReceipt` with a `timeout` derived from per-chain config (default `min(3 blocks, 30s)`).
- On timeout → identify the TX is stuck → bump gas (multiply both `maxFeePerGas` and `maxPriorityFeePerGas` by 1.5×, floor with `1.2× current basefee` for `maxFeePerGas`) → re-submit at the **same nonce** with bumped gas → re-await.
- Up to **3 bumps** per TX. After exhaustion, the TX is treated as failed and surfaces in `SubmissionResult.calls[i].status === 'reverted'` with an explicit "submission_stuck" revert reason. The framework's per-vault streak fuse engages on repeated failures.

Replacement is at the EOA nonce — same primitive a smart-wallet adapter will use to replace its outer `execTransaction` TX when it lands. Sharing this primitive across adapter implementations is the reason it's factored out (see "Reusable internal primitives" below).

### `DryRunWalletAdapter`

A wrapper around any real `WalletAdapter`. Delegates `address`, `getBalance`, `getCapabilities` unchanged. Intercepts `submit`:

- Runs the real adapter's simulation step (so genuine simulation-revert errors still surface in the result and feed `/status/near-misses`).
- Skips dispatch entirely.
- Logs the would-be `Call[]` at INFO via OTEL.
- Records a "would-have-fired" entry in `/status/near-misses` (a ring buffer the bot exposes in dry-run mode only).
- Returns a synthetic `SubmissionResult`:
  - `status: 'SIMULATION_REVERTED'` if any call would have been dropped at sim, otherwise `'CONFIRMED'`.
  - `txHashes: []` (no on-chain TX was attempted).
  - `calls[*]`: simulation result per call, with `txHash` unset and `status` ∈ `{ 'simulation_reverted', 'success' }` (the "would have succeeded" interpretation).

Framework call sites are unchanged — the dry-run wrapper is configured at adapter construction time, not branched on at the call site.

### Reusable internal primitives

Factored out as adapter-internal utilities so the smart-wallet adapter follow-up can reuse them:

| Primitive                          | EOA usage                                | Smart-wallet usage (future)                                                                                                                                                                          |
| ---------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createNonceManager(chainId)`      | Nonces for direct `sendTransaction`      | Nonces for the outer `execTransaction`-wrapper TX                                                                                                                                                    |
| `bumpAndReplace(txState)`          | Replace the stuck direct TX at its nonce | Replace the stuck outer wrapper TX at its nonce                                                                                                                                                      |
| `simulateCall({ from, to, data })` | Per-call sim for EOA                     | Available for `/status` preview or future bots; not the smart-wallet's primary sim primitive (Safe simulates via `execTransaction` calldata against the Safe — a separate utility added in that TIB) |

These live in the adapter package as named helpers, not deep inside the EOA-direct class.

### Forward-compat surface for smart-wallet

When the smart-wallet adapter ships, the interface above does not change. What changes:

- `address` becomes the smart-wallet's contract address (holds the allocator role).
- The inner submitter EOA is the adapter's private state — same nonce-manager and bump-replace primitives apply to the outer `execTransaction` TX.
- `getCapabilities(chainId)` returns `{ atomicBatch: true }`.
- `submit` collapses the N input calls into one atomic batch via the wallet's primitive (Safe's `multiSend`, CB Smart Wallet's batched `execute`, or EIP-7702's delegated batch executor). Returns one `txHashes[0]`; every `calls[i].txHash` points to that hash.
- Simulation switches to a wallet-specific primitive (e.g., `eth_call` against `execTransaction` with a real signature payload) — internal to the adapter, not exposed.
- `SubmissionResult.status` semantics narrow: smart-wallet atomic submission is "all calls succeed or all fail," so partial-success states (`status: REVERTED` with some `calls[i].status: success`) cannot occur on that adapter — but the shape supports the EOA case without forcing the smart-wallet adapter to fabricate per-call data.

Framework call sites — `walletAdapter.submit(chainId, calls)` from the per-block action pipeline — stay byte-for-byte unchanged.

## Considered Alternatives

### Alternative 1: Cross-trigger fusion queue (microbatch debounce per chain)

Buffer concurrent `submit` calls per chain in a small debounce window, then flush as one batch.

**Why rejected for v1.** Pure EOA has nothing to fuse — each call becomes its own TX regardless. The queue would add a latency knob (window length), a starvation surface (continuous enqueues), and a "what happens when block N+1 arrives during flush of block N" question with no upside. The queue is real work for the smart-wallet adapter (where atomic fusion is the whole point); deferred to that TIB.

### Alternative 2: Single-`Call` `submit` signature

`submit(chainId, call): Promise<...>` instead of `submit(chainId, calls: Call[]): Promise<...>`.

**Why rejected.** The smart-wallet adapter's natural primitive is N-call atomic batch. Forcing N single-call submits and then trying to fuse them inside the adapter would require either the queue (rejected above) or a smart-wallet-specific API extension — both worse than just letting the shape carry an array from day one. Kill switch always passes `[oneCall]`; cost is zero.

### Alternative 3: `Multicall3.aggregate3` for batched simulation

Simulate all pending calls via one `eth_call` to `Multicall3.aggregate3` with per-call success flags.

**Why rejected.** Multicall3's inner `call` executes with `msg.sender = Multicall3`, breaking every privileged check in the simulated calls. `vault.isAllocator(msg.sender)` would always be false during simulation while passing at real submission. N parallel `eth_call`s with `from: this.address` is correct, JSON-RPC-batched into one HTTP round-trip, and gives per-call attribution natively.

### Alternative 4: Sequential per-TX submission

Submit calls one at a time, awaiting each receipt before dispatching the next.

**Why rejected.** Independent vaults' calls have no ordering dependency. Sequential adds N × block-time to total latency for no correctness benefit. viem's `nonceManager` makes parallel-with-managed-nonces trivial; the only cost is each TX gets its own receipt watcher.

### Alternative 5: Adapter-owned inflight TX tracking per vault

Move the per-vault inflight map (currently framework-owned) inside the adapter.

**Why rejected.** The adapter doesn't know about vaults — `meta.vault` is for observability, not state. The framework already keys inflight tracking off `(chain, vault)` from the action layer's intent map; moving it would split that state across two layers. Adapter stays vault-agnostic.

### Alternative 6: Exposed `simulate` method on the interface

Add `simulate(chainId, calls): Promise<SimulationResult>` to the public interface so the framework can preview before submitting.

**Why rejected for v1.** Simulation is internal to the `submit` flow; the framework doesn't need it as a separate primitive. If `/status` preview, dry-run debugging, or a future bot needs explicit simulation, it can be added as an interface extension at that point without breaking v1's `submit` contract. YAGNI.

## Assumptions & Constraints

- **viem's `nonceManager` is correct under concurrent submission.** It serializes nonce issuance with an internal lock and issues monotonically increasing nonces. Verified by viem's test suite and exercised in production by many other tools; we don't re-validate.
- **HTTP transport JSON-RPC batching is supported by the operator's RPC provider.** Alchemy, Infura, QuickNode all support it. On a provider that doesn't, simulation falls back to N serial requests — slower per round-trip but still correct.
- **`Bun.env.SIGNER_PRIVATE_KEY` is the v1 signer.** Single private key, derives one EOA used across all configured chains. Per-chain keys and custodial signing are tracked separately.
- **Operator's chain is EIP-1559-compatible.** The gas-bump policy uses `maxFeePerGas` / `maxPriorityFeePerGas`. Pre-1559 chains (none in the target set) would need a separate bump path.
- **Multicall3 is deployed at the canonical address on every configured chain.** Required by the framework's read path; this adapter doesn't use Multicall3 (see Alternative 3), but mentioning it here for completeness — the framework TIB owns this assumption.

## Dependencies

- **viem** (workspace catalog). Required: `WalletClient`, `PublicClient`, `nonceManager`, `sendTransaction`, `waitForTransactionReceipt`, `call`, `estimateFeesPerGas`, HTTP transport with `batch: true`. All stable surface.
- **`@repo/utils`** — `tryCatch`, structured-log helpers.
- **`@repo/abis`** — only consumed indirectly: the adapter receives encoded `data` from the action layer; it doesn't decode or re-encode ABIs itself.

## Observability

The adapter emits the following OTEL signals (names locked at implementation time, may vary slightly):

**Logs.** `wallet.submit.started` (chain, vault, trigger, callCount); `wallet.simulate.ok` (per call); `wallet.simulate.reverted` (per call, with revertReason); `wallet.dispatch.ok` (per call, with txHash + nonce); `wallet.dispatch.failed` (per call, with error); `wallet.submit.confirmed` (per call); `wallet.submit.reverted` (per call); `wallet.submit.bumped` (per stuck TX, with bumpCount and new gas params); `wallet.submit.failed` (per call, exhausted bumps or RPC error).

**Metrics.** `wallet_submissions_total{chain,trigger,outcome}`; `wallet_simulation_reverts_total{chain,trigger,vault}`; `wallet_bumps_total{chain}`; `wallet_balance_native{chain}` (gauge, polled at startup and periodically). Histogram: `wallet_submit_latency_ms{chain,trigger}` (block-seen → terminal status).

**Traces.** Root span `wallet.submit {chain,trigger,vault,callCount}`. Child spans: `wallet.simulate`, `wallet.dispatch`, `wallet.waitForReceipt`, `wallet.bump` (when applicable). Errors attached as OTEL exceptions.

The dry-run wrapper's "would-have-fired" recording is via the framework's `/status/near-misses` ring buffer, not the adapter's own surface.

## Security

- **Trust boundary.** The adapter holds the EOA private key in memory after construction. The hosting environment (Railway / Docker host) is the trust boundary. The framework TIB owns this discussion in full; this TIB inherits it.
- **No additional contract dependencies.** v1 EOA-direct adds no on-chain dependency the framework TIB hasn't already accounted for. The smart-wallet follow-up will introduce a dependency on the chosen wallet contract; evaluated in that TIB.
- **Simulation cannot leak signer.** Simulation uses `eth_call` with `from: address` — no signature is constructed or transmitted. Only `sendTransaction` (real dispatch) uses the signer.
- **Stuck-TX bump policy is bounded.** 3 bumps × 1.5× per bump = at most 3.375× the original gas. Operators concerned about runaway gas can set per-chain caps in config (Open Question: should we ship a default `maxBumpedFeeWei` ceiling?).
- **No external network calls beyond the configured RPC.** The adapter does not reach the OS for entropy at runtime (signer is created once at startup), does not call price APIs, does not fetch wallet metadata from third parties.

## Future Considerations

- **Smart-wallet adapter (Safe-1/1, CB Smart Wallet, EIP-7702).** Separate TIB. Inherits this interface verbatim. Adds: wallet-specific simulation (`execTransaction` / batched-execute calldata), atomic dispatch (`multiSend` payload construction), outer-TX nonce management for the wrapping submission, optional EIP-5792 capability translation. The "Forward-compat surface for smart-wallet" section above lists the deltas.
- **Custodial signer (KMS, Turnkey, Privy).** Swap the inner signer behind the adapter — `address` resolution and signing happen through an async signer interface instead of an in-memory private key. The adapter shape is unchanged.
- **Per-chain private keys.** Today the same EOA submits on every chain. A future enhancement allows a private key per chain (useful for separating gas budgets, audit boundaries). Implementation is a per-chain client + nonce manager instead of a single one — the adapter shape is unchanged.
- **Explicit `simulate` method on the interface.** If `/status` preview, dry-run debugging, or a future bot wants pre-submit simulation as a standalone primitive, add it then. EOA implementation is trivial (the existing internal helper); smart-wallet implementation will need a wallet-specific primitive.
- **Configurable gas-bump policy per chain.** Today: hardcoded 1.5× per bump, 3 bumps max, detection at `min(3 blocks, 30s)`. Per-chain overrides (e.g., aggressive bumps on mainnet, conservative on L2s) when an operator surfaces a concrete need.

## Open Questions

These do not block acceptance — they're the discussion-call agenda.

1. **Simulation primitive for the smart-wallet follow-up.** EOA's per-call `eth_call` is settled. The smart-wallet adapter has two options: (a) build the real `execTransaction` signature payload and `eth_call` it (atomic, all-or-nothing attribution); (b) use Safe's `SimulateTxAccessor` view (which bypasses signature checks but adds a dependency on a specific Safe utility contract). To be decided in the smart-wallet TIB.
2. **Default `maxBumpedFeeWei` ceiling per chain.** Today the bump policy is 3 bumps × 1.5× without an absolute cap. Should the adapter ship a per-chain absolute ceiling (e.g., 1× block.basefee × 10) to bound worst-case gas spend if the chain enters a fee spike during a bump cycle?
3. **Stuck-TX detection threshold defaults per chain.** Currently `min(3 blocks, 30s)`. Is this right for both mainnet (12s blocks → block-count fires first) and L2s (2s blocks → time fires first)? Operator override is supported either way; the question is what the bot ships as defaults.
4. **JSON-RPC batching fallback behavior.** If the configured RPC doesn't support batched JSON-RPC, the adapter falls back to N serial `eth_call` requests for simulation. Should the bot detect this at startup and warn (so operators know they're paying N round-trips per submit), or just silently degrade?
5. **`getCapabilities` shape evolution.** v1 returns `{ atomicBatch: boolean }`. Should we extend now to `{ atomicBatch: boolean; replaceTx?: boolean; paymaster?: boolean }` for forward-compat with the smart-wallet adapter, or wait and add fields when an adapter actually populates them?

## References

- [TIB-2026-05-14-vaults-v1-bot-framework](./TIB-2026-05-14-vaults-v1-bot-framework.md) — the framework TIB this adapter slots into; owns the per-vault inflight tracker, dry-run wrapper integration, and the failure-mode catalog the adapter contributes to.
- [TIB-2026-04-16: Bootstrap `curator-bots` repo](../../../../docs/decisions/TIB-2026-04-16-bootstrap-curator-bots.md) — repo posture this TIB inherits.
- [docs/CONVENTIONS.md](../../../../docs/CONVENTIONS.md) — RPC efficiency rules, structured log expectations.
- [viem `nonceManager`](https://viem.sh/docs/clients/wallet#nonce-manager) — the v1 primitive for concurrent EOA submission.
- [viem HTTP transport — JSON-RPC batching](https://viem.sh/docs/clients/transports/http#batch-optional) — the simulation round-trip primitive.
- [EIP-5792: Wallet Call API](https://eips.ethereum.org/EIPS/eip-5792) — informs the `getCapabilities` shape; consumed by the smart-wallet adapter follow-up.
- [Multicall3](https://www.multicall3.com/) — relevant for the framework's read path; explicitly **not** used by this adapter for simulation (see Alternative 3).
- Granola — discussion call recording _to be linked after the call_.

<!--
TIB conventions:
- Once accepted, do not substantively edit this TIB. If the decision needs to change,
  create a new TIB that supersedes this one and update the Status/Superseded by fields.
- Addenda may be appended to record operational updates that affect
  how the TIB is applied without changing the decision itself.
- TIB identifiers use CalVer (YYYY-MM-DD) based on the date the TIB was first drafted.
-->
