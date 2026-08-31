# vault-v1-reallocation

Reallocates liquidity between the Morpho Blue markets of whitelisted MetaMorpho (Vault V1) vaults,
migrated from the standalone
[morpho-blue-reallocation-bot](https://github.com/morpho-org/morpho-blue-reallocation-bot) repo onto
the shared `@repo/bot-kit` runtime.

> **Reference bot — not operated by Morpho.** Morpho is not a curator and publishes this bot as
> open source for curators to run themselves. It is not wired into this repo's CI deploy pipeline;
> the Dockerfile, compose file, and Railway deploy script below are worked examples of a
> deployment, not a managed service.

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
2. Fetch a block-pinned snapshot in **one** `eth_call` via the deployless lens in
   [src/state/lens.sol.ts](./src/state/lens.sol.ts): the vault's `owner` / `curator` /
   `isAllocator(eoa)`, its withdraw queue, and per market the params, accrued Blue state, the vault's
   position, the cap, and `rateAtTarget`. The lens calls `Morpho.accrueInterest` inside the simulation
   before reading, so the numbers are the market's exact on-chain state at that block — no client-side
   accrual, no block-timestamp handling. One vault therefore costs **one billed RPC call per pass**,
   not the ~55–65 the previous `fetchAccrualVault` fan-out billed for a 10-market vault.
3. Re-check that the EOA still satisfies `onlyAllocatorRole` — the snapshot's `isAllocator`, `owner`,
   or `curator`, all three read in that same call (`allocator.missing_role` + skip while absent; a
   pending grant never crash-loops the bot, and a fresh grant is picked up without restart).
4. Run the strategy — a pure function of that snapshot:
   - **`apy-range`** (default): keep each market's borrow APY inside its configured range by
     inverting the AdaptiveCurveIRM curve; the idle market absorbs or supplies the imbalance
     (`ALLOW_IDLE_REALLOCATION`). Fires only when some market's implied APY move exceeds
     `MIN_APY_DELTA_BIPS`.
   - **`equalize-utilizations`**: converge every non-idle market to the vault-wide average
     utilization; fires only past `MIN_UTILIZATION_DELTA_BIPS`.
5. Simulate the exact `reallocate(...)` bytes from the EOA; on sim-ok, submit through the pending
   queue (or log `reallocation.dry_run` when `DRY_RUN=true`). Because vaults are processed
   concurrently, several submits can land in the same instant — the queue serializes its
   nonce-critical section (bot-kit's coalescing mutex), so each gets its own nonce.

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
  vault funds, never the EOA's. A whitelisted vault the EOA cannot reallocate is cheap to leave in
  place: the role now rides the same single lens call as the snapshot, so such a vault costs one RPC
  call per pass and a warning line.
- An RPC endpoint per chain. Supported chains: mainnet (1), Base (8453) — extend `CHAIN_MAP` in
  [src/config.ts](./src/config.ts).

## Configuration

In-container env vars are unsuffixed. The `_<chainId>` suffix is an operator-side convention used by
docker-compose and the Railway deploy script, and it covers every per-chain input: `RPC_URL_<id>`,
`RPC_URL_FALLBACK_<id>`, `VAULT_WHITELIST_<id>`, `STRATEGY_<id>`, `DRY_RUN_<id>`,
`BETTERSTACK_HEARTBEAT_URL_<id>`, and the five tuning knobs `REALLOCATION_INTERVAL_MS_<id>`,
`MIN_APY_DELTA_BIPS_<id>`, `MIN_UTILIZATION_DELTA_BIPS_<id>`, `ALLOW_IDLE_REALLOCATION_<id>`,
`MAX_FEE_GWEI_<id>` — so chains can be tuned independently. `REALLOCATOR_PRIVATE_KEY` may be suffixed per chain or shared unsuffixed. The
deploy script sets each optional knob when supplied and **deletes** it from the service when not, so
dropping one from the deploy env returns that chain to the default below rather than leaving a stale
value on the service.

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

## Deploy (Railway example)

An example of a real hosted deployment, for operators who want more than compose:

```sh
RAILWAY_PROJECT_ID=… RPC_URL_1=… VAULT_WHITELIST_1=0x… REALLOCATOR_PRIVATE_KEY=0x… \
  pnpm --filter @morpho-org/vault-v1-reallocation run deploy:railway
```

Provisions one `bot-<chainId>` service per chain (new services start in dry-run). Re-running with
`DEPLOY_ONLY=1` re-ships already-provisioned services without touching their variables — the shape
a CI pipeline would call; this repo's CI deliberately does not, since Morpho does not operate this
bot.

## Observability

Structured JSON-lines on stderr, one event per line, with `bot`/`chainId` (and Railway identity)
stamped on every line. Key events: `startup`, `allocator.missing_role`, `vault.inflight` (debug),
`market.non_adaptive_curve` (debug), `reallocation.found`, `reallocation.sim_revert`,
`reallocation.dry_run`, `reallocation.not_broadcast` (debug), `vault.error`, per-pass `tick.end` counters (`vaults`, `skipped_inflight`,
`missing_role`, `reallocations_found`, `sim_reverts`, `dry_runs`, `submitted`, `errors`,
`duration_ms`), and the shared bot-kit `tx.*` / `signer.balance` / `block.new` events. BetterStack
shipping and heartbeat are opt-in via the env vars above.

The shared queue identifies a tracked transaction by the key this bot hands it, under the field `id`
(it was `label`). This bot's key is the **vault address, checksummed** — not a liquidator's
`lensKey` — so `tx.*.id` does not join to this bot's own events, which key on `vault`. Compare the two
case-insensitively.

## Testing

```sh
pnpm vitest run --project vault-v1-reallocation
```

Pure unit tests cover both strategies (ported from the original repo), the IRM math, config
loading, strategy-config resolution, revert decoding, the startup vault checks, the interval gate,
the lens's compile/decode surface, and a dependency-injected tick. There is no anvil fork suite yet.
Two live checks stand in for it:

```sh
# Reads the lens against a real vault at a pinned block, then re-reads the same block through the
# fetchAccrualVault path it replaced and diffs every field.
RPC_URL=… CHAIN_ID=8453 VAULT=0x… \
  pnpm --filter @morpho-org/vault-v1-reallocation run probe:lens
```

and `DRY_RUN` against a live RPC for the full read → strategy → simulate path.
