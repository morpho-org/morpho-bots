# Quoter bot

The bot validates its chain and Midnight setup, bootstraps target lending positions, maintains
two-sided rate ladders, and provides explicit recovery commands. Start with read-only mode to inspect
every intended action before enabling signing.

See [Architecture](./docs/architecture.md) for the contributor-facing package design and code
structure.

## Install from npm

The bot ships on npm as [`@morpho-org/quoter`](https://www.npmjs.com/package/@morpho-org/quoter):
one self-contained, dependency-free bundle installing the `morpho-quoter` command. It requires
Node.js 24.14.1 or newer.

```sh
npm install -g @morpho-org/quoter
```

```sh
# Read-only readiness checks against the configured maker address (no key required).
morpho-quoter --readonly setup-check

# Inspect every intended ladder action without signing or submitting anything.
morpho-quoter --readonly ladder --monitor --verbose

# Run setup checks, position bootstrap, and ladder monitoring together until SIGINT/SIGTERM.
morpho-quoter start --verbose
```

Configuration is identical in every distribution: the CLI discovers `quoter-bot.yaml` (then
`quoter-bot.yml`) in the working directory, takes an explicit file with `--config <path>`, and
reads the environment variables documented below — see [Configuration](#configuration). The
[Docker image](#deploy) `morphoorg/quoter` and the workspace invocation below run the same CLI, so
every `morpho-quoter <arguments>` example in this document can also be run as
`pnpm --filter @morpho-org/quoter-bot run start -- <arguments>` from a repository checkout.

## Parameter playground

Run the stateless parameter playground locally from the repository root:

```sh
pnpm run quoter-bot:playground
```

The launcher performs a frozen-lockfile dependency check before every build, then prints the local
server URL after building the browser artifact. For a production-equivalent
build without starting a server, run:

```sh
pnpm --filter @morpho-org/quoter-bot run playground:build
```

After this pull request is merged to `main`, relevant playground, browser-safe bot-kit, package, lock,
or deployment-workflow changes deploy through GitHub Actions to
<https://morpho-org.github.io/morpho-bots/>. Repository Pages settings must use **GitHub Actions** as
the publishing source; the workflow intentionally cannot change that repository setting with its
least-privilege token. The Pages site is not live until that post-merge workflow completes
successfully; check the repository's **Deploy quoter-bot playground to GitHub Pages** workflow and
its `github-pages` environment for deployment status.

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
`--readonly`, signer-only checks are reported as `not-required`; maker balance, allowance, ratifier,
chain, market, reference, and active-offer observations still run.

`setup-check --monitor` runs the same complete read-only observation every minute and streams each
report. A report containing only explicitly transient provider failures is retried up to two
times within the cycle; recovery emits only the successful report. An invariant or mixed failure
emits `ready: false`, halts monitoring, includes that report in the terminal `setup-failed`
record, and exits with code `1`. A transient-only report that survives its in-cycle retries is
emitted as `ready: false` and retried on the next interval for up to ten consecutive cycles
before halting the same way, because halting cancels every live offer and a provider outage
must not cost the book. `SIGINT` or `SIGTERM` after successful checks lets an
in-flight check finish and emits a final `{"status":"stopped","reason":"signal","cycles":N}` record
with exit code `0`. Monitoring never signs, submits remediation, or performs shutdown cleanup. Add
the root `--readonly` flag when signer checks should be omitted.

Read-only writer commands serialize desired bootstrap and ladder reconcile, hard-halt, and cleanup
requests as one JSON line with event name `readonly.make`. They never sign or submit an operation.
The `--readonly bootstrap` command executes one complete observational decision cycle after deriving
its exact tick, comparing the prospective offer with the complete current maker book, and applying
the SDK's live Mempool-policy validation without signing or broadcasting.
The corresponding final cycle outcome uses `status: "logged"` rather than `"applied"`.

`bootstrap --monitor` requires at least one explicit `bootstrap` / `BOOTSTRAP_MARKETS` entry. Each
market independently selects `targetRate.strategy: variable_rate_avg` (the existing Morpho Blue
variable-rate average) or `hardcoded` with `hardcodedRateBps`; `premiumBps` — plus the optional
`maturityPremium` term derived from the market's live time to maturity — is then added to derive
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
reference rate (with its seconds to maturity when a maturity premium is configured), the resolved
maturity premium, premium-adjusted target rate, deterministic decision, desired bootstrap offer, and
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
Mempool-validated unsigned before signing. Ecrecover trees are signed locally and deliberately not
revalidated, so the replayable signature never leaves the process before publication; Setter trees
are revalidated after their approval confirms. Ecrecover trees are signed and published in one
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

`ladder --verbose` includes the validated market config, current capacities and active quote, the
reference rate (with its seconds to maturity when a maturity premium is configured), the resolved
maturity premium, the premium-adjusted target rate, exact desired ladder, decision, confirmed
transaction hashes, and a fresh state read after every check. Live transaction hashes are also
emitted immediately as `ladder.transaction-submitted` records.

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
depending on API indexing. Before a live cancellation it still verifies the connected chain,
deployed configured Midnight contract, signer identity and nonce, signer authorization, and the
maker and signer gas reserves. Maker-wide invalidation submits one zero-value native Midnight
`multicall(bytes[])`; each
ordered inner call is exactly `setConsumed(groupId, MAX_OFFER_CAP, MAKER_ADDRESS)`. Midnight executes
the inner calls with `delegatecall`, so the authorized signer that submits the outer transaction
remains `msg.sender` throughout while every `onBehalf` value remains the maker. The local transaction
policy rejects any wrong target, selector, call count,
order, group, amount, on-behalf account, or extra calldata. A reverted or failed multicall is reported
without serial retry. Explicit single-group invalidation keeps the simpler direct Midnight
`setConsumed` transaction. Successfully canceled bot-owned groups are removed from durable
ownership state; explicitly configured `V0_OFFER_GROUP_IDS` remain configuration-owned until the
operator edits configuration. If the provider omits one of these configured groups, bootstrap and
ladder reads deliberately fail closed because neither omission nor ordinary partial onchain
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
ownership state. `cancelBuys`, hard halt and graceful cleanup always cancel through one native
multicall under the `cancel-batch` policy, even for one group. Bootstrap and ladder replacement send
two or more groups the same way and a lone group as one `setConsumed` call, so
`MAX_BATCH_CANCELLATION_GAS` and `MAX_BATCH_CANCELLATION_DATA_BYTES` also cap every multi-group
recenter. Removed-market cleanup cancels one group at a time.

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

The package owns its production [Dockerfile](./Dockerfile), local
[docker-compose.yml](./docker-compose.yml), and Kubernetes [Helm chart](./helm/quoter-bot). The
Docker build context is the repository root so pnpm can resolve every workspace dependency; a build
stage compiles the workspace, and the runtime stage ships only this bot's self-contained bundle —
no other bot's code, workspace source, or package manager. The image runs the combined setup,
bootstrap, and ladder monitor directly as the unprivileged `node` user.

Infrastructure operators own scheduling, secrets, and persistent state. Run one instance per chain,
provide the required values from [`.env.example`](./.env.example) or a YAML configuration, and mount
durable storage at `XDG_STATE_HOME`. The local Compose service demonstrates the environment-based
configuration and a persistent `/state` volume. Kubernetes operators can use the package-owned Helm
chart — see [Kubernetes (Helm)](#kubernetes-helm).

A production release (a merged PR whose description says `Releases quoter-bot`, approved after that
line was added) creates a tag without deploying the bot, then publishes the image to Docker Hub as
`morphoorg/quoter`, tagged with the release commit hash and `latest`. The push runs in the public
`morpho-org/morpho-bots` repository from the `quoter-bot-*` tag the release mirror creates there.
The **Publish quoter-bot Docker Hub** workflow publishes only a tag whose commit is on
first-parent `main` and carries the mirror's `Source-Ref:` trailer, and authenticates through the
Docker organization's OIDC connection scoped by the `quoter-bot-dockerhub` GitHub Environment
(secret `DOCKERHUB_OIDC_CONNECTIONID`, vars `DOCKER_USERNAME` and `DOCKER_REPOSITORY`), so CI
stores no static Docker Hub credential.

Before each build, the workflow checks Docker's registry API, reuses an existing immutable
commit-SHA tag on reruns, and fails closed on unexpected registry errors. `latest` only moves
forward: when a
`quoter-bot-*` release tag descends from the built commit, a rerun backfills that commit's image
tag without touching `latest`.

### npm publishing

A production release also publishes the CLI to npm as
[`@morpho-org/quoter`](https://www.npmjs.com/package/@morpho-org/quoter) when
[`package.json`](./package.json)`#version` was bumped. When the release mirror pushes the
`quoter-bot-*` tag to the public `morpho-org/morpho-bots` repository, the **Publish quoter-bot npm**
workflow there — standalone because npm trusted publishing validates the top-level workflow
filename — verifies that the tagged commit is a mirror release snapshot on first-parent `main`,
stages the package with
`pnpm --filter @morpho-org/quoter-bot run npm:pack`, smoke-tests that the staged CLI reports the
staged manifest version, and publishes through npm trusted publishing (OIDC), so CI stores no npm
token. Every publish carries a provenance attestation naming the release commit: a tag push's
event commit is that commit, and a recovery dispatch must select the release tag as the workflow
ref — a run whose event commit differs is refused rather than published unattested.

The staged package (`dist/npm/`) contains exactly the self-contained bundle renamed to
`morpho-quoter.js`, a generated dependency-free manifest, the repository LICENSE, and
[`docs/npm-README.md`](./docs/npm-README.md); the private workspace manifest never reaches the
registry. Published versions are immutable: a release whose version already exists on the registry
completes as a no-op, so bumping `version` in the release PR is what opts a release into an npm
publish. Dist-tags only move forward: a rerun whose commit has a newer descendant release tag
publishes under `backfill` (stable or prerelease), a remaining prerelease takes the `next`
dist-tag only when it semver-advances the registry's current `next`, and a stable version must be
semver-greater than the registry's current `latest` to take that tag; non-advancing versions
publish under `backfill`.

One-time setup: npm cannot create a brand-new package through trusted publishing, so a maintainer
bootstraps the first publish manually
(`pnpm --filter @morpho-org/quoter-bot run npm:pack && npm publish bots/quoter-bot/dist/npm` from
the repository root), then configures the package's trusted publisher on npmjs.com (repository
`morpho-org/morpho-bots`, workflow `publish-quoter-bot-npm.yml`, environment `quoter-bot-npm`) and
creates the `quoter-bot-npm` GitHub Environment there with its deployment policy scoped to
`quoter-bot-*` tags.

### Kubernetes (Helm)

The [`helm/quoter-bot`](./helm/quoter-bot) chart is the recommended way to self-host the bot on
Kubernetes from the public `morphoorg/quoter:latest` image. The chart is consumed directly from
this repository checkout — it is not published to any Helm registry yet — so install it from the
local path. One values file fully configures a deployment: classic workload parameters (image,
CPU/memory resources, persistence, scheduling) sit next to a `config` mapping holding the bot's
complete native YAML configuration — the same schema as
[`quoter-bot.example.yaml`](./quoter-bot.example.yaml) — which the chart renders into a Secret and
passes to the bot with `--config`. Because environment values override YAML values, the chart's
`env`/`envFrom` parameters keep the maker signing secret and the environment-only Better Stack
variables out of that block.

From the repository root:

```sh
helm lint bots/quoter-bot/helm/quoter-bot

helm install quoter-bot bots/quoter-bot/helm/quoter-bot \
  --namespace quoter-bot --create-namespace --values my-values.yaml

helm upgrade quoter-bot bots/quoter-bot/helm/quoter-bot \
  --namespace quoter-bot --values my-values.yaml
```

The chart runs a one-replica StatefulSet because the bot is a singleton writer — a replacement
pod is never created until the old one has fully terminated, across rollouts, manual deletion,
and eviction alike. It mounts a persistent volume at `/state` for durable offer-group ownership
state (kept on uninstall by default), runs the bundle directly as the image's unprivileged
`node` user, and sizes the termination grace period
(1020 seconds by default, automatically floored for a chart-managed configuration to one
receipt timeout per serialized shutdown wait — three per bootstrap market, two per ladder
market, one per ladder group, and two cleanup batches — plus a drain buffer) so shutdown
cleanup can invalidate owned groups and wait for receipts. An upgrade that
changes `config` rolls the pod automatically. See the
[chart README](./helm/quoter-bot/README.md) for the full parameter reference, a complete values
example, and secret-handling options.

## Configuration

### Configuration sources and precedence

Configuration can come from environment variables, a YAML file, or both. YAML files and the
`BOOTSTRAP_MARKETS` and `LADDER_MARKETS` values are each limited to 1 MiB before parsing.

1. `--config <path>` selects that exact `.yaml` or `.yml` file. Other path extensions and a missing,
   unreadable, empty, oversized, malformed, symlinked, or non-regular explicitly named file fail
   startup. Default-discovered symlinks are rejected as unreadable too.
2. Without `--config`, the CLI searches the process working directory from which `morpho-quoter`
   was invoked. It checks `quoter-bot.yaml` first, then `quoter-bot.yml`. If both exist, `.yaml`
   wins.
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

Use [`quoter-bot.example.yaml`](./quoter-bot.example.yaml) as the complete YAML template and
[`.env.example`](./.env.example) as the environment template. Default discovery never selects the
example filename.

```sh
# Explicit file; relative paths resolve from the invocation working directory.
pnpm --filter @morpho-org/quoter-bot run start -- --config ./quoter-bot.yml setup-check

# Default discovery in the current working directory.
pnpm --filter @morpho-org/quoter-bot run start -- setup-check

# Address-only mode works with either configuration source.
pnpm --filter @morpho-org/quoter-bot run start -- --readonly setup-check
```

Two unit conventions apply everywhere: amounts are **raw loan-token units** (for six-decimal USDC,
`101000000` is 101 USDC) and rates are **integer basis points** (`100` = one percentage point).

### Environment variables

Every supported environment variable is listed below. “Raw assets” means the loan token's smallest
unit; for six-decimal USDC, `101000000` is 101 USDC. No value is inferred from another variable.

| Environment variable                | YAML key                              | Requirement and behavior                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHAIN_ID`                          | `chain.id`                            | Required. Must be `1` (Ethereum mainnet) or `8453` (Base); all protocol, token, market, and transaction operations run on the selected chain.                                                                                                                                                                                                                                                                          |
| `RPC_URL`                           | `chain.rpcUrl`                        | Required. Current-state JSON-RPC endpoint for the configured chain, used for blocks, balances, allowances, positions, contract reads, simulation, transaction submission, and receipts.                                                                                                                                                                                                                                |
| `REFERENCE_RPC_URL`                 | `chain.archiveRpcUrl`                 | Required when the selected command has an active `variable_rate_avg` target. Archive-capable JSON-RPC endpoint for the configured chain, used to read the reference Morpho Blue Market at historical blocks. It must retain state for at least `REFERENCE_LOOKBACK_SECONDS`.                                                                                                                                           |
| `MAKER_ADDRESS`                     | `identity.makerAddress`               | Required. Funded principal retained as every offer maker and Midnight `onBehalf` value. It must match a local or keystore signer and differ from an AWS signer.                                                                                                                                                                                                                                                        |
| `KEY_STORAGE_METHOD`                | `identity.keyStorageMethod`           | Optional only for backward-compatible `MAKER_PRIVATE_KEY` use; otherwise `private-key`, `keystore`, or `aws`. Exactly one effective source is required in write mode.                                                                                                                                                                                                                                                  |
| `MAKER_PRIVATE_KEY`                 | `identity.makerPrivateKey`            | Local private-key source. Must be a 0x-prefixed 32-byte secp256k1 key. `--private-key` overrides config. Never include it in committed configuration or logs.                                                                                                                                                                                                                                                          |
| `KEYSTORE_PATH`                     | `identity.keystorePath`               | Encrypted Web3 Secret Storage file used by the `keystore` method. CLI equivalent: `--keystore <path>`.                                                                                                                                                                                                                                                                                                                 |
| `KEYSTORE_PASSWORD`                 | `identity.keystorePassword`           | Keystore password. Exactly one direct or interactive mode is required; see the argv exposure warning above. Never logged or included in diagnostics.                                                                                                                                                                                                                                                                   |
| `KEYSTORE_INTERACTIVE`              | `identity.keystoreInteractive`        | `true` prompts without echoing for the keystore password; CLI equivalent: `--interactive`. Not suitable for unattended deployment.                                                                                                                                                                                                                                                                                     |
| `AWS_KMS_KEY_ID`                    | `identity.awsKmsKeyId`                | KMS key ID/ARN/alias for a distinct asymmetric `ECC_SECG_P256K1` signer. The bot calls KMS directly. `--aws` selects this backend.                                                                                                                                                                                                                                                                                     |
| `AWS_REGION`                        | `identity.awsRegion`                  | AWS region containing the KMS key. AWS credentials use the standard AWS SDK credential chain.                                                                                                                                                                                                                                                                                                                          |
| `MIDNIGHT_ADDRESS`                  | `contracts.midnightAddress`           | Required. Expected deployed Midnight singleton. Setup verifies its bytecode before a writer starts.                                                                                                                                                                                                                                                                                                                    |
| `LOAN_ASSET_ADDRESS`                | `contracts.loanAssetAddress`          | Required. Loan token used by every configured Midnight Market. Balances, allowances, budgets, offer sizes, and exposure values use this token's raw units.                                                                                                                                                                                                                                                             |
| `RATIFIER_ADDRESS`                  | `contracts.ratifierAddress`           | Required. Canonical SDK ratifier authorized by the maker. AWS mode requires Ecrecover; local and keystore modes may use Ecrecover or Setter.                                                                                                                                                                                                                                                                           |
| `MORPHO_API_BASE_URL`               | `apis.morphoBaseUrl`                  | Required. Morpho API origin used for Midnight books, market metadata, prospective-offer validation, and cursor-paginated maker offer groups. No API-key header is supported.                                                                                                                                                                                                                                           |
| `ROUTER_API_BASE_URL`               | `apis.routerBaseUrl`                  | Deprecated compatibility key. Accepted and ignored; ratifier identity comes from the pinned Morpho SDK catalog.                                                                                                                                                                                                                                                                                                        |
| `MARKET_IDS`                        | `markets.allowlist`                   | Required comma-separated list of unique 0x-prefixed bytes32 Midnight Market IDs. Every bootstrap or ladder `marketId` must appear here.                                                                                                                                                                                                                                                                                |
| `REFERENCE_MARKET_ID`               | `markets.referenceMarketId`           | Required when the selected command has an active `variable_rate_avg` target. Must be a 0x-prefixed bytes32 Morpho Blue Market ID.                                                                                                                                                                                                                                                                                      |
| `REFERENCE_LOOKBACK_SECONDS`        | `markets.referenceLookbackSeconds`    | Optional window, in seconds, that the `variable_rate_avg` target averages the reference market over; defaults to `259200` (three days) and accepts `3600` through `2592000`. Widening it trades responsiveness for immunity to transient spikes that can walk the ladder into the resting book. The archive endpoint must retain state for the whole window.                                                           |
| `V0_OFFER_GROUP_IDS`                | `markets.v0OfferGroupIds`             | Optional comma-separated list of unique, explicitly strategy-owned bytes32 offer-group IDs; defaults to empty. Use it to adopt known pre-existing groups safely.                                                                                                                                                                                                                                                       |
| `NATIVE_RESERVE_WEI`                | `setup.nativeReserveWei`              | Required unsigned integer. Minimum maker native-token balance, in wei, required by readiness for transaction fees.                                                                                                                                                                                                                                                                                                     |
| `SIGNER_NATIVE_RESERVE_WEI`         | `setup.signerNativeReserveWei`        | Required positive integer in AWS write mode. Minimum signer native-token balance in wei.                                                                                                                                                                                                                                                                                                                               |
| `MAX_FEE_GWEI`                      | `setup.maxFeeGwei`                    | Required positive decimal gwei in write mode. Maximum EIP-1559 fee per gas. Keep it well above twice the chain's base fee: once it clamps a first send, the first bump drops.                                                                                                                                                                                                                                          |
| `PRIORITY_FEE_GWEI`                 | `setup.priorityFeeGwei`               | Required positive decimal gwei in write mode. Initial priority fee, with replacement headroom below `MAX_FEE_GWEI`.                                                                                                                                                                                                                                                                                                    |
| `MAX_TRANSACTION_SPEND_WEI`         | `setup.maxTransactionSpendWei`        | Required positive integer in write mode. Maximum `gas × maxFeePerGas` for one transaction.                                                                                                                                                                                                                                                                                                                             |
| `MAX_PUBLICATION_GAS`               | `setup.maxPublicationGas`             | Required positive integer in write mode. Publication gas ceiling.                                                                                                                                                                                                                                                                                                                                                      |
| `MAX_PUBLICATION_DATA_BYTES`        | `setup.maxPublicationDataBytes`       | Required positive integer in write mode. Publication calldata ceiling.                                                                                                                                                                                                                                                                                                                                                 |
| `MAX_CANCELLATION_GAS`              | `setup.maxCancellationGas`            | Required positive integer in write mode. Single-cancellation gas ceiling.                                                                                                                                                                                                                                                                                                                                              |
| `MAX_BATCH_CANCELLATION_GAS`        | `setup.maxBatchCancellationGas`       | Required positive integer in write mode. Batch-cancellation gas ceiling.                                                                                                                                                                                                                                                                                                                                               |
| `MAX_BATCH_CANCELLATION_DATA_BYTES` | `setup.maxBatchCancellationDataBytes` | Required positive integer in write mode. Batch-cancellation calldata ceiling.                                                                                                                                                                                                                                                                                                                                          |
| `MAX_RATIFICATION_GAS`              | `setup.maxRatificationGas`            | Required only for local or keystore Setter mode. Setter ratification gas ceiling.                                                                                                                                                                                                                                                                                                                                      |
| `REQUEST_TIMEOUT_MS`                | `setup.requestTimeoutMs`              | Optional provider-operation and aggregate pagination timeout in milliseconds. Defaults to `10000`; accepted range is `1` through `120000`.                                                                                                                                                                                                                                                                             |
| `TRANSACTION_RECEIPT_TIMEOUT_MS`    | `setup.transactionReceiptTimeoutMs`   | Optional timeout for confirming an already-submitted transaction, in milliseconds. Defaults to `180000`; accepted range is `1` through `900000`.                                                                                                                                                                                                                                                                       |
| `BOOTSTRAP_MARKETS`                 | `bootstrap`                           | Optional exact JSON array of position-bootstrap entries documented below; defaults to `[]` and replaces the complete YAML `bootstrap` list when supplied.                                                                                                                                                                                                                                                              |
| `LADDER_MARKETS`                    | `ladder`                              | Optional exact JSON array of ladder entries documented below; defaults to `[]` and replaces the complete YAML `ladder` list when supplied.                                                                                                                                                                                                                                                                             |
| `ACCEPTED_LOSS_FACTOR`              | `markets.acceptedLossFactor`          | Optional JSON object (YAML mapping) from allowlisted market id to its accepted loss factor as a canonical unsigned decimal string, below `type(uint128).max`. An omitted market accepts `0`; lending on a market halts whenever its loss factor differs. Replaces the complete YAML mapping when non-empty; an empty value (as Compose forwards an unset one) is ignored. See [Loss-factor guard](#loss-factor-guard). |
| `BETTERSTACK_SOURCE_TOKEN`          | —                                     | Optional Better Stack source token. Must be set together with `BETTERSTACK_INGESTING_HOST`; partial configuration emits `logship.misconfigured` and ships nothing.                                                                                                                                                                                                                                                     |
| `BETTERSTACK_INGESTING_HOST`        | —                                     | Optional Better Stack ingest host, with or without an `https://` prefix. Must be set together with `BETTERSTACK_SOURCE_TOKEN`.                                                                                                                                                                                                                                                                                         |
| `OTEL_EXPORTER_OTLP_ENDPOINT`       | —                                     | Optional OTLP/HTTP base endpoint enabling OpenTelemetry trace and metric export. Unset disables telemetry entirely; the standard `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` variants enable one signal alone. The value may embed an access token and is never logged.                                                                                                               |
| `OTEL_EXPORTER_OTLP_HEADERS`        | —                                     | Optional comma-separated `key=value` request headers for the OTLP endpoint (typically authorization). Read by the exporter only and never logged.                                                                                                                                                                                                                                                                      |

There is no separate Mempool endpoint or API-key field. Books and cursor-paginated maker offer groups
are read through `MORPHO_API_BASE_URL`. Ratifier identity is validated from the pinned Morpho SDK
catalog, so setup readiness does not depend on a Router API endpoint. `ROUTER_API_BASE_URL` and
`apis.routerBaseUrl` remain accepted as ignored compatibility keys for existing deployments.

### Better Stack observability

Set both `BETTERSTACK_SOURCE_TOKEN` and `BETTERSTACK_INGESTING_HOST` to ship sanitized named
monitoring records to Better Stack. Records written through the CLI event writer pass an explicit
allowlist: only the event names in `MONITORING_EVENT_NAMES` plus `ladder.transaction-submitted`,
`bootstrap.transaction-submitted`, and `offer-invalidation.transaction-submitted` cross that
boundary. Everything else the CLI writes stays local — the `quoter-bot.cycle` cycle envelope and
`readonly.make` are named but nested and unversioned, so they are stdout-only, and the terminal
monitor report is never shipped (it lands on stdout on success and on stderr on the failure path,
attached to `quoter-bot.error`). Their content is available as the flat `cycle.completed`,
`guardrail.*`, and `bot.failed` records. Separately, `@repo/observability` emits
`bot.started`, `bot.stopped`, and `bot.unexpected-error` straight through the shipping logger,
bypassing the allowlist, so those three are in the log source too. Shipping is
best-effort and never replaces or suppresses the existing stdout/stderr JSON Lines contract. With
full shipping configuration, `start`, `bootstrap`, and `ladder` automatically enable the existing
safe `--verbose` event stream (without adding a duplicate flag), so active positions, bootstrap
offers, ladder quotes/offers, decisions, and submitted/confirmed transactions are available to the
log source. With the shipping variables unset no log record leaves the process; partial
configuration fails loud locally and does not enable verbose diagnostics.

Every record carries `bot: "quoter-bot"` and the configured `chainId`. `schemaVersion` is bound into
the logger context of every record (currently `4`), so a
consumer can pin the contract; it is bumped only on a breaking field rename or removal. Nested
`status: "failed"`, `status: "halted"`, and `errorName` values are emitted at error level.
Unexpected failures include only a sanitized `errorName`; private keys, RPC/API credentials, signed
or raw transaction payloads, provider payloads, and untrusted raw error messages are never added to
observability records.

Useful Better Stack source queries/filters include:

- lifecycle and restarts: `bot:quoter-bot AND event:(bot.started OR bot.stopped OR bot.failed)`;
- configured scope: `bot:quoter-bot AND event:(bot.configured OR market.configured)`;
- monitor cycles: `bot:quoter-bot AND event:cycle.completed` plus `workflow`, `action`, or `status`;
- failures: `bot:quoter-bot AND level:error`, optionally grouped by `event` and `errorName`.

Create the log source, saved queries, and any dashboard/alerting in Better Stack externally;
this repository does not provision or claim a deployed dashboard URL.

Every shipped record carries a named top-level `event` and a flat scalar payload, so Better Stack
metric expressions can group on it; the `bot.action` fallback is unreachable for this bot.

**Units.** Every `*Assets` field is an unsigned raw smallest-unit amount of the configured
`loanAsset`. Every `*Bps` field is an integer basis-point value. Both serialize as decimal strings
because the bot-kit logger flattens `bigint` before shipping. The bot never reads token decimals, so
no field is human-scaled — resolve decimals downstream from the `loanAsset` address in
`bot.configured`.

| Event                            | Fires when                                                                                                | Fields                                                                                                                                                                                                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bot.configured`                 | Once per process start                                                                                    | `bootstrapIntervalSeconds`, `loanAsset`, `referenceMode`, `readOnly`                                                                                                                                                                                                   |
| `market.configured`              | Once per configured market, at startup                                                                    | `marketId`, `ladder`, `bootstrap`, `ladderIntervalSeconds?`                                                                                                                                                                                                            |
| `bot.failed`                     | A terminal failure stops the process                                                                      | `workflow?`, `reason`, `errorName?`                                                                                                                                                                                                                                    |
| `cycle.completed`                | Every market of every setup/bootstrap/ladder cycle                                                        | `workflow`, `marketId?`, `status`, `stage?`, `action?`, `reason?`, `durationMs?`, `errorName?`, `adapterOperation?`, `snapshotErrorOperation?`                                                                                                                         |
| `guardrail.rate-omitted`         | A cycle omitted rates outside the hard range (per side and bound, count > 0)                              | `workflow`, `marketId`, `side?`, `omittedRungs`, `omittedAssets`, `bound`, `outermostRateBps`, `referenceRateBps?`, `minimumRateBps`, `maximumRateBps`                                                                                                                 |
| `guardrail.cross-book-cleared`   | Own bootstrap-buy clearance repriced rungs during generation (per side, count > 0)                        | `workflow`, `marketId`, `side`, `clearedRungs`                                                                                                                                                                                                                         |
| `guardrail.book-cleared`         | The opposing market book repriced rungs at publication (per side, count > 0)                              | `workflow`, `marketId`, `side`, `clearedRungs`                                                                                                                                                                                                                         |
| `guardrail.book-crossed`         | A third party crosses the resting ladder on that side (per side, verbose cycles)                          | `workflow`, `marketId`, `side`, `clearable`, `suppressed`                                                                                                                                                                                                              |
| `guardrail.exposure-capped`      | A bootstrap offer was reduced below its request                                                           | `workflow`, `marketId`, `requestedAssets`, `cappedAssets`, `cap`                                                                                                                                                                                                       |
| `guardrail.rungs-truncated`      | Funded rungs are fewer than configured (per side)                                                         | `marketId`, `side`, `configuredRungs`, `fundedRungs`                                                                                                                                                                                                                   |
| `guardrail.spread-rejected`      | A bootstrap result's `adapterOperation` is `negative-spread`                                              | `marketId`                                                                                                                                                                                                                                                             |
| `guardrail.publication-withheld` | A prepared buy was released unpublished after its replaced groups were cancelled                          | `workflow`, `marketId`, `reason` (`capacity-changed` \| `price-changed` \| `loss-factor-mismatch` \| `snapshot-unavailable` \| `below-minimum-offer` \| `rate-out-of-range`), `minimumAssets?`                                                                         |
| `guardrail.lend-halted`          | A loss-factor mismatch halts lending on a market; on change and every ten cycles while it lasts           | `workflow`, `marketId`, `lossFactor`, `acceptedLossFactor`, `defaulted`, `direction`, `incrementalLossBps?` (only for `above`)                                                                                                                                         |
| `guardrail.halted`               | A cycle halted (offers pulled)                                                                            | `workflow`, `marketId?`, `stage`, `reason`, `strategyInvalidated`, `adapterOperation?`                                                                                                                                                                                 |
| `reference.observed`             | A verbose cycle read the reference rate                                                                   | `workflow`, `marketId`, `referenceRateBps`, `targetRateBps?`                                                                                                                                                                                                           |
| `inventory-skew.observed`        | A verbose ladder cycle priced its buys with a configured inventory skew                                   | `workflow`, `marketId`, `inventorySkewBps`, `skewClamped`, `creditAssets`, `neutralCredit`                                                                                                                                                                             |
| `position.observed`              | A verbose ladder cycle observed post-check market state                                                   | `marketId`, `cashBalanceAssets?`, `creditAssets?`, `otherMarketCreditAssets?`, `reservedAssets?`, `marketReservedAssets?`, `maturityTimestamp?`, `lowerRateCapacityAssets?`, `higherRateCapacityAssets?`, `targetMarketCapacityAssets?`, `maximumTotalCapacityAssets?` |
| `bootstrap.progress`             | A verbose bootstrap cycle observed position state                                                         | `marketId`, `creditAssets`, `creditTargetAssets`                                                                                                                                                                                                                       |
| `book.observed`                  | A verbose ladder cycle observed post-check market state (both sides always)                               | `marketId`, `side`, `state`, `rungs`, `totalUnits`, `bestRateBps?`, `worstRateBps?`, `centerRateBps?`                                                                                                                                                                  |
| `offer.consumed`                 | A group's monotonic `consumed` grew since the previous cycle                                              | `marketId`, `side`, `consumedDeltaUnits`, `groupRateBps`, `remainingUnits`, `groupId` _(trace only)_                                                                                                                                                                   |
| `transaction.settled`            | A submitted transaction confirmed; `marketId` is absent for strategy-wide halt/invalidation cancellations | `workflow`, `marketId?`, `operation`, `txHash` _(trace only)_                                                                                                                                                                                                          |
| `setup.check-failed`             | One named setup check failed, blocking readiness                                                          | `check`, `status`                                                                                                                                                                                                                                                      |
| `setup.check-warning`            | One named setup check warned without blocking readiness                                                   | `check`, `status`                                                                                                                                                                                                                                                      |

`txHash` and `groupId` are unbounded trace-only correlation fields: use them to join records, never
as grouping dimensions. The safe dimensions are `workflow`, `marketId`, `side`, `status`, `stage`,
`action`, `reason`, `check`, `bound`, `cap`, `operation`, `state`, `referenceMode`,
`adapterOperation`, `snapshotErrorOperation`, `guardrail.lend-halted`'s `direction` and `defaulted`,
and `guardrail.book-crossed`'s `clearable` and `suppressed`.
Guardrail records are aggregated per side per cycle and emitted only when the count is non-zero,
because a side can hold up to 512 rungs and regenerate every second. Error text never ships — only
allowlisted `errorName` classifications.

Alert recipes:

| Question             | Signal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Crash / halt         | `bot.failed` (grouped by `workflow`) OR `bot.unexpected-error`, which is the only record an unclassified entrypoint failure emits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Liveness             | Absence of a healthy `cycle.completed` — `workflow` `ladder` or `bootstrap` with `status` `applied`, `observed`, or `logged` — for longer than the shortest configured interval plus the longest cycle. A cycle emits only when it ends, runs its markets in turn, and can wait up to `TRANSACTION_RECEIPT_TIMEOUT_MS` on each transaction it confirms, so size the window from that bound and observed `durationMs`. A crash loop that dies before its first healthy cycle, a hung process, and a stopped log pipeline all read as silence. Configure one alert per `chainId`, each opening an incident on missing data: Better Stack's default does not fire when no records arrive, and a grouped query stays non-empty while any other chain still reports |
| Restarts             | More than one `bot.started` per `chainId` within the liveness window. A process hard-killed after a healthy cycle emits neither `bot.failed` nor `bot.unexpected-error`, and its restarts keep the liveness alert quiet                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Halt / guardrail     | `guardrail.halted`; `guardrail.*` counts over a window                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Stale reference      | Absence of `reference.observed` for a `marketId` beyond two of its `ladderIntervalSeconds`. Scope to `market.configured` with `ladder: true`; a bootstrap-only market can go silent legitimately (see below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Inventory / exposure | `position.observed` gauges plus `guardrail.exposure-capped` grouped by `cap`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Fills                | `offer.consumed`, summing `consumedDeltaUnits` by `marketId` and `side`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| PnL / losses         | Derived downstream from `offer.consumed`, `position.observed`, and `maturityTimestamp`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Not quoting          | `book.observed` with `state: "empty"` — emitted for both sides even with no active quote                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Absence alerts are scoped per market by `market.configured`, which names the market and its own
`ladderIntervalSeconds`; a single process-wide interval would make slower markets look overdue.
`bot.configured` scopes the process-wide `bootstrapIntervalSeconds`.

**Known limits.**

- Everything beyond `cycle.completed`, `guardrail.halted`, `guardrail.lend-halted`,
  `setup.check-failed`, and `setup.check-warning` requires
  `--verbose`. Full shipping configuration auto-enables it; running `start`, `bootstrap`, or `ladder`
  manually without `--verbose` yields far fewer records.
- Fills are diffed from monotonic per-group `consumed`. A group first seen establishes a baseline and
  emits nothing, so a restart loses one cycle of fill telemetry.
- `offer.consumed.groupRateBps` is the configured rate of the group's rung nearest the center, not
  the rate that executed. Under `groupMode: per-book` every rung on a side shares one protocol group,
  so it is only the best of several shared rates; and because publication aligns a rate to the
  market's tick spacing, it can differ slightly from the published rate on either mode.
- `position.observed.maturityTimestamp` is projected from maker groups already read this cycle rather
  than a dedicated market read, so it is absent when the maker holds no indexed group in that market.
- `book.observed.state` is `quoting` or `empty` only: `readActive` reconstructs indexed and
  not-yet-indexed groups into one quote set, so a pending-index state is not observable at this seam.
- Bootstrap does not always read a reference. `decidePositionBootstrapTransition` decides before any
  rate derivation once the credit target is reached, or once the initial target completed with
  `autoRefill` off, and `reference.observed` is emitted only when a verbose cycle holds a reference
  rate — so for a bootstrap-only market its absence often means "not needed" rather than "stale".
  A ladder market reads a reference every cycle.
- Monitoring cannot halt quoting. Records are derived and written inside the monitored cycle's own
  callback, but `writeCycle` swallows any failure raised while projecting or writing them: telemetry
  can be lost silently, and a broken projection can never stop a cycle.
- Shutdown cleanup cancellations and the explicit `invalidate` command ship pre-receipt
  `*.transaction-submitted` records but no `transaction.settled` counterpart: confirmed hashes
  exist only on terminal reports, which are not shipped, and `MonitoringWorkflow` has no
  invalidation member for a contract-valid settled record. The `quoter_bot.transactions` metric
  therefore pairs `submitted`/`settled` phases only for the `bootstrap` and `ladder` workflows —
  `offer-invalidation` submissions are submitted-only by contract, not stuck. A failed cleanup
  remains alertable as `bot.failed` with `reason: "cleanup-failed"`.
- `cycle.completed.durationMs` covers one market's check including the post-check verbose re-read.
  Under the combined `start` lifecycle the ladder and bootstrap writers share one mutation queue, so
  it can include queue wait.

### OpenTelemetry observability

Set `OTEL_EXPORTER_OTLP_ENDPOINT` (or a signal-specific
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`) to export traces and
metrics over OTLP/HTTP with JSON encoding. Telemetry follows
the same contract as Better Stack shipping: strictly opt-in (unset means nothing is registered and
no telemetry code runs), strictly best-effort (no export failure can interrupt or halt quoting),
and strictly sanitized. It is configured independently of `BETTERSTACK_*`; either sink alone
auto-enables the safe `--verbose` event stream for `start`, `bootstrap`, and `ladder`.

**Traces.** Every setup/bootstrap/ladder cycle runs inside a `quoter-bot.cycle` span tagged
`workflow`, and every outbound `fetch`/undici request (RPC and Morpho API calls) becomes a child
client span via `diagnostics_channel` instrumentation, with the semconv
`http.client.request.duration` histogram recorded alongside. Under the combined `start` lifecycle
the cycle span begins at enqueue, so wait behind the shared bootstrap/ladder mutation queue is
part of the span — per-market work time remains `cycle.completed.durationMs`, making contention
the difference between the two. Every URL-bearing attribute (`url.full`, `server.address`, on
spans and the duration metric alike) is reduced to a classified origin: path and query are
dropped and subdomain labels collapse to `[redacted]` (some providers encode keys as hostname
labels), keeping only the last two hostname labels, the scheme, and the port — IP literals and
one- or two-label hosts pass through. Failures are sanitized the
same way: a span processor strips every `exception` event and status message before export, so a
failed request or cycle span carries only an error status plus low-cardinality classifications
(`error.type`, the allowlisted `errorName`) — raw error text never reaches the exporter. A cycle
whose result reports a handled failure — a `failed`/`halted` market result, a not-ready readiness
report — carries the same error status, and one-shot `setup-check`, `bootstrap`, and `ladder`
invocations wrap their single cycle in the same span and mirror their result into the same flat
monitoring records for the sinks (never onto stdout, whose one-shot contract stays a single
result), so trace and metric coverage match the monitors. Monitor and `start` service
construction — the readiness preflight and removed-market cleanup that run before the first
cycle — is traced as a `quoter-bot.startup` span. AWS KMS and quoter-signer Lambda calls use the AWS SDK's `node:http` stack, not
undici, so they appear inside the cycle span's duration but not as child spans.

**Metrics.** The `quoter_bot.*` instruments are derived from the same shipped monitoring records
documented above, so the log stream and the metric stream can never disagree about what happened.
Their attributes are restricted to the safe grouping dimensions listed above plus the derived
`type` (guardrail event suffix) and `phase` (`submitted`/`settled`) discriminators; `txHash`,
`groupId`, and `errorName` never become metric attributes. The semconv
`http.client.request.duration` histogram is the one instrument outside that vocabulary, carrying
the standard bounded HTTP client dimensions (method, status code, server address/port, URL
scheme, class-of-error `error.type`) and never a path, query, or free-form text. `*_assets` and
`*_bps` values are raw smallest-unit integers converted to floating point (magnitudes beyond 2^53
lose precision but keep scale). The book `*_rate_bps` gauges exist only while that side is
quoting: an empty side drops its rate data points rather than freezing the last published rate,
so a rate reading always sits beside `quoter_bot.book.quoting = 1`. Position and reference gauges
are last-observed values, refreshed by every verbose cycle that carries the field — an optional
field absent from one record (for example `maturityTimestamp` with no indexed group) keeps its
previous reading rather than being dropped, exactly like its log counterpart.

| Instrument                                                            | Kind      | Source record                                                     |
| --------------------------------------------------------------------- | --------- | ----------------------------------------------------------------- |
| `quoter_bot.cycles`                                                   | counter   | `cycle.completed`                                                 |
| `quoter_bot.cycle.duration` (ms)                                      | histogram | `cycle.completed.durationMs`                                      |
| `quoter_bot.failures`                                                 | counter   | `bot.failed`                                                      |
| `quoter_bot.guardrail.events`                                         | counter   | `guardrail.*`, tagged `type`                                      |
| `quoter_bot.transactions`                                             | counter   | `*.transaction-submitted` + `transaction.settled`, tagged `phase` |
| `quoter_bot.transaction.lifecycle`                                    | counter   | `transaction.lifecycle`, tagged `state` and `reason`              |
| `quoter_bot.offers.consumed` / `.consumed_units`                      | counter   | `offer.consumed`                                                  |
| `quoter_bot.setup.checks`                                             | counter   | `setup.check-failed` / `-warning`                                 |
| `quoter_bot.reference.rate_bps` / `.target_rate_bps`                  | gauge     | `reference.observed`                                              |
| `quoter_bot.market.inventory_skew_bps`                                | gauge     | `inventory-skew.observed`                                         |
| `quoter_bot.position.*`                                               | gauge     | `position.observed`, one per field                                |
| `quoter_bot.bootstrap.credit_assets` / `.credit_target_assets`        | gauge     | `bootstrap.progress`                                              |
| `quoter_bot.book.*` (`rungs`, `total_units`, `quoting`, `*_rate_bps`) | gauge     | `book.observed`                                                   |

Every exported span and metric carries resource identity `service.name: quoter-bot`
(`OTEL_SERVICE_NAME` overrides), `service.version`, and `chainId`. Metrics export every 60 s
(`OTEL_METRIC_EXPORT_INTERVAL` overrides, in milliseconds); spans batch-export continuously; on
shutdown both flush with a 10-second bound. Lifecycle is visible as `otel.started`,
`otel.start-failed`, and `otel.shutdown-failed` records, and SDK-internal export errors surface as
a rate-limited `otel.diagnostic` record carrying a classification token only — endpoint URLs and
headers may embed credentials and are never logged.

For a local stack, `docker compose --profile otel up` starts a bundled
collector/Tempo/Prometheus/Loki/Grafana ([`grafana/otel-lgtm`](https://github.com/grafana/docker-otel-lgtm));
point the bot at `http://otel-lgtm:4318` (from inside compose) or `http://127.0.0.1:4318` (from a
local `start`) and open Grafana on `http://localhost:3000`. As with Better Stack, this repository
does not provision or claim a deployed collector or dashboard.

### YAML schema

The root accepts exactly `chain`, `identity`, `contracts`, `apis`, `markets`, `setup`, `bootstrap`,
and `ladder`; unknown keys at any level are rejected. Every supported key appears in
[`quoter-bot.example.yaml`](./quoter-bot.example.yaml).

- `chain`: `id`, `rpcUrl`, `archiveRpcUrl`.
- `identity`: `makerAddress`, `keyStorageMethod`, `makerPrivateKey`, `keystorePath`,
  `keystorePassword`, `keystoreInteractive`, `awsKmsKeyId`, `awsRegion`.
- `contracts`: `midnightAddress`, `loanAssetAddress`, `ratifierAddress`.
- `apis`: `morphoBaseUrl`, `routerBaseUrl`.
- `markets`: `allowlist`, `referenceMarketId`, `referenceLookbackSeconds`, `v0OfferGroupIds`,
  `acceptedLossFactor`.
- `setup`: `nativeReserveWei`, `signerNativeReserveWei`, `maxFeeGwei`, `priorityFeeGwei`,
  `maxTransactionSpendWei`, `maxPublicationGas`, `maxPublicationDataBytes`, `maxCancellationGas`,
  `maxBatchCancellationGas`, `maxBatchCancellationDataBytes`, `maxRatificationGas`,
  `requestTimeoutMs`, `transactionReceiptTimeoutMs`.
- `bootstrap`: an ordered list of the exact per-market objects documented below.
- `ladder`: an ordered list of the exact per-market objects documented below.

`setup.maximumLendExposureAssets` was removed. Delete it from existing configuration files:
unknown keys are rejected and the sanitized error does not name the offending key, so a stale entry
crash-loops the bot at startup with no indication of which line is at fault. A stale
`MAXIMUM_LEND_EXPOSURE_ASSETS` environment variable is inert and needs no action — the loader reads
an allowlist and ignores anything outside it.

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

- Configured chain identity and configured Midnight bytecode.
- The maker emergency-gas reserve, loan-token allowance, and ratifier authorization.
  Startup fails when the maker has no allowance to Midnight while any buy is configured, and warns without blocking when the
  allowance is below one full deployment of the configured buy exposure. Each ladder market
  contributes `min(higherRateBudgetAssets, targetMarketExposureAssets)` — only the higher-rate side
  lends, lower-rate rungs sell existing credit — and each bootstrap market contributes
  `min(offerSize, creditTarget, maximumMarketExposure)`. Contributions sharing one `marketId` are
  summed once and capped by that market's loosest market-exposure bound, so a market configured in
  both workflows is not double counted; the combined sum is then capped by the largest configured
  total-exposure bound across all markets (`maximumTotalExposureAssets` for ladder,
  `maximumTotalExposure` for bootstrap), because both workflows reserve against the same maker
  portfolio. `groupMode` only changes how rungs are grouped onchain, not the cash committed, so it
  does not affect the figure. An ERC-20 allowance is a cumulative spend budget, not an
  outstanding-exposure cap: every buy fill draws it down, including rebuys after the lower side
  sells credit. Both the ladder and the bootstrap size each buy by the lesser of wallet balance and
  remaining allowance, so a draining approval shrinks the book rather than halting the bot;
  monitoring reports a `warning` below the figure, including a revoked approval, but never fails. Approve headroom above the figure, or an unlimited
  amount, to keep quoting at full size.
- Active maker offers: an offer on an unconfigured market, or a crossed/inverted book, fails
  readiness. A live offer group the bot cannot attribute to itself is reported as `warning` and
  does not block readiness — group ownership is a local durable record, so redeploying onto a fresh
  filesystem orphans the bot's own groups, and halting on that cannot recover until every orphan
  expires. Exposure is derived from live onchain groups either way.
- Signer identity, signer nonce, and the required identity relationship: local and keystore signers
  equal the maker; an AWS signer differs. AWS mode also checks the signer gas reserve and Midnight
  authorization. Signer-only checks are `not-required` with `--readonly`. Addresses are not included
  in operator output.
- Every allowlisted market is active, uses the configured loan asset, has valid tick spacing and
  maturity, and agrees between API and chain state.
- The exact Blue reference market is readable from the archive provider.
- Active offer groups belong to configured namespaces and markets and are not crossed/inverted.
- Every allowlisted market's loss factor equals its accepted value. A difference, an unreadable
  value, or a malformed response is a `loss-factor` `warning`, never a failure; see
  [Loss-factor guard](#loss-factor-guard).

`V0_OFFER_GROUP_IDS` is optional. Readiness and every writer use the same explicit ownership source:
configured IDs plus bot-issued IDs from the maker-and-market-bound state file. Publication first durably
reserves the SDK-derived group ID, broadcasts only after that write succeeds, and then promotes the
reservation to confirmed ownership. A failed broadcast removes its reservation; if confirmation storage
fails after a successful broadcast, the reservation remains sufficient to recognize the group from fresh
provider data without claiming that an absent group is live. A same-quoter group absent from these
sources remains unknown, fails readiness, and requires an operator decision; market membership alone never
permits reconciliation or hard-halt cancellation. The request timeout is an aggregate fetch/RPC bound and
does not reveal endpoint details in failures.

Bootstrap offer-group reads request the configured chain explicitly, ignore well-formed rows from other chains, and fail
closed on malformed chain identity, asset strings, or empty/repeated pagination cursors. The variable Blue
reference hard-fails when its latest checkpoint is more than five minutes behind wall-clock time, and
when either checkpoint lands on a block where the reference market does not yet exist or holds no
supply shares. Blue's virtual shares make that state indistinguishable from a market supplying at
par, so it is rejected rather than priced; widening `REFERENCE_LOOKBACK_SECONDS` widens the
historical interval in which such a block is reachable.

### Position-bootstrap fields

Each `bootstrap` entry must use a unique `marketId` present in `markets.allowlist`.
`targetRate` defaults to `{ strategy: "variable_rate_avg" }` when omitted for backward compatibility
and `maturityPremium` may be omitted entirely; every other field in each entry is required.

| Field                   | Unit / behavior                                                 | Validation                                                                                            |
| ----------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `marketId`              | 0x-prefixed 32-byte Midnight Market ID                          | Required, unique, and allowlisted                                                                     |
| `targetRate`            | Target-rate method selection                                    | `variable_rate_avg`, or `hardcoded` with positive `hardcodedRateBps`; defaults to `variable_rate_avg` |
| `creditTarget`          | Raw credit units; complete at `creditTarget - acceptanceAssets` | Positive unsigned integer                                                                             |
| `acceptanceAssets`      | Raw acceptable shortfall                                        | Non-negative and no greater than `creditTarget`                                                       |
| `offerSize`             | Raw desired offer size before capacity caps                     | Positive unsigned integer                                                                             |
| `premiumBps`            | Integer BPS added to the reference rate                         | Zero or negative                                                                                      |
| `maturityPremium`       | Optional premium function of the market's time to maturity      | Object with `shape: 'linear'`, positive `premiumPerYearBps`, optional positive `maximumPremiumBps`    |
| `maximumMarketExposure` | Raw per-market exposure cap                                     | Positive and no greater than `maximumTotalExposure`                                                   |
| `maximumTotalExposure`  | Raw strategy-wide exposure cap                                  | Positive                                                                                              |
| `minimumRateBps`        | Inclusive final-rate minimum                                    | Non-negative and no greater than `maximumRateBps`                                                     |
| `maximumRateBps`        | Inclusive final-rate maximum                                    | Non-negative                                                                                          |
| `autoRefill`            | Resume after first observed completion if credit later falls    | Boolean; completion memory lasts for one service instance                                             |

For a market below its accepted target, desired assets are the minimum of `offerSize`, remaining
credit target, cash balance, remaining per-market exposure, and remaining total exposure. Replacement
capacity excludes that market's representative live group while retaining every other active group's
exposure. Zero or negative capacity leaves no offer. The final requested rate is `reference rate +
premiumBps + maturity premium`; a result outside the inclusive hard range publishes no offer and
invalidates any live one (`action: "rate-out-of-range"`) rather than posting a clamped offer, and a
reference-rate excursion never halts the strategy. A rate equal to a bound is admissible. Near
maturity the range can be narrower than one tick's rate step; when it holds no aligned tick at the
snapshot the cycle takes the same `rate-out-of-range` path, and when that first happens at the
publication block it cancels the live offer and reports `action: "publication-withheld"`,
`reason: "rate-out-of-range"`. Neither charges the failure budget.

`maturityPremium` makes each entry's premium a function of that market's remaining time to
maturity, so one bot can quote every configured maturity from one term structure: further maturity
= higher premium. The initial `linear` shape resolves
`floor(premiumPerYearBps × secondsToMaturity / 31,536,000)` from the fresh onchain maturity and
latest Base block timestamp at every cycle, optionally capped by the inclusive `maximumPremiumBps`;
a market at or past maturity contributes zero. The resolved term is added on top of the signed
static `premiumBps` (urgency discount and duration compensation stay independently configured), so
long maturities can quote above the reference while `premiumBps` still anchors the short end. The
premium decays as maturity approaches; integer flooring keeps the requested rate stable for days at
a time, and a one-BPS step only republishes when it actually moves the canonical Midnight tick.
Additional function shapes may be added later; `shape` selects the active one. Both target-rate
strategies compose with it — a `hardcoded` reference with a maturity premium still decays along the
curve. Omit the object entirely to keep today's static-premium behavior.

Live reconciliation retains an owned offer when its assets, canonical Midnight tick, and continuous
fee cap still match, even if a raw reference-rate change produced the same tick. A market fee-policy
change therefore replaces an offer that is no longer takeable. Every genuinely new publication uses
the current block timestamp as its start, so replacing a consumed offer cannot recreate its
content-addressed group ID.

`BOOTSTRAP_MARKETS` uses an exact JSON array with the same fields; YAML syntax, duplicate object keys,
and prototype keys are rejected. Every integer-valued property—including asset amounts, exposure caps,
rates, `premiumBps`, and the nested `maturityPremium` integers—must be a quoted decimal-integer
string. JSON number tokens are rejected even
when integral; `marketId` remains a string, `autoRefill` remains a JSON boolean, and
`maturityPremium.shape` remains the JSON string `"linear"`. Supplying it replaces
every YAML bootstrap entry, which avoids ambiguous partial-array merge behavior. See
[`.env.example`](./.env.example) for exact syntax.

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

`morpho-quoter setup-check --monitor` repeats non-overlapping read-only readiness observations every
minute until its shutdown signal or the first failed report after transient-provider retry tolerance.
`morpho-quoter bootstrap` first runs the same one-shot readiness gate as `setup-check`, then executes
exactly one position-bootstrap cycle and prints its
bigint-safe JSON result. `morpho-quoter bootstrap --monitor` uses the same gate, repeats non-overlapping
cycles every minute, and performs owned-group cleanup after its shutdown signal.
`morpho-quoter bootstrap --verbose` adds safe rate, offer, transaction-hash, configuration, and
before/after position diagnostics to each result. `morpho-quoter ladder --monitor` similarly repeats at the shortest configured ladder cadence,
streams cycles, and cleans active owned ladder groups after shutdown; `--verbose` adds safe
configuration, rate, quote, transaction-hash, and before/after capacity diagnostics. Version output,
setup monitoring, and invalid usage never start either writer.

Configuration is validated once when it loads, so invalid configuration stops the bot before either
writer starts. Reference and decision failures trigger a strategy-wide hard halt;
an ordinary position-read failure requests market-local invalidation and permits other markets to
continue. Receipt polling is bounded independently by `TRANSACTION_RECEIPT_TIMEOUT_MS`. Read-only
mode retains the same decisions and fresh prospective whole-book comparison but logs every requested
mutation and graceful-cleanup operation instead.

### Ladder fields and formulas

Each `ladder` entry has a unique allowlisted `marketId`. Rates are integer BPS and asset/exposure
amounts are exact raw loan-asset units. `quotePremiumBps` and `sizeSkewBps` are signed; all other
integer fields are nonnegative or positive as shown below. `targetRate` defaults to
`{ strategy: "variable_rate_avg" }`, `maturityPremium` and `inventorySkew` may be omitted entirely,
and `bookCrossedCooldownSeconds` defaults to three loop intervals; every other field in each entry is
required.

| Field                        | Unit / behavior                                                                                                                                                                                                      | Validation                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `marketId`                   | 0x-prefixed 32-byte Midnight Market ID quoted by this entry.                                                                                                                                                         | Required, unique across the array, and present in `MARKET_IDS`.                                                                                                                |
| `targetRate`                 | Target-rate method used as reference `R`.                                                                                                                                                                            | `variable_rate_avg`, or `hardcoded` with positive `hardcodedRateBps`; defaults to `variable_rate_avg`.                                                                         |
| `quotePremiumBps`            | Signed BPS added to the fresh reference rate before the ladder spread is applied. Positive moves both sides higher; negative moves both lower.                                                                       | Signed decimal integer; the resulting funded rungs must remain inside the configured rate range.                                                                               |
| `maturityPremium`            | Optional premium function of the market's time to maturity added to the effective center on top of `quotePremiumBps`.                                                                                                | Object with `shape: 'linear'`, positive `premiumPerYearBps`, optional positive `maximumPremiumBps`.                                                                            |
| `spreadBps`                  | Full distance in BPS between the nearest lower and higher rates. Each nearest rung is half this value from the center.                                                                                               | Positive and even, so each half-spread is an exact integer BPS value.                                                                                                          |
| `stepBps`                    | Additional BPS between successive rungs on the same side, moving farther from the center.                                                                                                                            | Positive.                                                                                                                                                                      |
| `rungCount`                  | Maximum number of rungs constructed on each side before capacity and minimum-size filtering.                                                                                                                         | Positive safe integer no greater than `512`.                                                                                                                                   |
| `sizeSkewBps`                | Signed change to each successive rung's allocation weight from the base weight `10000`. Positive favors outer rungs; negative favors inner rungs.                                                                    | Signed decimal integer; every configured rung weight must remain positive.                                                                                                     |
| `lowerRateBudgetAssets`      | Maximum raw assets allocated across lower-rate rungs. This side posts reduce-only borrow-side sells and is additionally capped by the maker's accrued market credit.                                                 | `0` for a lend-only ladder, which never sells and holds the credit it buys to maturity; otherwise at least `minimumOfferAssets`.                                               |
| `higherRateBudgetAssets`     | Maximum raw assets allocated across higher-rate rungs. This side posts lend-side buys and is additionally capped by available balance, allowance, and exposure.                                                      | Positive and at least `minimumOfferAssets`.                                                                                                                                    |
| `targetMarketExposureAssets` | Raw cap for credit plus reserved lend-buy liquidity in this market. It caps only the higher-rate, exposure-increasing side.                                                                                          | Positive and no greater than `maximumTotalExposureAssets`.                                                                                                                     |
| `maximumTotalExposureAssets` | Raw cap for credit plus reserved lend-buy liquidity across all configured markets. It caps only the higher-rate, exposure-increasing side.                                                                           | Positive.                                                                                                                                                                      |
| `minimumOfferAssets`         | Smallest raw size permitted for any emitted rung. Capacity funds the closest rungs first and omits a side or outer rungs that cannot each meet this floor.                                                           | Positive and no greater than either non-zero side budget. Use at least `101000000` for USDC.                                                                                   |
| `groupMode`                  | Consumption-cap grouping: `shared-rung` creates one independent group per rung; `per-book` creates one shared group for all funded rungs on each side.                                                               | Exactly `shared-rung` or `per-book`.                                                                                                                                           |
| `loopIntervalSeconds`        | Requested delay between completed monitor cycles for this market set; the monitor uses the shortest configured value.                                                                                                | Positive integer no greater than `2147483`, keeping the millisecond delay within the runtime timer limit.                                                                      |
| `bookCrossedCooldownSeconds` | Seconds one side of the resting ladder waits between replacements triggered by a third party crossing it. Anchored to the block timestamp the replaced publication was prepared at, and held in process memory only. | Optional positive integer no greater than `2147483`; defaults to three times `loopIntervalSeconds`.                                                                            |
| `movementToleranceBps`       | Inclusive center-rate deadband. An existing center is retained until the effective center moves by strictly more than this value; capacity resizing still applies.                                                   | Nonnegative.                                                                                                                                                                   |
| `minimumRateBps`             | Inclusive hard minimum for every funded final rung after premium, spread, and step offsets. A rung below it is omitted, not clamped.                                                                                 | Nonnegative and strictly less than `maximumRateBps`.                                                                                                                           |
| `maximumRateBps`             | Inclusive hard maximum for every funded final rung after premium, spread, and step offsets. A rung above it is omitted, not clamped.                                                                                 | Positive and strictly greater than `minimumRateBps`; the complete static ladder shape must fit.                                                                                |
| `inventorySkew`              | Optional lend-rate skew that raises every higher-rate rung with the face credit held in this market; lower-rate rungs never move. See [Inventory skew](#inventory-skew).                                             | Object with positive `unitsPerStep`, optional nonnegative `neutralCredit` (default `0`), and optional positive `maxSkewBps` no greater than `maximumRateBps − minimumRateBps`. |

The rung limit bounds local allocation to 1,024 offers for a two-sided ladder, a height-10 tree
below the Midnight SDK's height-20 protocol limit.

For reference `R`, effective center `C = R + quotePremiumBps + maturity premium` (the maturity term
is zero without a `maturityPremium`). With zero-based rung `k`:

```text
lower rate = C - spreadBps / 2 - k * stepBps
higher rate = C + spreadBps / 2 + k * stepBps + S
```

`S` is the [inventory skew](#inventory-skew), zero without `inventorySkew`.

The complete static shape must fit between `minimumRateBps` and `maximumRateBps`. At runtime the
range is an admissibility envelope, not a clamp target: a rung whose final rate (after premiums,
skew, and own-bootstrap clearance) falls outside it is omitted together with its allocation, which
is never moved onto the surviving rungs, and a side left with no rung withdraws. A rate equal to a
bound is admissible, and the range is enforced again at the encoded tick, so tick rounding never
publishes an APR past a bound. A reference-rate excursion therefore thins or withdraws the ladder
but never halts the strategy. Tick APR steps widen toward maturity, so a range can come to hold no
aligned tick at all; that cycle cancels both sides and reports `publication-withdrawn` rather than
failing, and the ladder republishes once a tick fits again. A retained center is recentered only when
absolute effective-center movement is strictly greater than `movementToleranceBps`; capacity
changes still resize quotes inside that tolerance. For a lend-only ladder, only the lending
rungs have to fit: `(rungCount - 1) * stepBps` within the range.

A lend-only ladder stops new sells, not sells already on the book. To switch a writer to one:

1. Stop the old writer; its shutdown cancels the groups it owns.
2. Run maker-wide `invalidate`, which also cancels indexed groups no strategy owns, then confirm its
   receipt and that the maker book is empty.
3. Deploy the lend-only configuration.

A group that is neither indexed nor recorded as owned cannot be found, so a sell in it stays live
until it expires. Credit the ladder buys is held to maturity, and the matured-market flow is
unchanged.

A rung that would cross an offer already resting on the market book is repriced to the nearest tick
just clear of it, so a large reference move compresses the affected side against the best opposing
offer instead of quoting through it. That clearance is capped at the hard rate range: if the best opposing offer sits beyond `minimumRateBps` / `maximumRateBps`, no in-range
tick can clear it and the rung publishes at the bound, crossed, rather than outside the configured
rates. Publication refuses only a ladder that would cross an offer the maker itself owns, since that
is a self-trade; crossing a third party is a pricing concern, never a reason to fail the cycle. Own
bootstrap buys keep their own clearance and their deliberate tie at the bound.

The clearance itself is exact and lives in tick space, so it never appears as a rate, and rate-space
quote drift stays governed by `movementToleranceBps` alone. Every cycle additionally reports, per
side, whether a third party currently crosses the ladder resting on the book and whether the
configured rate window could still clear it (`guardrail.book-crossed`). A book the reader cannot parse leaves that signal absent for the cycle and
never withdraws the ladder. An opposing offer smaller than `minimumOfferAssets` at its own tick is dust and never counts as crossing, so a free-to-post
offer cannot buy a cancel-and-republish every cooldown. A side that is crossed,
clearable, and past its `bookCrossedCooldownSeconds` upgrades that cycle's `rest` into a replacement
with reason `book-crossed`. The crossing is then re-evaluated inside the mutation queue from a fresh
book before anything is reserved, cancelled, or signed: a cross that has already gone mutates
nothing and the cycle reports `rest`. The cooldown is per side, lives in process memory, is anchored
to the block timestamp the publication was prepared at, and advances only on a replacement that was
applied — or logged, in read-only mode — so a failed replacement retries on the next cycle.
Crossed-and-unclearable is an operator condition rather than a bot condition: the book has left the
configured rate window, so the cross is reported and nothing is acted on.
`guardrail.book-cleared` reports how many rungs the book repriced, separately from the own
bootstrap-buy clearance on `guardrail.cross-book-cleared`.

`maturityPremium` makes the effective center a function of that market's remaining time to
maturity, so one bot can quote every configured maturity from one term structure: further maturity
= higher center. The initial `linear` shape resolves
`floor(premiumPerYearBps × secondsToMaturity / 31,536,000)` from the fresh onchain maturity and
latest Base block timestamp at every cycle, optionally capped by the inclusive `maximumPremiumBps`;
a market at or past maturity contributes zero. The resolved term is added on top of the signed
static `quotePremiumBps`, and the premium decays as maturity approaches; `movementToleranceBps`
absorbs that slow decay exactly like reference movement, so a retained center rests until the
decayed effective center escapes the inclusive deadband. Additional function shapes may be added
later; `shape` selects the active one. Both target-rate strategies compose with it — a `hardcoded`
reference with a maturity premium still decays along the curve, and its load-time shape check only
rejects a shape that no attainable premium can place fully inside the hard bounds (a transiently omitted
rung is documented runtime behavior). Omit the object entirely to keep today's static-center
behavior.

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
   `variable_rate_avg`, and the market's fresh time to maturity only when a maturity premium is
   configured).
2. Reconstructs the remaining active quote. A partially consumed group contributes only its
   remaining assets, and a fully consumed indexed group contributes no rung. A persisted group that
   has not appeared in the eventually consistent API remains pending-active so the bot cannot
   publish an unsafe duplicate while indexing catches up.
3. Generates a complete desired quote from the current capacities and configuration. If the center
   remains inside `movementToleranceBps`, the active center is retained while sizes are still
   recalculated from fresh inventory.
4. Compares the complete active and desired quotes, then selects one decision:

| Decision       | Condition                                                                                                                                                                             | Mutation                                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publish`      | No active ladder remains and at least one side can fund an offer.                                                                                                                     | Publishes one fresh complete tree. The cycle reports `action: "publish", reason: "publish"`.                                                                                              |
| `rest`         | Active and desired quotes are exactly equal, or neither an active nor a fundable desired quote exists.                                                                                | Submits no transaction.                                                                                                                                                                   |
| `resize`       | An active ladder exists, its center remains inside tolerance, but fresh sizes, funded rung count, side availability, or grouping have changed.                                        | Replaces the complete market ladder and reports `action: "replace", reason: "resize"`.                                                                                                    |
| `recenter`     | The absolute movement from the active center to the fresh effective center (reference plus quote and maturity premiums) is strictly greater than `movementToleranceBps`.              | Recalculates rates and sizes, replaces the complete ladder, and reports `action: "replace", reason: "recenter"`.                                                                          |
| `book-crossed` | An active ladder exists, its quote is otherwise unchanged, and a third party crosses one side of it inside the configured rate window, past that side's `bookCrossedCooldownSeconds`. | Rechecks the crossing under the mutation lock, then replaces the complete ladder and reports `action: "replace", reason: "book-crossed"`; a cross that has gone reports `action: "rest"`. |

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
reduces only that group's remaining amount onchain, but the next cycle recalculates the complete
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

#### Inventory skew

Without `inventorySkew`, every fill forces a `resize` that refills the higher side from its nearest
rung at an unchanged center. A taker who repeatedly takes only the nearest buy therefore lends the
maker's whole budget at the nearest rate instead of the rate one sweep of the same size would pay:
in one audited run, about 491,000 of 500,000 USDC was lent at the nearest rung.

`inventorySkew` makes the higher (lend) side behave as a supply curve whose marginal rate rises
with the inventory held. Every higher rung gains the same skew `S`:

```text
S = min(maxSkewBps, floor(stepBps × max(0, credit − neutralCredit) / unitsPerStep))
```

`credit` is the maker's face credit in the market from the block-pinned exposure snapshot,
including credit a position bootstrap acquired, so the rule needs no history, clock, or new state.
`S` is added after the retained or fresh center is chosen, and the usual range check still applies: a buy
past `maximumRateBps` is omitted and counted on `guardrail.rate-omitted`. The center's meaning and
recentering are unchanged, and `targetRateBps` still excludes the skew.

Only lend rates respond to inventory; lower-rate sells never move, so the ladder never offers held
inventory more cheaply. That is what keeps the skew free of round trips. A taker who sells credit to
the ladder receives a rate of at least `C + spreadBps / 2`, and can buy it back only from sells at
most `C' − spreadBps / 2`, where `C'` is the retained center or one a reference move beyond
`movementToleranceBps` recentered. The buy-back costs at least `spreadBps − movementToleranceBps`
plus settlement fees, whatever the fill size or group mode. A sell fill lowers `credit`, so the buys
move back toward the base curve.

Because the skew never moves a sell, it adds no round trip to inventory from any source, including a
same-market position bootstrap. It does not remove one that exists without it: sells clear a
bootstrap buy only while that buy is live, so once a taker consumes the bootstrap, the ladder may
resell that credit below the bootstrap's price. The bootstrap and the ladder are separate phases,
and that transition loss is accepted. In the other direction, a bootstrap buy still clears every
resting sell on its market, the ladder's included: while the ladder sells above the bootstrap's
desired rate, an `autoRefill` buy is repriced to 10 BPS above the highest-rate sell, or withheld for
the cycle when that exceeds the bootstrap's `maximumRateBps`.

With five higher rungs of 20,000 USDC, 10 BPS apart from 5.10%, one year to maturity, 500,000 USDC
of exposure room, and a taker who takes the whole nearest buy every cycle (credit accrues as face,
so about 471,000–476,000 USDC is lent before the room is used):

```text
without inventorySkew:                every fill at 5.10%           spend-weighted 5.10%
unitsPerStep = face of one 20k rung:  fill k near 5.10% + k × 0.10%  spend-weighted ≈ 6.24%
one sweep of the same size:           rung k at 5.10% + k × 0.10%    spend-weighted ≈ 6.23%
```

Set `unitsPerStep` to one rung's face, which is the face credit its assets buy at the nearest
buy's price, about `assets × (1 + rate × years to maturity)`, so the outer buy rungs behave as real
depth: once a taker has lent against the nearest rung's worth,
the next cycle's nearest buy prices where the second rung was. A larger value flattens the curve and
a smaller one steepens it. `neutralCredit` is inventory held at the base curve; for a market shared
with a position bootstrap, use that bootstrap's `creditTarget` so its acquired inventory does not
skew the ladder. `maxSkewBps` bounds the skew. All three are pricing intent, not safety bounds: the
exposure caps still bound size.

Under `per-book`, one offer can consume the whole side's shared cap in a single fill (see
[Per-book consumption](#per-book-consumption)), so the skew cannot price depth inside that fill; it
raises the next cycle's rates once the fill lands. Use `shared-rung` when the curve must apply
inside one sweep.

With `inventorySkew` configured, a missing or negative credit observation fails the decision and
halts the strategy with `ladder-decision-failed`, so the ladder never lends at the unskewed rate by
accident. Verbose cycles report `diagnostics.inventorySkew` (`inventorySkewBps`, `skewClamped`,
`creditAssets`, `neutralCredit`), emit `inventory-skew.observed`, and gauge
`quoter_bot.market.inventory_skew_bps`. Omit the object entirely to keep today's quotes exactly.

Safety failures are separate from the four normal decisions. Reference or decision failure
requests a strategy-wide hard halt; a market-state read failure requests market-local
invalidation. A failed or halted monitored cycle stops the loop and still attempts exhaustive owned
group cleanup. In a writer, that cleanup is the one retry of a hard halt whose cancellation threw.
If it fails too, the monitor exits with `reason: "cleanup-failed"`: cancellation is unproven, so
treat owned offers as fillable until `invalidate` confirms them.
`SIGINT` and `SIGTERM` let the in-flight cycle finish and then cancel every remaining active owned
ladder group before the monitor reports `status: "stopped"`.

`LADDER_MARKETS` is exact JSON with the same fields. Every integer-valued property — including the
nested `maturityPremium` and `inventorySkew` integers — must be a quoted decimal string; JSON number tokens, floats,
exponents, malformed values, unknown fields, duplicate markets, and markets outside `MARKET_IDS`
are rejected, and `maturityPremium.shape` remains the JSON string `"linear"`. The variable replaces
the YAML list before semantic validation, so a valid environment list can replace semantically
invalid YAML while YAML parser hazards still fail closed.

### Units of each limit

Every exposure limit and offer budget is meant as face credit, the credit units a buy acquires and
that repay one raw loan asset each at maturity; wallet cash, allowance, and `minimumOfferAssets` are
loan assets.

| Limit                                                                                                       | Unit                              |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `creditTarget`, `acceptanceAssets`                                                                          | Face credit, compared with credit |
| `targetMarketExposureAssets`, `maximumTotalExposureAssets`, `maximumMarketExposure`, `maximumTotalExposure` | Face credit plus reserved buys    |
| `lowerRateBudgetAssets`, `higherRateBudgetAssets`, `offerSize`                                              | Face credit, the offer's cap      |
| Wallet balance, allowance, `minimumOfferAssets`                                                             | Loan assets                       |

Every offer is capped in credit units (`maxUnits`), so a group acquires exactly its cap in face and
every face limit holds. A units buy pays at most one loan asset per unit, since no tick prices above
one. `minimumOfferAssets` becomes the fewest units worth that much at the configured maximum rate,
so every rung still clears the Router floor. Wallet cash is reserved for each buy group as its
remaining units priced at its highest buy tick, rounded up, or at face for a group the API has not
indexed; `makeLend` reserves the same bound. Capacity, reservation, and exposure-cap fields in monitoring are face
credit, like `creditAssets`.

A cash-capped buy (`maxAssets`) cannot be bounded in face: a take whose asset amount rounds to zero
still adds credit, even once the cap is used up. So any known cash-capped buy that is not cancelled
fails the exposure snapshot with `adapterOperation: "cash-capped-buy-group"`, and the bot lends
nothing until it is cancelled with `morpho-quoter invalidate <group>`.

### Upgrading to unit-capped offers

Strategy state (version 7) records every offer size in credit units, and this version reads no
earlier state. Any unreadable state file, or one of another version, fails every command at
startup with
`StrategyStateVersionError`. To upgrade:

1. Stop the running bot. Its shutdown cancels every offer group it owns.
2. With the earlier version, run `invalidate --readonly` and confirm that no offer group remains;
   cancel any survivor with its `invalidate`, including `invalidate <group>` for a group the API has
   not indexed yet. The state directory is the only record of an unindexed group.
3. Delete the strategy state directory, `$XDG_STATE_HOME/morpho-quoter-bot`: by default
   `~/.local/state/morpho-quoter-bot`, and `/state/morpho-quoter-bot` under Compose and Helm.
4. Unset `OFFER_CAP_KIND` and remove `markets.offerCapKind`; this version fails at startup while
   either is set.
5. Start this version.

An indexed cash-capped buy that survives halts lending until it is cancelled; see
[Units of each limit](#units-of-each-limit).

### Exposure guarantee

Sizing and replacement read exposure from one snapshot: accrued credit on every allowlisted market,
wallet balance and allowance, and onchain consumption of every known maker buy group, all pinned
to one block. Only group ids, caps, markets, and buy ticks come from the Morpho API. A group is capped in
either loan assets (`max_assets`) or credit units (`max_units`); a group with both or neither fails
closed, and a units-capped buy reserves its remaining units as exposure and those units priced at
its highest buy tick as cash. A group at the protocol cancellation sentinel counts as zero, and an unindexed durable group
without a persisted cap fails closed.

Durable ownership records every group's size in credit units. A cash-capped buy stays takeable for
fills that round to zero assets after its cap is used up, so the bot cancels every owned buy before
forgetting it; a sell is done at its cap.

A replacement cancels the old groups before publishing, and an old buy can fill until its
cancellation lands. So after the cancellations confirm, both strategies re-admit the prepared buy
against a fresh snapshot at a block B at or after every cancellation receipt. The guarantee: at B,
accrued credit plus the remaining face reservation of every known group plus the new buy is within
each configured limit, in the bot's current accounting. Reduce-only ladder sells are not re-admitted,
and a bootstrap offer that is retained unchanged is not re-admitted.

A buy that no longer fits is released unpublished. The cycle reports `status: "applied"`,
`action: "publication-withheld"`, `reason: "capacity-changed"` with the confirmed cancellations,
and the next cycle sizes afresh. A buy whose market loss factor no longer equals the accepted value
at B is withheld the same way with `reason: "loss-factor-mismatch"`. With `inventorySkew`
configured, a buy is withheld with `reason: "price-changed"` when the credit at B would publish any
planned buy at a higher rate, or push one past `maximumRateBps` so it would be omitted, because old buys filled while the cancellations
confirmed; the next cycle republishes at the fresh skew. The comparison is in rate space, so a rise
that tick alignment or book clearance would absorb still withholds for that one cycle. A lower fresh skew only leaves the buys
dearer than needed and is admitted. If no snapshot at or after B
can be read, the cycle fails at the
`reconcile` (ladder) or `make` (bootstrap) stage with `adapterOperation: "snapshot-unavailable"`,
the allowlisted cause in `snapshotErrorOperation` (for example `missing-owned-group-intent`), and
`invalidated: true` when a cancellation confirmed; it counts toward the five-cycle market failure
budget. Both emit `guardrail.publication-withheld`. Nothing signed leaves the process before this
check: ladder Ecrecover trees are validated unsigned and signed locally.

A bootstrap buy sized down by wallet cash or the remaining allowance can fall below the Router's
minimum offer size. That `MinOfferAssetsUsd` rejection happens at preparation, before anything is
reserved or sent, and is treated as no capacity: any resting bootstrap offer is cancelled and the
cycle reports `action: "publication-withheld"`, `reason: "below-minimum-offer"` and the Router's
`minimumAssets`, without counting toward the failure budget. The same rejection under any other
binding cap, and every other rejection, still fails the `make` stage.

The guarantee assumes one writer per maker key, a complete initial maker inventory (every maker group
is indexed or in durable ownership state), and that the first receipt is final. It makes no claim
after B beyond each group's cap: a units-capped group can still acquire its remaining
`maxUnits − consumed` of face, which B already counts.
Read-only and preview output is the pre-cancellation plan; it cannot predict fills during a real
cancellation.

### Loss-factor guard

A Midnight Market's loss factor rises only when a liquidation realizes bad debt, and every lender's
credit is slashed by it. The bot lends on a market only while its loss factor equals the value the
operator accepted for it in `markets.acceptedLossFactor` (`ACCEPTED_LOSS_FACTOR`): a map from
allowlisted market id to a canonical unsigned decimal string. A market that is not listed accepts
`0`. Unknown or duplicate market ids, non-canonical values, and any value at or above
`type(uint128).max` (which would accept a maxed-out market and disable the guard) are rejected at
startup.

**Deploy consequence.** A market with any bad debt in its history already has a non-zero loss
factor, so it starts lend-halted until its current value is accepted. Setup reports it as a
`loss-factor` `warning` listing the market, both values, the direction, and whether the default was
used. Readiness never fails on it: a failed readiness cancels every owned offer and exits, which
would stop quoting on every market rather than only the halted one.

**Re-arm.** Review the realized loss, set the market's `acceptedLossFactor` to the observed
`lossFactor` from the warning or the `guardrail.lend-halted` record, and redeploy. The change is
audited by the configuration history; there is no command and no state file.

**Fail-closed rules.**

- Any inequality halts lending, in either direction. `above` is a newly realized loss; `below`
  means configuration is ahead of the chain (a reorg, or a pre-accepted future loss).
- Bootstrap checks the snapshot-block loss factor before target completion, auto-refill, or any
  reference-rate read, cancels every active group in the market, and never marks the initial target
  complete while halted. The ladder reads only the loss factor first, before the active-state,
  market, book, or snapshot reads, and on a mismatch cancels the market's durable buy groups through
  a dedicated operation that reads no book and prepares no replacement. Sells are untouched.
- Within a cycle, cancelling mismatched buys comes before any other mutation or fallible step:
  bootstrap runs its loss-factor invalidations before any publication, and the ladder guards every
  market before removed-market cleanup. A failure elsewhere cannot leave a mismatched buy live.
  Bootstrap cancels every group of a halted market before forgetting any, so an ownership write
  failure cannot skip a cancellation.
- A loss factor that cannot be read or is not a uint128 is treated as a mismatch: the workflow
  cancels its buys in the market and fails that market as a retryable `guard-read`. It counts
  toward the five-cycle market failure budget.
- A cancellation that fails or whose receipt is uncertain keeps ownership and goes straight to the
  strategy-wide hard halt, which also cancels sells. It is not retried while fillable buys remain.
- Exposure admission withholds any prepared buy whose market loss factor differs at the admission
  snapshot, including a change between sizing and admission.

Outcomes: `status: "observed"` (no live buy), `"applied"` (cancellation confirmed), or `"logged"`
(read-only), each with `action: "lend-halted"`, `reason: "loss-factor-mismatch"`, `lossFactor`,
`acceptedLossFactor`, `defaulted`, and `direction`. A withheld admission reports
`action: "publication-withheld"`, `reason: "loss-factor-mismatch"`, and the same halt fields. A safe
lend-halted outcome clears a pending publication failure from the failure budget. A `failed` or
`halted` result whose cancellation went wrong still carries the known halt fields, so the alert
and gauge report the halt regardless of the cancellation outcome. The
`guardrail.lend-halted` record is emitted when a halt starts or its values change and every ten
cycles while it continues; `quoter_bot.market.lend_halted` gauges each market (0/1). A halted
market's credit still counts toward total exposure.

**Guarantee.** Enforcement is per cycle, per workflow, and in writer mode only. Within one cycle of
a workflow observing a loss factor other than the accepted value, plus cancellation confirmation,
that workflow has no newly admitted buy and no durably owned resting buy in that market. Bootstrap
and ladder run separate cycles, so the bot as a whole is covered for a market once every workflow
configured for it has run its first cycle after the mismatch becomes observable. Buys the bot does
not durably own (for example after a lost ownership volume) are not covered; readiness already warns
about unattributable groups.

It does not cover a same-block ordering in which a searcher places the loss-causing `liquidate`
before a take of a resting buy. Only take-time onchain enforcement closes that, which is tracked as
BOTS-238.

The guard itself runs only in cycles. A writer that fails before its first cycle cancels every
durably owned offer before it exits; see [Writer startup failure](#writer-startup-failure).

### Writer startup failure

A writer (`bootstrap`, `ladder`, or `start`, without `--readonly`) that fails startup cancels every
offer both strategies durably own before it exits. This covers every step after the signer is
verified: the pending-nonce check, startup removed-market cleanup, and the readiness gate. It uses
the same exhaustive, receipt-confirmed cleanup as a hard halt and shutdown.

- Earlier failures cannot cancel anything and exit without cleanup: configuration errors, signer
  creation, and a signer that does not match the maker. An empty strategy configuration is a
  configuration error too.
- A `SIGINT` or `SIGTERM` that interrupts startup is a normal stop, not a failure, and exits
  without cleanup. Any other startup error still cleans up, even if a signal arrives at the same
  time.
- A latched nonce means an unknown transaction is pending. The cancellation queues behind it and
  confirms once it mines. If it never mines, the receipt deadline expires and cleanup fails.
- On success the bot writes `startup.owned-offers-cancelled` (terminal only) with the startup
  `errorName`, any `adapterOperation`, and each strategy's confirmed cancellation transactions. It
  then exits with the original startup error.
- If either cleanup fails, the bot exits with `StartupCleanupFailedError` and ships
  `bot.failed` with `reason: "startup-cleanup-failed"`. The printed report gives each strategy's
  outcome and, when ownership could be read, the `unresolvedGroupIds` whose cleanup did not
  complete. Those offers may or may not still be live; cancel them with `invalidate`.

Bootstrap ownership is scoped to the configured `MARKET_IDS` set, so bootstrap groups persisted under
a different market set are not covered by this or any other cleanup.

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
