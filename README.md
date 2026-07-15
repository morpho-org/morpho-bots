# curator-bots

Off-chain Morpho curator bots — reallocators, liquidation monitors, and similar —
and the shared packages they consume.

This is a [bun workspaces](https://bun.com/docs/install/workspaces) monorepo:

- `apps/` — independently runnable programs: the UNIX-pipeable `morpho-bots` CLI (sources emit
  transparent position JSON; transforms consume those semantic fields and emit transaction JSON),
  the per-chain `morpho-queued` daemon — which alone owns transaction state, dedupe, re-simulation,
  fees, nonces, broadcast, and replacement — and the policy-enforcing `morpho-signer` agent
- `packages/` — libraries: the bot cores (`@repo/blue-liquidation`, `@repo/midnight-liquidation`)
  and focused shared layers
- `deploy/` — deployment packaging (`@repo/deploy`): the Docker image + pipeline entrypoint loop,
  docker-compose files, Railway deploy scripts, and the Blue indexer image (`deploy/blue-rindexer`)

Pipeline records are deliberately inspectable and adaptable with tools such as `jq`. Position IDs
are correlation/deduplication labels only; consumers use explicit `marketId`, `borrower`, and domain
fields rather than decoding IDs. `morpho-queued submit` streams transaction JSON directly over a
Unix socket to the queue daemon.

Transforms read JSONL incrementally in bounded batches. A malformed or oversized line is reported
on stderr; valid records are still processed, and the command exits 2 so `pipefail` loops stop.
Filters must preserve one object per line (for example, use `jq -c`).

## Getting started

```sh
nvm use         # Node 24.14.1 (see .nvmrc)
bun install
```

## Running a bot

A single tick is a source op piped into a transform op piped into the queue daemon — for example,
Morpho Blue on Base:

```sh
morpho-bots blue unhealthy-positions \
  | morpho-bots blue liquidate \
  | morpho-queued submit --chain 8453
```

That pipeline runs once. A live bot loops it on an interval alongside a long-lived
`morpho-queued serve` daemon — which alone owns dedupe, re-simulation, fees, nonces, broadcast, and
replacement — plus a `morpho-signer` process when armed. Running the queue with `--dry-run` exercises
the whole path and emits `would_submit` records without any signer or key.

- [`apps/cli/README.md`](./apps/cli/README.md) — the `morpho-bots` command reference and a
  copy-pasteable walkthrough for running a looping bot by hand
- [`deploy/README.md`](./deploy/README.md) — the packaged, always-on loop (Docker image, compose
  files, Railway deploy scripts)

## Daily commands

```sh
bun run lint        # oxlint, repo-wide
bun run lint:fix    # oxlint with --fix
bun format          # oxfmt, repo-wide
bun run knip        # dead-code detection
bun test            # bun's built-in test runner
```

## Pointers

- [`apps/cli/README.md`](./apps/cli/README.md) — the `morpho-bots` operator handbook (commands,
  config/state, the pipeline, running a looping bot)
- `docs/INDEX.md` — documentation discovery index (guides, bots, packages, TIBs)
- `CLAUDE.md` — agent and contributor conventions (Strict Rules, agent team,
  self-verification ritual)
- `docs/CONVENTIONS.md` — code organization, patterns, and style
- `docs/GUIDANCE.md` — when to write a TIB, when to file a Linear ticket
- `docs/decisions/` — TIBs (Technical Intent Briefs)
- `docs/templates/` — TIB and data-flow doc templates

The monorepo scaffold and tooling rationale are documented in
[TIB-2026-04-16](./docs/decisions/TIB-2026-04-16-bootstrap-curator-bots.md).

Bot docs:

- `packages/midnight-liquidation/README.md` — how the Midnight liquidation bot works and how to run it
  end to end
- `packages/blue-liquidation/README.md` — how the Morpho Blue liquidation bot works and how to run it
  end to end

## License

[Apache-2.0](./LICENSE) © 2026 Morpho Association
