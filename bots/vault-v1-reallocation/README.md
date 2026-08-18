# vault-v1-reallocation

Reallocates liquidity between the Morpho Blue markets of whitelisted MetaMorpho (Vault V1) vaults,
migrated from the standalone
[morpho-blue-reallocation-bot](https://github.com/morpho-org/morpho-blue-reallocation-bot) repo onto
the shared `@repo/bot-kit` runtime.

**Whitelisting a vault is production-active**: once a vault is in `VAULT_WHITELIST` (and `DRY_RUN`
is off), the bot continuously manages its allocations under the strategy's defaults — the global
3–8% APY range unless [src/strategy-config.ts](./src/strategy-config.ts) overrides it. There is no
further per-vault opt-in.

## How it works

One long-running process per chain. A block watcher drives per-block queue maintenance
(receipt checks, fee bumps, nonce reconciliation); a wall-clock gate (`REALLOCATION_INTERVAL_MS`,
default 10 min) throttles the actual reallocation passes. Each pass processes every whitelisted
vault concurrently, so a pass costs the slowest vault rather than the sum:

1. Skip if a reallocation tx for this vault is in flight or cooling down.
2. Fetch a block-pinned snapshot with `fetchAccrualVault` (`@morpho-org/blue-sdk-viem`) — the
   withdraw queue plus per-market state, position, and cap, with interest accrued to the pinned
   block's own timestamp, never wall clock — alongside a concurrent `isAllocator` read. The
   per-market reads are batched into a few JSON-RPC round trips.
3. Re-check that the EOA still satisfies `onlyAllocatorRole` — `isAllocator`, or the snapshot's
   owner / curator (`allocator.missing_role` + skip while absent; a pending grant never crash-loops
   the bot, and a fresh grant is picked up without restart).
4. Run the strategy — a pure function of that snapshot:
   - **`apy-range`** (default): keep each market's borrow APY inside its configured range by
     inverting the AdaptiveCurveIRM curve; the idle market absorbs or supplies the imbalance
     (`ALLOW_IDLE_REALLOCATION`). Fires only when some market's implied APY move exceeds
     `MIN_APY_DELTA_BIPS`.
   - **`equalize-utilizations`**: converge every non-idle market to the vault-wide average
     utilization; fires only past `MIN_UTILIZATION_DELTA_BIPS`.
5. Simulate the exact `reallocate(...)` bytes from the EOA; on sim-ok, submit through the pending
   queue (or log `reallocation.dry_run` when `DRY_RUN=true`).

Deposit legs stop at 99.99% of each market's supply cap (`CAP_BUFFER_WAD` in
[src/math.ts](./src/math.ts), not an env var) so interest accrual between read and mined execution
can't push a leg over cap. Withdrawals are listed first and the last deposit leg is
`maxUint256`, per `MetaMorpho.reallocate` semantics.

Assumptions and posture:

- **AdaptiveCurveIRM only, enforced**: the `apy-range` math needs a real `rateAtTarget` to invert the
  curve, so markets not on the chain's canonical AdaptiveCurveIRM are excluded from both legs (logged
  as `market.non_adaptive_curve`). `equalize-utilizations` is utilization-only and keeps them.
- **A market pinned at ~100% utilization reads as "APY too high"** and therefore attracts deposits.
  That is the intended direction (fresh supply is exactly what an exhausted market needs), so it is
  documented rather than special-cased.
- **The bot owns allocations between curator actions**: a plan is built, simulated, and submitted
  within a single pass (nothing unsent survives it), but a queued tx re-broadcasts the same
  calldata on fee bumps. The in-flight skip plus a settled cooldown bound how stale a mined
  reallocation can be; curators changing queues/caps mid-flight should expect the bot to re-derive
  and follow on the next pass.
- Cross-tick state is in-memory only; chain truth wins on restart.

## Prerequisites

- The EOA behind `REALLOCATOR_PRIVATE_KEY` must satisfy `onlyAllocatorRole` on every whitelisted
  vault — i.e. be in the **allocator set**, or be the vault's **curator** or **owner**. All three are
  accepted by the startup probe and the per-pass re-check. The bot only pays gas — reallocation moves
  vault funds, never the EOA's.
- An RPC endpoint per chain. Supported chains: mainnet (1), Base (8453) — extend `CHAIN_MAP` in
  [src/config.ts](./src/config.ts).

## Configuration

In-container env vars (unsuffixed; the `_<chainId>` suffix is an operator-side convention used by
docker-compose and the Railway deploy script):

| Var                                                       | Required | Default     | Notes                                                    |
| --------------------------------------------------------- | -------- | ----------- | -------------------------------------------------------- |
| `CHAIN_ID`                                                | yes      | —           | 1 or 8453                                                |
| `RPC_URL`                                                 | yes      | —           | reads, simulation, sends                                 |
| `RPC_URL_FALLBACK`                                        | no       | —           | failover endpoint                                        |
| `REALLOCATOR_PRIVATE_KEY`                                 | yes      | —           | allocator EOA                                            |
| `VAULT_WHITELIST`                                         | yes      | —           | comma-separated vault addresses; deduplicated, non-empty |
| `STRATEGY`                                                | no       | `apy-range` | or `equalize-utilizations`                               |
| `REALLOCATION_INTERVAL_MS`                                | no       | `600000`    | min wall-clock ms between passes                         |
| `MIN_APY_DELTA_BIPS`                                      | no       | `25`        | strategy-config overrides win                            |
| `MIN_UTILIZATION_DELTA_BIPS`                              | no       | `250`       | strategy-config overrides win                            |
| `ALLOW_IDLE_REALLOCATION`                                 | no       | `true`      | apy-range only                                           |
| `DRY_RUN`                                                 | no       | `false`     | plan + simulate + log, never submit                      |
| `MAX_FEE_GWEI`                                            | no       | `300`       | policy + queue fee ceiling                               |
| `LOG_LEVEL`                                               | no       | `info`      | debug/info/warn/error                                    |
| `BETTERSTACK_SOURCE_TOKEN` / `BETTERSTACK_INGESTING_HOST` | no       | —           | both set = ship logs                                     |
| `BETTERSTACK_HEARTBEAT_URL`                               | no       | —           | 60s heartbeat                                            |

Per-vault / per-market APY ranges and min-delta thresholds are **checked-in curator policy** in
[src/strategy-config.ts](./src/strategy-config.ts) (market > vault > env-default precedence).
The tables ship empty; changing policy is a reviewed PR + redeploy.

## Running

```sh
pnpm --filter @morpho-org/vault-v1-reallocation run build
CHAIN_ID=8453 RPC_URL=… REALLOCATOR_PRIVATE_KEY=0x… VAULT_WHITELIST=0x… \
  pnpm --filter @morpho-org/vault-v1-reallocation run start
```

Or via compose (one service per chain, both defaulting to `DRY_RUN=true`):

```sh
cd bots/vault-v1-reallocation && docker compose up --build
```

### Ramp-up (recommended)

Start any new deployment with `DRY_RUN=true`: the bot runs the full live read → strategy →
encode → simulate path and logs each would-be transaction as `reallocation.dry_run`, but never
submits. Review a few passes' plans, then flip `DRY_RUN=false`.

## Deploy (Railway)

```sh
RAILWAY_PROJECT_ID=… RPC_URL_1=… VAULT_WHITELIST_1=0x… REALLOCATOR_PRIVATE_KEY=0x… \
  pnpm --filter @morpho-org/vault-v1-reallocation run deploy:railway
```

Provisions one `bot-<chainId>` service per chain (new services start in dry-run). CI re-ships
already-provisioned services with `DEPLOY_ONLY=1` on merge to main (staging) and via the
`release-vault-v1-realloc` PR label (production).

## Observability

Structured JSON-lines on stderr, one event per line, with `bot`/`chainId` (and Railway identity)
stamped on every line. Key events: `startup`, `allocator.missing_role`, `vault.inflight` (debug),
`market.non_adaptive_curve` (debug), `reallocation.found`, `reallocation.sim_revert`,
`reallocation.dry_run`, `reallocation.not_broadcast` (debug), `vault.error`, per-pass `tick.end` counters (`vaults`, `skipped_inflight`,
`missing_role`, `reallocations_found`, `sim_reverts`, `dry_runs`, `submitted`, `errors`,
`duration_ms`), and the shared bot-kit `tx.*` / `signer.balance` / `block.new` events. BetterStack
shipping and heartbeat are opt-in via the env vars above.

## Testing

```sh
pnpm vitest run --project vault-v1-reallocation
```

Pure unit tests cover both strategies (ported from the original repo), the IRM math, config
loading, strategy-config resolution, revert decoding, the startup vault checks, the interval gate,
and a dependency-injected tick. There is no
anvil fork suite yet; `DRY_RUN` against a live RPC is the end-to-end check.
