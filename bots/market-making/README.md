# Market making bot

Implements the market-maker setup readiness gate from
[TIB-2026-07-27](../../docs/decisions/TIB-2026-07-27-midnight-market-making-bot.md) for
[MKT-1459](https://linear.app/morpho-labs/issue/MKT-1459).

## Architecture

The package follows the repository's hexagonal architecture:

- `SetupCheckService` owns the read-only readiness workflow and its consumer-owned `SetupStateService`
  port.
- `ViemSetupStateService` is the concrete RPC/Morpho API/Router API adapter.
- `ConfigService` validates environment configuration once and narrows addresses and bytes32 IDs.
- `bootstrap.ts` is the manual composition root.
- `Cli` is the operator adapter and `index.ts` is a thin entrypoint.

The setup service launches independent provider reads with `Promise.all`. Each read has its own error
boundary, so a rejected provider call becomes the corresponding failed report item and does not stop
other checks. Book reads also run concurrently; book validation waits only for the latest timestamp it
needs for maturity comparison.

The position-bootstrap domain and application APIs exist, but they are not wired into `ConfigService`,
`bootstrap.ts`, or the CLI. The ladder writer is also not implemented. Future runtime wiring must await
`SetupCheckService.assertReady()` before starting either writer, as required by the TIB. The existing
`setup-check` command exposes that reusable readiness gate without inventing a quote loop.

## Setup-check configuration

All values are required except `V0_OFFER_GROUP_IDS` and `REQUEST_TIMEOUT_MS`:

- `CHAIN_ID`: must be `8453` (Base).
- `RPC_URL`: Base RPC used for current chain state.
- `REFERENCE_RPC_URL`: archive-capable Base RPC. Setup verifies a latest block and reads the exact
  configured Blue reference market at a historical block approximately 10,800 blocks earlier.
- `REFERENCE_MARKET_ID`: 32-byte Morpho Blue market ID used by the variable-rate strategy. Setup
  fails closed when its immutable parameters or historical market state are missing or unreadable.
- `MAKER_PRIVATE_KEY`: 0x-prefixed 32-byte private key; never logged.
- `MAKER_ADDRESS`: configured maker address. Setup verifies that the private key derives it.
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
- `MORPHO_API_BASE_URL`: Morpho API origin used by `MidnightApi.fetchBooks` to verify active books.
- `ROUTER_API_BASE_URL`: official Router API origin used to traverse the maker's complete
  `/v0/midnight/users/{maker}/offer-groups` source. This includes fresh active offers before a
  takeable amount is measured; repeated cursors, oversized pages, excessive items, and aggregate
  deadline expiry fail closed.
- `REQUEST_TIMEOUT_MS`: optional bounded fetch/RPC timeout in milliseconds; defaults to `10000` and
  must be between `1` and `120000`.
- `V0_OFFER_GROUP_IDS`: optional comma-separated strategy-owned group IDs. Any active maker group not
  listed here, or any active offer on a market outside `MARKET_IDS` even when its group is known,
  fails readiness. Group IDs are canonicalized by bytes.

## Configure position bootstrapping

> **Integration boundary:** position bootstrapping is currently an application API only. Bootstrap
> settings are supplied programmatically to the `PositionBootstrapService` constructor. They are not
> loaded by `ConfigService`, and no environment variables, YAML schema, CLI command, composition-root
> wiring, concrete position/reference adapters, or signer/publication `BootstrapMakeService` adapter
> exists for this workflow yet. The example below configures the API; it does not make the current CLI
> run bootstrap offers.

The API takes one `BootstrapConfig` per market. All asset, credit, and exposure values are `bigint`
integers in the same raw loan-asset unit supplied by the injected position adapter; this layer does no
decimal parsing or scaling. Rates and premiums are integer basis points (`100n` = one percentage point).

```ts
import type {
  BootstrapMakeService,
  BootstrapPositionService,
  BootstrapReferenceRateService
} from './src/application/position-bootstrap.service'
import { PositionBootstrapService } from './src/application/position-bootstrap.service'
import type { BootstrapConfig } from './src/domain/position-bootstrap'

// Implementations must be injected by the future runtime composition root.
declare const positionPort: BootstrapPositionService
declare const referenceRatePort: BootstrapReferenceRateService
declare const makePort: BootstrapMakeService

const bootstrapConfigs = [
  {
    marketId: '0x1111111111111111111111111111111111111111111111111111111111111111',
    creditTarget: 10_000_000_000n,
    acceptanceAssets: 100_000_000n,
    offerSize: 500_000_000n,
    premiumBps: -50n,
    maximumMarketExposure: 20_000_000_000n,
    maximumTotalExposure: 30_000_000_000n,
    minimumRateBps: 200n,
    maximumRateBps: 800n,
    autoRefill: false
  },
  {
    marketId: '0x2222222222222222222222222222222222222222222222222222222222222222',
    creditTarget: 5_000_000_000n,
    acceptanceAssets: 50_000_000n,
    offerSize: 250_000_000n,
    premiumBps: 0n,
    maximumMarketExposure: 10_000_000_000n,
    maximumTotalExposure: 30_000_000_000n,
    minimumRateBps: 200n,
    maximumRateBps: 800n,
    autoRefill: true
  }
] satisfies readonly BootstrapConfig[]

const positionBootstrap = new PositionBootstrapService(
  positionPort,
  referenceRatePort,
  makePort,
  bootstrapConfigs
)

const results = await positionBootstrap.runOnce()
```

The numeric values are illustrative raw-unit placeholders, not pilot defaults. Configure each market
with every field below:

| Field                   | Unit / behavior                                                                                         | Validation                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `marketId`              | `Hex` market identifier passed to each injected port                                                    | Type-level `Hex`; this layer performs no runtime market-ID validation   |
| `creditTarget`          | Raw credit/loan-asset units; complete when `credit >= creditTarget - acceptanceAssets`                  | Must be positive                                                        |
| `acceptanceAssets`      | Raw loan-asset units of acceptable shortfall from the credit target                                     | Must be non-negative and no greater than `creditTarget`                 |
| `offerSize`             | Raw loan-asset units; fixed desired offer size before capacity caps                                     | Must be positive                                                        |
| `premiumBps`            | Basis points added to the reference rate                                                                | Must be zero or negative                                                |
| `maximumMarketExposure` | Raw loan-asset units; caps remaining capacity for this market                                           | Must be positive and no greater than `maximumTotalExposure`             |
| `maximumTotalExposure`  | Raw loan-asset units; caps remaining strategy-wide capacity                                             | Must be positive                                                        |
| `minimumRateBps`        | Inclusive minimum for the final premium-adjusted requested rate                                         | Must be non-negative and no greater than `maximumRateBps`               |
| `maximumRateBps`        | Inclusive maximum for the final premium-adjusted requested rate                                         | Must be non-negative                                                    |
| `autoRefill`            | Whether bootstrap may resume after this service instance has first observed completion and credit falls | Boolean; the completion gate is in memory for the service instance only |

For a market below its accepted target, desired assets are the minimum of `offerSize`, remaining
credit target, cash balance, remaining per-market exposure, and remaining total exposure. Zero or
negative capacity leaves no offer (and invalidates an active one). The final requested rate is
`reference rate + premiumBps`; a result outside the inclusive minimum/maximum bounds is rejected, not
clamped.

With `autoRefill: false`, the service stops top-ups after it first observes the accepted target and
remains observational if credit later falls. Recreating the service resets that in-memory,
service-lifetime gate; fresh position and active-offer reads remain authoritative. With
`autoRefill: true`, a later deficit can publish again. For an unchanged static rate and size,
observation-ID changes do not replace the offer. In variable mode, a new observation ID triggers
replacement; either mode also replaces when desired size or rate changes.

`runOnce()` validates every market config before the first position read, reference read, or
market-level reconciliation, so a bad later entry prevents an earlier valid entry from publishing.
Invalid configuration, reference-read failures, and decision failures (including a premium-adjusted
rate outside its bounds) stop the run and invoke strategy-wide `hardHalt` through the injected
`BootstrapMakeService`. An ordinary position-read failure instead requests market-local invalidation
and processing continues for other markets. These are port-level guarantees: this package does not yet
provide the concrete signing, invalidation, or publication adapter.

See [TIB-2026-07-27, Process 2](../../docs/decisions/TIB-2026-07-27-midnight-market-making-bot.md#5-process-2--bootstrap)
for the intended runtime contract; future environment/YAML and composition-root work described there
is not part of the currently available application API.

## Run

```sh
bun run --filter @morpho-org/market-making-bot start -- setup-check
```

Success prints one JSON report and exits zero. Bigints are serialized as decimal strings. Any failed
check throws `SetupFailedError`, prints the failed check names, and exits non-zero. The check is strictly
read-only; remediation transaction descriptions are reported but never submitted.

Version output remains available:

```sh
bun run --filter @morpho-org/market-making-bot start -- --version
```

## Test

```sh
bun test bots/market-making/test
bun run --filter @morpho-org/market-making-bot typecheck
```
