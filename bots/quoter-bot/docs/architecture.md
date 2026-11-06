# Quoter bot architecture

This document describes the package structure and implementation boundaries for contributors. For
installation, configuration, and strategy behavior, see the [README](../README.md); for the complete
command, deployment, and operational-safety reference, see the
[operations reference](./reference.md).

The implementation follows the repository's [coding conventions](../../../docs/CONVENTIONS.md).

## Architectural boundaries

The package uses a pragmatic hexagonal architecture:

- `src/domain/` is a flat set of pure, deterministic modules: bootstrap and ladder decisions and
  their configuration validation, maturity premiums, tick windows, and failure budgets. It may use
  SDK math but has no provider, signer, persistence, or CLI responsibilities.
- `src/graph.ts`, `src/run.ts`, `src/kernel.ts` and `src/report.ts` are the framework skeleton
  every bot shares (`docs/framework/AUTHORING.md`): the one static graph, the run that hosts it, the
  kernel's options and signer policy, and the operator log over its events.
- `src/application/` owns setup readiness, invalidation, and each strategy's pure per-market
  decision under `application/engine/`, and the ports the readers implement live beside the reports
  they produce.
- `src/infrastructure/` implements those ports with viem, the Morpho API, the Midnight SDK, the
  kernel's ownership, and terminal output. `infrastructure/engine/` holds the graph's sources, acts,
  plans and polls, and the services the CLI calls. Every signer and pre-broadcast calldata check
  lives in `src/kernel.ts` and `infrastructure/kernel/`, over `@repo/kit`'s KMS and keystore accounts.
- `src/config/` loads YAML and environment sources, applies precedence, and narrows external values
  into the types consumed by the application.
- `src/bootstrap.ts` is the manual composition root. It selects live or read-only adapters and wires
  shared lifecycle dependencies.
- `src/infrastructure/cli/cli.ts` is the operator-facing adapter,
  `src/infrastructure/cli/quoter-bot-entrypoint.ts` maps application results to JSON Lines and
  process exit codes, and `src/index.ts` only installs signal handling and starts the application.

Dependencies point inward: infrastructure depends on application-owned interfaces and domain
types; application code does not depend on concrete provider or signer implementations.

## Application services and ports

### Setup readiness

`SetupCheckService` owns the read-only readiness workflow and the `SetupStateService` port.
`ViemSetupStateService` implements that port across current-state RPC, archive RPC, the Morpho API,
and the canonical contract catalog provided by the pinned Morpho SDK.

Independent provider reads are launched concurrently with `Promise.all`. Each read has its own
error boundary, so one rejected provider call becomes a failed report item without suppressing the
other observations. Book reads also run concurrently; book validation waits only for the latest
timestamp required for maturity comparison.

### Bootstrap and ladder on the engine

Both strategies run as one static dataflow graph (`src/graph.ts`) on
`@repo/engine`, with its kernel declared in the graph and the library folds of `@repo/controller`
around it. See [`docs/framework/AUTHORING.md`](../../../docs/framework/AUTHORING.md).

- **Sources** (`infrastructure/engine/quoter-sources.ts`) read every configured market with the
  readers each strategy always used: the ladder's lending guard first, then its active quote and
  market state; the bootstrap position at its own cadence; each market's reference; and setup
  readiness. Every chain reading carries the kernel epoch it was read at and its block, and the
  sources read again at once whenever one of the bot's own acts moves that epoch.
- **Decisions** (`application/engine/ladder-decision.ts`, `bootstrap-decision.ts`) are pure. Per
  market, they keep today's order of checks and reuse the domain's generation and sizing; each
  returns the groups to keep live, the quote it desires, and at most one act.
- **Preparation** is a need: only while a market would publish, the complete book is read, a
  `book-crossed` crossing is rechecked, the unsigned tree is built and API-validated, and the
  prospective spread is asserted, all before anything is cancelled.
- **Acts** are a cancellation, or a replacement that cancels the market's live groups and then
  signs or ratifies and publishes the prepared tree, in one kernel plan. The kernel holds the
  publication after the cancellation lands until a decision read after it still desires the same
  quote, which is what re-admission did.
- **The controller** sends one act at a time across both strategies, only from readings at the
  current epoch, re-affirms only what fresh decisions keep, and withdraws a market whose decision
  failed or went stale. Its bookkeeping retries a failed act after the fastest market cadence and
  halts after five consecutive failed acts of one market; the reporter also applies the five-poll
  per-market failure budget to the markets' reports, halting before that step sends anything.

A reference or decision failure halts the bot: the kernel withdraws every commitment it holds. A
market-read failure withdraws that market alone. Each decision carries its market's report as data;
on every markets poll, each market not in flight reports once, from the outcome of an act that ended
since its last report or else from its current decision, and that report becomes `cycle.completed`
and the guardrail and observation records. A decision is never `applied`: an act it wants is
`queued` until the kernel settles it.

### Explicit invalidation

`OfferInvalidationService` owns a narrower `OfferInvalidationPort`. The production implementation
uses a cancellation-specific preflight rather than the normal offer-readiness gate, allowing an
operator to remove unknown maker groups without weakening the readiness rules used by writers.

## Composition and runtime modes

`createApplication()` loads configuration lazily for commands that need it and constructs only the
selected workflow. A writer's controller first withdraws what an earlier run left, then runs the
readiness assertion, and only then lets any decision act; a failure there stops the kernel.

The root `--readonly` option changes composition rather than adding conditionals to domain logic:

- signer material is neither loaded nor validated;
- the configured maker address is used for observations;
- the controller runs over a dry kernel that starts from the ledgers on disk and signs nothing;
- all normal state, rate, policy, and prospective-spread validation remains active;
- each requested act is reported as a logged `cycle.completed` record carrying its condition.

## State and transaction safety

The kernel's ledger, beside the strategy state, is the only state the bot keeps: what it exposed
and what it signed at each nonce. Ownership of groups is read from the kernel's entries, with the
quote behind each publication kept in process memory from the act that published it. A restart
withdraws every group an earlier run left before quoting again.

Every write is a kernel plan: each step's payload is read by the Midnight offers validator,
simulated, signed through the kit signer's per-operation policy (target, selector, gas,
calldata, fee, and spend limits), durably recorded, then broadcast. AWS mode uses a distinct KMS
signer authorized by the funded maker; the KMS key never becomes the offer maker.

## Error and output boundaries

Expected failures use named error classes declared in `src/errors.ts`. Infrastructure
errors are translated into stable application outcomes before reaching the CLI. Operator-visible
reports omit private keys, maker identity, endpoints, signatures, raw transactions, response bodies,
provider payloads, and untrusted nested error text.

`runQuoterBotEntrypoint()` is the final boundary. It serializes bigint values as decimal strings,
writes one JSON value per line, emits sanitized handled reports on standard error, and maps success
or failure to process exit code `0` or `1`.

## Contributor verification

Unit tests mirror `src/` under `test/`. The end-to-end suite starts an Anvil fork of Base at a pinned
historical block and requires `anvil` on `PATH` plus an archive-capable `RPC_URL_8453`.

Run package-focused checks with:

```sh
pnpm --filter @morpho-org/quoter-bot exec vitest run
pnpm --filter @morpho-org/quoter-bot run test:e2e
pnpm --filter @morpho-org/quoter-bot run typecheck
pnpm --filter @morpho-org/quoter-bot run jsdoc:build
```

Before committing or when performing full validation, follow the repository-level validation suite
in [CONVENTIONS.md](../../../docs/CONVENTIONS.md).
