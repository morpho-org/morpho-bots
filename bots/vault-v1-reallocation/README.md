# vault-v1-reallocation

Reallocates liquidity between the Morpho Blue Markets of whitelisted Vault V1 Vaults,
migrated from the standalone
[morpho-blue-reallocation-bot](https://github.com/morpho-org/morpho-blue-reallocation-bot) repo and
built on the bot framework ([`framework/`](../../framework/)).

> **Reference bot — not operated by Morpho.** Morpho is not a curator and publishes this bot as
> open source for curators to run themselves. It is not wired into this repo's CI deploy pipeline;
> the Dockerfile and compose file below are worked examples of a deployment, not a managed service.

**Whitelisting a vault is production-active**: once a vault is in `VAULT_WHITELIST` (and `DRY_RUN`
is off), the bot continuously manages its allocations under the strategy's defaults — the global
3–8% APY range unless [src/strategy-config.ts](./src/strategy-config.ts) overrides it. There is no
further per-vault opt-in.

## Architecture

The bot is one graph on the bot framework (`framework/`). Its `src/` root is the
framework skeleton: `graph.ts` declares the graph, `run.ts` starts it, `kernel.ts` loads the
reallocator's key and builds its kernel, `report.ts` writes the operator log, `sources.ts` reads
each whitelisted vault at the kernel's head, and `prepare.ts` encodes and simulates one
reallocation. Around them:

- `strategies/` — the pure strategies; `reallocation.ts` turns a strategy's answer into legs and
  evidence, and `math.ts` holds the shared math.
- `state/` — the deployless lens; `vault-data.ts` and `vault-checks.ts` read a vault and check it
  at startup.
- `strategy-config.ts` and `stats.ts` — per-vault overrides and per-tick counters.

## How it works

One long-running process per chain, built as one engine graph whose kernel is the only code that
uses the key. The whitelist is read at the kernel's first head and then at the first head after each
`REALLOCATION_INTERVAL_MS` (default 10 min); each vault is its own key, so one vault's reallocation
never waits on another's:

1. Read every vault in **one** `eth_call` via the deployless lens in
   [src/state/lens.sol.ts](./src/state/lens.sol.ts), pinned to the kernel head's block hash: the
   vault's `owner` / `curator` / `isAllocator(eoa)`, its withdraw queue, and per market the params,
   accrued Blue state, the vault's position, the cap, and `rateAtTarget`. A vault the lens did not
   serve is failed for that read and keeps its last state; only a read that served every vault
   vouches for the whole whitelist.
2. Re-check that the EOA still satisfies `onlyAllocatorRole` from the same read
   (`allocator.missing_role` and no act while absent; a fresh grant is picked up on the next read).
3. Run the strategy, a pure function of that read:
   - **`apy-range`** (default): keep each market's borrow APY inside its configured range by
     inverting the AdaptiveCurveIRM curve; the idle market absorbs or supplies the imbalance
     (`ALLOW_IDLE_REALLOCATION`). Fires only when some market's implied APY move exceeds
     `MIN_APY_DELTA_BIPS`.
   - **`equalize-utilizations`**: converge every non-idle market to the vault-wide average
     utilization; fires only past `MIN_UTILIZATION_DELTA_BIPS`.
4. Encode `reallocate(...)` from that read and simulate the exact bytes from the EOA (or log
   `reallocation.dry_run` when `DRY_RUN=true`, and hand the kernel nothing). A revert or a dry run
   is tried again on the next read.
5. Hand the act to the kernel, which checks it with `@repo/validators`'
   `vaultV1ReallocationValidator` (exact `reallocate` calldata to a whitelisted vault, only markets in
   its withdraw queue, no deposit past a cap), simulates it again at its own head, signs it through
   `@repo/kit`'s default-deny signer policy, and tracks it to inclusion.

The act rests on the vault's **reallocation fact**: the markets the reallocation moves and their
directions. Accrual moves every amount between reads without changing it, so only a read in which the
strategy wants something different refuses an act still in flight. A reallocation creates no
commitment, so the kernel's exposure model treats it as neutral; only its gas is reserved.

Deposit legs stop at 99.99% of each market's supply cap (`CAP_BUFFER_WAD` in
[src/math.ts](./src/math.ts), not an env var) so interest accrual between read and mined execution
can't push a leg over cap. Withdrawals are listed first and the last deposit leg is
`maxUint256`, per `MetaMorpho.reallocate` semantics.

No leg ever targets a utilization above `MAX_TARGET_UTILIZATION` (99.9%, also in
[src/math.ts](./src/math.ts)). A target of exactly 100% sizes a withdrawal to a market's entire free
liquidity (S − B), which reverts on the first wei of accrual — and the AdaptiveCurve inverse
legitimately returns 100% bounds for any requested APY at or above 4·`rateAtTarget`, i.e. on cold
markets. Two rules keep that cap from distorting a plan:

- The **side** of a market's move comes from the strategy's raw (unclamped) bound; only the **size**
  uses the clamped target. Re-deriving the side from the clamped target would flip a market sitting
  between 99.9% and 100% from the intended withdrawal into a deposit.
- A move that the clamp leaves empty or backwards is simply **not emitted** — no leg for that market
  this pass. This is a per-leg rule, not a market-level skip: a dead cold market is still exited in
  full whenever its utilization is below 99.9%.

The min-delta firing thresholds are measured on the move each leg **realizes**: the reconciler derives
the post-move utilization from the take that survived budget trimming and asks the strategy to judge
that, so neither a leg trimmed away nor one trimmed down to a fragment can arm a plan on its full-size
promise. A withdrawal from a market with no borrows moves no rate at all, so such a leg needs a
counterpart that clears the threshold on its own.

Assumptions and posture:

- **AdaptiveCurveIRM only, enforced**: the `apy-range` math needs a real `rateAtTarget` to invert the
  curve, so markets not on the chain's canonical AdaptiveCurveIRM are excluded from both legs (logged
  as `market.non_adaptive_curve`). `equalize-utilizations` is utilization-only and keeps them.
- **A market pinned at ~100% utilization reads as "APY too high"** and therefore attracts deposits.
  That is the intended direction (fresh supply is exactly what an exhausted market needs), so it is
  documented rather than special-cased.
- **The bot owns allocations between curator actions**: a replacement re-broadcasts the same calldata
  on fee bumps, and an act rests on the read it was decided on; curators changing queues or caps
  mid-flight should expect the bot to re-derive and follow on the next read.
- The kernel's ledger under `KERNEL_STATE_DIR` survives a restart; everything else is in memory.

## Prerequisites

- The EOA behind `REALLOCATOR_PRIVATE_KEY` must satisfy `onlyAllocatorRole` on every whitelisted
  vault — i.e. be in the **allocator set**, or be the vault's **curator** or **owner**. All three are
  accepted by the startup probe and the per-pass re-check. The bot only pays gas — reallocation moves
  vault funds, never the EOA's. A whitelisted vault the EOA cannot reallocate is cheap to leave in
  place: the role now rides the same single lens call as the snapshot, so such a vault costs one RPC
  call per pass and a warning line.
- An RPC endpoint per chain. Supported chains: mainnet (1), Base (8453) — extend `CHAIN_MAP` in
  [src/config.ts](./src/config.ts).

## Configuration

In-container env vars are unsuffixed. The `_<chainId>` suffix is an operator-side convention used by
docker-compose, and it covers every per-chain input: `RPC_URL_<id>`,
`RPC_URL_FALLBACK_<id>`, `VAULT_WHITELIST_<id>`, `MAX_FEE_GWEI_<id>`, `KERNEL_ENROLLMENT_<id>`,
`STRATEGY_<id>`, `DRY_RUN_<id>`,
`BETTERSTACK_HEARTBEAT_URL_<id>`, and the four tuning knobs `REALLOCATION_INTERVAL_MS_<id>`,
`MIN_APY_DELTA_BIPS_<id>`, `MIN_UTILIZATION_DELTA_BIPS_<id>`, `ALLOW_IDLE_REALLOCATION_<id>` — so chains can be tuned independently. `REALLOCATOR_PRIVATE_KEY` is shared, unsuffixed.

| Var                                                       | Required | Default     | Notes                                                                                                                         |
| --------------------------------------------------------- | -------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `CHAIN_ID`                                                | yes      | —           | 1 or 8453                                                                                                                     |
| `RPC_URL`                                                 | yes      | —           | reads, simulation, sends                                                                                                      |
| `RPC_URL_FALLBACK`                                        | no       | —           | failover endpoint                                                                                                             |
| `MAX_DEPLOYLESS_BATCH_SIZE`                               | no       | —           | Caps one chunk's `eth_call` data in bytes                                                                                     |
| `REALLOCATOR_PRIVATE_KEY`                                 | yes      | —           | allocator EOA                                                                                                                 |
| `VAULT_WHITELIST`                                         | yes      | —           | comma-separated vault addresses; deduplicated, non-empty                                                                      |
| `STRATEGY`                                                | no       | `apy-range` | or `equalize-utilizations`                                                                                                    |
| `REALLOCATION_INTERVAL_MS`                                | no       | `600000`    | min wall-clock ms between passes; at most 604800000 (7 days)                                                                  |
| `MIN_APY_DELTA_BIPS`                                      | no       | `25`        | strategy-config overrides win                                                                                                 |
| `MIN_UTILIZATION_DELTA_BIPS`                              | no       | `250`       | strategy-config overrides win                                                                                                 |
| `ALLOW_IDLE_REALLOCATION`                                 | no       | `true`      | `APY-range` only                                                                                                              |
| `DRY_RUN`                                                 | no       | `false`     | plan + simulate + log, never submit                                                                                           |
| `MAX_FEE_GWEI`                                            | yes      | —           | signer policy and kernel fee ceiling                                                                                          |
| `KERNEL_STATE_DIR`                                        | yes      | —           | kernel ledger directory; must survive a restart                                                                               |
| `KERNEL_ENROLLMENT`                                       | yes      | —           | `enrolling` on an account's first start, then `enrolled`                                                                      |
| `FINALITY_<CHAIN_ID>`                                     | yes      | —           | `safe`, `finalized`, or a positive block depth: the block the kernel treats as final on that chain, e.g. `FINALITY_8453=safe` |
| `BUILD_REVISION` / `BUILD_IMAGE_TAG`                      | yes      | —           | the source revision and image the journal names; the Dockerfile bakes them in from build args                                 |
| `LOG_LEVEL`                                               | no       | `info`      | debug/info/warn/error                                                                                                         |
| `BETTERSTACK_SOURCE_TOKEN` / `BETTERSTACK_INGESTING_HOST` | no       | —           | both set = ship logs                                                                                                          |
| `BETTERSTACK_HEARTBEAT_URL`                               | no       | —           | 60s heartbeat                                                                                                                 |

Per-vault / per-market APY ranges and min-delta thresholds are **checked-in curator policy** in
[src/strategy-config.ts](./src/strategy-config.ts) (market > vault > env-default precedence).
The tables ship empty; changing policy is a reviewed PR + redeploy.

## Running

```sh
pnpm --filter @morpho-org/vault-v1-reallocation run build
CHAIN_ID=8453 RPC_URL=… REALLOCATOR_PRIVATE_KEY=0x… VAULT_WHITELIST=0x… MAX_FEE_GWEI=… \
  FINALITY_8453=safe KERNEL_STATE_DIR=./state KERNEL_ENROLLMENT=enrolling \
  BUILD_REVISION=$(git rev-parse HEAD) BUILD_IMAGE_TAG=local \
  pnpm --filter @morpho-org/vault-v1-reallocation run start
```

Or via compose (one service per chain, both defaulting to `DRY_RUN=true`, each with its own
volume for the kernel's ledger):

```sh
cd bots/vault-v1-reallocation && BUILD_REVISION=$(git rev-parse HEAD) docker compose up --build
```

Set `KERNEL_ENROLLMENT_<id>=enrolling` for a chain's first start and `enrolled` for every start
after it, so a lost ledger refuses to start instead of starting blank.

### Ramp-up (recommended)

Start any new deployment with `DRY_RUN=true`: the bot runs the full live read → strategy →
encode → simulate path and logs each would-be transaction as `reallocation.dry_run`, but never
submits. Review a few passes' plans, then flip `DRY_RUN=false`.

## Observability

Structured JSON-lines on stderr, one event per line, with `bot`/`chainId` (and Railway identity)
stamped on every line. Key events: `startup`, `allocator.missing_role`, `vault.inflight` (debug),
`market.non_adaptive_curve` (debug), `reallocation.found`, `reallocation.sim_revert`,
`reallocation.dry_run`, `reallocation.not_broadcast` (an act that ended without a send), `vault.error`,
per-read `tick.end` counters (`blockNumber`, `vaults`, `skipped_inflight`, `missing_role`,
`reallocations_found`, `sim_reverts`, `dry_runs`, `broadcast`, `errors`), the
framework's `act.submitted` / `act.dropped` / `backoff.*` / `kernel.*` events, and the `tx.*` /
`signer.balance` events. Preparations and sends finish after the read that started them, so
`sim_reverts`, `dry_runs` and `broadcast` count what finished since the previous `tick.end`.
BetterStack shipping and heartbeat are opt-in via the env vars above.

Names that changed with the framework port, for queries written against the earlier bot:
`tx.confirmed` is now `tx.included`; the `tx.*` fee fields `maxFee` and `priority` are now
`maxFeePerGasWei` and `priorityFeePerGasWei`; `tick.end`'s `submitted` is now `broadcast`, and it no longer carries `duration_ms`. The
queue-only events `tx.replace_failed`, `tx.send_aborted`, `tx.observer_failed` and
`tx.onblock_error` are gone.

Every `tx.*` and `act.*` line identifies its vault under `id`: the **vault address, checksummed**,
which also joins to this bot's own events keyed on `vault`.

## Testing

```sh
pnpm vitest run --project vault-v1-reallocation
```

Pure unit tests cover both strategies (ported from the original repo), the IRM math, config
loading, strategy-config resolution, revert decoding, the startup vault checks, the lens's
compile/decode surface, and the reallocation decision. Scenario tests in `test/scenario/` run the whole
graph against a fake kernel chain. The fork suite needs `RPC_URL_8453`. Two live checks stand in for
a full fork run:

```sh
# Reads the lens against a real vault at a pinned block, then re-reads the same block through the
# fetchAccrualVault path it replaced and diffs every field.
RPC_URL=… CHAIN_ID=8453 VAULT=0x… \
  pnpm --filter @morpho-org/vault-v1-reallocation run probe:lens
```

and `DRY_RUN` against a live RPC for the full read → strategy → simulate path.
