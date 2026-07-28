# Market making bot

Implements the market-maker setup readiness gate and position-bootstrap application API from
[TIB-2026-07-27](../../docs/decisions/TIB-2026-07-27-midnight-market-making-bot.md) for
[MKT-1459](https://linear.app/morpho-labs/issue/MKT-1459) and
[MKT-1468](https://linear.app/morpho-labs/issue/MKT-1468).

## Architecture and runtime boundary

The package follows the repository's hexagonal architecture:

- `ConfigService` is the only configuration boundary. It loads YAML, overlays environment values,
  and validates the combined values once before exposing typed setup and bootstrap configuration.
- `SetupCheckService` owns the read-only readiness workflow and its consumer-owned
  `SetupStateService` port.
- `ViemSetupStateService` is the concrete RPC/Morpho API/Router API adapter.
- `bootstrap.ts` is the manual composition root. `Cli` is the operator adapter and `index.ts` is a
  thin entrypoint.

The setup service starts independent provider reads with `Promise.all`. Each read has its own error
boundary, so one rejected provider call becomes its corresponding failed report item without stopping
other checks.

Position-bootstrap parsing is fully integrated into `ConfigService` as `config.bootstrap`, with the
exact validated `BootstrapConfig[]` consumed by `PositionBootstrapService`. Runtime publication is
still deferred: `bootstrap.ts` does not yet construct `PositionBootstrapService`, and concrete
position, reference-rate, signing, invalidation, and publication adapters do not exist. The current
CLI therefore loads and validates bootstrap configuration but only runs `setup-check`; it does not
publish bootstrap offers.

## Configuration sources and precedence

Configuration can come from environment variables, a YAML file, or both. YAML files and the
`BOOTSTRAP_MARKETS` value are each limited to 1 MiB before parsing.

1. `--config <path>` selects that exact `.yaml` or `.yml` file. Other path extensions and a missing,
   unreadable, empty, oversized, malformed, symlinked, or non-regular explicitly named file fail
   startup. Default-discovered symlinks are rejected as unreadable too.
2. Without `--config`, the CLI searches the process working directory from which `mm` was invoked.
   It checks `market-making.yaml` first, then `market-making.yml`. If both exist, `.yaml` wins.
3. If neither default file exists, environment-only startup remains supported.
4. Every supplied environment variable overrides the corresponding YAML value. A duplicate value is
   never an error.

Scalar fields override independently. `MARKET_IDS` and `V0_OFFER_GROUP_IDS` each replace their
complete YAML list. `BOOTSTRAP_MARKETS` replaces the complete YAML `bootstrap` list; bootstrap arrays
are never partially or positionally merged. YAML syntax and source-safety checks run before overlay,
then only the effective merged configuration is semantically validated, so replaced invalid values do
not block startup while parser hazards in replaced sections still do.

Use [`market-making.example.yaml`](./market-making.example.yaml) as the complete YAML template and
[`.env.example`](./.env.example) as the environment template. Default discovery never selects the
example filename.

```sh
# Explicit file; relative paths resolve from the invocation working directory.
bun run --filter @morpho-org/market-making-bot start -- --config ./operator.yml setup-check

# Default discovery in the current working directory.
bun run --filter @morpho-org/market-making-bot start -- setup-check
```

### Environment mapping

| Environment variable           | YAML key                          | Required/default                                                 |
| ------------------------------ | --------------------------------- | ---------------------------------------------------------------- |
| `CHAIN_ID`                     | `chain.id`                        | Required; must be Base `8453`                                    |
| `RPC_URL`                      | `chain.rpcUrl`                    | Required current-state Base RPC URL                              |
| `REFERENCE_RPC_URL`            | `chain.archiveRpcUrl`             | Required archive-capable Base RPC URL                            |
| `MAKER_ADDRESS`                | `identity.makerAddress`           | Required maker EVM address                                       |
| `MAKER_PRIVATE_KEY`            | `identity.makerPrivateKey`        | Required 0x-prefixed 32-byte key                                 |
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

There is no separate Mempool endpoint or API-key field in the current clients. Books and cursor-paginated
maker offer groups are read through `MORPHO_API_BASE_URL`; `ROUTER_API_BASE_URL` is used only for the
`/v0/config/contracts` ratifier registry. The existing clients do not accept configured API-key
headers. No unused credential setting is exposed.

### YAML schema

The root accepts exactly `chain`, `identity`, `contracts`, `apis`, `markets`, `setup`, and
`bootstrap`; unknown keys at any level are rejected. Every supported key appears in
[`market-making.example.yaml`](./market-making.example.yaml).

- `chain`: `id`, `rpcUrl`, `archiveRpcUrl`.
- `identity`: `makerAddress`, `makerPrivateKey`.
- `contracts`: `midnightAddress`, `loanAssetAddress`, `ratifierAddress`.
- `apis`: `morphoBaseUrl`, `routerBaseUrl`.
- `markets`: `allowlist`, `referenceMarketId`, `v0OfferGroupIds`.
- `setup`: `nativeReserveWei`, `maximumLendExposureAssets`, `requestTimeoutMs`.
- `bootstrap`: an ordered list of the exact per-market objects documented below.

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

- Base chain identity, maker/private-key agreement, configured Midnight bytecode, native reserve, and
  loan-token allowance.
- The selected ratifier is listed by Router, deployed with the expected Ecrecover surface and
  Midnight immutable target, and authorized for the maker.
- Every allowlisted market is active, uses the configured loan asset, has valid tick spacing and
  maturity, and agrees between API and chain state.
- The exact Blue reference market is readable from the archive provider.
- Active offer groups belong to configured namespaces and markets and are not crossed/inverted.

`V0_OFFER_GROUP_IDS` is optional, but any active maker group not listed there fails readiness. The
request timeout is an aggregate fetch/RPC bound and does not reveal endpoint details in failures.

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
credit target, cash balance, remaining per-market exposure, and remaining total exposure. Zero or
negative capacity leaves no offer. The final requested rate is `reference rate + premiumBps`; an
out-of-bounds result is rejected rather than clamped.

`BOOTSTRAP_MARKETS` uses an exact JSON array with the same fields; YAML syntax, duplicate object keys,
and prototype keys are rejected. Every integer-valued property—including asset amounts, exposure caps,
rates, and `premiumBps`—must be a quoted decimal-integer string. JSON number tokens are rejected even
when integral; `marketId` remains a string and `autoRefill` remains a JSON boolean. Supplying it replaces
every YAML bootstrap entry, which avoids ambiguous partial-array merge behavior. See
[`.env.example`](./.env.example) for exact syntax.

`runOnce()` validates every market before any position/reference read or publication. Invalid
configuration, reference failures, and decision failures invoke strategy-wide `hardHalt`; ordinary
position-read failure requests market-local invalidation and permits other markets to continue.
These are application-port guarantees until the deferred adapters and composition are implemented.

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
bun run --filter @morpho-org/market-making-bot start -- --version
```

Success prints one JSON report and exits zero. Bigints are serialized as decimal strings. Any failed
check throws `SetupFailedError`, prints the complete sanitized report, and exits non-zero. The check
is read-only; remediation transaction descriptions are reported but never submitted.

## Test

```sh
bun test bots/market-making/test
bun run --filter @morpho-org/market-making-bot typecheck
bun run --filter @morpho-org/market-making-bot jsdoc:build
```
