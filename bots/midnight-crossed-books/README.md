# Midnight crossed-books resolver

Implements [MKT-1379](https://linear.app/morpho-labs/issue/MKT-1379/crossed-books-resolver-bot).

The bot lists active, listed Midnight markets through the Morpho API, loads both takeable Router book sides, greedily pairs crossed asks and bids, simulates the exact resolver transaction, and submits only a profitable request.

## Architecture

The code follows the service and dependency-injection style used by `morpho-api` and the generated OpenAPI client pattern used by `morpho-apps`:

- `CrossedBooksBotService` owns the application workflow and depends only on service interfaces.
- `MorphoApiService` implements listed-market discovery through a generated `openapi-fetch` client.
- `RouterApiService` implements takeable-book reads through a separate generated `openapi-fetch` client.
- `MatchingService` is a pure domain service.
- `ResolverExecutionService` prepares immutable calldata, simulates it, and submits the same bytes through an injected transport.
- `bootstrap.ts` is the composition root. It wires concrete services, signer policy, nonce queue, monitors, and runner.

The permissionless `CrossedBooksResolver` needs no inventory. It recursively takes every crossed sell offer through nested `onBuy` callbacks. The deepest callback sells all received units into the crossed buy offers, approves the aggregate sell cost, and lets the callbacks unwind. The positive loan-token balance delta goes to `msg.sender`. Same-market checks, balanced units, settlement fees, rounding, stale offers, callbacks, and minimum profit remain atomic.

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

The generated files live under each infrastructure adapter's `generated/` directory and are not edited by hand.

## Configuration

- `CHAIN_ID` — required, currently `8453`.
- `RPC_URL` — required. `RPC_URL_FALLBACK` is optional.
- `READONLY` — optional; set to `true` (or `1`) to simulate and log profitable matches without submitting transactions.
- `RESOLVER_PRIVATE_KEY` — required `0x`-prefixed 32-byte bot key unless `READONLY` is enabled.
- `RESOLVER_ADDRESS` — optional deterministic deployment override.
- `API_BASE_URL` — Morpho API origin, default `https://api.morpho.org`.
- `ROUTER_API_BASE_URL` — Router API origin, defaults to `API_BASE_URL` for the public gateway.
- `MIN_PROFIT_ASSETS` — raw loan-token units, default `1`; one value applies to all markets.
- `MAX_MATCHES` — maximum crossed matches per resolver transaction, default `10`.
- `SCAN_INTERVAL_MS` — default `15000`.
- `MAX_FEE_GWEI` — default `300`.

## Deploy the contract

```sh
RPC_URL=https://… DEPLOYER_PRIVATE_KEY=0x… \
MIDNIGHT_ADDRESS=0xAdedD8ab6dE832766Fedf0FaC4992E5C4D3EA18A \
pnpm --filter @repo/contracts run deploy:crossed-books-resolver
```

## Run

```sh
CHAIN_ID=8453 RPC_URL=https://… READONLY=true \
pnpm --filter @morpho-org/midnight-crossed-books run start
```

Readonly mode uses the resolver address as the simulation caller, logs each profitable result as
`match.computed`, and never creates a signer, transaction queue, or submission.

To execute profitable resolutions instead, provide the signer key:

```sh
CHAIN_ID=8453 RPC_URL=https://… RESOLVER_PRIVATE_KEY=0x… \
pnpm --filter @morpho-org/midnight-crossed-books run start
```

The signer policy pins chain, resolver, `resolve` selector, zero ETH value, calldata, gas, and fee ceilings. The pending queue manages nonces and replacement. Every transaction is simulated byte-for-byte before submission.

## Deploy

The first deployment provisions the Railway service and writes the runtime secrets directly to
Railway:

```sh
RAILWAY_PROJECT_ID=… RAILWAY_ENVIRONMENT=staging \
RPC_URL=https://… RESOLVER_PRIVATE_KEY=0x… \
pnpm --filter @morpho-org/midnight-crossed-books run deploy:railway
```

CI subsequently runs the same command with `DEPLOY_ONLY=true`, so GitHub holds only a
project/environment-scoped Railway token. Pushes to `main` deploy staging through the
`crossed-books-staging` GitHub Environment. Production deploys use the `release-crossed-books`
label or a manual production workflow dispatch and the `crossed-books-prod` GitHub Environment.
Each GitHub Environment defines `RAILWAY_PROJECT_ID` as a variable and `RAILWAY_TOKEN` as a secret;
bot runtime secrets remain on Railway.

## Test

```sh
pnpm --filter @morpho-org/midnight-crossed-books exec vitest run
forge test --root packages/contracts -vv
```

Coverage includes configuration validation, generated-client request mapping, pagination, upstream failures, domain matching boundaries, dependency-injected orchestration, simulation-to-submit byte identity, ABI encoding, permissionless execution, atomic rollback, balance preservation, and allowance cleanup.
