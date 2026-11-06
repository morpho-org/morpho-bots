# Midnight crossed-books resolver

The bot lists active, listed Midnight Markets through the Morpho API, loads both takeable Router book
sides, greedily pairs crossed asks and bids, simulates the exact resolver transaction, and sends only
a profitable one.

## How it works

The bot runs on the bot framework: the engine, the transaction kernel and the controller's task
family ([`docs/framework/AUTHORING.md`](../../docs/framework/AUTHORING.md)). Its key is used only
through the kernel, and the `crossed-books` validator in `@repo/validators` reads every transaction
before the kernel signs it.

- **Scan.** Every `SCAN_INTERVAL_MS`, at the kernel's head, the bot reads every listed market's book
  sides, matches them (`MatchingService`), encodes `resolve` with `MIN_PROFIT_ASSETS` as its floor,
  and simulates it there as the account that would send it. A market whose resolution simulates is
  _crossed_; one whose books do not cross, or whose resolution reverts, is not. A market whose book
  or simulation failed reads as failed, which withdraws any resolution resting on it; a failed
  market list changes nothing.
- **Resolve.** Each crossed market is one resolution, resting on the fact that the scan computed
  exactly these calldata bytes. The bot sends one resolution at a time, and crossed markets take
  turns. The kernel simulates the bytes again at its own head before it signs, and drops the act
  if a later scan computes other bytes for that market first.
- **Validator.** The kernel signs only a zero-value `resolve` to the resolver whose takes cross one
  market on this chain's Midnight in equal units and never take the account's own offer
  ([validators SPEC §4](../../framework/validators/SPEC.md#4-crossed-books-resolution)). The signer
  policy pins the chain, the resolver, the `resolve` selector, and the fee, gas and calldata
  ceilings.

The permissionless `CrossedBooksResolver` needs no inventory. It recursively takes every crossed sell
offer through nested `onBuy` callbacks. The deepest callback sells all received units into the
crossed buy offers, approves the aggregate sell cost, and lets the callbacks unwind. The positive
loan-token balance delta goes to `msg.sender`. Same-market checks, balanced units, settlement fees,
rounding, stale offers, callbacks, and minimum profit remain atomic.

## Generated API clients

The upstream schemas are checked in so builds never depend on network access:

- `morpho-api.json` — Morpho Midnight API market discovery schema.
- `router-api.json` — Router book and takeable-offer schema.

Regenerate types after updating either schema:

```sh
pnpm --filter @morpho-org/midnight-crossed-books run generate:api
pnpm format
pnpm --filter @morpho-org/midnight-crossed-books run typecheck
```

The generated files live under each infrastructure adapter's `generated/` directory and are not
edited by hand.

## Configuration

- `CHAIN_ID` — required, currently `8453`.
- `RPC_URL` — required. `RPC_URL_FALLBACK` is optional.
- `READONLY` — optional; `true`/`1` enables simulation-only mode, while absent/`false`/`0` selects
  write mode. Other values are rejected.
- `RESOLVER_ADDRESS` — optional deterministic deployment override. Startup refuses a resolver whose
  `MIDNIGHT()` is not the configured Midnight.
- `API_BASE_URL` — Morpho API origin, default `https://api.morpho.org`.
- `ROUTER_API_BASE_URL` — Router API origin, defaults to `API_BASE_URL` for the public gateway.
- `MIN_PROFIT_ASSETS` — raw loan-token units, default `1`; one value applies to all markets. No
  fee bound depends on profit, so set it above a resolution's expected fee, in every listed loan
  token's units.
- `MAX_MATCHES` — maximum crossed matches per resolver transaction, default `10`.
- `SCAN_INTERVAL_MS` — default `15000`. A scan authorizes resolutions for two intervals from when it
  started.

Write mode also requires these, with no defaults:

- `RESOLVER_PRIVATE_KEY` — the `0x`-prefixed 32-byte key of the account that sends resolutions and
  receives their profit.
- `MAX_FEE_GWEI` — the ceiling on one gas unit.
- `MAX_SPEND_ETH` — the ceiling on what one transaction spends on fees. The kernel reserves it from
  the account's ETH before every act, and refuses acts the balance cannot cover.
- `MAX_GAS_LIMIT` — the ceiling on a signed transaction's gas limit, at least 21,000.
- `FINALITY_8453` — `safe`, `finalized`, or a block depth.
- `KERNEL_STATE_DIR` — where the kernel keeps its ledger and the journal; it must survive a restart.
- `KERNEL_ENROLLMENT` — `enrolling` for the first start of an account, `enrolled` after.
- `JOURNAL_RUN_CAP_BYTES` — the size at which a run's journal stops the bot cleanly.
- `BUILD_REVISION` and `BUILD_IMAGE_TAG` — the build the journal names; the image sets them.

Readonly mode needs `SIMULATION_CALLER_ADDRESS` instead: the non-zero public EOA that would execute
resolutions in write mode, so `msg.sender`, profit transfers and reverts match execution without
loading its private key. Readonly mode neither reads nor keeps `RESOLVER_PRIVATE_KEY`, and runs no
kernel.

## Deploy the contract

```sh
RPC_URL=https://… DEPLOYER_PRIVATE_KEY=0x… \
MIDNIGHT_ADDRESS=0xAdedD8ab6dE832766Fedf0FaC4992E5C4D3EA18A \
pnpm --filter @repo/contracts run deploy:crossed-books-resolver
```

## Run

```sh
CHAIN_ID=8453 RPC_URL=https://… READONLY=true \
SIMULATION_CALLER_ADDRESS=0x… \
pnpm --filter @morpho-org/midnight-crossed-books run start
```

Readonly mode scans at the latest block every `SCAN_INTERVAL_MS`, logs each profitable result as
`match.computed`, and never creates a signer, a kernel, or a transaction.

To send profitable resolutions instead, run write mode with the variables above, or
`docker compose up` in this directory.

## Deploy

The bot is not deployed yet. It will run on the AWS `tools` EKS cluster, deployed by Argo CD from the
chart at [`helm/midnight-crossed-books`](./helm/midnight-crossed-books); the Argo CD applications
live in `morpho-org/morpho-infra` under `gitops/tools`. ECR `bots/midnight-crossed-books` images are
published by `.github/workflows/publish-liquidation-ecr.yml`, and a merged PR whose description says
`Releases crossed-books` adds its release tag to that image.

### Release values

A write-mode release sets `image.repository`, `image.tag`, `serviceAccount.name`,
`serviceAccount.roleArn`, `runtimeSecret.key`, and these `env` entries, none of which the chart
defaults:

| Var                 | Base (`8453`)                |
| ------------------- | ---------------------------- |
| `CHAIN_ID`          | `8453`                       |
| `FINALITY_8453`     | `safe`                       |
| `MAX_FEE_GWEI`      | `0.5`                        |
| `MAX_SPEND_ETH`     | `0.0075`                     |
| `MAX_GAS_LIMIT`     | `15000000`                   |
| `KERNEL_ENROLLMENT` | `enrolling`, then `enrolled` |

At these values one transaction's L2 execution fee is at most 0.0075 ETH; Base's L1 data fee comes on
top and grows with the resolution's calldata. Keep the account funded above `MAX_SPEND_ETH`: below
it the kernel refuses every act. A readonly release sets `READONLY=true` and
`SIMULATION_CALLER_ADDRESS` instead of the last five.

The chart sets `KERNEL_STATE_DIR=/repo/state`, where it mounts the state volume, and
`JOURNAL_RUN_CAP_BYTES` from `state.journalRunCapBytes` (1 GiB), and refuses a release whose `env`
sets either. `state.storageClass` (`tools-gp3`) and `state.size` (`10Gi`) shape that volume. The
claim `<statefulset>-state` holds the ledger, `kernel-8453-<account>.json`, and the journal; neither
`helm uninstall`, deleting the Argo CD application, nor a prune deletes it. The pod gets 120 seconds
to stop, so the kernel can settle what it has in flight.

### Runtime secret

The ExternalSecret reads `RPC_URL`, optional `RPC_URL_FALLBACK`, `RESOLVER_PRIVATE_KEY` (unless
readonly), and optionally `BETTERSTACK_SOURCE_TOKEN`, `BETTERSTACK_INGESTING_HOST` and
`BETTERSTACK_HEARTBEAT_URL` from Secrets Manager `midnight-crossed-books/<env>/8453/runtime`. Dev and
production hold distinct keys, and no other bot signs with this one: a send from it outside the kernel
moves the nonce past its ledger.

### Enrollment

`KERNEL_ENROLLMENT` is `enrolling` for the first start of an account with no ledger and `enrolled`
for every start after it. The kernel refuses an enrollment over an existing ledger and an enrolled
start with none: it logs `kernel.stopped` with `outcome: refused` and exits.

1. Confirm the account has no transaction pending.
2. Set `KERNEL_ENROLLMENT=enrolling` and sync. The start waits, signing nothing, until the account's
   nonce at `safe` matches its latest one.
3. Wait for `kernel.running`, logged once the first ledger write lands.
4. Set `KERNEL_ENROLLMENT=enrolled` and sync before anything else restarts the pod.

## Observability

Every scan logs `match.computed` (`marketId`, `units`, `profit`) for each market whose resolution
simulates, `match.not_profitable` with the decoded revert for each that does not,
`books.fetch_failed` or `match.failed` for a market it could not read, and `tick.no_match` when no
market crossed. In write mode it also logs `source.read` (`source`, `block`, `durationMs`, `coverage`) when a
scan's read lands, `tick.end` with the crossed markets in flight or backed
off and the kernel's pending-nonce fields, the controller's `act.*` and `backoff.*` events, and the
kernel's `tx.*` events, `resolution.not_sent` for an act that never broadcast, and `kernel.stopped`.

Every act and transaction event carries the **market id** as `id`. It does not join to a
liquidator's `id`, which is `marketId:borrower`.

## Test

```sh
pnpm --filter @morpho-org/midnight-crossed-books run test
pnpm --filter @repo/validators run test
forge test --root packages/contracts -vv
```

The bot's tests cover configuration, the scan's coverage, the kernel's limits and signer policy,
readonly mode, the Helm chart, and scenarios on a fake chain: sending exactly the simulated bytes,
one resolution at a time, and nothing the validator or the kernel's own simulation refuses. The
resolver's Forge tests cover permissionless execution, atomic rollback, balance preservation and
allowance cleanup.
