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
- `MidnightBootstrapMakeService` and `MidnightLadderMakeService` serialize owned-group
  reconciliation, while their read-only decorators emit terminal records without signing or mutation.
- `bootstrap.ts` is the manual composition root.
- `Cli` is the operator adapter and `index.ts` is a thin entrypoint.

The setup service launches independent provider reads with `Promise.all`. Each read has its own error
boundary, so a rejected provider call becomes the corresponding failed report item and does not stop
other checks. Book reads also run concurrently; book validation waits only for the latest timestamp it
needs for maturity comparison.

Ladder has production inventory, reference-rate, tick conversion, lower/higher-to-buy/sell mapping,
offer-tree encoding, live publication, replacement, invalidation, and monitoring adapters. One
`ladder` command runs one explicit cycle; `ladder --monitor` runs continuous non-overlapping checks.
Position bootstrap additionally has a one-minute monitoring lifecycle. Its read-only make adapter performs
the same fresh whole-book prospective-spread validation, then renders the requested operations
without signing or submission.

## Setup-check configuration

All values are required except `V0_OFFER_GROUP_IDS`, `REQUEST_TIMEOUT_MS`,
`TRANSACTION_RECEIPT_TIMEOUT_MS`, and `MAKER_PRIVATE_KEY` when `--readonly` is set:

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
- `TRANSACTION_RECEIPT_TIMEOUT_MS`: optional post-submission confirmation timeout in milliseconds;
  defaults to `180000` and must be between `1` and `900000`. It is independent from provider
  request deadlines so a slow confirmation does not turn an already-broadcast transaction into a
  premature strategy retry.
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

# Emit compact JSON Lines for automation instead of the default human-readable output.
bun run --filter @morpho-org/market-making-bot start -- --json setup-check

# One live position-bootstrap cycle.
bun run --filter @morpho-org/market-making-bot start -- bootstrap

# One address-only cycle that logs desired make operations without submitting them.
bun run --filter @morpho-org/market-making-bot start -- --readonly bootstrap

# Repeat bootstrap every minute; SIGINT/SIGTERM drains the current cycle and removes owned offers.
bun run --filter @morpho-org/market-making-bot start -- bootstrap --monitor

# Stream full safe diagnostics and emit publication/cancellation hashes as soon as submitted.
bun run --filter @morpho-org/market-making-bot start -- bootstrap --monitor --verbose

# Exercise the complete monitor and cleanup lifecycle without signing or submitting.
bun run --filter @morpho-org/market-making-bot start -- --readonly bootstrap --monitor

# Validate and continuously render ladder decisions without loading a private key or submitting.
bun run --filter @morpho-org/market-making-bot start -- ladder --monitor --verbose --readonly

# Sign, broadcast, and confirm one ladder reconciliation cycle.
bun run --filter @morpho-org/market-making-bot start -- ladder

# Continuously reconcile the live ladder and remove owned offers on SIGINT/SIGTERM.
bun run --filter @morpho-org/market-making-bot start -- ladder --monitor --verbose

# Cancel every active offer group for the configured maker.
bun run --filter @morpho-org/market-making-bot start -- invalidate

# Cancel one explicit offer group, even when it has not been indexed by the API.
bun run --filter @morpho-org/market-making-bot start -- invalidate 0x<64-hex-characters>

# Preview the active groups that maker-wide invalidation would cancel.
bun run --filter @morpho-org/market-making-bot start -- invalidate --readonly
```

Success exits zero and writes human-readable output to standard output. Add the root `--json` flag for
compact JSON Lines suitable for automation. In JSON mode, ordinary commands emit one report record;
a read-only writer command emits zero or more `readonly.make` records followed by its final cycle
report. Consumers must parse stdout one line at a time rather than as one JSON document. Bigints are
serialized as decimal strings. Failures always produce an explicit error on standard error and exit
non-zero; with `--json`, that error is one `market-making.error` JSON record with optional structured
details. Any failed check throws `SetupFailedError` and identifies the failed check names. The check is
strictly read-only; remediation transaction descriptions are reported but never submitted. With
`--readonly`, only private-key/maker agreement is reported as `not-required`; balance, allowance,
ratifier, chain, market, reference, and active-offer observations still run against the configured
maker address.

`setup-check --monitor` runs the same complete read-only observation every minute and streams each
report. The first report with `ready: false` halts monitoring, includes that report in the terminal
`setup-failed` record, and exits with code `1`. `SIGINT` or `SIGTERM` after successful checks lets an
in-flight check finish and emits a final `{"status":"stopped","reason":"signal","cycles":N}` record
with exit code `0`. Monitoring never signs, submits remediation, or performs shutdown cleanup. Add
the root `--readonly` flag when private-key/maker agreement should be omitted.

Read-only make adapters serialize desired bootstrap and ladder reconcile/hard-halt/cleanup requests
as one JSON line with event name `readonly.make`. They never sign or submit an operation. The
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

Add `--verbose` to either one-shot or monitored bootstrap mode to include the complete market
configuration, fresh credit, debt, cash balance, per-market and total exposure, active offer,
reference rate, premium-adjusted target rate, deterministic decision, desired bootstrap offer, and
a fresh position read after every check. Live mode immediately emits a
`bootstrap.transaction-submitted` record when the wallet returns each publication or cancellation
hash. Completed results also list confirmed transaction hashes in submission order, and verbose
monitor cleanup reports its confirmed cancellation hashes. These diagnostics deliberately omit the
maker identity, private key, RPC/API URLs, signatures, raw transactions, provider payloads, and
untrusted error text. Without `--verbose`, bootstrap output and provider-read volume remain
unchanged.

`ladder` requires at least one `ladder` / `LADDER_MARKETS` entry. It runs readiness first, derives
fresh wallet, allowance, credit, position, active-group, and strategy-wide exposure capacities, and
then builds one deterministic quote set from the current Blue reference rate. Lower-rate rungs are
reduce-only borrow-side sells; higher-rate rungs are lend-side buys. The complete mixed-side tree is
Mempool-validated before and after signing and is submitted in one transaction. Replacement
reserves the future group IDs durably, verifies the resulting whole maker book has positive spread,
confirms cancellation receipts for old owned groups, and only then broadcasts the replacement.
`ladder --readonly` performs the same readiness, state, rate, and decision reads, reconstructs any
active owned quote set, builds the exact prospective tree, applies unsigned Mempool policy and
whole-book spread validation, and only then emits the requested reconciliation without signing or
writing.

`ladder --monitor` repeats non-overlapping checks at the shortest `loopIntervalSeconds` configured
across its markets. `SIGINT` or `SIGTERM` lets the current cycle and receipt handling finish, then
invalidates every active owned ladder group through the same serialized mutation queue. Any failed
or halted cycle stops monitoring, still attempts cleanup, prints the terminal halted report, and
exits with code `1`. Read-only monitoring emits the cleanup request without signing or submitting.

`ladder --verbose` includes the validated market config, current capacities and active quote,
reference and premium-adjusted target rates, exact desired ladder, decision, confirmed transaction
hashes, and a fresh state read after every check. Live transaction hashes are also emitted
immediately as `ladder.transaction-submitted` records.

`invalidate` is an explicit recovery command and does not run the normal offer-readiness gate. With
no group argument it reads the complete active maker group set and invalidates every distinct group,
including groups that are not owned by the bootstrap or ladder strategy. Because one Midnight group
can cap several offers, one cancellation invalidates every offer in that group. With an optional
0x-prefixed bytes32 argument, `invalidate <group-id>` directly invalidates only that group without
depending on API indexing. Before a live cancellation it still verifies the connected Base chain,
deployed configured Midnight contract, maker/private-key agreement, and configured native gas
reserve. Every transaction is locally restricted to the exact Midnight `setConsumed` cancellation,
broadcast from the maker, and receipt-confirmed before success is reported. Successfully canceled
bot-owned groups are removed from durable ownership state; explicitly configured
`V0_OFFER_GROUP_IDS` remain configuration-owned until the operator edits configuration.

Maker-wide invalidation attempts every selected group before returning. Submitted hashes stream as
`offer-invalidation.transaction-submitted` records and are retained in the terminal success or
failure report. A partial failure exits with code `1` and includes completed groups plus sanitized
per-group failure classifications. `invalidate --readonly` performs the cancellation preflight and,
for maker-wide scope, lists the active groups, but never loads a private key, submits transactions,
or edits ownership state.

For a maker with at least 101 USDC of both available balance and accrued credit, this
one-rung-per-side preset caps each side at 150 USDC. USDC uses six decimals, so `150000000` is 150
USDC and `101000000` is the Router-compatible 101 USDC offer floor. Duplicate the exact market ID
already present in `MARKET_IDS`:

```dotenv
LADDER_MARKETS=[{"marketId":"0x05959752fdeff325962b9d263edb421efc6e2186a49360dba6c32e86ebf6c84c","quotePremiumBps":"0","spreadBps":"200","stepBps":"100","rungCount":"1","sizeSkewBps":"0","lowerRateBudgetAssets":"150000000","higherRateBudgetAssets":"150000000","targetMarketExposureAssets":"300000000","maximumTotalExposureAssets":"300000000","minimumOfferAssets":"101000000","groupMode":"shared-rung","loopIntervalSeconds":"60","movementToleranceBps":"10","minimumRateBps":"200","maximumRateBps":"800"}]
```

Run the exact read-only monitor command first to inspect whether current cash/credit capacity
produces a lower side, a higher side, or both:

```sh
bun run --filter @morpho-org/market-making-bot start -- ladder --monitor --verbose --readonly
```

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

### Environment variables

Every supported environment variable is listed below. “Raw assets” means the loan token's smallest
unit; for six-decimal USDC, `101000000` is 101 USDC. No value is inferred from another variable.

| Environment variable             | YAML key                            | Requirement and behavior                                                                                                                                                     |
| -------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHAIN_ID`                       | `chain.id`                          | Required. Must be `8453`; all protocol, token, market, and transaction operations run on Base.                                                                               |
| `RPC_URL`                        | `chain.rpcUrl`                      | Required. Current-state Base JSON-RPC endpoint used for blocks, balances, allowances, positions, contract reads, simulation, transaction submission, and receipts.           |
| `REFERENCE_RPC_URL`              | `chain.archiveRpcUrl`               | Required. Archive-capable Base JSON-RPC endpoint used to read the reference Morpho Blue market at historical blocks.                                                         |
| `MAKER_ADDRESS`                  | `identity.makerAddress`             | Required. EVM address whose balance, allowance, credit, offers, and exposure the bot manages. In write mode it must be derived by `MAKER_PRIVATE_KEY`.                       |
| `MAKER_PRIVATE_KEY`              | `identity.makerPrivateKey`          | Required in write mode; omitted and never loaded with `--readonly`. Must be a 0x-prefixed 32-byte secp256k1 key. Never include it in committed configuration or logs.        |
| `MIDNIGHT_ADDRESS`               | `contracts.midnightAddress`         | Required. Expected deployed Midnight singleton. Setup verifies its bytecode before a writer starts.                                                                          |
| `LOAN_ASSET_ADDRESS`             | `contracts.loanAssetAddress`        | Required. Loan token used by every configured Midnight market. Balances, allowances, budgets, offer sizes, and exposure values use this token's raw units.                   |
| `RATIFIER_ADDRESS`               | `contracts.ratifierAddress`         | Required. Router-listed Ecrecover ratifier authorized by the maker; the bot signs offer trees for this ratifier and verifies its deployed Midnight binding.                  |
| `MORPHO_API_BASE_URL`            | `apis.morphoBaseUrl`                | Required. Morpho API origin used for Midnight books, market metadata, prospective-offer validation, and cursor-paginated maker offer groups. No API-key header is supported. |
| `ROUTER_API_BASE_URL`            | `apis.routerBaseUrl`                | Required. Router API origin used only to verify the configured ratifier against `/v0/config/contracts`. No API-key header is supported.                                      |
| `MARKET_IDS`                     | `markets.allowlist`                 | Required comma-separated list of unique 0x-prefixed bytes32 Midnight market IDs. Every bootstrap or ladder `marketId` must appear here.                                      |
| `REFERENCE_MARKET_ID`            | `markets.referenceMarketId`         | Required 0x-prefixed bytes32 Morpho Blue market ID whose historical variable borrow rate supplies the reference rate for all configured strategies.                          |
| `V0_OFFER_GROUP_IDS`             | `markets.v0OfferGroupIds`           | Optional comma-separated list of unique, explicitly strategy-owned bytes32 offer-group IDs; defaults to empty. Use it to adopt known pre-existing groups safely.             |
| `NATIVE_RESERVE_WEI`             | `setup.nativeReserveWei`            | Required unsigned integer. Minimum maker native-token balance, in wei, required by readiness for transaction fees.                                                           |
| `MAXIMUM_LEND_EXPOSURE_ASSETS`   | `setup.maximumLendExposureAssets`   | Required unsigned integer in raw loan-token units. Minimum maker allowance to Midnight required by readiness; it is not a strategy position cap.                             |
| `REQUEST_TIMEOUT_MS`             | `setup.requestTimeoutMs`            | Optional provider-operation and aggregate pagination timeout in milliseconds. Defaults to `10000`; accepted range is `1` through `120000`.                                   |
| `TRANSACTION_RECEIPT_TIMEOUT_MS` | `setup.transactionReceiptTimeoutMs` | Optional timeout for confirming an already-submitted transaction, in milliseconds. Defaults to `180000`; accepted range is `1` through `900000`.                             |
| `BOOTSTRAP_MARKETS`              | `bootstrap`                         | Optional exact JSON array of position-bootstrap entries documented below; defaults to `[]` and replaces the complete YAML `bootstrap` list when supplied.                    |
| `LADDER_MARKETS`                 | `ladder`                            | Optional exact JSON array of ladder entries documented below; defaults to `[]` and replaces the complete YAML `ladder` list when supplied.                                   |

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
- `setup`: `nativeReserveWei`, `maximumLendExposureAssets`, `requestTimeoutMs`,
  `transactionReceiptTimeoutMs`.
- `bootstrap`: an ordered list of the exact per-market objects documented below.
- `ladder`: an ordered list of the exact per-market objects documented below.

Addresses and bytes32 IDs should be quoted YAML strings. Every integer field uses exact
decimal-integer syntax: unsigned fields accept digits only, while `premiumBps`, `quotePremiumBps`,
and `sizeSkewBps` additionally accept one leading minus. Exact raw-unit amounts may be quoted decimal
strings or bare YAML decimal integers without precision loss. Floats, exponent notation, leading
plus signs, surrounding whitespace inside quoted integers, negative unsigned amounts, wrong
scalar/list/object types, duplicate keys or IDs, aliases, custom tags, prototype keys, unsupported
keys, and malformed YAML are rejected. Rates and premiums are integer basis points (`100` = one
percentage point); floats are never coerced. Each YAML `autoRefill` value must be the unquoted
lowercase plain scalar `true` or `false`. Environment integer values follow the same decimal syntax
after outer environment whitespace is trimmed.

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
There are no per-field defaults: every field in each entry is required.

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
every minute, and performs owned-group cleanup after its shutdown signal. `mm bootstrap --verbose`
adds safe rate, offer, transaction-hash, configuration, and before/after position diagnostics to
each result. `mm ladder --monitor` similarly repeats at the shortest configured ladder cadence,
streams cycles, and cleans active owned ladder groups after shutdown; `--verbose` adds safe
configuration, rate, quote, transaction-hash, and before/after capacity diagnostics. Version output,
setup monitoring, invalid usage, and application construction do not start either writer.

`runOnce()` validates every market before any position/reference read or publication. Invalid
configuration, reference failures, and decision failures invoke strategy-wide `hardHalt`; ordinary
position-read failure requests market-local invalidation and permits other markets to continue.
The production adapters re-read owned Mempool groups, serialize invalidation and publication, and
persist group ownership before broadcast. Receipt polling is bounded independently by
`TRANSACTION_RECEIPT_TIMEOUT_MS`.
Read-only mode retains the same decisions and fresh prospective whole-book comparison but logs every
requested make and graceful-cleanup operation instead.

### Ladder fields and formulas

Each `ladder` entry has a unique allowlisted `marketId`. Rates are integer BPS and asset/exposure
amounts are exact raw loan-asset units. `quotePremiumBps` and `sizeSkewBps` are signed; all other
integer fields are nonnegative or positive as shown below. There are no per-field defaults: every
field in each entry is required.

| Field                        | Unit / behavior                                                                                                                                                      | Validation                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `marketId`                   | 0x-prefixed 32-byte Midnight market ID quoted by this entry.                                                                                                         | Required, unique across the array, and present in `MARKET_IDS`.                                           |
| `quotePremiumBps`            | Signed BPS added to the fresh reference rate before the ladder spread is applied. Positive moves both sides higher; negative moves both lower.                       | Signed decimal integer; the resulting funded rungs must remain inside the configured rate range.          |
| `spreadBps`                  | Full distance in BPS between the nearest lower and higher rates. Each nearest rung is half this value from the center.                                               | Positive and even, so each half-spread is an exact integer BPS value.                                     |
| `stepBps`                    | Additional BPS between successive rungs on the same side, moving farther from the center.                                                                            | Positive.                                                                                                 |
| `rungCount`                  | Maximum number of rungs constructed on each side before capacity and minimum-size filtering.                                                                         | Positive safe integer no greater than `512`.                                                              |
| `sizeSkewBps`                | Signed change to each successive rung's allocation weight from the base weight `10000`. Positive favors outer rungs; negative favors inner rungs.                    | Signed decimal integer; every configured rung weight must remain positive.                                |
| `lowerRateBudgetAssets`      | Maximum raw assets allocated across lower-rate rungs. This side posts reduce-only borrow-side sells and is additionally capped by the maker's accrued market credit. | Positive and at least `minimumOfferAssets`.                                                               |
| `higherRateBudgetAssets`     | Maximum raw assets allocated across higher-rate rungs. This side posts lend-side buys and is additionally capped by available balance, allowance, and exposure.      | Positive and at least `minimumOfferAssets`.                                                               |
| `targetMarketExposureAssets` | Raw cap for credit plus reserved lend-buy liquidity in this market. It caps only the higher-rate, exposure-increasing side.                                          | Positive and no greater than `maximumTotalExposureAssets`.                                                |
| `maximumTotalExposureAssets` | Raw cap for credit plus reserved lend-buy liquidity across all configured markets. It caps only the higher-rate, exposure-increasing side.                           | Positive.                                                                                                 |
| `minimumOfferAssets`         | Smallest raw size permitted for any emitted rung. Capacity funds the closest rungs first and omits a side or outer rungs that cannot each meet this floor.           | Positive and no greater than either configured side budget. Use at least `101000000` for USDC.            |
| `groupMode`                  | Consumption-cap grouping: `shared-rung` creates one independent group per rung; `per-book` creates one shared group for all funded rungs on each side.               | Exactly `shared-rung` or `per-book`.                                                                      |
| `loopIntervalSeconds`        | Requested delay between completed monitor cycles for this market set; the monitor uses the shortest configured value.                                                | Positive integer no greater than `2147483`, keeping the millisecond delay within the runtime timer limit. |
| `movementToleranceBps`       | Inclusive center-rate deadband. An existing center is retained until the effective center moves by strictly more than this value; capacity resizing still applies.   | Nonnegative.                                                                                              |
| `minimumRateBps`             | Inclusive hard minimum for every funded final rung after premium, spread, and step offsets. Rates are rejected rather than clamped.                                  | Nonnegative and strictly less than `maximumRateBps`.                                                      |
| `maximumRateBps`             | Inclusive hard maximum for every funded final rung after premium, spread, and step offsets. Rates are rejected rather than clamped.                                  | Positive and strictly greater than `minimumRateBps`; the complete static ladder shape must fit.           |

The rung limit bounds local allocation to 1,024 offers for a two-sided ladder, a height-10 tree
below the Midnight SDK's height-20 protocol limit.

For reference `R`, effective center `C = R + quotePremiumBps`. With zero-based rung `k`:

```text
lower rate = C - spreadBps / 2 - k * stepBps
higher rate = C + spreadBps / 2 + k * stepBps
```

The complete static shape must fit between `minimumRateBps` and `maximumRateBps`. Every runtime rung
must also remain inside that inclusive hard range; values are rejected, never clamped. A retained
center is recentered only when absolute effective-center movement is strictly greater than
`movementToleranceBps`; capacity changes still resize quotes inside that tolerance.

“Lower” and “higher” describe rates, not protocol `buy`/`sell` flags. Because Midnight price is
inverse to rate, lower-rate rungs are encoded as borrow-side `sell` offers and higher-rate rungs as
lend-side `buy` offers. Every bot-created lower-rate offer has `reduceOnly: true`, so a fill may
unwind the maker's existing credit but cannot increase maker debt. Explorers may still label that
offer simply as “borrow”; use the tick-derived APR rather than the side label as the rate.

Rung weight `k` is `10000 + k * sizeSkewBps`, and every weight must stay positive. Positive skew
weights outer rungs more heavily; negative skew weights inner rungs more heavily. Each configured
`lowerRateBudgetAssets` / `higherRateBudgetAssets` is first capped by its fresh side capacity. The
target-market and strategy-total exposure capacities additionally cap only higher-rate lend buys;
lower-rate reduce-only borrow sells are capped by accrued credit and do not consume new lend
exposure. A side below `minimumOfferAssets` emits no offer. Otherwise the allocator funds as many
rungs as can each satisfy the floor, always selecting the closest-to-market rates first, reserves the
floor for each, distributes remaining assets by weight, and assigns integer remainder to the
outermost funded rung. Hard-rate bounds apply to every nonzero rung that can be published; an
exhausted side cannot trigger a bound failure. `targetMarketExposureAssets` must not exceed
`maximumTotalExposureAssets`.

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
bun run --filter @morpho-org/market-making-bot start -- ladder
bun run --filter @morpho-org/market-making-bot start -- ladder --readonly
bun run --filter @morpho-org/market-making-bot start -- ladder --monitor --verbose
bun run --filter @morpho-org/market-making-bot start -- ladder --monitor --verbose --readonly
bun run --filter @morpho-org/market-making-bot start -- invalidate
bun run --filter @morpho-org/market-making-bot start -- invalidate 0x<64-hex-characters>
bun run --filter @morpho-org/market-making-bot start -- invalidate --readonly
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
`"applied"`. A ladder monitor failure prints its sanitized terminal cycle/cleanup report and exits
non-zero.

## Test

```sh
bun test bots/market-making/test
bun run --filter @morpho-org/market-making-bot test:e2e
bun run --filter @morpho-org/market-making-bot typecheck
bun run --filter @morpho-org/market-making-bot jsdoc:build
```

The e2e suite starts its own Anvil fork of Base at a pinned historical block. It requires the
`anvil` binary on `PATH` and an archive-capable `RPC_URL_8453`.
