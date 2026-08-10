# Market-making bot architecture

This document describes the package structure and implementation boundaries for contributors. For
installation, configuration, strategy behavior, commands, and operational safety, see the
[operator README](../README.md).

The implementation follows the market-maker design from
[TIB-2026-07-27](../../../docs/decisions/TIB-2026-07-27-midnight-market-making-bot.md) and the
repository's [coding conventions](../../../docs/CONVENTIONS.md).

## Architectural boundaries

The package uses a pragmatic hexagonal architecture:

- `src/domain/` contains deterministic bootstrap and ladder decisions plus their configuration
  validation. It has no provider, signer, persistence, or CLI responsibilities.
- `src/application/` coordinates setup, bootstrap, ladder, invalidation, and the combined lifecycle.
  Application services own the ports they consume and return sanitized workflow reports.
- `src/infrastructure/` implements those ports with viem, the Morpho and Router APIs, the Midnight
  SDK, local ownership state, transaction submission, and terminal output.
- `src/config/` loads YAML and environment sources, applies precedence, and narrows external values
  into the types consumed by the application.
- `src/bootstrap.ts` is the manual composition root. It selects live or read-only adapters and wires
  shared lifecycle dependencies.
- `src/infrastructure/cli/cli.ts` is the operator-facing adapter,
  `src/infrastructure/cli/market-making-entrypoint.ts` maps application results to JSON Lines and
  process exit codes, and `src/index.ts` only installs signal handling and starts the application.

Dependencies point inward: infrastructure depends on application-owned interfaces and domain
types; application code does not depend on concrete provider or signer implementations.

## Application services and ports

### Setup readiness

`SetupCheckService` owns the read-only readiness workflow and the `SetupStateService` port.
`ViemSetupStateService` implements that port across current-state RPC, archive RPC, the Morpho API,
and the Router API.

Independent provider reads are launched concurrently with `Promise.all`. Each read has its own
error boundary, so one rejected provider call becomes a failed report item without suppressing the
other observations. Book reads also run concurrently; book validation waits only for the latest
timestamp required for maturity comparison.

### Position bootstrap

`PositionBootstrapService` consumes three application-owned ports:

- `BootstrapPositionService` reads fresh position, balance, exposure, and active-group state.
- `BootstrapReferenceRateService` reads the Blue reference rate.
- `BootstrapMakeService` owns reconciliation, market invalidation, strategy hard halt, and graceful
  cleanup mutations.

`runOnce()` validates every configured market before reading positions, rates, or publishing.
Configuration, reference, and decision failures request a strategy-wide hard halt. A position-read
failure first requests market-local invalidation and allows other markets to complete unless that
invalidation also fails.

`MidnightBootstrapMakeService` is the live implementation. It rereads owned groups, validates the
prospective complete maker book, serializes invalidation and publication, persists group ownership
before broadcast, and waits for bounded receipts. `ReadOnlyBootstrapMakeService` implements the same
mutation port by emitting `readonly.make` records without loading a signer or mutating state.

Continuous bootstrap cycles never overlap. Shutdown waits for the current cycle and then calls the
same make port to clean all strategy-owned bootstrap groups.

### Ladder market making

`LadderMarketMakerService` consumes the analogous `LadderPositionService`,
`LadderReferenceRateService`, and `LadderMakeService` ports. The domain module validates ladder
configuration, generates deterministic quote sets, and decides whether a live center must be
recentered. The application service reconstructs the active quote, derives a complete desired quote
from fresh capacity, and selects `publish`, `rest`, `resize`, or `recenter`.

`MidnightLadderMakeService` implements live reconciliation. Its infrastructure collaborators handle
inventory reads, tick conversion, lower/higher-rate to buy/sell mapping, offer-tree encoding,
Mempool validation, whole-book spread validation, signing, publication, replacement, invalidation,
and durable group ownership. `ReadOnlyLadderMakeService` preserves the read and validation path but
renders the intended mutation instead of signing or submitting it.

Replacement is deliberately market-wide. The adapter reserves future content-addressed group IDs,
validates the future tree, confirms cancellation of existing owned groups, publishes the complete
replacement, waits for its receipt, and confirms ownership. Continuous cycles do not overlap and
use the shortest configured market interval.

As with bootstrap, configuration, reference, and decision failures request a strategy-wide hard
halt. A market-state read failure requests market-local invalidation. A halted monitor still attempts
exhaustive owned-group cleanup.

### Combined lifecycle

`MarketMakingService` supervises readiness, position bootstrap, and ladder monitoring as one
fail-together lifecycle. `serializeMarketMakingWrites()` wraps the two make ports in one shared queue,
so otherwise concurrent strategy reads cannot turn into signer-nonce or maker-book mutation races.

The first rejected, halted, or unexpectedly stopped workflow aborts its peers. The supervisor then
waits for both writer workflows to drain their in-flight cycles and finish cleanup before returning
one terminal report.

### Explicit invalidation

`OfferInvalidationService` owns a narrower `OfferInvalidationPort`. The production implementation
uses a cancellation-specific preflight rather than the normal offer-readiness gate, allowing an
operator to remove unknown maker groups without weakening the readiness rules used by writers.

## Composition and runtime modes

`createApplication()` loads configuration lazily for commands that need it and constructs only the
selected workflow. Before a bootstrap, ladder, or combined writer is created, the composition root
runs the readiness assertion. This prevents writer side effects after failed setup.

The root `--readonly` option changes composition rather than adding conditionals to domain logic:

- signer material is neither loaded nor validated;
- the configured maker address is used for observations;
- live make ports are replaced or decorated by read-only implementations;
- all normal state, rate, policy, and prospective-spread validation remains active;
- requested mutations are emitted as `readonly.make` JSON Lines records.

## State and transaction safety

Bootstrap and ladder group ownership is stored outside the repository in a maker-and-market-bound
state namespace. Publication reserves derived group IDs before broadcast and promotes them after
confirmation. A failed broadcast removes the reservation; a successful broadcast followed by a
storage failure leaves enough ownership evidence to recognize the group when provider indexing
catches up.

All transaction-producing adapters enforce a blocking sequence: derive and validate, persist the
pending ownership state, sign, broadcast, and confirm. Receipt timeouts are independent from general
provider request timeouts. Transaction assertion utilities restrict outgoing calls to the expected
Midnight publication or cancellation operation.

## Error and output boundaries

Expected failures use named error classes isolated in their own `*.error.ts` files. Infrastructure
errors are translated into stable application outcomes before reaching the CLI. Operator-visible
reports omit private keys, maker identity, endpoints, signatures, raw transactions, response bodies,
provider payloads, and untrusted nested error text.

`runMarketMakingEntrypoint()` is the final boundary. It serializes bigint values as decimal strings,
writes one JSON value per line, emits sanitized handled reports on standard error, and maps success
or failure to process exit code `0` or `1`.

## Contributor verification

Unit tests mirror `src/` under `test/`. The end-to-end suite starts an Anvil fork of Base at a pinned
historical block and requires `anvil` on `PATH` plus an archive-capable `RPC_URL_8453`.

Run package-focused checks with:

```sh
bun test bots/market-making/test
pnpm --filter @morpho-org/market-making-bot run test:e2e
pnpm --filter @morpho-org/market-making-bot run typecheck
pnpm --filter @morpho-org/market-making-bot run jsdoc:build
```

Before committing or when performing full validation, follow the repository-level validation suite
in [CONVENTIONS.md](../../../docs/CONVENTIONS.md).
