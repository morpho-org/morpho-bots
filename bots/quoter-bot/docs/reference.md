# Quoter bot operations reference

This is the complete operator reference for quoter-bot: every command, the deployment workflow,
configuration sources, field-level validation rules, and failure behavior. The bot validates its
Base and Midnight setup, bootstraps target lending positions, maintains two-sided rate ladders, and
provides explicit recovery commands. Start with read-only mode to inspect every intended action
before enabling signing.

For a user-oriented introduction, start with the package [README](../README.md). For the
contributor-facing package design and code structure, see [Architecture](./architecture.md).

## Run

```sh
pnpm --filter @morpho-org/quoter-bot run start -- setup-check

# Address-only setup inspection: MAKER_PRIVATE_KEY may be omitted.
pnpm --filter @morpho-org/quoter-bot run start -- --readonly setup-check

# Explicit signer sources (root options precede the command).
pnpm --filter @morpho-org/quoter-bot run start -- --private-key '<key>' setup-check
pnpm --filter @morpho-org/quoter-bot run start -- --keystore ./maker.json --interactive setup-check
pnpm --filter @morpho-org/quoter-bot run start -- --aws setup-check
```

For unattended keystore operation, provision `KEYSTORE_PASSWORD` separately through the deployment
secret manager or process environment, then run the keystore command without an inline value:

```sh
pnpm --filter @morpho-org/quoter-bot run start -- --keystore ./maker.json setup-check
```

`--private-key <key>` and `--password <password>` remain available for explicit automation, but they
place secrets in argv, where process listings and shell history may expose them. Prefer
`MAKER_PRIVATE_KEY` and `KEYSTORE_PASSWORD` respectively for unattended operation, or hidden
`--interactive` password input for attended keystore operation.

```sh
# Repeat read-only readiness checks every minute until SIGINT/SIGTERM.
pnpm --filter @morpho-org/quoter-bot run start -- setup-check --monitor

# Emit compact JSON Lines for automation instead of the default human-readable output.
pnpm --filter @morpho-org/quoter-bot run start -- --json setup-check

# One live position-bootstrap cycle.
pnpm --filter @morpho-org/quoter-bot run start -- bootstrap

# One address-only cycle that logs desired make operations without submitting them.
pnpm --filter @morpho-org/quoter-bot run start -- --readonly bootstrap

# Repeat bootstrap every minute; SIGINT/SIGTERM drains the current cycle and removes owned offers.
pnpm --filter @morpho-org/quoter-bot run start -- bootstrap --monitor

# Stream full safe diagnostics and emit publication/cancellation hashes as soon as submitted.
pnpm --filter @morpho-org/quoter-bot run start -- bootstrap --monitor --verbose

# Exercise the complete monitor and cleanup lifecycle without signing or submitting.
pnpm --filter @morpho-org/quoter-bot run start -- --readonly bootstrap --monitor

# Validate and continuously render ladder decisions without loading a private key or submitting.
pnpm --filter @morpho-org/quoter-bot run start -- ladder --monitor --verbose --readonly

# Sign, broadcast, and confirm one ladder reconciliation cycle.
pnpm --filter @morpho-org/quoter-bot run start -- ladder

# Continuously reconcile the live ladder and remove owned offers on SIGINT/SIGTERM.
pnpm --filter @morpho-org/quoter-bot run start -- ladder --monitor --verbose

# Run setup checks, bootstrap, and ladder monitoring together until SIGINT/SIGTERM.
pnpm --filter @morpho-org/quoter-bot run start -- start --verbose

# Exercise the same combined lifecycle without signing or submitting transactions.
pnpm --filter @morpho-org/quoter-bot run start -- --readonly start --verbose

# Cancel every active offer group for the configured maker.
pnpm --filter @morpho-org/quoter-bot run start -- invalidate

# Cancel one explicit offer group, even when it has not been indexed by the API.
pnpm --filter @morpho-org/quoter-bot run start -- invalidate 0x<64-hex-characters>

# Preview the active groups that maker-wide invalidation would cancel.
pnpm --filter @morpho-org/quoter-bot run start -- invalidate --readonly
```

Success exits zero and writes human-readable output to standard output. Add the root `--json` flag for
compact JSON Lines suitable for automation. In JSON mode, ordinary commands emit one report record;
a read-only writer command emits zero or more `readonly.make` records followed by its final cycle
report. Consumers must parse stdout one line at a time rather than as one JSON document. Bigints are
serialized as decimal strings. Failures always produce an explicit error on standard error and exit
non-zero; with `--json`, that error is one `quoter-bot.error` JSON record with optional structured
details. Any failed check throws `SetupFailedError` and identifies the failed check names. The check is
strictly read-only; remediation transaction descriptions are reported but never submitted. With
`--readonly`, only private-key/maker agreement is reported as `not-required`; balance, allowance,
ratifier, chain, market, reference, and active-offer observations still run against the configured
maker address.

`setup-check --monitor` runs the same complete read-only observation every minute and streams each
report. A report containing only explicitly transient provider failures is retried up to two times;
recovery emits only the successful report. An invariant failure, a mixed failure, or three transient
attempts with no recovery emits `ready: false`, halts monitoring, includes that report in the terminal
`setup-failed` record, and exits with code `1`. `SIGINT` or `SIGTERM` after successful checks lets an
in-flight check finish and emits a final `{"status":"stopped","reason":"signal","cycles":N}` record
with exit code `0`. Monitoring never signs, submits remediation, or performs shutdown cleanup. Add
the root `--readonly` flag when private-key/maker agreement should be omitted.

Read-only writer commands serialize desired bootstrap and ladder reconcile, hard-halt, and cleanup
requests as one JSON line with event name `readonly.make`. They never sign or submit an operation.
The `--readonly bootstrap` command executes one complete observational decision cycle after deriving
its exact tick, comparing the prospective offer with the complete current maker book, and applying
the SDK's live Mempool-policy validation without signing or broadcasting.
The corresponding final cycle outcome uses `status: "logged"` rather than `"applied"`.

`bootstrap --monitor` requires at least one explicit `bootstrap` / `BOOTSTRAP_MARKETS` entry. Each
market independently selects `targetRate.strategy: variable_rate_avg` (the existing Morpho Blue
variable-rate average) or `hardcoded` with `hardcodedRateBps`; `premiumBps` is then added to derive
the published offer rate. It serially runs a cycle every minute
and streams each result. `SIGINT` or `SIGTERM` lets an in-flight cycle finish, then invalidates every
explicitly owned bootstrap group through the same mutation queue and waits for bounded transaction
receipts. The final record reports the number of cycles and whether cleanup was applied, logged, or
failed. Read-only monitoring logs the cleanup request and never loads a private key. In live mode,
Ecrecover bootstrap signs and publishes the validated payload in one transaction. Setter bootstrap
durably reserves the future group, confirms any replacement cancellations, submits and confirms
`setIsRootRatified`, revalidates the exact final proof payload with the Mempool API, then publishes it
in a second transaction and confirms ownership. A post-approval validation failure does not publish
and retains the reservation for safe cleanup.

Add `--verbose` to either one-shot or monitored bootstrap mode to include the complete market
configuration, fresh credit, debt, cash balance, per-market and total exposure, active offer,
reference rate, premium-adjusted target rate, deterministic decision, desired bootstrap offer, and
a fresh position read after every check. Live mode immediately emits a
`bootstrap.transaction-submitted` record when the wallet returns each ratification, publication, or cancellation
hash. Completed results also list confirmed transaction hashes in submission order, and verbose
monitor cleanup reports its confirmed cancellation hashes. These diagnostics deliberately omit the
maker identity, private key, RPC/API URLs, signatures, raw transactions, provider payloads, and
untrusted error text. Without `--verbose`, bootstrap output and provider-read volume remain
unchanged.

`ladder` requires at least one `ladder` / `LADDER_MARKETS` entry. It runs readiness first, derives
fresh wallet, allowance, credit, position, active-group, and strategy-wide exposure capacities, and
then builds one deterministic quote set from that market's independently selected target-rate
strategy. Lower-rate rungs are
reduce-only borrow-side sells; higher-rate rungs are lend-side buys. The complete mixed-side tree is
Mempool-validated before and after ratification. Ecrecover trees are signed and published in one
transaction; Setter trees first submit and confirm `setIsRootRatified`, then publish the proof-only
payload in a second transaction. Replacement
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

`start` requires at least one configured bootstrap market and one configured ladder market. It runs
the readiness gate before constructing either writer, then launches setup monitoring, position
bootstrap monitoring, and ladder monitoring concurrently. Cycle records are tagged with
`event: "quoter-bot.cycle"` and their `workflow`; verbose transaction records retain the existing
bootstrap and ladder event names. The first halted, rejected, or unexpectedly stopped workflow
aborts its peers, waits for both writer monitors to drain their in-flight cycles and cleanup owned
offers, and emits one combined terminal report. Bootstrap and ladder reads remain concurrent, while
their reconcile, hard-halt, and cleanup operations are serialized to prevent signer-nonce and book
mutation races. A normal SIGINT or SIGTERM returns `status: "stopped"`; any workflow failure
returns `status: "halted"` and exits with code `1`.

`invalidate` is an explicit recovery command and does not run the normal offer-readiness gate. With
no group argument it reads the complete active maker group set and invalidates every distinct group,
including groups that are not owned by the bootstrap or ladder strategy. Because one Midnight group
can cap several offers, one cancellation invalidates every offer in that group. With an optional
0x-prefixed bytes32 argument, `invalidate <group-id>` directly invalidates only that group without
depending on API indexing. Before a live cancellation it still verifies the connected Base chain,
deployed configured Midnight contract, maker/private-key agreement, and configured native gas
reserve. Maker-wide invalidation submits one zero-value native Midnight `multicall(bytes[])`; each
ordered inner call is exactly `setConsumed(groupId, MAX_OFFER_CAP, MAKER_ADDRESS)`. Midnight executes
the inner calls with `delegatecall`, so the maker account that submits the outer transaction remains
`msg.sender` throughout. The local transaction policy rejects any wrong target, selector, call count,
order, group, amount, on-behalf account, or extra calldata. A reverted or failed multicall is reported
without serial retry. Explicit single-group invalidation keeps the simpler direct Midnight
`setConsumed` transaction. Successfully canceled bot-owned groups are removed from durable
ownership state; explicitly configured `V0_OFFER_GROUP_IDS` remain configuration-owned until the
operator edits configuration. If the provider omits one of these configured groups, bootstrap and
ladder reads deliberately fail closed because neither omission nor ordinary partial on-chain
consumption reveals the group's original maximum capacity. A `consumed` value equal to the Midnight
SDK's `MAX_OFFER_CAP` is the exception: it conclusively proves invalidation, so readers ignore that
group and cleanup does not resubmit its cancellation after a restart. Remove stale IDs from
`V0_OFFER_GROUP_IDS` after invalidation to keep the operator-owned set current.

Maker-wide invalidation waits for the single multicall receipt, reports its hash against every group,
then forgets all confirmed bot-owned groups together. Submitted hashes stream as
`offer-invalidation.transaction-submitted` records and are retained in the terminal success or
failure report. A failed atomic multicall exits with code `1` and reports the same submitted hash for
every selected group. `invalidate --readonly` performs the cancellation preflight and, for maker-wide
scope, lists the active groups, but never loads a private key, submits transactions, or edits
ownership state. Normal bootstrap and ladder invalidation loops remain serial; native multicall is
limited to the explicit maker-wide recovery command.

For a maker with at least 101 USDC of both available balance and accrued credit, this
one-rung-per-side preset caps each side at 150 USDC. USDC uses six decimals, so `150000000` is 150
USDC and `101000000` is the Router-compatible 101 USDC offer floor. Duplicate the exact market ID
already present in `MARKET_IDS`. This legacy preset intentionally omits `targetRate`, so it uses the
backward-compatible `variable_rate_avg` default:

```dotenv
LADDER_MARKETS=[{"marketId":"0x05959752fdeff325962b9d263edb421efc6e2186a49360dba6c32e86ebf6c84c","quotePremiumBps":"0","spreadBps":"200","stepBps":"100","rungCount":"1","sizeSkewBps":"0","lowerRateBudgetAssets":"150000000","higherRateBudgetAssets":"150000000","targetMarketExposureAssets":"300000000","maximumTotalExposureAssets":"300000000","minimumOfferAssets":"101000000","groupMode":"shared-rung","loopIntervalSeconds":"60","movementToleranceBps":"10","minimumRateBps":"200","maximumRateBps":"800"}]
```

Run the exact read-only monitor command first to inspect whether current cash/credit capacity
produces a lower side, a higher side, or both:

```sh
pnpm --filter @morpho-org/quoter-bot run start -- ladder --monitor --verbose --readonly
```

Version output remains available:

```sh
pnpm --filter @morpho-org/quoter-bot run start -- --version
```

## Deploy

The package owns its production [Dockerfile](../Dockerfile), local
[docker-compose.yml](../docker-compose.yml), and idempotent
[`scripts/deploy-railway.ts`](../scripts/deploy-railway.ts) entrypoint. The Docker build context is the
repository root so pnpm can resolve every workspace dependency; the image builds the workspace and
starts the combined setup, bootstrap, and ladder monitor as an unprivileged Node process.

A full deployment creates the `quoter-bot` Railway service, selects the package Dockerfile,
provisions a persistent volume at `/state`, and writes the effective environment configuration
through stdin so values never appear in process arguments or logs:

```sh
RAILWAY_PROJECT_ID=... \
pnpm --filter @morpho-org/quoter-bot run deploy:railway
```

Provide the required values from [`.env.example`](../.env.example) in the invoking environment.
A full provisioning run supports only `private-key`, because the script cannot safely seed a local
keystore file or an AWS credential source into a newly created service. For `keystore`, first
provision the encrypted file at `KEYSTORE_PATH` in the existing service. For `aws`, first provision
an AWS SDK credential source with KMS access in the existing service. Then set the corresponding
signer variables out of band and use `DEPLOY_ONLY=true`; deploy-only does not inspect or mutate those
credentials or files. Full provisioning fails closed for both modes instead of launching a service
that cannot resolve its signer.

`BOOTSTRAP_MARKETS` and `LADDER_MARKETS` must each be populated JSON arrays so a full run cannot
replace a working strategy with an empty list. Every remaining optional value is synchronized:
omitted timeouts return to their documented defaults, and omitted group IDs and BetterStack settings
are disabled. `RAILWAY_ENVIRONMENT` defaults to `production`. CI uses `DEPLOY_ONLY=true` with the
`quoter-bot-production` GitHub Environment, so it reads only `RAILWAY_PROJECT_ID` and
`RAILWAY_TOKEN` and uses project-token deployment permissions to re-ship the pre-provisioned
service. Deploy-only does not inspect or mutate Railway variables, volumes, or secrets. Before
deploy-only, an authorized operator or full provisioning run must configure `RAILWAY_RUN_UID=0`,
the current `RAILWAY_DOCKERFILE_PATH=bots/quoter-bot/Dockerfile`, `XDG_STATE_HOME=/state`, signer
and application variables, and the state volume. A full provisioning run preserves root-level
ownership files in an attached volume at `/state`; when none is attached, it creates a fresh volume
there and leaves any detached pre-rename volume untouched. A project token (`RAILWAY_TOKEN`) cannot
manage that configuration; use authorized account or workspace credentials only for provisioning,
not routine deploy-only CI.

The local Compose service uses the same `/state` ownership path through a named volume, requires both
strategy arrays, and supplies the runtime timeout defaults when the corresponding host variables are
absent.

Both modes snapshot the previous deployment, start a detached upload, and poll the new deployment to
a terminal state. A GitHub release is created only after Railway reports `SUCCESS`; failed, crashed,
approval-blocked, removed, skipped, sleeping, unknown, or timed-out deployments fail the workflow.

## Configuration

### Configuration sources and precedence

Configuration can come from environment variables, a YAML file, or both. YAML files and the
`BOOTSTRAP_MARKETS` and `LADDER_MARKETS` values are each limited to 1 MiB before parsing.

1. `--config <path>` selects that exact `.yaml` or `.yml` file. Other path extensions and a missing,
   unreadable, empty, oversized, malformed, symlinked, or non-regular explicitly named file fail
   startup. Default-discovered symlinks are rejected as unreadable too.
2. Without `--config`, the CLI searches the process working directory from which `quoter-bot` was invoked.
   It checks `quoter-bot.yaml` first, then `quoter-bot.yml`. If both exist, `.yaml` wins.
3. If neither default file exists, environment-only startup remains supported.
4. Every supplied environment variable overrides the corresponding YAML value. CLI signer flags
   override environment and YAML signer selection. A higher-precedence signer selection discards
   competing lower-precedence signer fields while retaining same-method companion fields. Within one
   effective layer, configuring more than one source is an error.

Scalar fields override independently. `MARKET_IDS` and `V0_OFFER_GROUP_IDS` each replace their
complete YAML list. `BOOTSTRAP_MARKETS` and `LADDER_MARKETS` replace the complete YAML `bootstrap` and
`ladder` lists respectively; arrays are never partially or positionally merged. YAML syntax and
source-safety checks run before overlay,
then only the effective merged configuration is semantically validated, so replaced invalid values do
not block startup while parser hazards in replaced sections still do.

Use [`quoter-bot.example.yaml`](../quoter-bot.example.yaml) as the complete YAML template and
[`.env.example`](../.env.example) as the environment template. Default discovery never selects the
example filename.

```sh
# Explicit file; relative paths resolve from the invocation working directory.
pnpm --filter @morpho-org/quoter-bot run start -- --config ./quoter-bot.yml setup-check

# Default discovery in the current working directory.
pnpm --filter @morpho-org/quoter-bot run start -- setup-check

# Address-only mode works with either configuration source.
pnpm --filter @morpho-org/quoter-bot run start -- --readonly setup-check
```

### Environment variables

Every supported environment variable is listed below. “Raw assets” means the loan token's smallest
unit; for six-decimal USDC, `101000000` is 101 USDC. No value is inferred from another variable.

| Environment variable             | YAML key                            | Requirement and behavior                                                                                                                                                                                  |
| -------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHAIN_ID`                       | `chain.id`                          | Required. Must be `8453`; all protocol, token, market, and transaction operations run on Base.                                                                                                            |
| `RPC_URL`                        | `chain.rpcUrl`                      | Required. Current-state Base JSON-RPC endpoint used for blocks, balances, allowances, positions, contract reads, simulation, transaction submission, and receipts.                                        |
| `REFERENCE_RPC_URL`              | `chain.archiveRpcUrl`               | Required when the selected command has an active `variable_rate_avg` target. Archive-capable Base JSON-RPC endpoint used to read the reference Morpho Blue market at historical blocks.                   |
| `MAKER_ADDRESS`                  | `identity.makerAddress`             | Required. EVM address whose balance, allowance, credit, offers, and exposure the bot manages. In write mode it must match the selected signer.                                                            |
| `KEY_STORAGE_METHOD`             | `identity.keyStorageMethod`         | Optional only for backward-compatible `MAKER_PRIVATE_KEY` use; otherwise `private-key`, `keystore`, or `aws`. Exactly one effective source is required in write mode.                                     |
| `MAKER_PRIVATE_KEY`              | `identity.makerPrivateKey`          | Local private-key source. Must be a 0x-prefixed 32-byte secp256k1 key. `--private-key` overrides config. Never include it in committed configuration or logs.                                             |
| `KEYSTORE_PATH`                  | `identity.keystorePath`             | Encrypted Web3 Secret Storage file used by the `keystore` method. CLI equivalent: `--keystore <path>`.                                                                                                    |
| `KEYSTORE_PASSWORD`              | `identity.keystorePassword`         | Keystore password. Exactly one direct or interactive mode is required; see the argv exposure warning above. Never logged or included in diagnostics.                                                      |
| `KEYSTORE_INTERACTIVE`           | `identity.keystoreInteractive`      | `true` prompts without echoing for the keystore password; CLI equivalent: `--interactive`. Not suitable for unattended deployment.                                                                        |
| `AWS_KMS_KEY_ID`                 | `identity.awsKmsKeyId`              | KMS key ID/ARN/alias for an asymmetric `ECC_SECG_P256K1` signing key. `--aws` selects this backend.                                                                                                       |
| `AWS_REGION`                     | `identity.awsRegion`                | AWS region containing the KMS key. AWS credentials use the standard AWS SDK credential chain.                                                                                                             |
| `MIDNIGHT_ADDRESS`               | `contracts.midnightAddress`         | Required. Expected deployed Midnight singleton. Setup verifies its bytecode before a writer starts.                                                                                                       |
| `LOAN_ASSET_ADDRESS`             | `contracts.loanAssetAddress`        | Required. Loan token used by every configured Midnight market. Balances, allowances, budgets, offer sizes, and exposure values use this token's raw units.                                                |
| `RATIFIER_ADDRESS`               | `contracts.ratifierAddress`         | Required. Canonical SDK Ecrecover or Setter ratifier authorized by the maker. The bot signs Ecrecover trees or approves Setter roots onchain, then verifies the selected deployment and Midnight binding. |
| `MORPHO_API_BASE_URL`            | `apis.morphoBaseUrl`                | Required. Morpho API origin used for Midnight books, market metadata, prospective-offer validation, and cursor-paginated maker offer groups. No API-key header is supported.                              |
| `ROUTER_API_BASE_URL`            | `apis.routerBaseUrl`                | Deprecated compatibility key. Accepted and ignored; ratifier identity comes from the pinned Morpho SDK catalog.                                                                                           |
| `MARKET_IDS`                     | `markets.allowlist`                 | Required comma-separated list of unique 0x-prefixed bytes32 Midnight market IDs. Every bootstrap or ladder `marketId` must appear here.                                                                   |
| `REFERENCE_MARKET_ID`            | `markets.referenceMarketId`         | Required when the selected command has an active `variable_rate_avg` target. Must be a 0x-prefixed bytes32 Morpho Blue market ID.                                                                         |
| `V0_OFFER_GROUP_IDS`             | `markets.v0OfferGroupIds`           | Optional comma-separated list of unique, explicitly strategy-owned bytes32 offer-group IDs; defaults to empty. Use it to adopt known pre-existing groups safely.                                          |
| `NATIVE_RESERVE_WEI`             | `setup.nativeReserveWei`            | Required unsigned integer. Minimum maker native-token balance, in wei, required by readiness for transaction fees.                                                                                        |
| `MAXIMUM_LEND_EXPOSURE_ASSETS`   | `setup.maximumLendExposureAssets`   | Required unsigned integer in raw loan-token units. Minimum maker allowance to Midnight required by readiness; it is not a strategy position cap.                                                          |
| `REQUEST_TIMEOUT_MS`             | `setup.requestTimeoutMs`            | Optional provider-operation and aggregate pagination timeout in milliseconds. Defaults to `10000`; accepted range is `1` through `120000`.                                                                |
| `TRANSACTION_RECEIPT_TIMEOUT_MS` | `setup.transactionReceiptTimeoutMs` | Optional timeout for confirming an already-submitted transaction, in milliseconds. Defaults to `180000`; accepted range is `1` through `900000`.                                                          |
| `BOOTSTRAP_MARKETS`              | `bootstrap`                         | Optional exact JSON array of position-bootstrap entries documented below; defaults to `[]` and replaces the complete YAML `bootstrap` list when supplied.                                                 |
| `LADDER_MARKETS`                 | `ladder`                            | Optional exact JSON array of ladder entries documented below; defaults to `[]` and replaces the complete YAML `ladder` list when supplied.                                                                |
| `BETTERSTACK_SOURCE_TOKEN`       | —                                   | Optional Better Stack source token. Must be set together with `BETTERSTACK_INGESTING_HOST`; partial configuration emits `logship.misconfigured` and ships nothing.                                        |
| `BETTERSTACK_INGESTING_HOST`     | —                                   | Optional Better Stack ingest host, with or without an `https://` prefix. Must be set together with `BETTERSTACK_SOURCE_TOKEN`.                                                                            |
| `BETTERSTACK_HEARTBEAT_URL`      | —                                   | Optional HTTP(S) heartbeat URL pinged at startup and once per minute. Invalid URLs and ping failures are reported safely and never interrupt quoter-bot.                                                  |

There is no separate Mempool endpoint or API-key field. Books and cursor-paginated maker offer groups
are read through `MORPHO_API_BASE_URL`. Ratifier identity is validated from the pinned Morpho SDK
catalog, so setup readiness does not depend on a Router API endpoint. `ROUTER_API_BASE_URL` and
`apis.routerBaseUrl` remain accepted as ignored compatibility keys for existing deployments.

### Better Stack observability

Set both `BETTERSTACK_SOURCE_TOKEN` and `BETTERSTACK_INGESTING_HOST` to ship sanitized named
monitoring records to Better Stack. Shipping is best-effort and never replaces or suppresses the
existing stdout/stderr JSON Lines contract. With full shipping configuration, `start`, `bootstrap`,
and `ladder` automatically enable the existing safe `--verbose` event stream (without adding a
duplicate flag), so active positions, bootstrap offers, ladder quotes/offers, decisions, and
submitted/confirmed transactions are available to the log source. With the shipping variables unset
no log record leaves the process; partial configuration fails loud locally and does not enable
verbose diagnostics.

Every record carries `bot: "quoter-bot"`, `chainId: 8453`, and available Railway deployment
context. Nested `status: "failed"`, `status: "halted"`, and `errorName` values are emitted at error
level. Unexpected failures include only a sanitized `errorName`; private keys, RPC/API credentials,
signed or raw transaction payloads, provider payloads, and untrusted raw error messages are never
added to observability records.

Useful Better Stack source queries/filters include:

- lifecycle and restarts: `bot:quoter-bot AND event:(bot.started OR bot.stopped OR bot.failed)`;
- configured scope: `bot:quoter-bot AND event:(bot.configured OR market.configured)`;
- monitor cycles: `bot:quoter-bot AND event:cycle.completed` plus `workflow`, `action`, or `status`;
- market state: `bot:quoter-bot AND event:(position.observed OR book.observed OR offer.consumed)`;
- failures: `bot:quoter-bot AND level:error`, optionally grouped by `event` and `errorName`.

`BETTERSTACK_HEARTBEAT_URL` is optional and is configured independently of the shipping opt-in.
Whenever it is set the heartbeat pings on a wall-clock interval whether or not
`BETTERSTACK_SOURCE_TOKEN` and `BETTERSTACK_INGESTING_HOST` are configured, so "shipping unset"
means no log records are sent, not that the process makes no network calls. The heartbeat starts
with the process, stops during normal teardown, and cannot interrupt strategy execution. Create the
log source, heartbeat, saved
queries, and any dashboard/alerting in Better Stack externally; this repository does not provision
or claim a deployed dashboard URL.

#### Shipping allowlist

Records written through the CLI event writer pass an explicit allowlist, not "any record carrying an
`event`". `isShippableRecord` admits exactly the names in `MONITORING_EVENT_NAMES` — the
`MonitoringEvent` union tabulated below, which a compile-time assertion keeps in sync with that list
— plus the three pre-receipt transaction names
`ladder.transaction-submitted`, `bootstrap.transaction-submitted`, and
`offer-invalidation.transaction-submitted`, which are already flat and version alongside their
`transaction.settled` counterparts.

Everything else the CLI writes stays local:

| Record                                                 | Where it goes, and why it is not shipped                                                                               |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `quoter-bot.cycle`                                     | stdout; a named envelope wrapping a nested, unversioned per-workflow cycle report                                      |
| `readonly.make`                                        | stdout; a named envelope wrapping a nested, unversioned mutation request                                               |
| Terminal monitor and cycle reports, `quoter-bot.error` | stdout on success, stderr on the failure path (the report rides `quoter-bot.error`); never routed through the boundary |

A nested unversioned shape cannot be grouped on by a metric expression and cannot be pinned by
`schemaVersion`, so admitting it would put an unmaintainable surface in the log source. Nothing is
lost: the same content ships flat as `cycle.completed`, `guardrail.*`, and `bot.failed`. The
`@repo/observability` `bot.action` fallback is therefore unreachable for this bot.

The allowlist scopes the CLI event writer only. `bot.started`, `bot.stopped`,
`bot.unexpected-error`, and `heartbeat.failed` are emitted straight through the shipping logger by
`@repo/observability` and `@repo/bot-kit`, bypassing this boundary entirely — so they are present
in the log source while absent from `MONITORING_EVENT_NAMES`. `bot.unexpected-error` in particular is
the only shipped signal for an entrypoint failure that no reported error classifies.

#### Event contract

Every shipped record carries a named top-level `event` and a flat scalar payload, so Better Stack
metric expressions can group on it directly. Names are `<domain>.<kebab-verb>`. `schemaVersion` is
bound once into the shipping logger's context (`MONITORING_SCHEMA_VERSION`, currently `1`) rather
than onto each record, so every line carries it at zero per-event cost and a consumer can pin the
contract. It is bumped only on a breaking field rename or removal; adding an optional field is not
breaking.

`adapterOperation` is not a shipped field. Bootstrap failure and halt results carry it internally:
an allowlisted reason such as `negative-spread` or `transaction-policy`, withheld when
unrecognized. The projection reads it solely to decide whether to emit `guardrail.spread-rejected`, which the
collapsed `errorName` classification could not distinguish. It appears on no `MonitoringEvent`
variant, so it is not available as a grouping dimension in the log source.

Records are projected from cycle results that are already sanitized — the projections read nothing
and never re-classify an error. Only allowlisted `errorName` classifications ship; raw error text,
provider payloads, and URLs never do. Fill telemetry reads owned-group consumption, but that request
is deduplicated against the active-quote read it runs concurrently with, so a verbose cycle issues no
extra provider round trip.

#### Units

Every `*Assets` field is an unsigned raw smallest-unit amount of the configured `loanAsset`. Every
`*Bps` field is an integer basis-point value (`100` = one percentage point). Both serialize as
decimal strings, because the bot-kit logger flattens `bigint` before loglayer sees it. Counts
(`clampedRungs`, `clearedRungs`, `configuredRungs`, `fundedRungs`, `rungs`), the cadence fields
(`ladderIntervalSeconds`, `bootstrapIntervalSeconds`), and `durationMs` are plain numbers, and
`maturityTimestamp` is a Unix-seconds `bigint`. The bot never reads token decimals, so nothing is
human-scaled: a consumer resolves decimals from the `loanAsset` address shipped in `bot.configured`.

#### Events

| Event                          | Fires when                                                                                    | Fields                                                                                                                                                                                                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bot.configured`               | Once per process start, from the validated configuration                                      | `bootstrapIntervalSeconds`, `loanAsset`, `referenceMode` (`static` \| `variable` \| `mixed`), `readOnly`                                                                                                                                                               |
| `market.configured`            | Once per configured market, immediately after `bot.configured`                                | `marketId`, `ladder`, `bootstrap` (which workflows the market is configured for), `ladderIntervalSeconds?` (that market's own `loopIntervalSeconds`; absent for a bootstrap-only market, whose cadence is `bootstrapIntervalSeconds`)                                  |
| `bot.failed`                   | A terminal failure stops the process; one per process, plus one per failed workflow           | `workflow?` (`setup-check` \| `bootstrap` \| `ladder`; absent on the process-level record), `reason`, `errorName?`                                                                                                                                                     |
| `cycle.completed`              | Once per market per bootstrap/ladder cycle, and once per setup check                          | `workflow` (`setup-check` \| `bootstrap` \| `ladder`), `marketId?` (absent for `setup-check`), `status` (`ready` \| `failed` for `setup-check`), `stage?`, `action?`, `reason?`, `durationMs?`, `errorName?`                                                           |
| `guardrail.rate-clamped`       | A cycle clamped a rate to its bound; ladder aggregates per side, bootstrap reports one rung   | `workflow`, `marketId`, `side?` (absent for `bootstrap`), `clampedRungs`, `bound` (`minimum` \| `maximum`), `minimumRateBps`, `maximumRateBps`                                                                                                                         |
| `guardrail.cross-book-cleared` | Cross-book clearance repriced at least one rung on a side                                     | `workflow`, `marketId`, `side`, `clearedRungs`                                                                                                                                                                                                                         |
| `guardrail.exposure-capped`    | A bootstrap offer was sized below its request by an inventory limit                           | `workflow`, `marketId`, `requestedAssets`, `cappedAssets`, `cap` (`offer-size` \| `credit-target` \| `cash-balance` \| `market-exposure` \| `total-exposure`)                                                                                                          |
| `guardrail.rungs-truncated`    | A side funded fewer rungs than configured                                                     | `marketId`, `side`, `configuredRungs`, `fundedRungs`                                                                                                                                                                                                                   |
| `guardrail.spread-rejected`    | A bootstrap result carries `adapterOperation: "negative-spread"`                              | `marketId`                                                                                                                                                                                                                                                             |
| `guardrail.halted`             | A bootstrap or ladder cycle halted, pulling offers                                            | `workflow`, `marketId?`, `stage`, `reason`, `strategyInvalidated`                                                                                                                                                                                                      |
| `reference.observed`           | A verbose bootstrap or ladder cycle read a reference rate; event time is the staleness anchor | `workflow`, `marketId`, `referenceRateBps`, `targetRateBps?`                                                                                                                                                                                                           |
| `position.observed`            | A verbose ladder cycle observed market state                                                  | `marketId`, `cashBalanceAssets?`, `creditAssets?`, `otherMarketCreditAssets?`, `reservedAssets?`, `marketReservedAssets?`, `maturityTimestamp?`, `lowerRateCapacityAssets?`, `higherRateCapacityAssets?`, `targetMarketCapacityAssets?`, `maximumTotalCapacityAssets?` |
| `bootstrap.progress`           | A verbose bootstrap cycle observed position state                                             | `marketId`, `creditAssets`, `creditTargetAssets`                                                                                                                                                                                                                       |
| `book.observed`                | A verbose ladder cycle observed market state; one record per side, on every observed cycle    | `marketId`, `side`, `state` (`quoting` \| `empty`), `rungs`, `totalAssets`, `bestRateBps?`, `worstRateBps?`, `centerRateBps?` (absent when no quote is active)                                                                                                         |
| `offer.consumed`               | A group's monotonic `consumed` grew relative to the previous cycle                            | `marketId`, `side`, `consumedDeltaAssets`, `groupRateBps`, `remainingAssets`, `groupId` _(trace only)_                                                                                                                                                                 |
| `transaction.settled`          | A submitted bootstrap or ladder transaction confirmed                                         | `workflow`, `marketId?`, `operation` (`cancel` \| `ratify` \| `publish`), `txHash` _(trace only)_                                                                                                                                                                      |
| `setup.check-failed`           | One named readiness check failed; `observed`/`required` are typed `unknown` and are omitted   | `check`                                                                                                                                                                                                                                                                |

`bot.started`, `bot.stopped`, `bot.unexpected-error`, `heartbeat.failed`,
`ladder.transaction-submitted`, `bootstrap.transaction-submitted`, and
`offer-invalidation.transaction-submitted` are unchanged and ship alongside these.

Readiness is not a separate record. `cycle.completed { workflow: "setup-check" }` already carries it
as `status`, so a per-cycle `ready` record would restate the same fact every minute.
`bootstrap.progress` carries no shortfall: it is `max(creditTargetAssets - creditAssets, 0)`, exact
arithmetic a consumer can do over the two shipped fields. `guardrail.cross-book-cleared` carries no
clearance width, because it is a code constant rather than an observation, and
`guardrail.spread-rejected` carries no `errorName`, because the event name is the signal and the
paired `cycle.completed` carries the classification. `transaction.settled` carries no `status`,
because a settled transaction is confirmed by definition.

#### Cardinality

Safe grouping dimensions are `workflow`, `marketId`, `side`, `status`, `stage`, `action`, `reason`,
`check`, `bound`, `cap`, `operation`, `state`, and `referenceMode`. `marketId` is safe only
because it is bounded by the configured allowlist.

`txHash` and `groupId` are unbounded trace-only correlation fields. Use them to join records within
an incident; never use them as a grouping dimension in a metric expression.

Guardrail records are aggregated per side per cycle and emitted only when the count is non-zero. A
side may hold up to `MAX_LADDER_RUNG_COUNT` (512) rungs and regenerate as often as every second, so a
per-rung record would reach millions of lines per day per market; the aggregate answers the same
operator question at three orders of magnitude less volume.

#### Alert recipes

| Question             | Signal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Crash / halt         | `bot.failed` OR `bot.unexpected-error`, plus a missed heartbeat. `bot.failed` covers a classified failure — the process-level record carries no `workflow`; group the accompanying records by `workflow` to name the half that broke, and by `reason` and `errorName` to classify it. An unclassified entrypoint failure emits `bot.unexpected-error` (with `origin` and `errorName`) and **no** `bot.failed`, so alerting on `bot.failed` alone misses it. A hard process death emits neither; the missed heartbeat is the only signal |
| Halt / guardrail     | Any `guardrail.halted` (alert on `strategyInvalidated: true` first); `guardrail.rate-clamped`, `guardrail.cross-book-cleared`, and `guardrail.rungs-truncated` counts sustained over a window                                                                                                                                                                                                                                                                                                                                           |
| Stale reference      | Absence of `reference.observed` for a `marketId` beyond two of that market's `ladderIntervalSeconds`. Sound for a ladder market, which reads a reference every cycle. Scope the alert to `market.configured` with `ladder: true`: a bootstrap-only market can legitimately go silent (see Known limits)                                                                                                                                                                                                                                 |
| Inventory / exposure | `position.observed` balance and capacity gauges; `guardrail.exposure-capped` grouped by `cap` names the limit that actually bound                                                                                                                                                                                                                                                                                                                                                                                                       |
| Fills                | `offer.consumed`, summing `consumedDeltaAssets` by `marketId` and `side`                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| PnL / losses         | Derived downstream from `offer.consumed`, `position.observed` balances, and `maturityTimestamp` — the bot emits primitives, not attribution                                                                                                                                                                                                                                                                                                                                                                                             |
| Not quoting          | `book.observed` with `state: "empty"`. Both sides are emitted on every observed cycle, including when no quote is active at all, so "not quoting" is a positive signal rather than silence                                                                                                                                                                                                                                                                                                                                              |

Absence alerts are scoped per market by `market.configured`, which names one `marketId` and that
market's own `ladderIntervalSeconds`, so each market's silence window is its own configured cadence.
A market configured for bootstrap only carries no `ladderIntervalSeconds`; use
`bootstrapIntervalSeconds` for it. The `ladder` and `bootstrap` flags distinguish a market that is
missing a cycle from one that never configured that workflow. Both manifest records are emitted by `start`; the standalone
`bootstrap` and `ladder` commands are operator tools and emit no manifest, so absence scoping applies
to the deployed `start` process.
One process-wide shortest interval made slower markets look overdue. `bot.configured` scopes the
process-wide `bootstrapIntervalSeconds` and identifies the loan asset and mode. Both are re-emitted
on every process start, so the scope follows configuration changes across a redeploy.

`bot.failed` covers the two incidents no cycle record can describe: a readiness check that fails
during startup, before any monitor loop begins, and the fail-together lifecycle, where one supervised
workflow ends and stops its peers. In the combined case one record is emitted for the process plus
one per failed workflow, so "which workflow half-broke?" is answerable from the shipped stream alone.

The heartbeat is process-level. `runContinuously` is fail-together — any workflow halt aborts its
peers and the process exits — so one heartbeat covers all three workflows, but it proves liveness
only and cannot prove a particular market was read or quoted. The per-market `cycle.completed` and
`reference.observed` records are the positive anchors for that.

#### Known limits

- **Verbose gating.** Everything beyond `cycle.completed`, `guardrail.halted`, `bot.failed`, and
  `setup.check-failed` is projected from verbose diagnostics. Full shipping configuration
  auto-enables `--verbose` for `start`, `bootstrap`, and `ladder`; an operator running those commands
  manually without `--verbose` gets far fewer records.
- **Fill baseline.** `offer.consumed` is a cycle-over-cycle delta of monotonic per-group `consumed`,
  held in an in-process map and never persisted. A group first seen establishes a baseline and emits
  nothing, so a restart loses one cycle of fill telemetry. A baseline is never dropped for a group
  absent from one cycle, because the indexer is eventually consistent and re-baselining would swallow
  the fill in between.
- **Group rate fidelity.** `offer.consumed.groupRateBps` is the _configured_ rate of the group's rung
  nearest the center, not the rate that executed. Two things separate them. Under
  `groupMode: per-book` every rung on a side shares one protocol group, so the reported rate is the
  best of several shared rates. And publication aligns a configured rate to the market's tick
  spacing, so a rate that is not exactly representable at that spacing is published slightly away
  from the configured value on either mode. Treat the field as the intended price level rather than
  an execution price; there is no per-rung execution ledger.
- **Maturity availability.** `position.observed.maturityTimestamp` is projected from maker groups
  already read this cycle rather than a dedicated market read, so monitoring adds no RPC round trip
  and the field is absent when the maker holds no indexed group in that market.
- **Book state is binary.** `book.observed.state` is `quoting` or `empty` only. `readActive`
  reconstructs indexed and not-yet-indexed groups into a single quote set, so a pending-index state is
  not observable at this seam.
- **Reference reads are conditional for bootstrap.** `decidePositionBootstrapTransition` returns a
  decision before any reference-rate derivation once the credit target is reached, or once the
  initial target completed with `autoRefill` off — and `reference.observed` is emitted only when a
  verbose cycle actually holds a reference rate. For a bootstrap-only market, absence therefore
  means "no reference was needed" at least as often as "the reference went stale". A ladder market reads a
  reference every cycle, so the staleness recipe is sound there.
- **Monitoring cannot halt quoting.** Records are derived and written inside the monitored cycle's
  own callback, but `writeCycle` swallows any failure raised while projecting or writing them. A
  broken projection or a failing writer loses telemetry silently; it can never stop a cycle.
- **Duration scope.** `cycle.completed.durationMs` covers one market's check including the post-check
  verbose re-read. Under the combined `start` lifecycle the ladder and bootstrap writers share one
  mutation queue, so it can include queue wait as well as work.

### YAML schema

The root accepts exactly `chain`, `identity`, `contracts`, `apis`, `markets`, `setup`, `bootstrap`,
and `ladder`; unknown keys at any level are rejected. Every supported key appears in
[`quoter-bot.example.yaml`](../quoter-bot.example.yaml).

- `chain`: `id`, `rpcUrl`, `archiveRpcUrl`.
- `identity`: `makerAddress`, `keyStorageMethod`, `makerPrivateKey`, `keystorePath`,
  `keystorePassword`, `keystoreInteractive`, `awsKmsKeyId`, `awsRegion`.
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
provider data without claiming that an absent group is live. A same-quoter group absent from these
sources remains unknown, fails readiness, and requires an operator decision; market membership alone never
permits reconciliation or hard-halt cancellation. The request timeout is an aggregate fetch/RPC bound and
does not reveal endpoint details in failures.

Bootstrap offer-group reads request Base explicitly, ignore well-formed rows from other chains, and fail
closed on malformed chain identity, asset strings, or empty/repeated pagination cursors. The variable Blue
reference hard-fails when its latest checkpoint is more than five minutes behind wall-clock time.

### Position-bootstrap fields

Each `bootstrap` entry must use a unique `marketId` present in `markets.allowlist`.
`targetRate` defaults to `{ strategy: "variable_rate_avg" }` when omitted for backward compatibility;
every other field in each entry is required.

| Field                   | Unit / behavior                                                 | Validation                                                                                            |
| ----------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `marketId`              | 0x-prefixed 32-byte Midnight market ID                          | Required, unique, and allowlisted                                                                     |
| `targetRate`            | Target-rate method selection                                    | `variable_rate_avg`, or `hardcoded` with positive `hardcodedRateBps`; defaults to `variable_rate_avg` |
| `creditTarget`          | Raw credit units; complete at `creditTarget - acceptanceAssets` | Positive unsigned integer                                                                             |
| `acceptanceAssets`      | Raw acceptable shortfall                                        | Non-negative and no greater than `creditTarget`                                                       |
| `offerSize`             | Raw desired offer size before capacity caps                     | Positive unsigned integer                                                                             |
| `premiumBps`            | Integer BPS added to the reference rate                         | Zero or negative                                                                                      |
| `maximumMarketExposure` | Raw per-market exposure cap                                     | Positive and no greater than `maximumTotalExposure`                                                   |
| `maximumTotalExposure`  | Raw strategy-wide exposure cap                                  | Positive                                                                                              |
| `minimumRateBps`        | Inclusive final-rate minimum                                    | Non-negative and no greater than `maximumRateBps`                                                     |
| `maximumRateBps`        | Inclusive final-rate maximum                                    | Non-negative                                                                                          |
| `autoRefill`            | Resume after first observed completion if credit later falls    | Boolean; completion memory lasts for one service instance                                             |

For a market below its accepted target, desired assets are the minimum of `offerSize`, remaining
credit target, cash balance, remaining per-market exposure, and remaining total exposure. Replacement
capacity excludes that market's representative live group while retaining every other active group's
exposure. Zero or negative capacity leaves no offer. The final requested rate is `reference rate +
premiumBps`; an out-of-bounds result is rejected rather than clamped.

Live reconciliation retains an owned offer when its assets, canonical Midnight tick, and continuous
fee cap still match, even if a raw reference-rate change produced the same tick. A market fee-policy
change therefore replaces an offer that is no longer takeable. Every genuinely new publication uses
the current block timestamp as its start, so replacing a consumed offer cannot recreate its
content-addressed group ID.

`BOOTSTRAP_MARKETS` uses an exact JSON array with the same fields; YAML syntax, duplicate object keys,
and prototype keys are rejected. Every integer-valued property—including asset amounts, exposure caps,
rates, and `premiumBps`—must be a quoted decimal-integer string. JSON number tokens are rejected even
when integral; `marketId` remains a string and `autoRefill` remains a JSON boolean. Supplying it replaces
every YAML bootstrap entry, which avoids ambiguous partial-array merge behavior. See
[`.env.example`](../.env.example) for exact syntax.

Bootstrap and ladder select their methods independently. These two valid YAML combinations show both
directions:

```yaml
# Bootstrap fixed at 4%; ladder follows the Blue variable-rate average.
bootstrap:
  - marketId: '0x...'
    targetRate: { strategy: 'hardcoded', hardcodedRateBps: '400' }
ladder:
  - marketId: '0x...'
    targetRate: { strategy: 'variable_rate_avg' }

# Bootstrap follows Blue; ladder is fixed at 4%.
bootstrap:
  - marketId: '0x...'
    targetRate: { strategy: 'variable_rate_avg' }
ladder:
  - marketId: '0x...'
    targetRate: { strategy: 'hardcoded', hardcodedRateBps: '400' }
```

`quoter-bot setup-check --monitor` repeats non-overlapping read-only readiness observations every minute
until its shutdown signal or the first failed report after transient-provider retry tolerance.
`quoter-bot bootstrap` first runs the same one-shot readiness gate as `setup-check`, then executes exactly
one position-bootstrap cycle and prints its
bigint-safe JSON result. `quoter-bot bootstrap --monitor` uses the same gate, repeats non-overlapping cycles
every minute, and performs owned-group cleanup after its shutdown signal. `quoter-bot bootstrap --verbose`
adds safe rate, offer, transaction-hash, configuration, and before/after position diagnostics to
each result. `quoter-bot ladder --monitor` similarly repeats at the shortest configured ladder cadence,
streams cycles, and cleans active owned ladder groups after shutdown; `--verbose` adds safe
configuration, rate, quote, transaction-hash, and before/after capacity diagnostics. Version output,
setup monitoring, and invalid usage never start either writer.

Before a bootstrap cycle reads positions or publishes, it validates every configured market.
Invalid configuration, reference failures, and decision failures trigger a strategy-wide hard halt;
an ordinary position-read failure requests market-local invalidation and permits other markets to
continue. Receipt polling is bounded independently by `TRANSACTION_RECEIPT_TIMEOUT_MS`. Read-only
mode retains the same decisions and fresh prospective whole-book comparison but logs every requested
mutation and graceful-cleanup operation instead.

### Ladder fields and formulas

Each `ladder` entry has a unique allowlisted `marketId`. Rates are integer BPS and asset/exposure
amounts are exact raw loan-asset units. `quotePremiumBps` and `sizeSkewBps` are signed; all other
integer fields are nonnegative or positive as shown below. `targetRate` defaults to
`{ strategy: "variable_rate_avg" }`; every other field in each entry is required.

| Field                        | Unit / behavior                                                                                                                                                      | Validation                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `marketId`                   | 0x-prefixed 32-byte Midnight market ID quoted by this entry.                                                                                                         | Required, unique across the array, and present in `MARKET_IDS`.                                           |
| `targetRate`                 | Target-rate method used as reference `R`.                                                                                                                            | `variable_rate_avg`, or `hardcoded` with positive `hardcodedRateBps`; defaults to `variable_rate_avg`.    |
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

The ladder is state reconciliation, not a collection of independently refilled orders. Every
one-shot `ladder` invocation and every non-overlapping `ladder --monitor` cycle:

1. Reads fresh market credit, wallet balance, allowance, market and strategy exposure, active owned
   groups, group consumption, and the configured target rate (including Blue history only for
   `variable_rate_avg`).
2. Reconstructs the remaining active quote. A partially consumed group contributes only its
   remaining assets, and a fully consumed indexed group contributes no rung. A persisted group that
   has not appeared in the eventually consistent API remains pending-active so the bot cannot
   publish an unsafe duplicate while indexing catches up.
3. Generates a complete desired quote from the current capacities and configuration. If the center
   remains inside `movementToleranceBps`, the active center is retained while sizes are still
   recalculated from fresh inventory.
4. Compares the complete active and desired quotes, then selects one decision:

| Decision   | Condition                                                                                                                                      | Mutation                                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `publish`  | No active ladder remains and at least one side can fund an offer.                                                                              | Publishes one fresh complete tree. The cycle reports `action: "publish", reason: "publish"`.                     |
| `rest`     | Active and desired quotes are exactly equal, or neither an active nor a fundable desired quote exists.                                         | Submits no transaction.                                                                                          |
| `resize`   | An active ladder exists, its center remains inside tolerance, but fresh sizes, funded rung count, side availability, or grouping have changed. | Replaces the complete market ladder and reports `action: "replace", reason: "resize"`.                           |
| `recenter` | The absolute movement from the active center to `reference + quotePremiumBps` is strictly greater than `movementToleranceBps`.                 | Recalculates rates and sizes, replaces the complete ladder, and reports `action: "replace", reason: "recenter"`. |

`movementToleranceBps` controls only rate movement. It never suppresses a capacity-driven `resize`.
For example, a retained center can stay at 4.22% while a fill changes five higher-side rungs from
200 USDC each to 160 USDC each.

A replacement is market-wide rather than rung-local. The bot prepares and validates the future tree,
durably reserves its group IDs, confirms cancellation of every remaining active group for the
market, publishes the complete replacement tree, waits for its receipt, and confirms its durable
ownership. Every publication uses the fresh block timestamp, producing new content-addressed group
IDs instead of reusing consumed IDs. This means an unchanged rung also receives a new group ID when
another rung causes a resize or recenter.

Monitoring is interval-based rather than fill-event-driven. With `loopIntervalSeconds: "60"`, a
consumption is normally reconciled by the next cycle after the current cycle and interval finish;
provider reads and receipt confirmation add to that wall-clock time. A direct one-shot `ladder`
command performs the same reconciliation once.

#### Shared-rung consumption and inventory movement

`shared-rung` creates an independent consumption cap and group ID for every funded rung. A fill
reduces only that group's remaining amount on-chain, but the next cycle recalculates the complete
ladder. Partial consumption normally triggers `resize` too: if one 200 USDC rung has 150 USDC left
while fresh side capacity calls for five 190 USDC rungs, the active and desired quotes differ.

Consider 2,000 USDC split initially into 1,000 USDC of market credit and 1,000 USDC of wallet cash,
with five equal rungs per side and these inventory-responsive limits:

```json
{
  "lowerRateBudgetAssets": "2000000000",
  "higherRateBudgetAssets": "2000000000",
  "targetMarketExposureAssets": "2000000000",
  "maximumTotalExposureAssets": "2000000000"
}
```

The initial quote can allocate 200 USDC to each of five lower and five higher rungs. If a 200 USDC
higher-rate lend offer is consumed, approximately 200 USDC moves from wallet cash into market
credit. The next desired quote becomes:

```text
before fill: lower 1,000 = 5 × 200; higher 1,000 = 5 × 200
after fill:  lower 1,200 = 5 × 240; higher   800 = 5 × 160
decision:    replace / resize
```

If both configured side budgets were instead 1,000 USDC, the lower side would remain capped at
1,000 USDC despite the increased credit, while the higher side would shrink to 800 USDC:

```text
after fill: lower 1,000 = 5 × 200; higher 800 = 5 × 160
```

A lower-side reduce-only fill moves inventory in the opposite direction: market credit falls and
wallet cash rises, so the lower side can shrink while the higher side grows, subject to its budget,
allowance, target-market exposure, and total-exposure caps.

`rungCount` is a maximum, not a guaranteed count. With five configured rungs, zero skew, and a 101
USDC minimum, decreasing capacity produces approximately:

| Fresh side capacity | Funded rungs | Equal allocation                            |
| ------------------- | ------------ | ------------------------------------------- |
| 1,000 USDC          | 5            | 200 USDC each                               |
| 800 USDC            | 5            | 160 USDC each                               |
| 500 USDC            | 4            | 125 USDC each                               |
| 400 USDC            | 3            | About 133 USDC each, plus integer remainder |
| 100 USDC            | 0            | Side omitted because it is below the floor  |

The closest-to-market rungs are funded first when capacity cannot support the full count.

#### Per-book consumption

`per-book` creates one shared consumption group for every funded lower-side offer and a separate
shared group for every funded higher-side offer. It never creates one group spanning both sides.
All offers on one side can consume the same side-total cap, so a fill at any one rate reduces the
capacity available through every rate in that group.

For three higher-side rates sharing 300 USDC:

```text
4.47% ─┐
4.57%  ├─ higher group H: 300 USDC total
4.67% ─┘
```

If 120 USDC executes at 4.47%, only 180 USDC remains collectively across all three offers. Because
otherwise identical rational takers prefer the best rate and that offer can consume the complete
shared cap, the worse same-side rates generally have no execution incentive. `per-book` is therefore
a set of alternative prices under one side limit, not strict price-level depth. Use `shared-rung`
when each rate must reserve a distinct amount and execution should move through successive levels.

Safety failures are separate from the four normal decisions. Configuration, reference, or decision
failure requests a strategy-wide hard halt; a market-state read failure requests market-local
invalidation. A failed or halted monitored cycle stops the loop and still attempts exhaustive owned
group cleanup. `SIGINT` and `SIGTERM` let the in-flight cycle finish and then cancel every remaining
active owned ladder group before the monitor reports `status: "stopped"`.

`LADDER_MARKETS` is exact JSON with the same fields. Every integer-valued property must be a quoted
decimal string; JSON number tokens, floats, exponents, malformed values, unknown fields, duplicate
markets, and markets outside `MARKET_IDS` are rejected. The variable replaces the YAML list before
semantic validation, so a valid environment list can replace semantically invalid YAML while YAML
parser hazards still fail closed.

### Secrets and failure behavior

Do not commit real configuration. The repository ignores `quoter-bot.yaml` and
`quoter-bot.yml` while keeping the example trackable. Prefer environment variables for the maker
private key and future credentials. If a local YAML file contains a secret, restrict access (for
example `chmod 600 quoter-bot.yaml`).

Configuration errors contain stable field/reason metadata but never rejected values, URLs, private
keys, parser snippets, or nested third-party errors. Explicit file failures are loud but do not echo
the supplied path. Runtime setup reports identify providers by stable IDs only.

## Parameter playground

The stateless local playground exposes exactly the ordered `BOOTSTRAP_MARKETS` and `LADDER_MARKETS`
collections. It renders accessible bootstrap and ladder graphics from deterministic per-market derived
rates, validates them with the same browser-safe pure parsers used by runtime configuration, and never
imports secret, provider, logging, or observability modules. It does not read current offers, balances,
positions, or a live market book; use storage, cookies, a backend, or network requests; or model runtime
capacity.

The URL fragment is a strict, bounded, versioned JSON payload containing only `version`, `bootstrap`,
and `ladder`. Valid edits synchronize with `history.replaceState`; invalid edits leave the last valid
URL untouched. The copied URL reproduces collection order, configuration, and graphics on a fresh page,
including under the GitHub Pages subpath.

Import is paste-only. It accepts a strict bootstrap object/array, ladder object/array, documented
`{"bootstrap": [...], "ladder": [...]}` envelope, or one JSON-string layer containing an unambiguous
supported shape. Unknown or duplicate keys, mixed arrays, malformed/oversized input, and invalid
collections are rejected atomically. The four outputs are Bootstrap JSON, the compact exact
`BOOTSTRAP_MARKETS` value, Ladder JSON, and the compact exact `LADDER_MARKETS` value; each collection
validates independently.

From the repository root, one command runs `pnpm install --frozen-lockfile` (also on already-installed
workspaces, where it is fast), creates a fresh isolated build, and serves it on loopback. It does not
run test assertions or require Chromium:

```sh
pnpm run quoter-bot:playground
```

Open the exact URL printed by the command (default `http://127.0.0.1:4173`). Override the listener
with `PORT=5173`, `HOST=localhost`, `--port 5173`, or `--host ::1`; command-line flags take precedence
over environment variables. Only `localhost`, `127.0.0.1`, and `::1` are accepted. IPv6 may be entered
as `::1` or `[::1]`; the printed URL uses brackets. If the selected port is occupied, the launcher
exits with an actionable error instead of claiming success.

The interactive launcher owns install and build process trees portably: Linux and macOS use detached
process groups, while Windows uses non-shell task-tree termination. Press Ctrl-C to stop; `SIGINT` and
`SIGTERM` perform bounded server shutdown, terminate owned process trees, and remove the temporary
fresh build. Cleanup failures are reported and produce a nonzero exit.

For a production-equivalent build without starting a server, run:

```sh
pnpm --filter @morpho-org/quoter-bot run playground:build
```

Relevant playground, browser-safe bot-kit, package, lock, or deployment-workflow changes merged to
`main` deploy through GitHub Actions to <https://morpho-org.github.io/morpho-bots/>. Repository Pages
settings must use **GitHub Actions** as the publishing source; the workflow intentionally cannot
change that repository setting with its least-privilege token. The Pages site is not live until that
post-merge workflow completes successfully; check the repository's **Deploy quoter-bot playground to
GitHub Pages** workflow and its `github-pages` environment for deployment status.
