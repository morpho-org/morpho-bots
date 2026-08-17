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
  vault-data.ts       // fetchAccrualVault → block-pinned snapshot; IRM classification
  math.ts             // utilization / withdrawable / depositable / apy⇄rate glue
  market.utils.ts     // idle-market predicate
  strategies/         // apy-range | equalize-utilizations (pure)
  runner/tick.ts      // one pass: read → strategy → encode → simulate → submit
  index.ts, *.error.ts
```

The whole bot is ~1.2k LOC of read → pure strategy → simulate → submit. Each tick reads a
block-pinned vault snapshot, runs the configured strategy as a pure function of that snapshot,
encodes a `reallocate`, simulates it, and submits only sim-ok transactions through the queue.

### SDK-first math

All Blue and IRM math comes from `@morpho-org/blue-sdk` (`MathLib`, `AdaptiveCurveIrmLib`, `getChainAddresses`), and all reads from `@morpho-org/blue-sdk-viem` (`fetchAccrualVault`,
`metaMorphoAbi`, `MetaMorphoAction.reallocate`). Nothing re-derives the adaptive curve or
hand-rolls vault/market reads. The only local math (`src/math.ts`) is the thin glue with no SDK
counterpart: `getUtilization`, `getWithdrawableAmount`, `getDepositableAmount`, and
`apyToRate` / `rateToApy`.

### `Policy.executor` widened to a target list

bot-kit's default-deny signing policy previously authorized a single Executor address per bot. This
bot legitimately targets N whitelisted vaults, so `Policy.executor` (`packages/bot-kit/src/policy.ts`)
became a list with a membership check. The invariant is unchanged: a transaction is signable only
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
on a foreign IRM has no `rateAtTarget` (the SDK yields `undefined`), and feeding `rateAtTarget = 0n`
into `AdaptiveCurveIrmLib.getUtilizationAtBorrowRate` returns WAD for **every** rate — so both APY
bounds collapse to WAD, the market always reads "below range", and the strategy would withdraw the
vault's entire position out of it with perfectly valid, simulation-passing calldata.

`src/vault-data.ts` therefore classifies each market against
`getChainAddresses(chainId).adaptiveCurveIrm` — belt-and-suspenders, it also requires a non-zero
`rateAtTarget` — and `apy-range` excludes non-AdaptiveCurve markets from **both** the withdraw and
the deposit leg. `equalize-utilizations` is utilization-only, so it keeps them.

### Testing and ramp-up

Coverage is pure unit tests over both strategies, the IRM math, config and strategy-config
resolution, revert decoding, and a dependency-injected tick. There is no anvil fork suite yet
(unlike the liquidators). Instead, **every new deployment starts with `DRY_RUN=true`**, which runs
the full live read → strategy → encode → simulate path and logs each would-be transaction as
`reallocation.dry_run` without submitting. An operator flips `DRY_RUN=false` once the dry-run stream
looks right for that vault set.

## Considered Alternatives

### Alternative 1: Keep the bot in its own repository

Leave `morpho-blue-reallocation-bot` standalone and adopt bot-kit patterns by hand.

**Why rejected:** it would keep forking the runtime — queue, signer, policy guard, logging — that
`@repo/bot-kit` already owns, and the operator surface it needs (CI deploy, Railway provisioning,
BetterStack sources and dashboards) is repo-wide here. Two implementations of the submission path
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
  skipped, not retried into failure.
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
- `@morpho-org/blue-sdk-viem` — `fetchAccrualVault`, `metaMorphoAbi`, `MetaMorphoAction.reallocate`.
- `@repo/bot-kit` (workspace) — clients, logger, block watcher + runner, pending-tx queue, signing
  policy (with the widened `Policy.executor`), simulation, revert decoding, balance metric.
- Repo-wide operator surface: the CI deploy pipeline, Railway, BetterStack.

## Observability

Bot-specific events: `startup`, `allocator.missing_role`, `reallocation.found`,
`reallocation.sim_revert`, `reallocation.dry_run`, `vault.inflight` (debug),
`market.non_adaptive_curve` (debug), `vault.error`, and a
per-pass `tick.end` counters line — `vaults`, `skipped_inflight`, `missing_role`,
`reallocations_found`, `sim_reverts`, `dry_runs`, `submitted`, `errors`, `duration_ms`.

These ride on top of the shared bot-kit events (`tx.*`, `signer.balance`, `block.new`), so the
existing BetterStack transaction and balance panels work unchanged.

## Security

- The signing policy is the trust boundary: value-0, `reallocate` selector, fee/gas/size ceilings,
  and target ∈ the configured vault set. The list widening preserves default-deny.
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
