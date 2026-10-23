# vault-v2-reallocation

Reallocates liquidity between the Morpho Blue Markets of whitelisted Morpho Vault V2 Vaults (via
each vault's MorphoMarketV1 adapter), migrated from the standalone
[vault-v2-reallocation-bot](https://github.com/morpho-org/vault-v2-reallocation-bot) repo and built
on the bot framework ([`framework/`](../../framework/)). Sibling of [vault-v1-reallocation](../vault-v1-reallocation).

> **Reference bot — not operated by Morpho.** Morpho is not a curator and publishes this bot as
> open source for curators to run themselves. It is not wired into this repo's CI deploy pipeline;
> the Dockerfile and compose file below are worked examples of a deployment, not a managed service.

**Whitelisting a vault is production-active**: once a vault is in `VAULT_WHITELIST` (and `DRY_RUN`
is off), the bot continuously manages its allocations under the strategy's defaults — the
vault-wide `equalize-utilizations` target unless `STRATEGY`/[src/strategy-config.ts](./src/strategy-config.ts)
say otherwise. There is no further per-vault opt-in.

## Architecture

The bot is one graph on the bot framework (`framework/`). Its `src/` root is the
framework skeleton: `graph.ts` declares the graph, `run.ts` starts it, `kernel.ts` loads the
reallocator's key and builds its kernel, `report.ts` writes the operator log, `sources.ts` reads
each whitelisted vault at the kernel's head, and `prepare.ts` encodes and simulates one
reallocation. `encode.ts` builds the adapter calldata. Around them:

- `strategies/` — the pure strategies; `reallocation.ts` turns a strategy's answer into legs and
  evidence, and `math.ts` holds the shared math.
- `state/` — the deployless lens; `vault-data.ts` and `vault-checks.ts` read a vault and check it
  at startup.
- `strategy-config.ts` and `stats.ts` — per-vault overrides and per-tick counters.

## How it works

One long-running process per chain, built as one engine graph whose kernel is the only code that
uses the key. The whitelist is read at the kernel's first head and then at the first head after each
`REALLOCATION_INTERVAL_MS` (default 10 min); each vault is its own key, so one vault's reallocation
never waits on another's. Per read, per whitelisted vault:

1. Fetch a snapshot pinned to the kernel head's block hash in **one** `eth_call` via the deployless lens in
   [src/state/lens.sol.ts](./src/state/lens.sol.ts): the VaultV2 factory identity, the EOA's
   `isAllocator` bit, the idle balance, the (factory-classified) adapter set, the accrued
   `totalAssets`, and per market the params, accrued Blue state, the adapter's position,
   `rateAtTarget`, and the `absoluteCap`/`relativeCap`/`allocation` triple for the market,
   collateral, and adapter cap ids. The lens projects each market's accrual read-only (as
   `MorphoBalancesLib.expectedMarketBalances` does, without calling the state-changing
   `Morpho.accrueInterest`), and `totalAssets()` is VaultV2's own view accrual, so the numbers are
   the state each market would hold once accrued at that block, with no accrual in TypeScript. One vault therefore costs **one billed RPC call per pass**, not the
   ~40–70 the previous `fetchAccrualVaultV2` fan-out + cap multicall billed for a 20-market vault.
   No Morpho API dependency. A vault the lens did not serve, or served in an unsupported shape, is
   failed for that read and keeps its last state.
2. Re-check the snapshot's `isAllocator` bit (`allocator.missing_role` and no act while absent; a
   fresh grant is picked up on the next read), and that the vault's adapter is still the one the
   startup checks resolved (`adapter.changed` and no act until a restart).
3. Run the strategy — a pure function of that snapshot, emitting **exact-amount deltas**
   (`{allocations, deallocations}`). Legs need not balance: surplus deallocations park in the
   vault's idle balance, and allocations may exceed deallocations by up to the idle balance.
   Matching the original bot, a plan only fires when BOTH sides have at least one leg — pure idle
   deployment (all markets above target, nothing to deallocate) does not fire; deploying fresh
   idle is a deliberate follow-up decision, not an accident of this port:
   - **`equalize-utilizations`** (default; what production runs): converge every market to the
     vault-wide average utilization, `Σborrow / (Σsupply + idle)`. Fires only past
     `MIN_UTILIZATION_DELTA_BIPS`.
   - **`apy-range`**: keep each market's borrow APY inside its configured range by inverting the
     AdaptiveCurveIRM curve; deallocation surplus parks in idle only when
     `ALLOW_IDLE_REALLOCATION=true` (allocations always draw on idle). Fires only past
     `MIN_APY_DELTA_BIPS`.
4. Encode ONE `vault.multicall([deallocate…, allocate…])` (deallocations strictly first so idle is
   funded) and simulate those exact bytes from the EOA (or log `reallocation.dry_run` when
   `DRY_RUN=true`, and hand the kernel nothing). A revert or a dry run is tried again on the next
   read.
5. Hand the act to the kernel, which checks it with `@repo/validators`'
   `vaultV2ReallocationValidator`, simulates it again at its own head, signs it through `@repo/kit`'s
   default-deny signer policy, and tracks it to inclusion.

The act rests on the vault's **reallocation fact**: the markets the plan moves and their directions.
Accrual moves every amount between reads without changing it, so only a read in which the strategy
wants something different refuses an act still in flight. A reallocation creates no commitment, so
the kernel's exposure model treats it as neutral; only its gas is reserved.

**All three cap levels are enforced in sizing** — per-market cap ids plus the adapter-level
(`"this"`) and per-collateral cap ids. Headroom is measured from the ACCRUED position (each leg
trues `allocation(id)` up to it before the contract's cap check; the aggregate pools add every
market's accrual drift on top of the stored allocation), a relative cap of exactly WAD is honored
as the contract's no-constraint sentinel, and capacity freed by the plan's own deallocations
(executed first) is credited back. A 99.99% buffer absorbs accrual between read and mined
execution. A binding aggregate cap shrinks the plan instead of producing a sim-revert loop.

Every strategy target is additionally clamped to a **99.9% utilization ceiling**
(`MAX_TARGET_UTILIZATION`): a target at/above 100% (a degenerate AdaptiveCurveIRM inversion on a
decayed market, or a bad-debt aggregate) would size a deallocation to the market's entire free
liquidity — exact to the snapshot and unrealizable one accrual later. The clamp changes a leg's
size, never its side: a move the clamp leaves empty or backwards is dropped, and the min-delta
gates measure the utilization each TRIMMED leg actually realizes — a clearing move cut to a
fragment by the budget or the cap pools cannot arm a plan. One corollary: a withdrawal out of a
zero-borrow market realizes no utilization change, so an empty-market exit only ships alongside a
leg that clears the threshold on its own merits.

Signing is default-deny in depth. The signer policy admits only value-0 `multicall(bytes[])` calls to
whitelisted vaults. The kernel's `vaultV2ReallocationValidator` then decodes every inner call exactly:
each must be a `deallocate` or `allocate` (deallocations first) naming that vault's adapter and one
market the adapter holds, and replaying the legs against the read must keep every allocation within
its market, collateral and adapter caps. Anything it cannot decode, including a nested call, is
refused.

Assumptions and posture:

- **Exactly one Morpho Blue Market adapter per vault** (either adapter-contract generation,
  `MorphoMarketV1Adapter` or `MorphoMarketV1AdapterV2` — live vaults use the latter) — startup and
  every fetch fail loud otherwise. `forceDeallocate`, liquidity adapters, gates, and Vault V1
  (VaultV1) adapters are out of scope.
- **The adapter's onchain market list is the candidate set.** The original adapter generation
  removes a market from its list when its allocation hits zero, so a fully-deallocated market
  cannot be re-entered by this bot until some allocator supplies it again — size deallocations
  accordingly (the strategies never fully exit a market on their own; only the vault-wide target
  math can drive a position to zero).
- **AdaptiveCurveIRM only**: the `apy-range` math assumes every market uses the canonical
  AdaptiveCurveIRM.
- **Relative-cap staleness**: relative headroom moves with `totalAssets` between read and mine;
  the cap buffer and the kernel's exact-bytes simulation bound the drift.
- **The bot owns allocations between curator actions**: a replacement re-broadcasts the same calldata
  on fee bumps, and an act rests on the read it was decided on.
- The kernel's ledger under `KERNEL_STATE_DIR` survives a restart; everything else is in memory.

## Prerequisites

- The EOA behind `REALLOCATOR_PRIVATE_KEY` must hold the **allocator role** on every whitelisted
  vault. The bot only pays gas — reallocation moves vault funds, never the EOA's.
- An RPC endpoint per chain. Supported chains: mainnet (1), Base (8453) — extend `CHAIN_MAP` in
  [src/config.ts](./src/config.ts).

## Configuration

In-container env vars (unsuffixed; the `_<chainId>` suffix is an operator-side convention used by
docker-compose):

| Var                                                       | Required | Default                 | Notes                                                                                                                         |
| --------------------------------------------------------- | -------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `CHAIN_ID`                                                | yes      | —                       | 1 or 8453                                                                                                                     |
| `RPC_URL`                                                 | yes      | —                       | reads, simulation, sends                                                                                                      |
| `RPC_URL_FALLBACK`                                        | no       | —                       | failover endpoint                                                                                                             |
| `MAX_DEPLOYLESS_BATCH_SIZE`                               | no       | —                       | Caps one chunk's `eth_call` data in bytes                                                                                     |
| `REALLOCATOR_PRIVATE_KEY`                                 | yes      | —                       | allocator EOA                                                                                                                 |
| `VAULT_WHITELIST`                                         | yes      | —                       | comma-separated VaultV2 addresses; must be non-empty                                                                          |
| `STRATEGY`                                                | no       | `equalize-utilizations` | or `apy-range`                                                                                                                |
| `REALLOCATION_INTERVAL_MS`                                | no       | `600000`                | min wall-clock ms between passes; at most 604800000 (7 days)                                                                  |
| `MIN_APY_DELTA_BIPS`                                      | no       | `25`                    | strategy-config overrides win                                                                                                 |
| `MIN_UTILIZATION_DELTA_BIPS`                              | no       | `250`                   | strategy-config overrides win                                                                                                 |
| `ALLOW_IDLE_REALLOCATION`                                 | no       | `true`                  | `APY-range` only                                                                                                              |
| `DRY_RUN`                                                 | no       | `false`                 | plan + simulate + log, never submit                                                                                           |
| `MAX_FEE_GWEI`                                            | yes      | —                       | signer policy and kernel fee ceiling                                                                                          |
| `KERNEL_STATE_DIR`                                        | yes      | —                       | kernel ledger directory; must survive a restart                                                                               |
| `KERNEL_ENROLLMENT`                                       | yes      | —                       | `enrolling` on first start, then `enrolled`                                                                                   |
| `FINALITY_<CHAIN_ID>`                                     | yes      | —                       | `safe`, `finalized`, or a positive block depth: the block the kernel treats as final on that chain, e.g. `FINALITY_8453=safe` |
| `BUILD_REVISION` / `BUILD_IMAGE_TAG`                      | yes      | —                       | the source revision and image the journal names; the Dockerfile bakes them in from build args                                 |
| `LOG_LEVEL`                                               | no       | `info`                  | debug/info/warn/error                                                                                                         |
| `BETTERSTACK_SOURCE_TOKEN` / `BETTERSTACK_INGESTING_HOST` | no       | —                       | both set = ship logs                                                                                                          |
| `BETTERSTACK_HEARTBEAT_URL`                               | no       | —                       | 60s heartbeat                                                                                                                 |

Per-vault / per-market APY ranges and min-delta thresholds are **checked-in curator policy** in
[src/strategy-config.ts](./src/strategy-config.ts) (market > vault > env-default precedence). The
tables ship empty; changing policy is a reviewed PR + redeploy.

The pre-migration production posture, for reference (set these at deploy time): mainnet
`VAULT_WHITELIST=0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB,0x8eB67A509616cd6A7c1B3c8C21D48FF57df3d458`
with `REALLOCATION_INTERVAL_MS=900000`; Base
`VAULT_WHITELIST=0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183` with `REALLOCATION_INTERVAL_MS=300000`;
both `equalize-utilizations`.

## Running

```sh
pnpm --filter @morpho-org/vault-v2-reallocation run build
CHAIN_ID=1 RPC_URL=… REALLOCATOR_PRIVATE_KEY=0x… VAULT_WHITELIST=0x… MAX_FEE_GWEI=… \
  FINALITY_1=safe KERNEL_STATE_DIR=./state KERNEL_ENROLLMENT=enrolling \
  BUILD_REVISION=$(git rev-parse HEAD) BUILD_IMAGE_TAG=local \
  pnpm --filter @morpho-org/vault-v2-reallocation run start
```

Or via compose (one service per chain, both defaulting to `DRY_RUN=true`, each with its own
volume for the kernel's ledger):

```sh
cd bots/vault-v2-reallocation && BUILD_REVISION=$(git rev-parse HEAD) docker compose up --build
```

Set `KERNEL_ENROLLMENT_<id>=enrolling` for a chain's first start and `enrolled` for every start
after it, so a lost ledger refuses to start instead of starting blank.

### Ramp-up (recommended)

Start any new deployment with `DRY_RUN=true`: the bot runs the full live read → strategy →
encode → simulate path and logs each would-be transaction as `reallocation.dry_run`, but never
submits. Review a few passes' plans, then flip `DRY_RUN=false`.

## Observability

Structured JSON-lines on stderr, one event per line, with `bot`/`chainId` (and Railway identity)
stamped on every line. Key events: `startup`, `allocator.missing_role`, `reallocation.found`
(per-leg direction/collateral/lltv/assets), `reallocation.sim_revert`, `reallocation.dry_run`,
`reallocation.not_broadcast` (an act that ended without a send), `adapter.changed`, `vault.error`,
per-read `tick.end` counters (`blockNumber`, `vaults`, `skipped_inflight`, `missing_role`,
`adapter_changed`, `reallocations_found`, `sim_reverts`, `dry_runs`, `broadcast`, `errors`), the framework's `act.submitted` / `act.dropped` / `backoff.*` / `kernel.*` events,
and the `tx.*` / `signer.balance` events. Preparations and sends finish after the read that started
them, so `sim_reverts`, `dry_runs` and `broadcast` count what finished since the previous
`tick.end`. BetterStack shipping and heartbeat are opt-in via the env vars above.

Names that changed with the framework port, for queries written against the earlier bot:
`tx.confirmed` is now `tx.included`; the `tx.*` fee fields `maxFee` and `priority` are now
`maxFeePerGasWei` and `priorityFeePerGasWei`; `tick.end`'s `submitted` is now `broadcast`, and it no longer carries `duration_ms`. The
queue-only events `tx.replace_failed`, `tx.send_aborted`, `tx.observer_failed` and
`tx.onblock_error` are gone.

Every `tx.*` and `act.*` line identifies its vault under `id`: the **vault address, checksummed**,
which also joins to this bot's own events keyed on `vault`.

## Testing

```sh
pnpm vitest run --project vault-v2-reallocation
```

Pure unit tests cover both strategies (delta output, idle folding/top-up, three-level cap pools),
the cap/IRM math, multicall encoding (decode round-trip incl. leg ordering), config loading,
strategy-config resolution, revert decoding, lens-row shaping/validation, and the reallocation
decision; the validator's conformance suite lives in `@repo/validators`. Scenario tests in
`test/scenario/` run the whole graph against a fake kernel chain. The fork suite needs
`RPC_URL_8453`. Two live checks stand in for a full fork run:

```sh
# Reads the lens against a real vault at a pinned block, then re-reads the same block through the
# fetchAccrualVaultV2 + cap-multicall path it replaced and diffs every field (markets paired by id,
# in-Solidity cap ids checked against the SDK's derivations).
RPC_URL=… CHAIN_ID=8453 VAULT=0x… \
  pnpm --filter @morpho-org/vault-v2-reallocation run probe:lens
```

and `DRY_RUN` against a live RPC for the full read → strategy → simulate path. Known live-evidence
gap: every live vault runs `MorphoMarketV1AdapterV2`, so the lens's original-generation
(`marketParamsList`) branch has no live counterpart — it mirrors the SDK's exact call sequence and
is exercised at the TS layer only.
