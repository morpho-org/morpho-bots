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
- `READONLY` — optional; `true`/`1` enables simulation-only mode, while absent/`false`/`0` selects write mode. Other values are rejected.
- `SIMULATION_CALLER_ADDRESS` — required in readonly mode. Set it to the non-zero public EOA that would execute resolutions in write mode so `msg.sender`, profit transfers, and reverts match execution without loading its private key. The operator is responsible for supplying this public caller address; the zero address is rejected.
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
SIMULATION_CALLER_ADDRESS=0x… \
pnpm --filter @morpho-org/midnight-crossed-books run start
```

Readonly mode uses `SIMULATION_CALLER_ADDRESS` as the execution-equivalent simulation caller, logs
each profitable result as `match.computed`, and never creates a signer, transaction queue, or
submission. Only the public EOA address is required; do not provide or derive its private key.

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

For keyless readonly Railway provisioning, replace the private key with the public caller address:

```sh
RAILWAY_PROJECT_ID=… RAILWAY_ENVIRONMENT=staging \
RPC_URL=https://… READONLY=true SIMULATION_CALLER_ADDRESS=0x… \
pnpm --filter @morpho-org/midnight-crossed-books run deploy:railway
```

The deploy script validates and propagates `READONLY` and `SIMULATION_CALLER_ADDRESS`; it does not
require or install `RESOLVER_PRIVATE_KEY` in readonly mode. It also removes a stale private key when
switching to readonly and removes a stale simulation caller when switching to write mode, aborting
before the mode change if deletion fails. Deletion uses `RAILWAY_TOKEN` (or `RAILWAY_API_TOKEN`) with
Railway's key-only variable metadata and an explicitly project/environment/service/name-scoped
mutation; it never runs `railway variable list` or retrieves variable values. Write mode still
requires a valid key.

CI subsequently runs the same command with `DEPLOY_ONLY=true`, so GitHub holds only a
project/environment-scoped Railway token. Pushes to `main` deploy staging through the
`crossed-books-staging` GitHub Environment. Production deploys use the `release-crossed-books`
label or a manual production workflow dispatch and the `crossed-books-prod` GitHub Environment.
Each GitHub Environment defines `RAILWAY_PROJECT_ID` as a variable and `RAILWAY_TOKEN` as a secret;
bot runtime secrets remain on Railway.

## Observability

The shared queue identifies a tracked transaction by the key this bot hands it, under the field `id`
(it was `label`). This bot's key is the **market id**, so `tx.*.id` is a market rather than a
position — it does not join to a liquidator's `id`, which is `marketId:borrower`.

## Test

```sh
pnpm --filter @morpho-org/midnight-crossed-books exec vitest run
forge test --root packages/contracts -vv
```

Coverage includes configuration validation, generated-client request mapping, pagination, upstream failures, domain matching boundaries, dependency-injected orchestration, simulation-to-submit byte identity, ABI encoding, permissionless execution, atomic rollback, balance preservation, and allowance cleanup.
