# Market making bot

> [!WARNING]
> The market-making bot is a work in progress, must not be used yet, and is expected to be ready for use around August 12, 2026.

Implements the market-maker setup readiness gate from
[TIB-2026-07-27](../../docs/decisions/TIB-2026-07-27-midnight-market-making-bot.md) for
[MKT-1459](https://linear.app/morpho-labs/issue/MKT-1459).

## Architecture

The package follows the repository's hexagonal architecture:

- `SetupCheckService` owns the read-only readiness workflow and its consumer-owned `SetupStateService`
  port.
- `ViemSetupStateService` is the concrete RPC/Morpho API/Router API adapter.
- `ConfigService` validates YAML plus environment configuration once and narrows addresses, bytes32
  IDs, bootstrap settings, and ladder settings.
- `PositionBootstrapService` and `LadderMarketMakerService` define the current application/domain
  boundary through consumer-owned fresh-state, reference-rate, and blocking make ports.
- `ReadOnlyBootstrapMakeService` and `ReadOnlyLadderMakeService` implement those make ports with
  terminal JSON output and no signing or mutation.
- `bootstrap.ts` is the manual composition root.
- `Cli` is the operator adapter and `index.ts` is a thin entrypoint.

The setup service launches independent provider reads with `Promise.all`. Each read has its own error
boundary, so a rejected provider call becomes the corresponding failed report item and does not stop
other checks. Book reads also run concurrently; book validation waits only for the latest timestamp it
needs for maturity comparison.

Concrete ladder tick conversion, lower/higher-to-buy/sell mapping, offer encoding, live publication,
and runtime loop composition do not exist yet. Those ladder-specific concerns remain deferred
infrastructure adapters. Position bootstrap has production read, reference-rate, publication, and
invalidation adapters plus a one-minute monitoring lifecycle. Its read-only make adapter performs
the same fresh whole-book prospective-spread validation, then renders the requested operations
without signing or submission.

## Setup-check configuration

All values are required except `V0_OFFER_GROUP_IDS`, `REQUEST_TIMEOUT_MS`, and
`MAKER_PRIVATE_KEY` when `--readonly` is set:

- `CHAIN_ID`: must be `8453` (Base).
- `RPC_URL`: Base RPC used for current chain state.
- `REFERENCE_RPC_URL`: archive-capable Base RPC. Setup verifies a latest block and reads the exact
  configured Blue reference market at a historical block approximately 10,800 blocks earlier.
- `REFERENCE_MARKET_ID`: 32-byte Morpho Blue market ID used by the variable-rate strategy. Setup
  fails closed when its immutable parameters or historical market state are missing or unreadable.
- `MAKER_PRIVATE_KEY`: 0x-prefixed 32-byte private key; never logged. It is not loaded, validated, or
  required in `--readonly` mode.
- `MAKER_ADDRESS`: configured maker address. Write mode verifies that the private key derives it;
  read-only mode uses the address directly.
- `MIDNIGHT_ADDRESS`: expected Midnight singleton.
- `LOAN_ASSET_ADDRESS`: expected market loan asset.
- `RATIFIER_ADDRESS`: selected Base Ecrecover ratifier. V0 requires the address in the official
  Router `/v0/config/contracts` registry, verifies deployed code and the `MIDNIGHT` /
  `isRootCanceled` Ecrecover surface, checks that its immutable Midnight target matches, and verifies
  `Midnight.isAuthorized(maker, ratifier)`.
- `MARKET_IDS`: comma-separated allowlisted 32-byte market IDs; at least one is required. IDs are
  canonicalized by bytes, so equivalent mixed-case hex values compare identically.
- `NATIVE_RESERVE_WEI`: minimum native balance in wei.
- `MAXIMUM_LEND_EXPOSURE_ASSETS`: minimum loan-token allowance in raw assets.
- `MORPHO_API_BASE_URL`: Morpho API origin used by `MidnightApi.fetchBooks` to verify active books
  and to traverse the maker's complete `/v0/midnight/users/{maker}/offer-groups` source. The latter
  includes fresh active offers before a takeable amount is measured; repeated cursors, oversized
  pages, excessive items, and aggregate deadline expiry fail closed.
- `ROUTER_API_BASE_URL`: official Router API origin used to verify the ratifier registry.
- `REQUEST_TIMEOUT_MS`: optional bounded fetch/RPC timeout in milliseconds; defaults to `10000` and
  must be between `1` and `120000`.
- `V0_OFFER_GROUP_IDS`: optional comma-separated strategy-owned group IDs. Confirmed groups published
  by this bot are also recorded mode `0600` under
  `$XDG_STATE_HOME/morpho-market-making` (or `~/.local/state/morpho-market-making`) using a maker-and-
  market-bound namespace, so deployments must persist that directory across restarts. Any active
  maker group absent from both explicit sources, or any active offer on a market outside `MARKET_IDS`
  even when its group is known, fails readiness. Group IDs are canonicalized by bytes.

## Run

```sh
bun run --filter @morpho-org/market-making-bot start -- setup-check

# Address-only setup inspection: MAKER_PRIVATE_KEY may be omitted.
bun run --filter @morpho-org/market-making-bot start -- --readonly setup-check

# Repeat read-only readiness checks every minute until SIGINT/SIGTERM.
bun run --filter @morpho-org/market-making-bot start -- setup-check --monitor

# One live position-bootstrap cycle.
bun run --filter @morpho-org/market-making-bot start -- bootstrap

# One address-only cycle that logs desired make operations without submitting them.
bun run --filter @morpho-org/market-making-bot start -- --readonly bootstrap

# Repeat bootstrap every minute; SIGINT/SIGTERM drains the current cycle and removes owned offers.
bun run --filter @morpho-org/market-making-bot start -- bootstrap --monitor

# Exercise the complete monitor and cleanup lifecycle without signing or submitting.
bun run --filter @morpho-org/market-making-bot start -- --readonly bootstrap --monitor
```

Success exits zero and writes JSON Lines to standard output. Ordinary commands emit one report record;
a read-only writer command emits zero or more `readonly.make` records followed by its final cycle
report. Consumers must parse stdout one line at a time rather than as one JSON document. Bigints are
serialized as decimal strings. Any failed check throws `SetupFailedError`, prints the failed check
names, and exits non-zero. The check is strictly read-only; remediation transaction descriptions are
reported but never submitted. With `--readonly`, only private-key/maker agreement is reported as
`not-required`; balance, allowance, ratifier, chain, market, reference, and active-offer observations
still run against the configured maker address.

`setup-check --monitor` runs the same complete read-only observation every minute and streams each
report. The first report with `ready: false` halts monitoring, includes that report in the terminal
`setup-failed` record, and exits with code `1`. `SIGINT` or `SIGTERM` after successful checks lets an
in-flight check finish and emits a final `{"status":"stopped","reason":"signal","cycles":N}` record
with exit code `0`. Monitoring never signs, submits remediation, or performs shutdown cleanup. Add
the root `--readonly` flag when private-key/maker agreement should be omitted.

Read-only make adapters serialize desired bootstrap and ladder reconcile/hard-halt requests as one
JSON line with event name `readonly.make`. They never sign or submit an operation. The
`--readonly bootstrap` command executes one complete observational decision cycle and routes every
requested mutation through this terminal adapter after deriving its exact tick, comparing the
prospective offer with the complete current maker book, and applying the SDK's live Mempool-policy
validation without signing or broadcasting.
The corresponding final cycle outcome uses `status: "logged"` rather than `"applied"`.

`bootstrap --monitor` requires at least one explicit `bootstrap` / `BOOTSTRAP_MARKETS` entry. It
serially runs a cycle every minute and streams each result. `SIGINT` or `SIGTERM` lets an in-flight
cycle finish, then invalidates every explicitly owned bootstrap group through the same mutation
queue and waits for bounded transaction receipts. The final record reports the number of cycles and
whether cleanup was applied, logged, or failed. Read-only monitoring logs the cleanup request and
never loads a private key.

Version output remains available:

```sh
bun run --filter @morpho-org/market-making-bot start -- --version
```

## Test

```sh
bun test bots/market-making/test
bun run --filter @morpho-org/market-making-bot test:e2e
bun run --filter @morpho-org/market-making-bot typecheck
```

The e2e suite starts its own Anvil fork of Base at a pinned historical block. It requires the
`anvil` binary on `PATH` and an archive-capable `RPC_URL_8453`.

## YAML and position-bootstrap configuration

The following configuration contract extends the environment-only setup gate above.

## Configuration sources and precedence

Configuration can come from environment variables, a YAML file, or both. YAML files and the
`BOOTSTRAP_MARKETS` and `LADDER_MARKETS` values are each limited to 1 MiB before parsing.

1. `--config <path>` selects that exact `.yaml` or `.yml` file. Other path extensions and a missing,
   unreadable, empty, oversized, malformed, symlinked, or non-regular explicitly named file fail
   startup. Default-discovered symlinks are rejected as unreadable too.
2. Without `--config`, the CLI searches the process working directory from which `mm` was invoked.
   It checks `market-making.yaml` first, then `market-making.yml`. If both exist, `.yaml` wins.
3. If neither default file exists, environment-only startup remains supported.
4. Every supplied environment variable overrides the corresponding YAML value. A duplicate value is
   never an error.

Scalar fields override independently. `MARKET_IDS` and `V0_OFFER_GROUP_IDS` each replace their
complete YAML list. `BOOTSTRAP_MARKETS` and `LADDER_MARKETS` replace the complete YAML `bootstrap` and
`ladder` lists respectively; arrays are never partially or positionally merged. YAML syntax and
source-safety checks run before overlay,
then only the effective merged configuration is semantically validated, so replaced invalid values do
not block startup while parser hazards in replaced sections still do.

Use [`market-making.example.yaml`](./market-making.example.yaml) as the complete YAML template and
[`.env.example`](./.env.example) as the environment template. Default discovery never selects the
example filename.

```sh
# Explicit file; relative paths resolve from the invocation working directory.
bun run --filter @morpho-org/market-making-bot start -- --config ./market-making.yml setup-check

# Default discovery in the current working directory.
bun run --filter @morpho-org/market-making-bot start -- setup-check

# Address-only mode works with either configuration source.
bun run --filter @morpho-org/market-making-bot start -- --readonly setup-check
```

### Environment mapping

| Environment variable           | YAML key                          | Required/default                                                 |
| ------------------------------ | --------------------------------- | ---------------------------------------------------------------- |
| `CHAIN_ID`                     | `chain.id`                        | Required; must be Base `8453`                                    |
| `RPC_URL`                      | `chain.rpcUrl`                    | Required current-state Base RPC URL                              |
| `REFERENCE_RPC_URL`            | `chain.archiveRpcUrl`             | Required archive-capable Base RPC URL                            |
| `MAKER_ADDRESS`                | `identity.makerAddress`           | Required maker EVM address                                       |
| `MAKER_PRIVATE_KEY`            | `identity.makerPrivateKey`        | Required write-mode key; omitted with `--readonly`               |
| `MIDNIGHT_ADDRESS`             | `contracts.midnightAddress`       | Required Midnight singleton address                              |
| `LOAN_ASSET_ADDRESS`           | `contracts.loanAssetAddress`      | Required loan-token address                                      |
| `RATIFIER_ADDRESS`             | `contracts.ratifierAddress`       | Required Router-listed Ecrecover ratifier                        |
| `MORPHO_API_BASE_URL`          | `apis.morphoBaseUrl`              | Required books and Mempool offer-group API origin                |
| `ROUTER_API_BASE_URL`          | `apis.routerBaseUrl`              | Required Router contract-registry API origin                     |
| `MARKET_IDS`                   | `markets.allowlist`               | Required; comma-separated bytes32 IDs / YAML list                |
| `REFERENCE_MARKET_ID`          | `markets.referenceMarketId`       | Required Morpho Blue reference market ID                         |
| `V0_OFFER_GROUP_IDS`           | `markets.v0OfferGroupIds`         | Optional; comma-separated bytes32 IDs / YAML list; defaults `[]` |
| `NATIVE_RESERVE_WEI`           | `setup.nativeReserveWei`          | Required unsigned integer wei                                    |
| `MAXIMUM_LEND_EXPOSURE_ASSETS` | `setup.maximumLendExposureAssets` | Required unsigned raw loan-asset units                           |
| `REQUEST_TIMEOUT_MS`           | `setup.requestTimeoutMs`          | Optional; default `10000`, range `1..120000`                     |
| `BOOTSTRAP_MARKETS`            | `bootstrap`                       | Optional JSON array; whole-list replacement; defaults `[]`       |
| `LADDER_MARKETS`               | `ladder`                          | Optional JSON array; whole-list replacement; defaults `[]`       |

There is no separate Mempool endpoint or API-key field in the current clients. Books and cursor-paginated
maker offer groups are read through `MORPHO_API_BASE_URL`; `ROUTER_API_BASE_URL` is used only for the
`/v0/config/contracts` ratifier registry. The existing clients do not accept configured API-key
headers. No unused credential setting is exposed.

### YAML schema

The root accepts exactly `chain`, `identity`, `contracts`, `apis`, `markets`, `setup`, `bootstrap`,
and `ladder`; unknown keys at any level are rejected. Every supported key appears in
[`market-making.example.yaml`](./market-making.example.yaml).

- `chain`: `id`, `rpcUrl`, `archiveRpcUrl`.
- `identity`: `makerAddress`, `makerPrivateKey`.
- `contracts`: `midnightAddress`, `loanAssetAddress`, `ratifierAddress`.
- `apis`: `morphoBaseUrl`, `routerBaseUrl`.
- `markets`: `allowlist`, `referenceMarketId`, `v0OfferGroupIds`.
- `setup`: `nativeReserveWei`, `maximumLendExposureAssets`, `requestTimeoutMs`.
- `bootstrap`: an ordered list of the exact per-market objects documented below.
- `ladder`: an ordered list of the exact per-market objects documented below.

Addresses and bytes32 IDs should be quoted YAML strings. Every integer field uses exact decimal-integer
syntax: unsigned fields accept digits only, while `premiumBps` additionally accepts one leading minus.
Exact raw-unit amounts may be quoted decimal strings or bare YAML decimal integers without precision
loss. Floats, exponent notation, leading plus signs, surrounding whitespace inside quoted integers,
negative unsigned amounts, wrong scalar/list/object types, duplicate keys or IDs, aliases, custom tags,
prototype keys, unsupported keys, and malformed YAML are rejected. Rates and premiums are integer basis
points (`100` = one percentage point); floats are never coerced. Each YAML `autoRefill` value must be
the unquoted lowercase plain scalar `true` or `false`. Environment integer values follow the same
decimal syntax after outer environment whitespace is trimmed.

### Setup checks

Setup verifies all of the following from the typed configuration:

- Base chain identity and configured Midnight bytecode.
- Native reserve, loan-token allowance, and ratifier readiness for the configured maker address.
- Maker/private-key agreement in write mode; only this signer-identity check is `not-required` with
  `--readonly`. Maker identity is reduced to configured/derived/matches status and the address is
  never included in operator output.
- Every allowlisted market is active, uses the configured loan asset, has valid tick spacing and
  maturity, and agrees between API and chain state.
- The exact Blue reference market is readable from the archive provider.
- Active offer groups belong to configured namespaces and markets and are not crossed/inverted.

`V0_OFFER_GROUP_IDS` is optional. Readiness and every writer use the same explicit ownership source:
configured IDs plus bot-issued IDs from the maker-and-market-bound state file. Publication first durably
reserves the SDK-derived group ID, broadcasts only after that write succeeds, and then promotes the
reservation to confirmed ownership. A failed broadcast removes its reservation; if confirmation storage
fails after a successful broadcast, the reservation remains sufficient to recognize the group from fresh
provider data without claiming that an absent group is live. A same-market maker group absent from these
sources remains unknown, fails readiness, and requires an operator decision; market membership alone never
permits reconciliation or hard-halt cancellation. The request timeout is an aggregate fetch/RPC bound and
does not reveal endpoint details in failures.

Bootstrap offer-group reads request Base explicitly, ignore well-formed rows from other chains, and fail
closed on malformed chain identity, asset strings, or empty/repeated pagination cursors. The variable Blue
reference hard-fails when its latest checkpoint is more than five minutes behind wall-clock time.

### Position-bootstrap fields

Each `bootstrap` entry must use a unique `marketId` present in `markets.allowlist`.

| Field                   | Unit / behavior                                                 | Validation                                                |
| ----------------------- | --------------------------------------------------------------- | --------------------------------------------------------- |
| `marketId`              | 0x-prefixed 32-byte Midnight market ID                          | Required, unique, and allowlisted                         |
| `creditTarget`          | Raw credit units; complete at `creditTarget - acceptanceAssets` | Positive unsigned integer                                 |
| `acceptanceAssets`      | Raw acceptable shortfall                                        | Non-negative and no greater than `creditTarget`           |
| `offerSize`             | Raw desired offer size before capacity caps                     | Positive unsigned integer                                 |
| `premiumBps`            | Integer BPS added to the reference rate                         | Zero or negative                                          |
| `maximumMarketExposure` | Raw per-market exposure cap                                     | Positive and no greater than `maximumTotalExposure`       |
| `maximumTotalExposure`  | Raw strategy-wide exposure cap                                  | Positive                                                  |
| `minimumRateBps`        | Inclusive final-rate minimum                                    | Non-negative and no greater than `maximumRateBps`         |
| `maximumRateBps`        | Inclusive final-rate maximum                                    | Non-negative                                              |
| `autoRefill`            | Resume after first observed completion if credit later falls    | Boolean; completion memory lasts for one service instance |

For a market below its accepted target, desired assets are the minimum of `offerSize`, remaining
credit target, cash balance, remaining per-market exposure, and remaining total exposure. Replacement
capacity excludes that market's representative live group while retaining every other active group's
exposure. Zero or negative capacity leaves no offer. The final requested rate is `reference rate +
premiumBps`; an out-of-bounds result is rejected rather than clamped.

`BOOTSTRAP_MARKETS` uses an exact JSON array with the same fields; YAML syntax, duplicate object keys,
and prototype keys are rejected. Every integer-valued property—including asset amounts, exposure caps,
rates, and `premiumBps`—must be a quoted decimal-integer string. JSON number tokens are rejected even
when integral; `marketId` remains a string and `autoRefill` remains a JSON boolean. Supplying it replaces
every YAML bootstrap entry, which avoids ambiguous partial-array merge behavior. See
[`.env.example`](./.env.example) for exact syntax.

`mm setup-check --monitor` repeats non-overlapping read-only readiness observations every minute
until its shutdown signal or the first failed report. `mm bootstrap` first runs the same one-shot
readiness gate as `setup-check`, then executes exactly one position-bootstrap cycle and prints its
bigint-safe JSON result. `mm bootstrap --monitor` uses the same gate, repeats non-overlapping cycles
every minute, and performs owned-group cleanup after its shutdown signal. Version output, setup
monitoring, invalid usage, and application construction do not start bootstrap.

`runOnce()` validates every market before any position/reference read or publication. Invalid
configuration, reference failures, and decision failures invoke strategy-wide `hardHalt`; ordinary
position-read failure requests market-local invalidation and permits other markets to continue.
The production adapters re-read owned Mempool groups, serialize invalidation and publication, and
persist group ownership before broadcast. Receipt polling is bounded by `REQUEST_TIMEOUT_MS`.
Read-only mode retains the same decisions and fresh prospective whole-book comparison but logs every
requested make and graceful-cleanup operation instead.

### Ladder fields and formulas

Each `ladder` entry has a unique allowlisted `marketId`. Rates are integer BPS and asset/exposure
amounts are exact raw loan-asset units. `quotePremiumBps` and `sizeSkewBps` are signed; all other
integer fields are nonnegative or positive as shown by the example. `spreadBps` is a positive even
full spread, `stepBps` is positive, `rungCount` is a positive safe integer no greater than 512, and
`loopIntervalSeconds` is a positive safe integer. `movementToleranceBps` is nonnegative, and
`groupMode` is `shared-rung` or `per-book`. The rung limit bounds local allocation to 1,024 offers
for a two-sided ladder, a height-10 tree below the Midnight SDK's height-20 protocol limit.

For reference `R`, effective center `C = R + quotePremiumBps`. With zero-based rung `k`:

```text
lower rate = C - spreadBps / 2 - k * stepBps
higher rate = C + spreadBps / 2 + k * stepBps
```

The complete static shape must fit between `minimumRateBps` and `maximumRateBps`. Every runtime rung
must also remain inside that inclusive hard range; values are rejected, never clamped. A retained
center is recentered only when absolute effective-center movement is strictly greater than
`movementToleranceBps`; capacity changes still resize quotes inside that tolerance.

Rung weight `k` is `10000 + k * sizeSkewBps`, and every weight must stay positive. Positive skew
weights outer rungs more heavily; negative skew weights inner rungs more heavily. Each configured
`lowerRateBudgetAssets` / `higherRateBudgetAssets` is first capped by its fresh side capacity. The
fresh target-market and strategy-total capacities then cap both sides in aggregate; when that cap
binds, capacity is split proportionally between the requested side budgets with the bigint remainder
assigned to the higher-rate side. Exact bigint proportional division allocates each nonzero side
across its rungs, and the outermost rung receives the remainder so the side sums exactly to its capped
budget. A side with zero fresh capacity produces no rungs, and any individual rung whose bigint
allocation rounds to zero is omitted. Hard-rate bounds apply to every nonzero rung that can be
published; an exhausted side cannot trigger a bound failure. `targetMarketExposureAssets` must not
exceed `maximumTotalExposureAssets`.

`LADDER_MARKETS` is exact JSON with the same fields. Every integer-valued property must be a quoted
decimal string; JSON number tokens, floats, exponents, malformed values, unknown fields, duplicate
markets, and markets outside `MARKET_IDS` are rejected. The variable replaces the YAML list before
semantic validation, so a valid environment list can replace semantically invalid YAML while YAML
parser hazards still fail closed.

### Secrets and failure behavior

Do not commit real configuration. The repository ignores `market-making.yaml` and
`market-making.yml` while keeping the example trackable. Prefer environment variables for the maker
private key and future credentials. If a local YAML file contains a secret, restrict access (for
example `chmod 600 market-making.yaml`).

Configuration errors contain stable field/reason metadata but never rejected values, URLs, private
keys, parser snippets, or nested third-party errors. Explicit file failures are loud but do not echo
the supplied path. Runtime setup reports identify providers by stable IDs only.

## Run

```sh
bun run --filter @morpho-org/market-making-bot start -- setup-check
bun run --filter @morpho-org/market-making-bot start -- --readonly setup-check
bun run --filter @morpho-org/market-making-bot start -- setup-check --monitor
bun run --filter @morpho-org/market-making-bot start -- bootstrap
bun run --filter @morpho-org/market-making-bot start -- --readonly bootstrap
bun run --filter @morpho-org/market-making-bot start -- --version
```

Success exits zero and writes JSON Lines to standard output. Ordinary commands emit one report record;
a read-only writer command emits zero or more `readonly.make` records followed by its final cycle
report. Consumers must parse stdout one line at a time rather than as one JSON document. Bigints are
serialized as decimal strings. Any failed check throws `SetupFailedError`, prints the complete
sanitized report, and exits non-zero. A bootstrap safety halt likewise prints its sanitized per-market
cleanup report before exiting non-zero. The check is read-only; remediation transaction descriptions
are reported but never submitted. `--readonly` also removes the private-key requirement, marks only
maker/private-key agreement as `not-required`, and replaces bootstrap submission with
`readonly.make` terminal output. Dry-run mutation outcomes use `status: "logged"` rather than
`"applied"`.

## Test

```sh
bun test bots/market-making/test
bun run --filter @morpho-org/market-making-bot test:e2e
bun run --filter @morpho-org/market-making-bot typecheck
bun run --filter @morpho-org/market-making-bot jsdoc:build
```

The e2e suite starts its own Anvil fork of Base at a pinned historical block. It requires the
`anvil` binary on `PATH` and an archive-capable `RPC_URL_8453`.
