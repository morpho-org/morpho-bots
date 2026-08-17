# vault-v2-reallocation

Reallocates liquidity between the Morpho Blue markets of whitelisted Morpho Vault V2 vaults (via
each vault's MorphoMarketV1 adapter), migrated from the standalone
[vault-v2-reallocation-bot](https://github.com/morpho-org/vault-v2-reallocation-bot) repo onto the
shared `@repo/bot-kit` runtime. Sibling of [vault-v1-reallocation](../vault-v1-reallocation).

**Whitelisting a vault is production-active**: once a vault is in `VAULT_WHITELIST` (and `DRY_RUN`
is off), the bot continuously manages its allocations under the strategy's defaults — the
vault-wide `equalize-utilizations` target unless `STRATEGY`/[src/strategy-config.ts](./src/strategy-config.ts)
say otherwise. There is no further per-vault opt-in.

## How it works

One long-running process per chain. A block watcher drives per-block queue maintenance
(receipt checks, fee bumps, nonce reconciliation); a wall-clock gate (`REALLOCATION_INTERVAL_MS`,
default 10 min) throttles the actual reallocation passes. Each pass, per whitelisted vault:

1. Skip if a reallocation tx for this vault is in flight or cooling down.
2. Re-check the EOA's allocator role (`allocator.missing_role` + skip while absent — a pending
   grant never crash-loops the bot, and a fresh grant is picked up without restart).
3. Fetch a block-pinned RPC snapshot: the accrued vault tree via blue-sdk's `fetchAccrualVaultV2`
   (which also proves the address is a factory-made VaultV2), plus per-id
   `absoluteCap`/`relativeCap`/`allocation` reads for every market id, the adapter id, and each
   collateral id. No Morpho API dependency.
4. Run the strategy — a pure function of that snapshot, emitting **exact-amount deltas**
   (`{allocations, deallocations}`). Legs need not balance: surplus deallocations park in the
   vault's idle balance, and allocations may exceed deallocations by up to the idle balance.
   Matching the original bot, a plan only fires when BOTH sides have at least one leg — pure idle
   deployment (all markets above target, nothing to deallocate) does not fire; deploying fresh
   idle is a deliberate follow-up decision, not an accident of this port:
   - **`equalize-utilizations`** (default; what production runs): converge every market to the
     vault-wide average utilization, `Σborrow / (Σsupply + idle)`. Fires only past
     `MIN_UTILIZATION_DELTA_BIPS`.
   - **`apy-range`**: keep each market's borrow APY inside its configured range by inverting the
     AdaptiveCurveIRM curve; allocations top up from idle (`ALLOW_IDLE_REALLOCATION`). Fires only
     past `MIN_APY_DELTA_BIPS`.
5. Encode ONE `vault.multicall([deallocate…, allocate…])` (deallocations strictly first so idle is
   funded), simulate those exact bytes from the EOA, and on sim-ok submit through the pending queue
   (or log `reallocation.dry_run` when `DRY_RUN=true`).

**All three cap levels are enforced in sizing** — per-market cap ids plus the adapter-level
(`"this"`) and per-collateral cap ids. Headroom is measured from the ACCRUED position (each leg
trues `allocation(id)` up to it before the contract's cap check; the aggregate pools add every
market's accrual drift on top of the stored allocation), a relative cap of exactly WAD is honored
as the contract's no-constraint sentinel, and capacity freed by the plan's own deallocations
(executed first) is credited back. A 99.99% buffer absorbs accrual between read and mined
execution. A binding aggregate cap shrinks the plan instead of producing a sim-revert loop.

The signing policy is default-deny in depth: only value-0 `multicall(bytes[])` calls to whitelisted
vaults are signed, and every inner call must be `allocate`/`deallocate` targeting that vault's own
adapter (see `@repo/bot-kit`'s `Policy.multicall`).

Assumptions and posture:

- **Exactly one Morpho Blue market adapter per vault** (either adapter-contract generation,
  `MorphoMarketV1Adapter` or `MorphoMarketV1AdapterV2` — live vaults use the latter) — startup and
  every fetch fail loud otherwise. `forceDeallocate`, liquidity adapters, gates, and MetaMorpho
  (VaultV1) adapters are out of scope.
- **The adapter's on-chain market list is the candidate set.** The original adapter generation
  removes a market from its list when its allocation hits zero, so a fully-deallocated market
  cannot be re-entered by this bot until some allocator supplies it again — size deallocations
  accordingly (the strategies never fully exit a market on their own; only the vault-wide target
  math can drive a position to zero).
- **AdaptiveCurveIRM only**: the `apy-range` math assumes every market uses the canonical
  AdaptiveCurveIRM.
- **Relative-cap staleness**: relative headroom moves with `totalAssets` between read and mine;
  the cap buffer, exact-bytes simulation, and the queue's revert audit bound the drift.
- **The bot owns allocations between curator actions**: a plan is built, simulated, and submitted
  within a single pass; a queued tx re-broadcasts the same calldata on fee bumps, bounded by the
  in-flight skip and settled cooldown.
- Cross-tick state is in-memory only; chain truth wins on restart.

## Prerequisites

- The EOA behind `REALLOCATOR_PRIVATE_KEY` must hold the **allocator role** on every whitelisted
  vault. The bot only pays gas — reallocation moves vault funds, never the EOA's.
- An RPC endpoint per chain. Supported chains: mainnet (1), Base (8453) — extend `CHAIN_MAP` in
  [src/config.ts](./src/config.ts).

## Configuration

In-container env vars (unsuffixed; the `_<chainId>` suffix is an operator-side convention used by
docker-compose and the Railway deploy script):

| Var                                                       | Required | Default                 | Notes                                                |
| --------------------------------------------------------- | -------- | ----------------------- | ---------------------------------------------------- |
| `CHAIN_ID`                                                | yes      | —                       | 1 or 8453                                            |
| `RPC_URL`                                                 | yes      | —                       | reads, simulation, sends                             |
| `RPC_URL_FALLBACK`                                        | no       | —                       | failover endpoint                                    |
| `REALLOCATOR_PRIVATE_KEY`                                 | yes      | —                       | allocator EOA                                        |
| `VAULT_WHITELIST`                                         | yes      | —                       | comma-separated VaultV2 addresses; must be non-empty |
| `STRATEGY`                                                | no       | `equalize-utilizations` | or `apy-range`                                       |
| `REALLOCATION_INTERVAL_MS`                                | no       | `600000`                | min wall-clock ms between passes                     |
| `MIN_APY_DELTA_BIPS`                                      | no       | `25`                    | strategy-config overrides win                        |
| `MIN_UTILIZATION_DELTA_BIPS`                              | no       | `250`                   | strategy-config overrides win                        |
| `ALLOW_IDLE_REALLOCATION`                                 | no       | `true`                  | apy-range only                                       |
| `DRY_RUN`                                                 | no       | `false`                 | plan + simulate + log, never submit                  |
| `MAX_FEE_GWEI`                                            | no       | `300`                   | policy + queue fee ceiling                           |
| `LOG_LEVEL`                                               | no       | `info`                  | debug/info/warn/error                                |
| `BETTERSTACK_SOURCE_TOKEN` / `BETTERSTACK_INGESTING_HOST` | no       | —                       | both set = ship logs                                 |
| `BETTERSTACK_HEARTBEAT_URL`                               | no       | —                       | 60s heartbeat                                        |

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
CHAIN_ID=1 RPC_URL=… REALLOCATOR_PRIVATE_KEY=0x… VAULT_WHITELIST=0x… \
  pnpm --filter @morpho-org/vault-v2-reallocation run start
```

Or via compose (one service per chain, both defaulting to `DRY_RUN=true`):

```sh
cd bots/vault-v2-reallocation && docker compose up --build
```

### Ramp-up (recommended)

Start any new deployment with `DRY_RUN=true`: the bot runs the full live read → strategy →
encode → simulate path and logs each would-be transaction as `reallocation.dry_run`, but never
submits. Review a few passes' plans, then flip `DRY_RUN=false`.

## Deploy (Railway)

```sh
RAILWAY_PROJECT_ID=… RPC_URL_1=… VAULT_WHITELIST_1=0x… REALLOCATOR_PRIVATE_KEY=0x… \
  pnpm --filter @morpho-org/vault-v2-reallocation run deploy:railway
```

Provisions one `bot-<chainId>` service per chain (new services start in dry-run). CI re-ships
already-provisioned services with `DEPLOY_ONLY=1` on merge to main (staging) and via the
`release-vault-v2-realloc` PR label (production).

## Observability

Structured JSON-lines on stderr, one event per line, with `bot`/`chainId` (and Railway identity)
stamped on every line. Key events: `startup`, `allocator.missing_role`, `reallocation.found`
(per-leg direction/collateral/lltv/assets), `reallocation.sim_revert`, `reallocation.dry_run`,
`vault.error`, per-pass `tick.end` counters, and the shared bot-kit `tx.*` / `signer.balance` /
`block.new` events. BetterStack shipping and heartbeat are opt-in via the env vars above.

## Testing

```sh
pnpm vitest run --project vault-v2-reallocation
```

Pure unit tests cover both strategies (delta output, idle folding/top-up, three-level cap pools),
the cap/IRM math, multicall encoding (decode round-trip incl. leg ordering), config loading,
strategy-config resolution, revert decoding, and a dependency-injected tick; the multicall signing
policy is tested in `@repo/bot-kit`. There is no anvil fork suite yet (the old repo's
`test/vitest/vaultSetup.ts` V2 timelock harness is the seed for one); `DRY_RUN` against a live RPC
is the end-to-end check.
