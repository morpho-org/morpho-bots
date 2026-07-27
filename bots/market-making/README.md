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

Bootstrap and ladder writer workflows do not exist in this package yet. When they are implemented,
the runtime must construct them in `bootstrap.ts` but await `SetupCheckService.assertReady()` before
starting either writer, as required by the TIB. The existing `setup-check` command exposes that same
reusable readiness gate without inventing a quote loop in this change.

## Setup-check configuration

All values are required except `V0_OFFER_GROUP_IDS`:

- `CHAIN_ID`: must be `8453` (Base).
- `RPC_URL`: Base RPC used for current chain state.
- `REFERENCE_RPC_URL`: archive-capable Base RPC. Setup verifies a latest read and a historical read
  approximately 10,800 blocks earlier.
- `MAKER_PRIVATE_KEY`: 0x-prefixed 32-byte private key; never logged.
- `MAKER_ADDRESS`: configured maker address. Setup verifies that the private key derives it.
- `MIDNIGHT_ADDRESS`: expected Midnight singleton.
- `LOAN_ASSET_ADDRESS`: expected market loan asset.
- `RATIFIER_ADDRESS`: selected Base Ecrecover ratifier. V0 accepts the repository-reviewed official
  Base deployment and verifies deployed code plus `Midnight.isAuthorized(maker, ratifier)`.
- `MARKET_IDS`: comma-separated allowlisted 32-byte market IDs; at least one is required.
- `NATIVE_RESERVE_WEI`: minimum native balance in wei.
- `MAXIMUM_LEND_EXPOSURE_ASSETS`: minimum loan-token allowance in raw assets.
- `MORPHO_API_BASE_URL`: Morpho API origin used to verify listed, active markets.
- `ROUTER_API_BASE_URL`: official Router API origin used to inspect all active maker offers.
- `V0_OFFER_GROUP_IDS`: optional comma-separated strategy-owned group IDs. Any active maker group not
  listed here fails readiness as an unknown namespace.

## Run

```sh
bun run --filter @morpho-org/market-making-bot start -- setup-check
```

Success prints one JSON report and exits zero. Bigints are serialized as decimal strings. Any failed
check throws `SetupCheckError`, prints the failed check names, and exits non-zero. The check is strictly
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
