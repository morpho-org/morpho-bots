# Blue liquidation bot

A non-competitive, ecosystem-backstop liquidator for **Morpho Blue** on Base and Robinhood. It
discovers at-risk borrowers via the Morpho API, reads fresh accrued state, sizes seize-exact
liquidations, simulates the final Executor call, and broadcasts only simulation-ok plans.

## Status

v0. Unit-tested across the core modules. The production read path (lens compile → deployless deploy →
IRM accrual sim → oracle → health → decode) is **validated against 256 live Base positions** via
`probe:lens`, and the lens gas model is **measured** (see `state/lens.sol.ts`). The end-to-end
fork suite liquidates a position it seeds on a Base fork through the real kernel (see
[Testing](#testing)).

## Architecture

The bot is one graph on the bot framework (`docs/framework/AUTHORING.md`). Its `src/` root is the
framework skeleton: `graph.ts` declares the graph, `run.ts` starts it, `kernel.ts` loads the
liquidator's key and builds its kernel, `report.ts` writes the operator log, `sources.ts` reads the
world at each head and quotes each liquidatable position, and `prepare.ts` encodes and simulates one
liquidation. Around them:

- `discovery/` — candidate borrowers from the Morpho API.
- `state/` — the deployless lens that reads each position's accrued state and market params.
- `runner/` and `sizing/` — pure eligibility and seize-exact sizing; `liquidation.ts` applies them
  to one position reading.
- `execution/` — the Executor calldata and the swap step; `quotes.ts` composes venue quoting.
- `market.ts`, `constants.ts`, `stats.ts` — market ids, protocol constants, per-tick counters.

## Prerequisites

- **pnpm** `11.11.0` (via corepack) and **Node** `24.22.1` (`.nvmrc`).
- A chain RPC that both reads and _relays_ transactions — **not** `rpc.morpho.dev/realtime`, which
  acknowledges sends but never broadcasts them.
- A **funded EOA** (native gas) — the liquidator and the recipient of the end-of-exec token sweeps.
- The generic **Executor** singleton deployed on each chain the bot runs on
  (`pnpm --filter @repo/contracts run deploy:executor`). The bot derives its CREATE2 address and
  refuses to start if it holds no code.
- At least one enabled **swap venue** — a `ZEROX_API_KEY` / `ONEINCH_API_KEY` / `LIFI_API_KEY`, or
  `ENABLE_LIFI=true` (LiFi routes keyless; its key only raises rate limits). A venue-less deployment
  must opt into detection-only mode explicitly (`ALLOW_DETECTION_ONLY=true`).

## Configuration

Env vars (fail-loud on a missing required var, an unknown chain, or a malformed value):

| Var                                                                 | Required | Default         | Purpose                                                                                                                                                                           |
| ------------------------------------------------------------------- | -------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHAIN_ID`                                                          | yes      | —               | Must be in the chain map (`8453`, `4663`)                                                                                                                                         |
| `RPC_URL`                                                           | yes      | —               | Primary RPC (reads, simulation, sends)                                                                                                                                            |
| `RPC_URL_FALLBACK`                                                  | no       | —               | Optional viem-dlc `failover` endpoint; each branch states its own `eth_call` gas cap                                                                                              |
| `MAX_DEPLOYLESS_BATCH_SIZE`                                         | no       | —               | Caps one chunk's `eth_call` data in bytes. Only set it when an endpoint rejects large requests                                                                                    |
| `LIQUIDATOR_PRIVATE_KEY`                                            | yes      | —               | EOA hex key (`0x` + 32-byte hex)                                                                                                                                                  |
| `KERNEL_STATE_DIR`                                                  | yes      | —               | Directory holding the signing kernel's ledger (`kernel-<chainId>-<account>.json`). Must survive restarts; the chart mounts a volume there.                                        |
| `JOURNAL_RUN_CAP_BYTES`                                             | yes      | —               | The size, in bytes and at least 64 MiB, at which a run's journal file stops the bot cleanly; the next start begins a new file. The chart sets it from `state.journalRunCapBytes`. |
| `KERNEL_ENROLLMENT`                                                 | yes      | —               | `enrolling` for the first start of a fresh account, `enrolled` for every later one; a missing ledger under `enrolled` refuses to start.                                           |
| `FINALITY_<CHAIN_ID>`                                               | yes      | —               | `safe`, `finalized`, or a positive block depth: the block the kernel treats as final, under its 10-minute window: `FINALITY_8453=safe`, `FINALITY_4663=50`                        |
| `BUILD_REVISION` / `BUILD_IMAGE_TAG`                                | yes      | —               | The source revision and image the journal names and every log line carries as `revision` and `imageTag`; the Dockerfile bakes them in from build args                             |
| `EXECUTOOOR_ADDRESS`                                                | no       | derived         | Override; default is the derived CREATE2 address                                                                                                                                  |
| `MORPHO_API_KEY`                                                    | yes      | —               | Morpho partner API key, sent as `x-api-key` on borrower discovery. Request one from Morpho                                                                                        |
| `LIQUIDATION_CANDIDATES_API_URL`                                    | no       | partner API     | Borrower-discovery endpoint override                                                                                                                                              |
| `HEALTH_FACTOR_LTE`                                                 | no       | `1.02`          | Discovery health-factor cutoff (min `1.0` — throws below)                                                                                                                         |
| `ZEROX_API_KEY` / `ONEINCH_API_KEY` / `LIFI_API_KEY`                | no       | —               | Each key **enables** its venue; LiFi also via `ENABLE_LIFI` (keyless)                                                                                                             |
| `ENABLE_LIFI`                                                       | no       | `false`         | Enable LiFi without a key                                                                                                                                                         |
| `ALLOW_DETECTION_ONLY`                                              | no       | `false`         | Opt-in: boot with zero venues (discover + log only, skip every liquidation). Without it, zero venues is a startup error                                                           |
| `EXCLUDE_COLLATERALS`                                               | no       | —               | Comma-separated collateral deny-list (skipped with `config.no_swap_path`)                                                                                                         |
| `ZEROX_BASE_URL` / `ONEINCH_BASE_URL` / `LIFI_BASE_URL`             | no       | —               | Optional per-venue API host overrides                                                                                                                                             |
| `PROBE_STALE_MS` / `PROBE_HTTP_RPS` / `PROBE_LADDER`                | no       | see `config.ts` | Venue-probe cache staleness, isolated probe rate, and ladder sizes (whole collateral tokens — this bot wires no USD price source)                                                 |
| `MAX_FEE_GWEI`                                                      | yes      | —               | Hard ceiling for fee bumps; at it the bot waits, live, for fees to fall                                                                                                           |
| `MAX_ROUTE_IMPACT_BPS`                                              | no       | `500`           | Reject aggregator routes this far below the oracle ref                                                                                                                            |
| `PENDLE_SLIPPAGE_BPS`                                               | no       | `50`            | Slippage for the Pendle PT → underlying unwrap hop (before the downstream venue sells)                                                                                            |
| `QUOTE_TIMEOUT_MS` / `HTTP_RPS` / `HTTP_BURST` / `HTTP_MAX_RETRIES` | no       | see `config.ts` | Aggregator HTTP tunables                                                                                                                                                          |
| `BACKOFF_BASE_BLOCKS` / `BACKOFF_MAX_BLOCKS`                        | no       | `2` / `64`      | Per-position failure backoff                                                                                                                                                      |
| `BETTERSTACK_SOURCE_TOKEN` / `BETTERSTACK_INGESTING_HOST`           | no       | —               | Opt-in log shipping; when both are set the bot's in-process loglayer transport ships structured logs to BetterStack (inert otherwise)                                             |
| `BETTERSTACK_HEARTBEAT_URL`                                         | no       | —               | Optional Better Stack Uptime heartbeat URL, pinged every minute; failures only log a warning and never interrupt liquidations                                                     |
| `LOG_LEVEL`                                                         | no       | `info`          | `debug` \| `info` \| `warn` \| `error`                                                                                                                                            |

For Compose, operator-facing RPC env vars are chain-id suffixed: `RPC_URL_8453`,
`RPC_URL_4663`, and optional distinct `BETTERSTACK_HEARTBEAT_URL_<chainId>` values. Inside each bot
container the runtime env remains unsuffixed because each service runs exactly one chain.

### Venues

There is no per-collateral routing file. Venues are **enabled by key presence** (`ZEROX_API_KEY`,
`ONEINCH_API_KEY`, `LIFI_API_KEY` — or `ENABLE_LIFI=true` for keyless LiFi), and for each
liquidatable position a background probe cache ranks the enabled venues best-first for the
`(collateral, loan)` pair (log-scaled indicative quotes on an isolated rate budget, interpolated at
the seize size — see `PROBE_LADDER`/`PROBE_STALE_MS`/`PROBE_HTTP_RPS`; ladder sizes are whole
collateral tokens here, since this bot wires no USD price source). The firm quote goes to the top
venue and falls through to the next on failure, so a transient venue outage costs coverage, never
correctness. The curve also predicts that venue's own output to set the quote's min-out denominator,
but only while it is fresher than the package's prediction-age ceiling — well under this bot's
ten-minute `PROBE_STALE_MS`, so an older curve simply pays the two-pass derivation's extra call.
Collateral that wraps an ERC-4626 vault or a Pendle PT is auto-unwrapped before the venue swap.
`EXCLUDE_COLLATERALS` is the operator's deny-list for collaterals the bot must never seize/hold.

With **zero venues** the bot refuses to start unless `ALLOW_DETECTION_ONLY=true`, in which case it
discovers and logs liquidatable positions but skips every liquidation (`config.no_swap_path`) — a
rotated/forgotten key must not quietly disable liquidations.

## Running locally

```sh
export CHAIN_ID=8453
export MORPHO_API_KEY=…
export RPC_URL=https://…
export LIQUIDATOR_PRIVATE_KEY=0x…
export ZEROX_API_KEY=…            # or ENABLE_LIFI=true, or ALLOW_DETECTION_ONLY=true
export MAX_FEE_GWEI=… FINALITY_8453=safe
export KERNEL_STATE_DIR=./state KERNEL_ENROLLMENT=enrolling   # `enrolled` once ./state holds the ledger
export JOURNAL_RUN_CAP_BYTES=1073741824
export BUILD_REVISION=$(git rev-parse HEAD) BUILD_IMAGE_TAG=local
pnpm --filter @morpho-org/blue-liquidation run start
```

`prestart` builds this bot and its workspace dependencies (soltag-compiles `@repo/contracts` and
materializes the ABI, then esbuild-bundles `dist/`), so `start` runs a plain `node` against a
freshly built bundle. Discovery hits the Morpho partner API, which needs a `MORPHO_API_KEY` — no
indexer or database to run.

## Running with Docker Compose

```sh
cd bots/blue-liquidation
export RPC_URL_8453=https://…
export LIQUIDATOR_PRIVATE_KEY=0x…
export ZEROX_API_KEY=…
export MORPHO_API_KEY=…
export MAX_FEE_GWEI=… FINALITY_8453=safe FINALITY_4663=50
export KERNEL_ENROLLMENT_8453=enrolling KERNEL_ENROLLMENT_4663=enrolling  # see Kernel state
BUILD_REVISION=$(git rev-parse HEAD) docker compose up --build
```

Brings up one bot per chain (`bot-base`, `bot-robinhood`), each with its own state volume — nothing
else. `RPC_URL_4663` is optional
locally because Compose defaults Robinhood to its public RPC. Robinhood defaults to detection-only
(`ALLOW_DETECTION_ONLY_4663` defaults true) and takes chainId-suffixed venue inputs
(`ZEROX_API_KEY_4663` etc.) so arming Base never silently arms it. The build context is the repo
root so the pnpm workspace resolves.

## Deploying

The bot runs on the AWS tools Kubernetes cluster, one StatefulSet per chain, deployed by Argo CD
from the chart at [`helm/blue-liquidation`](./helm/blue-liquidation). The Argo CD applications live
in morpho-infra:

- `dev-8453` follows `bots` main and takes its `env` and `replicas` from morpho-tools-deployment's
  `values-dev-<chain>.yaml`.
- `prd-8453` and `prd-4663` take values files from morpho-tools-deployment and render the chart from
  the public `morpho-bots` snapshot. The platform team owns their `replicas`, the production kill
  switch, in morpho-infra; a `replicas` value in morpho-tools-deployment has no effect.

Every push to main publishes `bots/blue-liquidation:<commit>` to ECR, built with
`BUILD_REVISION=<commit>`. A `Releases blue-liq` release's `Image` job adds the tag
`blue-liq-<PR#>` to that image. Production pins only a release tag, never a commit tag, in
morpho-tools-deployment, and a pin merges only after its release's `Image` job succeeded: a pin to a
tag with no image takes the bot offline. Rollback pins an earlier release tag.

### Release values

A release sets `image.repository`, `image.tag`, `serviceAccount.name`, `serviceAccount.roleArn`,
`runtimeSecret.key`, and these `env` entries. The chart defaults none of these entries, and the bot
refuses to start without any one of them:

| Var                   | Base (`8453`)                            | Robinhood (`4663`)           |
| --------------------- | ---------------------------------------- | ---------------------------- |
| `CHAIN_ID`            | `8453`                                   | `4663`                       |
| `FINALITY_<CHAIN_ID>` | `FINALITY_8453=safe`                     | `FINALITY_4663=50`           |
| `MAX_FEE_GWEI`        | `0.5`                                    | `0.05`                       |
| `KERNEL_ENROLLMENT`   | `enrolling`, then `enrolled` (see below) | `enrolling`, then `enrolled` |

Other non-secret settings from [Configuration](#configuration), such as `ALLOW_DETECTION_ONLY` or
`LOG_LEVEL`, also go in `env`. The chart sets `KERNEL_STATE_DIR=/repo/state`, where it mounts the
state volume, and `JOURNAL_RUN_CAP_BYTES` from `state.journalRunCapBytes` (1 GiB), and refuses a
release whose `env` sets either. `state.storageClass` (`tools-gp3`) and `state.size` (`10Gi`) shape
that volume; the render fails if either is empty, or if `state.journalRunCapBytes` is not a quoted
byte count.

### Runtime secret

Each release reads the AWS Secrets Manager secret `blue-liquidation/<env>/<chainId>/runtime`
(`eu-west-3`), named by `runtimeSecret.key`, into the pod's environment. It is a JSON object with
unsuffixed keys:

- `RPC_URL`, and optionally `RPC_URL_FALLBACK`.
- `MORPHO_API_KEY`, and `LIQUIDATION_CANDIDATES_API_URL` when the release discovers from an endpoint
  other than the partner API.
- `LIQUIDATOR_PRIVATE_KEY`. Each release holds its own account: two releases that share a key are
  two signers with two ledgers.
- The venue keys: `ZEROX_API_KEY`, `ONEINCH_API_KEY`, `LIFI_API_KEY`. Each one enables its venue. A
  release with none sets `ALLOW_DETECTION_ONLY=true` in `env`, or the bot refuses to start.
- `BETTERSTACK_SOURCE_TOKEN` and `BETTERSTACK_INGESTING_HOST`, and optionally
  `BETTERSTACK_HEARTBEAT_URL`.

The ExternalSecret refreshes it every five minutes, and a change restarts the pod.

### Kernel state

The claim `<statefulset>-state` (for example `prd-8453-blue-liquidation-state`) holds the kernel's
ledger, `kernel-<chainId>-<account>.json`, and the journal. It is an EBS volume in one availability
zone, so the pod schedules there. Neither `helm uninstall`, deleting the Argo CD application, nor an
Argo CD prune deletes it.

The ledger stays small. The journal grows about 100–160 MB a day while idle, and up to about 1.3 GB
a day when world reads fall back to carried coverage. No disk-usage metric is emitted.

Each start deletes old journal files under `journal/` before it creates its own. Newest first, it
keeps whole run files while they total at most three times `JOURNAL_RUN_CAP_BYTES`, and deletes the
rest. A crash loop's many small files therefore keep the journal of the run that crashed first. It
also deletes any file over twice the cap, even the newest, which only a run under no cap or a larger
one leaves. It logs `journal.pruned` with the `files` and `bytes` it deleted and how many it `kept`.
Deleting needs no free space, so a volume that has filled frees itself on the next start. When the
live file reaches `JOURNAL_RUN_CAP_BYTES`, the bot logs `journal.capped` and makes the same clean
stop as SIGTERM: `kernel.stopped`, exit 0, and Kubernetes starts it again on a new file. Kept files
total at most three caps and the live file overshoots its cap only by the entries its stop drains,
so the journal holds at most about four caps: 4 GiB at the chart's 1 GiB, inside `10Gi`. The ledger
is never pruned.

`KERNEL_ENROLLMENT` is `enrolling` for the first start of an account with no ledger and `enrolled`
for every start after it. The kernel refuses an enrollment over an existing ledger and an enrolled
start with none: it logs `kernel.stopped` with `outcome: refused` and the reason, and exits.

A refusing pod restarts into the same refusal and is never Ready. The StatefulSet rolls out in
order (`podManagementPolicy: OrderedReady`), so it waits on that pod and never replaces it: a
corrected `KERNEL_ENROLLMENT` synced through Argo CD does not reach the pod by itself. Each recovery
below therefore ends with Platform deleting the release's one pod, so the StatefulSet recreates it
from the synced spec. Argo CD shows its name, `<statefulset>-0`: for release `prd-8453`, it is
`prd-8453-blue-liquidation-0`. The Argo CD liquidation-bot operator role can sync, restart, and
read logs, but cannot delete a pod or exec into one.

To start an account for the first time:

1. Confirm the account has no transaction pending and that it never ran the kernel under this
   claim.
2. Set `KERNEL_ENROLLMENT=enrolling` in the release and sync.
3. Wait for the pod to log `kernel.running`. The kernel logs it only after its first ledger write
   lands as `kernel-<chainId>-<account>.json` in `/repo/state`; a failed write logs `kernel.error`
   and never reaches `kernel.running`.
4. Set `KERNEL_ENROLLMENT=enrolled` and sync, before anything else restarts the pod. The sync
   replaces the running pod with one that starts `enrolled`.

Three mistakes refuse to start, and each recovers the same way: set the value shown, sync, and ask
Platform to delete the pod.

- **Restarted while still `enrolling`** after `kernel.running`, with `account already has a ledger`:
  set `enrolled`.
- **Switched to `enrolled` before `kernel.running`**, with `ledger missing for enrolled account`:
  set `enrolling`, then follow the first-start steps from step 3. If it then refuses with
  `account already has a ledger`, the first write had landed: set `enrolled` instead.
- **Lost the ledger** (below), with `ledger missing for enrolled account`: confirm the account has
  no transaction pending, set `enrolling`, then follow the first-start steps from step 3.

A fresh `enrolling` start also waits in `starting`, signing nothing, until the account's nonce at
the chain's `safe` block matches its latest one, whatever `FINALITY_<chainId>` says: about 14
minutes after the account's last transaction on Robinhood, with no operator step, and then logs
`kernel.running`. A chain that serves no `safe` tag refuses a fresh enrollment.

Finality must lag the head by less than the kernel's 10-minute reorg window, at least 128 blocks
(3,000 on Base, 6,000 on Robinhood, 128 on mainnet). A depth at or past it fails at construction, and a tag that lags past it at
startup stops the kernel as refused, both naming the window. Robinhood's `safe` lags about 14
minutes, so it runs on `FINALITY_4663=50`, about 5 seconds. If finality falls behind the window
while running, the kernel holds it where it was and raises one `kernel.alarm`; nothing settles until
finality is back inside.

**Losing the ledger.** The ledger is the kernel's record of the transactions it signed and has not
seen settle. If the claim is lost or replaced, the next `enrolled` start refuses, because it finds
no ledger, and the bot stays down. That is deliberate: a blank kernel cannot account for a
transaction still pending. Recover as for a lost ledger above. Rotating to a new liquidator key is
the same case: a new account has no ledger.

## How it works

### Startup

Load + validate config (including the venue inference and the zero-venue gate), build the deployless
read client, then fail-loud liveness-check **both** the Executor and the Morpho singleton hold code.
Wire the venue selector, the two rate-limited HTTP clients (firm quotes vs background probes) and the
quoter, run one discovery self-check, and start the liquidator
([src/run.ts](./src/run.ts)): one `@repo/engine` graph whose `@repo/kernel` alone holds
the key. The kernel refuses to start on an unexplained nonce, a ledger for another account,
`enrolled` with no ledger, or finality lagging past its reorg window.

### The graph

[src/graph.ts](./src/graph.ts): each head the kernel's chain delivers starts a world
read ([src/sources.ts](./src/sources.ts)) — discovery, then the lens for exactly those pairs
pinned to that head by its hash — that writes every liquidatable position as a keyed level. Only a
discovery that walked its whole scope and a lens that validly read every pair vouch that a missing
position is gone; a failed read changes no position, a pair the lens could not read is failed, and a
read cut short carries just what it read.

Positions are open keys: a newly discovered one is a candidate at once. Each is sized purely and
ranked by health factor, worst first, read from the same lens reading, so the rank does not depend
on the loan token's decimals. Each sizeable position is quoted, least healthy first and within the
firm quote rate, and quoted again only once
its route expires (`QUOTE_VALID_MS`), stops covering its seize, found no path (`QUOTE_RETRY_MS`),
or failed and waited out its backoff. It is never quoted while the kernel holds a plan or an
unresolved send for it, or while it is backed off. The `@repo/controller` task family
prepares quoted candidates in rank order ([src/prepare.ts](./src/prepare.ts): encode, simulate),
skipping any position the kernel holds a plan or an unresolved send for, or that is backed off. Each
prepared liquidation goes to the kernel resting on two facts: "this position is still liquidatable",
a chain fact which holds while the lens reading moves block by block, and "this is its quoted
route", an offchain fact which holds until the route is quoted again or expires. It carries the
conflict id `position:<id>`, so liquidations of different positions are pending at once and two of
one never are.
The kernel refuses one whose fact changed before its nonce, or that was read before its own last
inclusion on that position, which is what keeps a lagging read from re-sending a position just
liquidated.

### Discovery

Each world reading, `discovery/borrowers.ts` GETs the Morpho API's blue liquidation-candidates
endpoint once per page, filtered server-side to **this chain** (`chain_ids`) and positions at or
below `HEALTH_FACTOR_LTE` (`health_factor_lte`). The endpoint returns **listed markets only**,
ordered by ascending health factor so the worst positions are always on page 1. Only `market_id` +
`borrower` are consumed; the walk follows the cursor across the full set (page size 1000, with a
loud `discover.max_pages` backstop against silent truncation, and de-dupe across pages).

Each distinct id resolves to `MarketParams` onchain via `idToMarketParams(id)` (memoized forever —
params are immutable per id), and the lens re-reads every pair fresh, so the API is a coverage
source, never a correctness dependency: over-inclusion is harmless, API indexing lag is coverage
latency only, and an id that doesn't resolve against this chain's singleton is dropped (with a
`discover.dropped` warn — the backstop against an API/deployment mismatch). Base uses the canonical
singleton `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb`; Robinhood uses its own singleton
`0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010`.

Because listing is enforced server-side, discovery covers **every listed market** from
the first reading — including markets that never had a borrow while the bot was running (the old
indexer only knew markets with an indexed `Borrow` event). The flip side: a delisted market's
positions leave discovery even if still liquidatable.

### State lens

A `soltag`-authored lens (`state/lens.sol.ts`) reads everything the decision depends on for the whole
batch inside one deployless `eth_call` against a single `block.timestamp`. Per element it:

1. re-derives `id = keccak256(abi.encode(params))` and reads `market(id)` / `position(id, borrower)` —
   a forged param set derives an id with no market and is rejected (`valid = false`);
2. **simulates interest accrual** to `block.timestamp` (`IIrm.borrowRateView` + Taylor compounding,
   exactly `MorphoBalancesLib.expectedMarketBalances`);
3. reads `oracle.price()`, then computes `healthy = maxBorrow >= borrowed` with the contract's exact
   rounding (`toAssetsUp` for debt, `mulDivDown`/`wMulDown` for `maxBorrow`, virtual shares/assets).

A per-element try/catch isolates a bad market/oracle to a zeroed `valid = false` row.

### Eligibility and sizing

Offchain: liquidatable ⟺ `valid && hasDebt && !healthy` (permissionless, time-independent — no gate,
lock, or maturity). Sizing (`sizing/plan.ts`) is **seize-exact**:

```
repaidAssetsFull = borrowShares.toAssetsDown(accruedTotalBorrowAssets, totalBorrowShares)
seizeForFullDebt = mulDivDown(wMulDown(repaidAssetsFull, lif), ORACLE_PRICE_SCALE, collateralPrice)
seizedAssets     = min(collateral, seizeForFullDebt)   // repaidShares = 0; Blue ceil-derives it
```

Pinning the seize keeps an aggregator's fixed sell amount correct. The inbound double-floor guarantees
`repaidShares ≤ borrowShares`, so the onchain subtraction can't underflow (proved by a brute-force
sweep in `test/sizing/plan.test.ts`). When collateral binds (underwater), seizing 100% drives
`position.collateral` to 0 and Blue socializes the residual as bad debt in the same call. LIF is a pure
function of LLTV (`sizing/lif.ts`), capped at `1.15e18`.

### Quoting

For each liquidatable position, `quotes.ts` projects the lens output into a `@repo/swaps`
`QuoteRequest` and hands it to the package's `composeMultiVenueQuoting`. The package first runs the
**pre-swap unwrap chain**: if the seized collateral wraps an ERC-4626 vault or a Pendle PT, it
auto-detects that (memoized `eth_call` for ERC-4626; the Pendle SDK for PT) and prepends the redeem
step(s) that convert it to a tradable underlying — threading each hop's worst-case output forward so a
downstream fixed-amount step can never revert on a shortfall. When the unwrap chain already ends in
the loan token there is nothing left to sell, so the plan is the unwrap steps alone.

Otherwise it starts — without awaiting — a probe-cache refresh for the POST-unwrap
`(collateral, loan)` pair (staleness-gated, so quiet markets cost no venue calls) and ranks venues
against whatever the cache already holds, so a cold pair costs the preparation nothing and falls open to the
configured order. The sweep itself runs on the separate probe client at `PROBE_HTTP_RPS`, worst case
roughly ladder points per venue. It takes the best-first venue order
(enabled-but-unranked venues appended so a probe hiccup can't hide a venue), and fetches **one**
executable quote from the top venue — `0x` / `1inch` / `lifi` (one rate-limited API call,
route-bound fixed sell amount; LiFi routes keyless) — falling through to the next venue on failure.
A free oracle-based route-quality check (against the full-path oracle reference) rejects any route
more than `MAX_ROUTE_IMPACT_BPS` below it. Quotes are made only for the small liquidatable set, and
never for a position that is backed off. A failed quote (a venue error or timeout, no acceptable
route, or a route that forwards native value) backs its position off in blocks from the block it
was asked at, like a failed preparation: `BACKOFF_BASE_BLOCKS`, doubling with each consecutive failed
quote up to `BACKOFF_MAX_BLOCKS`. A quote that finds no path is
retried after `QUOTE_RETRY_MS`.

### Simulation

The exact `Executor.exec_606BaXt(...)` bytes are `eth_call`-simulated from the EOA. Only an `ok`
result is broadcast (`simulate.ok` gate). The exec is `liquidate` + an in-callback queue (via
`onMorphoLiquidate`) that runs the plan's steps — a plain collateral is one venue swap; exotic
collateral is unwrap step(s) then usually a venue swap — followed by the repay-token approval. After
`liquidate` returns, trailing `skim` sweeps drain both market tokens **plus every intermediate token
the unwrap chain introduced** to the EOA (the full-drain invariant: a fixed-amount step leaves the
worst-case-vs-actual surplus behind).

### Kernel and backoff

The kernel admits a liquidation only if the shared validator
([@repo/validators executor-liquidation.ts](../../framework/validators/src/executor-liquidation.ts))
reads it as creating no commitment: a zero-value `exec_606BaXt` whose first call is Morpho
`liquidate`, called back on the Executor, whose callback transfers nothing out and ends approving
Morpho, and whose trailing sweeps pay both market tokens and every approved token to the account. It
then simulates the exact bytes at its head, signs through `@repo/kit`'s kernel signer, re-bids a
transaction stuck for 8s at a higher fee, and records every nonce in its ledger before it acts.
When no bid fits under `MAX_FEE_GWEI`, the bot stays live but lands nothing new until fees fall,
and `tick.end` reports `pendingAtCeiling` and `oldestPendingMs`
([How a kernel bot bids](../../docs/framework/README.md#how-a-kernel-bot-bids)). It signs one
transaction at a time, but several may be pending, as many as its native reservations allow: one per nonce until its
transaction resolves, at the per-transaction spend ceiling. Liquidations sharing a swap route are not reserved
against each other: a squeezed route reverts at simulation or onchain, at the cost of gas.

A position backs off exponentially in blocks (`BACKOFF_BASE_BLOCKS` doubling to
`BACKOFF_MAX_BLOCKS`) when its quote fails, when its preparation's simulation reverts, and when the
kernel refuses a liquidation of it or ends one other than settled, unless a cancel ended it before
any of it ran; a settled one clears it. That includes a send the chain declined with an execution
revert, a deliberate divergence from `bots/midnight-liquidation`: blue's liquidation incentive is
static, so a shortfall on this block does predict the next one. A backed-off position is neither
quoted nor prepared. Failed quotes keep their own count of consecutive failures, which a route or a
missing path resets, as can its position being gone a whole maximum wait past it; every
`backoff.set` line carries the count and `untilBlock`.

### Log correlation

Every **position-scoped** event carries the position in one field, **`id`**, whose value is
`lensKey(marketId, borrower)`: the two halves joined by `:` with both lowercased. So a window's events
group into one row per position with **no normalization in the query** (`GROUP BY id`). `tx.*` used to
name the same string `label`; it does not any more. The full set:

`plan.skipped`, `plan.built`, `config.no_swap_path`, `quote.excluded_collateral`,
`unwrap.failed`, `unwrap.resolved`, `unwrap.bad_route`, `unwrap.preview_reverted`,
`unwrap.preview_zero`, `quote.floor_unmet`, `quote.ok`, `quote.failed`, `quote.route_quality_failed`, `quote.native_value`,
`probe.error`, `select.cold_default`, `select.ok`, `simulate.ok`, `simulate.revert`,
`prepare.error`, `act.submitted`, `act.dropped`, `backoff.set`, `backoff.cleared`,
`liquidation.not_sent`, `tx.submit_failed`, `tx.sent`, `tx.bumped`, `tx.broadcast_unknown`,
`tx.included`, `tx.reverted`, `tx.cancelled`, `tx.dropped`. The `tx.*` events come from the
kernel's activity; a replacement at the same `nonce` is `tx.bumped`, naming `oldHash` and
`newHash`. `tx.included` logs every successful receipt, even of a liquidation cancelled after it
went out, and `tx.cancelled` only a liquidation a cancel ended before it ran. Each distinct outcome
of a receipt is logged once, when it lands, as `tx.included` or `tx.reverted` (whose `notice` is
`null`): a reorg that lands the same outcome again is not logged again, and one that changes it is.
One that lands after its act already ended carries `nonce: null`, and one that lands after a restart
is not logged.

`plan.skipped` and `plan.built` also keep `marketId` and `borrower` as human-readable extras — for
reading a single line, not for grouping. A Blue Market has exactly one collateral, so one position is
one candidate: unlike `bots/midnight-liquidation`, `id` alone identifies a row and no candidate
discriminator is emitted.

Everything else is scoped to something other than a position and carries **no** `id`, by design —
per world reading (`discover.*`, `lens.read`, `source.read`, `tick.end`, `tick.error`), per venue pair
(`probe.venue_error`, `probe.refreshed`), kernel-wide (`kernel.running`, `kernel.error`,
`kernel.stopped`, `runner.failed`), or process/config (`startup`, `shutdown`, `quoting.*`,
`discovery.*`, `signer.*`, `heartbeat.*`, `pendle.*`).

#### Changes from the pre-kernel bot

For queries and dashboards written against the bot before it ran on the kernel:

- **`tick.end`**: `submitted` is now `broadcast`, and `cooledDown` is always 0. Preparations and
  sends finish after the read that started them, so the counters cover what finished since the
  previous world read, and the old per-tick sums no longer hold. It adds `oldestPendingMs`,
  `pendingAtCeiling` and `waitingMaxFeePerGasWei`.
- **`tx.submit_failed`** has no `executionRevert` or `selector`; its `reason` is `rejected` or
  `withheld`.
- **`tx.dropped`** carries the kernel `notice` that ended the act and that notice's `reason`, in
  place of the pending queue's reasons, such as `fee_ceiling`.
- **`plan.built`** is logged once per preparation, not on every tick.
- **Gone**: the queue's `tx.send_aborted`, `tx.replace_failed`, `tx.onblock_error`,
  `tx.observer_failed`, `nonce.sync_failed`, `queue.nonce_hole`, `queue.nonce_hole_cleared`,
  `reconcile.failed` and `queue.maintenance_failed`; the runner's `block.new`, `runner.start`,
  `runner.shutdown` and `watcher.error`; `cooldown.skip`; and the `railway_*` context fields.

## Testing

- `pnpm test` — unit tests for the math, LIF, seize-exact planner (incl. the underflow-safety sweep),
  the id derivation, API discovery (parsing, cursor pagination, retry semantics), config (incl. venue
  inference and the zero-venue gate), eligibility, quoting, venues, the exec encoder against the
  shared validator, the world read and the preparation, and acceptance scenarios that run the whole
  graph and its kernel against a fake chain, including a burst measured in settlements per block.
- **Live read-path probe** — `pnpm --filter @morpho-org/blue-liquidation run probe:lens` (needs
  `RPC_URL`, no anvil) runs the deployless lens against a sample of real Base borrowers, prints a
  valid/hasDebt/healthy/liquidatable breakdown + a decoded sample. Run it any time to confirm the read
  path against production (last run: 256/256 returned, all valid, 0 liquidatable — a healthy market).
- **Fork suite** (`test/fork/`) — end-to-end on a Base fork; it skips unless `RPC_URL_8453` is set.
  It opens a position in Base's WETH/USDC market near its LLTV, swaps the market's oracle for one
  quoting 90% of the real price, then runs the liquidator with its real kernel and asserts the
  liquidation lands, the ledger records its nonce, a clean stop finalizes the journal, the EOA gains
  the loan token, and the Executor ends holding zero of both tokens.
  - Two fork assertions are not written yet. (1) An underwater position, asserting the
    collateral-binds path drives `position.collateral` to 0 and socializes the residual (supplier
    `totalSupplyAssets` drops): nothing blocks it, and it can reuse `seedUnhealthyPosition` with a
    price drop deep enough that the collateral cannot cover the debt; meanwhile the `plan.test.ts`
    underflow sweep covers the safety property. (2) A kernel replacement: the fork mines each
    transaction as it arrives, so none stays pending long enough to be replaced; the kit's
    `kernel.anvil` suite covers replacement against a local node instead.

## Important operational notes

- **Broadcast path**: use an RPC that relays. `rpc.morpho.dev/realtime` acks sends but never relays,
  which leaves the kernel's transaction unresolved until it gives it up.
- **Kernel state**: each release needs a volume at `KERNEL_STATE_DIR`; start a fresh account once
  with `KERNEL_ENROLLMENT=enrolling`, then `enrolled` once it logs `kernel.running`. The chart provisions the volume and sets `KERNEL_STATE_DIR`; the release sets
  `KERNEL_ENROLLMENT` (see [Kernel state](#kernel-state)).
- **Lens gas model** is currently **unset**, deliberately. Nothing about it is load-bearing: a chunk
  resizes from what its own pages report, so stating nothing costs continuation round trips and never
  a result — while a model viem-dlc rejects as malformed is ignored silently in favour of packing by
  bytes, which is worse than stating nothing. Populate `batch.gas` from the wide event's `fixed_gas`,
  `item_gas_avg` and `item_gas_stddev` once real traffic has been observed; do not guess.
- **Discovery health**: at boot the bot logs `discovery.startup` with this chain's candidate count
  and a parsed `MarketParams` sample (or `discovery.startup_error` with the API message; a redirect
  or a 4xx other than 429, from a bad `MORPHO_API_KEY` or URL, is a fatal `startup.error` instead).
  Grep those first, then per reading: `discover.error` (an API failure — the read fails and no
  position changes; transient unless it says the API rejected the key, refused the request or
  redirected it, which an operator fixes in the runtime secret), `discover.dropped` (malformed rows
  or ids that don't resolve on this chain's singleton — API schema drift or a wrong-deployment
  mismatch), and `discover.max_pages` (pagination backstop hit — under-inclusion, investigate
  immediately). There is no indexer-lag signal anymore: API indexing latency is a coverage concern
  only, since the lens re-reads every candidate fresh onchain each block.
- **Coverage** spans every listed market server-side; the lens re-reads all discovered candidates
  each block, bounded by the `HEALTH_FACTOR_LTE` cutoff rather than a borrow-event history.
