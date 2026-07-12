# curator-bots

Off-chain Morpho curator bots — reallocators, liquidation monitors, and similar —
and the shared packages they consume.

This is a [bun workspaces](https://bun.com/docs/install/workspaces) monorepo:

- `tools/` — operator-invoked, UNIX-pipeable one-shot commands. Sources emit transparent position
  JSON; transforms consume those semantic fields and emit transaction JSON.
- `bots/` — deployment packaging for the bot use-case (`@repo/bots`): the Docker image +
  pipeline entrypoint loop, docker-compose files, and Railway deploy scripts that wrap the
  generic CLI
- `services/` — long-lived processes: the Blue indexer and the per-chain `morpho-queued` daemon,
  which alone owns transaction state, dedupe, re-simulation, fees, nonces, broadcast, and replacement
- `packages/` — libraries: the bot cores (`@repo/blue-liquidation`, `@repo/midnight-liquidation`)
  and focused shared layers, including the policy-enforcing `morpho-signer` agent

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

## Daily commands

```sh
bun run lint        # oxlint, repo-wide
bun run lint:fix    # oxlint with --fix
bun format          # oxfmt, repo-wide
bun run knip        # dead-code detection
bun test            # bun's built-in test runner
```

## Pointers

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
