# TIB-2026-08-17: Vault V1 reallocation bot — monorepo migration

| Field      | Value                             |
| ---------- | --------------------------------- |
| **Status** | Accepted                          |
| **Date**   | 2026-08-17                        |
| **Author** | @haydenshively                    |
| **Scope**  | App: `bots/vault-v1-reallocation` |

---

## Context

The reallocation bot — which moves a MetaMorpho (Vault V1) vault's liquidity between its
whitelisted markets via `MetaMorphoV1_1.reallocate` — lived in the standalone
[`morpho-blue-reallocation-bot`](https://github.com/morpho-org/morpho-blue-reallocation-bot)
repository. That repo carried its own signer, transaction submission, logging, and deploy surface,
all of which `@repo/bot-kit` and the repo-wide CI/Railway/BetterStack tooling now own for the two
liquidators. It also predated the SDK maturity that makes hand-rolled IRM math unnecessary.

Two things made a migration a decision rather than a copy-paste: the old repo's hexagonal
ports/adapters layering does not match the bots-as-programs shape this repo settled on
([TIB-2026-07-16](./TIB-2026-07-16-revert-to-bots-as-programs.md)), and bot-kit's signing policy
authorized exactly one target address per bot, which a bot that legitimately touches N vaults
cannot express.

## Goals / Non-Goals

**Goals**

- Run the reallocation bot as a monorepo bot on the same flat, standalone-program shape as the
  liquidators, assembling its runtime from `@repo/bot-kit`.
- Take all Blue/IRM math and reads from the Morpho SDKs rather than re-deriving them locally.
- Express "this bot may call `reallocate` on these N whitelisted vaults" inside bot-kit's
  default-deny signing policy without weakening it.
- Ship curator policy (APY ranges, firing thresholds) as reviewed, checked-in code.
- Make first deployment of any vault safe by default.

**Non-Goals**

- Vault V2. This bot targets Vault V1 (MetaMorpho / MetaMorphoV1_1) only.
- Porting the old repo's populated policy tables, structure, or abstractions verbatim.
- An anvil fork suite in this iteration (see Future Considerations).
- Profitability or yield optimality guarantees — the strategies are policy enforcement, not
  optimizers.
- Multi-chain in one process. One process per chain, as with every other bot here.

## Current Solution

Before this change the bot ran out of its own repository, with its own runtime and deploy pipeline,
and was not covered by this repo's CI deploy, Railway wiring, or BetterStack dashboards.

## Proposed Solution

### Shape

The bot lives at `bots/vault-v1-reallocation` as a standalone long-running program: `main()` in
`src/index.ts` loads env config fail-loud, builds viem clients, and drives a bot-kit block watcher
plus runner loop. Signing, the pending-tx queue (fee policy, backoff, cooldown), the policy guard,
the logger, and call simulation (`simulateCall`) all come from `@repo/bot-kit`.

The structure is deliberately **flat and non-hexagonal**:

```
src/
  config.ts           // env → Config; chain map; fail loud
  strategy-config.ts  // checked-in curator policy tables + resolvers
  vault-data.ts       // deployless lens → block-pinned snapshot; IRM classification
  state/lens.sol.ts   // the soltag lens contract + its one-eth_call reader
  math.ts             // utilization / withdrawable / depositable / apy⇄rate glue; the target clamp
  vault-checks.ts     // startup whitelist validation (deployed, V1 surface, allocator probe)
  interval-gate.ts    // wall-clock throttle between reallocation passes
  strategies/         // reconcile.ts (sizing + legs) + apy-range | equalize classifiers (pure)
  runner/tick.ts      // one pass: read → strategy → encode → simulate → submit
  index.ts, *.error.ts
```

The whole bot is ~1.2k LOC of read → pure strategy → simulate → submit. Each tick reads a
block-pinned vault snapshot, runs the configured strategy as a pure function of that snapshot,
encodes a `reallocate`, simulates it, and submits only sim-ok transactions through the queue.

A strategy is only a **classifier**: per market it answers "what utilization should this sit at, and
does that move clear the min-delta threshold?". The single `strategies/reconcile.ts` owns every
mechanic — clamped sizing, idle netting (`net` for apy-range, `ignore` for equalize), the firing
gate, budget trimming in withdraw-queue order, and the `reallocate` legs.

### SDK-first math

All Blue and IRM math comes from `@morpho-org/blue-sdk` (`MathLib`, `AdaptiveCurveIrmLib`,
`getChainAddresses` — which is also where the lens gets its per-chain Morpho and AdaptiveCurveIRM
addresses, never a hardcoded constant), and the encoding plus the ABI from `@morpho-org/blue-sdk-viem`
(`metaMorphoAbi`, `MetaMorphoAction.reallocate`). Nothing re-derives the adaptive curve. The only
local math (`src/math.ts`) is the thin glue with no SDK counterpart: `getUtilization`,
`getWithdrawableAmount`, `getDepositableAmount`, `apyToRate` / `rateToApy`, `wadToBips`, and the two
WAD constants `CAP_BUFFER_WAD` and `MAX_TARGET_UTILIZATION` (both built with `@repo/utils`'s
`wholePercentToWAD`).

### `Policy.executor` replaced by `Policy.targets`

bot-kit's default-deny signing policy previously authorized a single Executor address per bot. This
bot legitimately targets N whitelisted vaults, so `Policy.executor` became `Policy.targets`
(`packages/bot-kit/src/policy.ts`) — a list with a membership check. The invariant is unchanged: a transaction is signable only
if it is value-0, selector-matched (`reallocate`), under the fee/gas/size ceilings, and addressed
to a member of the configured target set. Widening the arity does not widen what may be called.

### Curator policy as a reviewed template

Per-vault and per-market borrow-APY ranges and minimum-delta firing thresholds live in
`src/strategy-config.ts` with **market override > vault override > env default** precedence. The old
repo's populated tables were **not** ported: the tables ship empty, so every vault starts on the
env defaults (`DEFAULT_APY_RANGE`, `MIN_APY_DELTA_BIPS`, `MIN_UTILIZATION_DELTA_BIPS`) and any
policy change is a reviewed PR plus a redeploy rather than a runtime knob.

### AdaptiveCurveIRM-only is enforced, not just documented

The `apy-range` strategy inverts the AdaptiveCurve curve to turn borrow-APY bounds into utilization
bounds. That inversion is only meaningful for markets on the canonical AdaptiveCurveIRM. A market
on a foreign IRM has no `rateAtTarget` (the lens yields `0`), and feeding `rateAtTarget = 0n`
into `AdaptiveCurveIrmLib.getUtilizationAtBorrowRate` returns WAD for **every** rate — so both APY
bounds collapse to WAD, the market always reads "below range", and the strategy would withdraw the
vault's entire position out of it with perfectly valid, simulation-passing calldata.

`src/vault-data.ts` therefore classifies each market against
`getChainAddresses(chainId).adaptiveCurveIrm` — belt-and-suspenders, it also requires a non-zero
`rateAtTarget` — and `apy-range` excludes non-AdaptiveCurve markets from **both** the withdraw and
the deposit leg. `equalize-utilizations` is utilization-only, so it keeps them.

### The target clamp never changes a leg's direction

No target utilization above `MAX_TARGET_UTILIZATION` (99.9%, `src/math.ts`) is ever sized against. A
target of exactly WAD sizes a withdrawal to a market's entire free liquidity (S − B), which reverts on
the first wei of accrual between snapshot and mining — and the AdaptiveCurve inverse legitimately
returns WAD bounds on cold markets (any requested rate ≥ 4·`rateAtTarget`).

Clamping alone is not enough, because it can move the target across current utilization. A market at
99.95% whose raw lower bound is ≥WAD is intended to be _withdrawn from_; compared against the clamped
99.9% target it reads "above target" and would emit a _deposit_ — a plan that pushes liquidity into
exactly the market the strategy wanted to leave. Two mechanical rules resolve it, with no policy
judgment and no market-level skip:

1. **Side from intent, size from the clamp.** A classifier decides withdraw-vs-deposit on its raw
   bound and reports it as `MarketTarget.intent`; the reconciler sizes that side against the clamped
   target. `reconcile.ts` keeps its own `min(..., MAX_TARGET_UTILIZATION)` as an inert backstop.
2. **An empty-or-backwards move is no move.** If intent says withdraw but utilization is already at or
   above the clamped target (or intent says deposit and it is at or below), no candidate is emitted
   for that market this pass. This generalizes the pre-existing at-target skip to the whole wrong-side
   span. It is explicitly _not_ a degenerate-market policy skip: a dead cold market is still exited in
   full whenever its utilization sits below 99.9%.

`clearsMinDelta` is a **function of the realized move**, not a precomputed flag: for each surviving leg
the reconciler derives `u' = B·WAD/(S − take)` (withdraw) or `B·WAD/(S + take)` (deposit) from the take
that survived budget trimming, and the classifier judges that in its own units (`apy-range` in APY bips
off the curve, `equalize-utilizations` in utilization bips). A full-size take reproduces the effective
(clamped) target exactly, so this only ever removes false positives: the unclamped bound would
over-report the APY delta, and a flag carried through trimming would let a 1-wei fragment fire a
transaction worth less than its gas. Corollary: a market with no borrows cannot move its own
utilization, so a withdrawal from one only ships alongside a leg that clears on its own.

### One concurrent pass, with mutex-serialized submits

A pass processes every whitelisted vault concurrently (`Promise.all` over per-vault `tryCatch`), so it costs the slowest
vault rather than the sum. That makes simultaneous submits normal rather than exceptional, and two
races in the shared runtime became reachable: bot-kit's signer claimed nonces with
`nextNonce ??= await readPendingNonce()` — a null check that precedes its own await — and the pending
queue's empty-queue `syncNonce` could rewind the cursor past a send already in flight. Either way two
vaults get one nonce, the second broadcast is replacement-underpriced, and the abort latch wedges.

bot-kit now serializes the queue's whole nonce-critical section (latch checks → `syncNonce` → `send` →
tracking) through a viem-dlc `createCoalescingMutex()`, used purely for serialization — one mutex per
queue, one fixed resource key, `collectFollowers` never called. Reusing that primitive rather than
writing a lock was deliberate. The `pending.size === 0` test sits inside the lock, which is what
actually closes the rewind. A handler that throws rejects only its own caller and the mutex proceeds to
the next queued one, so `TxSendError` still surfaces to its caller without holding the lock.

### One billed call per vault per pass: a deployless lens

`fetchAccrualVault` fans out per-market reads — roughly 55–65 billed JSON-RPC calls for a 10-market
vault, every pass, per vault. JSON-RPC batching would have collapsed the latency but not the bill: a
provider still meters N calls in a batch. So the read moved to a soltag deployless lens
(`src/state/lens.sol.ts`), modelled directly on `bots/blue-liquidation`: one `eth_call` returns the
vault's roles, its withdraw queue, and per market the params, accrued state, position, cap, and
`rateAtTarget`.

Three consequences worth recording:

- **Accrual is on-chain.** The lens calls `Morpho.accrueInterest(marketParams)` inside the simulation
  before reading each market, so the totals _and_ the IRM's stored `rateAtTarget` are the market's
  exact state at the pinned block. The previous client-side `accrueInterest(timestamp)` — and the
  `getBlock` needed to source that timestamp — are gone. This makes the entrypoint `nonpayable`; the
  writes never leave the `eth_call`, and since `stateMutability` is part of neither the selector nor
  the encoding, the read path relabels that one ABI item `view` for typing only.
- **Role data joins the snapshot.** `isAllocator(eoa)` is read in the same call, so the tick's separate
  read and its `Promise.all` with the fetch are gone, and a whitelisted vault the EOA cannot reallocate
  costs one call rather than a full fan-out.
- **Equivalence is the evidence.** `scripts/probe-live-lens.ts` reads a real vault through the lens at a
  pinned block and re-reads that same block through the `fetchAccrualVault` path it replaced, diffing
  every field. Both sides are pinned to the same block and the SDK side accrued to that block's
  timestamp, which makes the comparison exact rather than approximate.

### Testing and ramp-up

Coverage is pure unit tests over both strategies (including the clamp corner cases above), the IRM
math, config and strategy-config resolution, revert decoding, the startup vault checks, the interval
gate, the lens's compile/ABI-decode surface, and a dependency-injected tick. There is no anvil fork
suite yet (unlike the liquidators). The lens instead carries its own live evidence — the
`probe:lens` field-by-field equivalence run described above. Beyond that, **every new deployment
starts with `DRY_RUN=true`**, which runs
the full live read → strategy → encode → simulate path and logs each would-be transaction as
`reallocation.dry_run` without submitting. An operator flips `DRY_RUN=false` once the dry-run stream
looks right for that vault set.

### Deployment: a reference bot, not a Morpho-operated service

Morpho is not a curator, so it publishes this bot open source rather than running it. The bot keeps
its full per-bot operator surface — `README.md`, `Dockerfile`, `docker-compose.yml`,
`scripts/deploy-railway.ts` — as a worked example for third-party operators, but it is deliberately
**not** registered in the repo's CI deploy pipeline (`deploy-staging.yml` / `deploy-production.yml`
/ `deploy-bot.yml`). Wiring it in without backing Railway services and GitHub Environments would
fail the staging job on every merge to main; wiring it in _with_ them would make Morpho the
operator. Registering the bot in CI is a deliberate future step for whoever chooses to operate it
from a fork of this repo.

## Considered Alternatives

### Alternative 1: Keep the bot in its own repository

Leave `morpho-blue-reallocation-bot` standalone and adopt bot-kit patterns by hand.

**Why rejected:** it would keep forking the runtime — queue, signer, policy guard, logging — that
`@repo/bot-kit` already owns. Two implementations of the submission path
is exactly the divergence this monorepo exists to prevent.

### Alternative 2: Port the old repo's hexagonal ports/adapters layering

Carry over the domain/ports/adapters split as-is.

**Why rejected:** the entire bot is ~1.2k LOC of read → pure strategy → simulate → submit. The
indirection obscured the one property that actually matters — that the strategy is a pure function
of a block-pinned snapshot — and it does not match the flat shape every other bot here uses.

## Assumptions & Constraints

- `apy-range` is only correct on markets whose IRM is the chain's canonical AdaptiveCurveIRM; this
  is enforced in `vault-data.ts`, not merely assumed.
- The bot's EOA satisfies MetaMorpho's `onlyAllocatorRole` — it is in the allocator set, or is the
  vault's curator or owner. A missing role is reported (`allocator.missing_role`) and the vault is
  skipped, not retried into failure. This allocator-or-curator-or-owner widening is a Vault V1
  semantic only: `VaultV2.allocate` requires strict `isAllocator[msg.sender]`, so the Vault V2 bot
  keeps a narrow `isAllocator` gate.
- **A market pinned at ~100% utilization reads as "APY too high" and therefore attracts deposits.**
  This is accepted behavior — the strategy is a policy function of borrow APY, and special-casing
  saturation would make the policy harder to reason about than the occasional deposit into a hot
  market.
- **The bot owns allocations between curator actions.** It does not coordinate with manual curator
  reallocations; the in-flight skip plus the settled cooldown bound how stale a mined reallocation
  can be relative to the snapshot it was computed from.
- Vault whitelists, strategy selection, and thresholds are deploy-time configuration; changing them
  requires a redeploy.
- One process per chain; the operator funds the EOA with native gas.

## Dependencies

- `@morpho-org/blue-sdk` — `MathLib`, `AdaptiveCurveIrmLib`, `getChainAddresses`.
- `@morpho-org/blue-sdk-viem` — `metaMorphoAbi`, `MetaMorphoAction.reallocate` (plus
  `fetchAccrualVault`, now only in the `probe:lens` equivalence check).
- `soltag` + `solc` — build-time compilation of the inline `sol``` lens; the bot ships a bundle with
  literal ABI/bytecode and runs no transform at runtime.
- `@repo/utils` — `readDeploylessBatchLens`, `wholePercentToWAD`, `tryCatch`.
- `@repo/bot-kit` (workspace) — clients, logger, block watcher + runner, pending-tx queue, signing
  policy (with `Policy.targets` in place of the single-Executor field), simulation, revert decoding,
  balance metric.
- BetterStack shipping and the heartbeat are opt-in env knobs; the repo's CI deploy pipeline is
  deliberately not a dependency (see Deployment above).

## Observability

Bot-specific events: `startup`, `allocator.missing_role`, `reallocation.found`,
`reallocation.sim_revert`, `reallocation.dry_run`, `reallocation.not_broadcast` (debug),
`vault.inflight` (debug), `market.non_adaptive_curve` (debug), `vault.error`, and a
per-pass `tick.end` counters line — `vaults`, `skipped_inflight`, `missing_role`,
`reallocations_found`, `sim_reverts`, `dry_runs`, `submitted`, `errors`, `duration_ms`.

These ride on top of the shared bot-kit events (`tx.*`, `signer.balance`, `block.new`), so the
existing BetterStack transaction and balance panels work unchanged.

## Security

- The signing policy is the trust boundary: value-0, `reallocate` selector, fee/gas/size ceilings,
  and target ∈ the configured vault set. Moving from one Executor to a target list preserves
  default-deny.
- `REALLOCATOR_PRIVATE_KEY` is read from env once at startup; never logged or persisted.
- Curator policy is code, not runtime input — a threshold change is a reviewed PR.
- `DRY_RUN` default-on for new deployments limits the blast radius of a misconfigured whitelist or
  policy table to log lines.

## Future Considerations

- An anvil fork suite covering `reallocate` end-to-end against a real MetaMorpho vault, matching
  the liquidators' `test/fork/` coverage.
- Populating the per-vault / per-market policy tables as curators opt in.
- Vault V2 support as a separate decision.

## References

- [TIB-2026-07-16: Revert to bots-as-programs](./TIB-2026-07-16-revert-to-bots-as-programs.md) —
  the architecture this bot was migrated onto.
- Upstream repository: `https://github.com/morpho-org/morpho-blue-reallocation-bot`.
- PR: `https://github.com/morpho-org/morpho-bots/pull/165`.

<!--
TIB conventions:
- Once accepted, do not substantively edit this TIB. If the decision needs to change,
  create a new TIB that supersedes this one and update the Status/Superseded by fields.
- Addenda may be appended to record operational updates that affect
  how the TIB is applied without changing the decision itself.
- TIB identifiers use CalVer (YYYY-MM-DD) based on the date the TIB was first drafted.
-->
